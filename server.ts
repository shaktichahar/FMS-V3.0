import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type Request, type Response, type NextFunction } from 'express';
import { databaseMode } from './src/db/index.ts';
import { adminAuth } from './src/lib/firebase-admin.ts';
import {
  ADMIN_GMAIL,
  dispatchLoginOtp,
  isValidEmail,
  isValidMobile,
  maskEmail,
  maskMobile,
  normalizeEmail,
  normalizeMobile,
} from './src/lib/otp-delivery.ts';
import {
  computeFinancialYear,
  consumeOtpChallenge,
  createBudgetHeadRecord,
  createOtpChallengeRecord,
  createSanctionRecord,
  createTransactionRecord,
  createUserRecord,
  deleteBudgetHeadRecord,
  deleteSanctionRecord,
  deleteTransactionRecord,
  deleteUserRecord,
  exportDatabaseSnapshot,
  findBudgetHeadById,
  findSanctionById,
  findTransactionById,
  findUserById,
  findUserByIdentifier,
  findUserByUsername,
  getLatestOtpChallengeForUser,
  getOtpChallengeById,
  hashPassword,
  incrementOtpAttempts,
  listBudgetHeads,
  listSanctions,
  listTransactions,
  listUsers,
  restoreDatabaseSnapshot,
  updateBudgetHeadRecord,
  updateSanctionRecord,
  updateTransactionRecord,
  updateUserRecord,
  upsertFirebaseUser,
  validateDatabaseBackupSnapshot,
  verifyPassword,
  type DatabaseBackupSnapshot,
  type StoredUser,
} from './src/db/repository.ts';
import type {
  AnalyticsSummary,
  BudgetHead,
  BudgetHeadEnriched,
  BudgetSanction,
  BudgetSanctionEnriched,
  ImportBudgetHeadRow,
  ImportResultSummary,
  ImportSanctionRow,
  ImportTransactionRow,
  OtpChallengeResponse,
  OtpPurpose,
  PaymentMethod,
  SafeUser,
  SanctionApprovalStatus,
  SanctionAttachment,
  Transaction,
  TransactionEnriched,
  TransactionStatus,
  TransactionType,
  UserRole,
} from './src/types/finance.ts';

interface AuthenticatedRequest extends Request {
  user?: StoredUser;
  sessionLoginAt?: string;
  sessionLastActivity?: number;
}

function resolvePort(): number {
  const portArgIdx = process.argv.indexOf('--port');
  if (portArgIdx !== -1 && process.argv[portArgIdx + 1]) {
    const parsed = Number(process.argv[portArgIdx + 1]);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  const envPort = Number(process.env.PORT);
  const nginxPort = Number(process.env.NGINX_PORT);
  if (Number.isFinite(envPort) && envPort > 0) {
    if (process.env.NODE_ENV === 'production' || envPort !== nginxPort) {
      return envPort;
    }
  }
  return 3000;
}

const PORT = resolvePort();
const DATA_DIR = path.resolve(process.cwd(), 'data');
const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
const SQL_SEED =
  process.env.SQL_HOST && process.env.SQL_PASSWORD
    ? `${process.env.SQL_HOST}:${process.env.SQL_DB_NAME || ''}:${process.env.SQL_USER || ''}:${process.env.SQL_PASSWORD}`
    : '';
const TOKEN_SECRET =
  process.env.SESSION_SECRET ||
  (SQL_SEED
    ? crypto.createHash('sha256').update(`ledgerflow-session:${SQL_SEED}`).digest('hex')
    : crypto.randomBytes(32).toString('hex'));
const SESSION_COOKIE_NAME = 'lf_session';
const INACTIVITY_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SESSION_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000; // 24 hours absolute cap
const MAX_PDF_BYTES = 8 * 1024 * 1024; // 8 MB max PDF attachment
const OTP_TTL_SECONDS = 5 * 60; // 5 minutes
const OTP_RESEND_COOLDOWN_SECONDS = 30;

// ── HMAC Token, Cookie & User Access Helpers ─────────────────────────────────

interface SessionTokenPayload {
  userId: string;
  role: UserRole;
  loginAt: string;
  lastActivity: number;
  exp: number;
}

function signToken(payload: SessionTokenPayload): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${sig}`;
}

function verifyToken(token: string): SessionTokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = crypto
    .createHmac('sha256', TOKEN_SECRET)
    .update(`${header}.${body}`)
    .digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) {
    return null;
  }
  try {
    const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<SessionTokenPayload>;
    if (!parsed.userId || !parsed.exp || Date.now() > parsed.exp) return null;
    return {
      userId: parsed.userId,
      role: parsed.role === 'admin' ? 'admin' : 'user',
      loginAt: typeof parsed.loginAt === 'string' ? parsed.loginAt : new Date().toISOString(),
      lastActivity: typeof parsed.lastActivity === 'number' ? parsed.lastActivity : Date.now(),
      exp: parsed.exp,
    };
  } catch {
    return null;
  }
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  if (!header) return {};
  const result: Record<string, string> = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const val = part.slice(idx + 1).trim();
    if (key) {
      try {
        result[key] = decodeURIComponent(val);
      } catch {
        result[key] = val;
      }
    }
  }
  return result;
}

function isHttpsRequest(req: Request): boolean {
  const xfProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  return req.secure || xfProto === 'https';
}

function setSessionCookie(req: Request, res: Response, token: string): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${Math.floor(SESSION_MAX_LIFETIME_MS / 1000)}`,
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  const parts = [
    `${SESSION_COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=0',
  ];
  if (isHttpsRequest(req)) {
    parts.push('Secure');
  }
  res.setHeader('Set-Cookie', parts.join('; '));
}

function issueUserSession(
  req: Request,
  res: Response,
  user: StoredUser,
  existingLoginAt?: string
): { token: string; loginAt: string; lastActivity: number } {
  const now = Date.now();
  const loginAt = existingLoginAt || new Date(now).toISOString();
  const token = signToken({
    userId: user.id,
    role: user.role,
    loginAt,
    lastActivity: now,
    exp: now + SESSION_MAX_LIFETIME_MS,
  });
  setSessionCookie(req, res, token);
  return { token, loginAt, lastActivity: now };
}

function hashOtpCode(code: string): string {
  return crypto.createHmac('sha256', TOKEN_SECRET).update(`otp:${code}`).digest('hex');
}

function verifyOtpHash(code: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOtpCode(code), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function toSafeUser(u: StoredUser): SafeUser {
  const { passwordHash: _ph, passwordSalt: _ps, firebaseUid: _fu, ...safe } = u;
  return safe;
}

const PENDING_APPROVAL_MESSAGE =
  'Your account is pending administrator approval or currently deactivated. Please contact an administrator.';

function formatAccessDate(d: Date): string {
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function evaluateUserAccess(
  user: StoredUser,
  now: Date = new Date()
): { allowed: boolean; reason?: string } {
  if (!user.active) {
    return { allowed: false, reason: PENDING_APPROVAL_MESSAGE };
  }

  const nowMs = now.getTime();
  if (user.activeFrom) {
    const start = new Date(user.activeFrom);
    if (!Number.isNaN(start.getTime()) && nowMs < start.getTime()) {
      return {
        allowed: false,
        reason: `Your account access is scheduled to start on ${formatAccessDate(start)}.`,
      };
    }
  }
  if (user.activeUntil) {
    const end = new Date(user.activeUntil);
    if (!Number.isNaN(end.getTime()) && nowMs > end.getTime()) {
      return {
        allowed: false,
        reason: `Your scheduled access period ended on ${formatAccessDate(end)}. Contact an administrator to extend access.`,
      };
    }
  }

  if (user.deactivatedFrom || user.deactivatedUntil) {
    const dFrom = user.deactivatedFrom ? new Date(user.deactivatedFrom) : null;
    const dUntil = user.deactivatedUntil ? new Date(user.deactivatedUntil) : null;
    const validFrom = dFrom && !Number.isNaN(dFrom.getTime()) ? dFrom : null;
    const validUntil = dUntil && !Number.isNaN(dUntil.getTime()) ? dUntil : null;

    if (
      (validFrom || validUntil) &&
      (!validFrom || nowMs >= validFrom.getTime()) &&
      (!validUntil || nowMs <= validUntil.getTime())
    ) {
      return {
        allowed: false,
        reason: validUntil
          ? `Your account is temporarily deactivated until ${formatAccessDate(validUntil)}.`
          : 'Your account is temporarily deactivated. Please contact an administrator.',
      };
    }
  }

  return { allowed: true };
}

function parseOptionalTimestampInput(
  raw: unknown
): { provided: boolean; value: Date | null; error?: string } {
  if (raw === undefined) return { provided: false, value: null };
  if (raw === null || raw === '') return { provided: true, value: null };
  if (typeof raw !== 'string') {
    return { provided: true, value: null, error: 'Invalid date/time format.' };
  }
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    return { provided: true, value: null, error: 'Invalid date/time value provided.' };
  }
  return { provided: true, value: parsed };
}

async function issueOtpChallengeForUser(
  user: StoredUser,
  purpose: OtpPurpose
): Promise<OtpChallengeResponse> {
  const isRegistration = purpose === 'register';
  const rawEmail = normalizeEmail(user.email);
  const usernameAsEmail = normalizeEmail(user.username);
  const cleanEmail = isValidEmail(rawEmail)
    ? rawEmail
    : isValidEmail(usernameAsEmail)
      ? usernameAsEmail
      : '';
  const hasEmail = isValidEmail(cleanEmail);
  const cleanMobile = normalizeMobile(user.mobile);
  const hasMobile = !isRegistration && isValidMobile(cleanMobile);

  if (isRegistration && !hasEmail) {
    throw new Error('A valid registered email address is required to send the registration OTP.');
  }
  if (!hasEmail && !hasMobile) {
    throw new Error(
      'No registered email address or mobile number is linked to this account. Contact your administrator to update your contact details.'
    );
  }

  const otpCode = String(crypto.randomInt(100000, 1000000));
  const delivery = await dispatchLoginOtp({
    fullName: user.fullName,
    loginIdentifier: user.username,
    email: hasEmail ? cleanEmail : null,
    mobile: hasMobile ? cleanMobile : null,
    otp: otpCode,
    purpose,
  });

  const maskedEmailValue = hasEmail ? maskEmail(cleanEmail) || cleanEmail : null;
  const maskedMobileValue = hasMobile ? maskMobile(cleanMobile) : null;
  const expiresAt = new Date(Date.now() + OTP_TTL_SECONDS * 1000);

  const challenge = await createOtpChallengeRecord({
    userId: user.id,
    purpose,
    codeHash: hashOtpCode(otpCode),
    channels: delivery.channels.join(','),
    maskedEmail: maskedEmailValue,
    maskedMobile: maskedMobileValue,
    deliverySummary: delivery.notice,
    expiresAt,
  });

  return {
    otpRequired: true,
    purpose,
    challengeId: challenge.id,
    maskedEmail: maskedEmailValue,
    maskedMobile: maskedMobileValue,
    expiresInSeconds: OTP_TTL_SECONDS,
    resendCooldownSeconds: OTP_RESEND_COOLDOWN_SECONDS,
    delivery,
  };
}

// ── PDF Attachment Disk Storage (Strict Path Confinement) ────────────────────

function ensureUploadsDir(): void {
  if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
  }
}

function sanitizeFileName(rawName: string): string {
  const base = path.basename(String(rawName || 'sanction-order.pdf'));
  const clean = base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
  if (!clean.toLowerCase().endsWith('.pdf')) {
    return `${clean || 'sanction-order'}.pdf`;
  }
  return clean;
}

function resolveUploadPath(storedFileName: string): string | null {
  const safeBase = path.basename(String(storedFileName || ''));
  if (!safeBase || safeBase !== storedFileName || safeBase.includes('..')) {
    return null;
  }
  const resolved = path.resolve(UPLOADS_DIR, safeBase);
  if (!resolved.startsWith(UPLOADS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function saveSanctionPdfFromBase64(
  sanctionId: string,
  base64Input: string,
  originalName: string,
  source: 'pdf-upload' | 'camera-scan'
): SanctionAttachment {
  const stripped = base64Input.includes(',') ? base64Input.split(',')[1] : base64Input;
  const buffer = Buffer.from(stripped.trim(), 'base64');

  if (buffer.length === 0) {
    throw new Error('Attached PDF file is empty.');
  }
  if (buffer.length > MAX_PDF_BYTES) {
    throw new Error('Attached PDF exceeds the 8 MB size limit.');
  }
  if (buffer.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error('Only valid PDF documents (.pdf) can be attached.');
  }

  ensureUploadsDir();
  const safeId = sanctionId.replace(/[^a-zA-Z0-9_-]/g, '');
  const storedFileName = `${safeId}-${Date.now()}.pdf`;
  const targetPath = resolveUploadPath(storedFileName);
  if (!targetPath) {
    throw new Error('Invalid attachment destination path.');
  }
  fs.writeFileSync(targetPath, buffer);

  return {
    fileName: sanitizeFileName(originalName),
    storedFileName,
    mimeType: 'application/pdf',
    sizeBytes: buffer.length,
    source: source === 'camera-scan' ? 'camera-scan' : 'pdf-upload',
    uploadedAt: new Date().toISOString(),
  };
}

function removeStoredAttachment(attachment?: SanctionAttachment): void {
  if (!attachment?.storedFileName) return;
  const fullPath = resolveUploadPath(attachment.storedFileName);
  if (!fullPath) return;
  try {
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
    }
  } catch {
    // Ignore cleanup errors
  }
}

// ── Computation & Enrichment Helpers ─────────────────────────────────────────

function netSpendForTransactions(txs: Transaction[]): number {
  let spend = 0;
  for (const t of txs) {
    if (t.type === 'expense') spend += t.amount;
    else if (t.type === 'income') spend -= t.amount;
  }
  return Math.max(0, Math.round(spend * 100) / 100);
}

function enrichBudgetHead(
  head: BudgetHead,
  allSanctions: BudgetSanction[],
  allTransactions: Transaction[]
): BudgetHeadEnriched {
  const headSanctions = allSanctions.filter(
    (s) => s.budgetHeadId === head.id && s.approvalStatus === 'approved'
  );
  const headTxs = allTransactions.filter((t) => t.budgetHeadId === head.id);
  const sanctionedTotal =
    Math.round(headSanctions.reduce((sum, s) => sum + s.sanctionAmount, 0) * 100) / 100;
  const spentTotal = netSpendForTransactions(headTxs);
  const remainingBalance = Math.round((sanctionedTotal - spentTotal) * 100) / 100;
  const utilizationPct =
    sanctionedTotal > 0 ? Math.round((spentTotal / sanctionedTotal) * 1000) / 10 : 0;

  const sortedByDate = [...headSanctions].sort((a, b) =>
    b.sanctionDate.localeCompare(a.sanctionDate)
  );

  return {
    ...head,
    sanctionedTotal,
    spentTotal,
    remainingBalance,
    utilizationPct,
    sanctionCount: headSanctions.length,
    latestFinancialYear: sortedByDate[0]?.financialYear || null,
  };
}

function enrichSanction(
  sanction: BudgetSanction,
  allHeads: BudgetHead[],
  allUsers: StoredUser[]
): BudgetSanctionEnriched {
  const head = allHeads.find((h) => h.id === sanction.budgetHeadId);
  const creator = allUsers.find((u) => u.id === sanction.createdBy);
  return {
    ...sanction,
    budgetHeadName: head?.name || 'Archived Head',
    budgetHeadColor: head?.color || '#475569',
    createdByName: creator?.fullName || 'Administrator',
  };
}

function enrichTransaction(
  tx: Transaction,
  allHeads: BudgetHead[],
  allUsers: StoredUser[]
): TransactionEnriched {
  const head = allHeads.find((h) => h.id === tx.budgetHeadId);
  const user = allUsers.find((u) => u.id === tx.userId);
  return {
    ...tx,
    budgetHeadName: head?.name || 'Archived Head',
    budgetHeadColor: head?.color || '#475569',
    userName: user?.fullName || 'Unknown User',
    userDepartment: user?.department || 'General',
  };
}

function buildAnalytics(
  user: StoredUser,
  allUsers: StoredUser[],
  allHeads: BudgetHead[],
  allSanctions: BudgetSanction[],
  allTransactions: Transaction[],
  rangeDays?: number,
  financialYear?: string
): AnalyticsSummary {
  const isAdmin = user.role === 'admin';
  const fyFilter = financialYear && financialYear !== 'all' ? financialYear : '';
  const approvedSanctions = allSanctions.filter((s) => s.approvalStatus === 'approved');

  const fySet = new Set<string>();
  approvedSanctions.forEach((s) => fySet.add(s.financialYear));
  allTransactions.forEach((t) => fySet.add(t.financialYear || computeFinancialYear(t.date)));
  const availableFinancialYears = Array.from(fySet).sort().reverse();

  const relevantSanctions = fyFilter
    ? approvedSanctions.filter((s) => s.financialYear === fyFilter)
    : approvedSanctions;

  // Standard users have full view-only visibility into all credited and debited ledger entries.
  const baseTxs = allTransactions;

  let scopedTxs = fyFilter
    ? baseTxs.filter((t) => (t.financialYear || computeFinancialYear(t.date)) === fyFilter)
    : baseTxs;

  if (rangeDays && rangeDays > 0) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - rangeDays);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    scopedTxs = scopedTxs.filter((t) => t.date >= cutoffStr);
  }

  const totalSanctioned =
    Math.round(relevantSanctions.reduce((s, item) => s + item.sanctionAmount, 0) * 100) / 100;
  const totalExpenseRaw = scopedTxs
    .filter((t) => t.type === 'expense')
    .reduce((s, t) => s + t.amount, 0);
  const totalIncome = scopedTxs
    .filter((t) => t.type === 'income')
    .reduce((s, t) => s + t.amount, 0);
  const totalSpent = Math.max(0, Math.round((totalExpenseRaw - totalIncome) * 100) / 100);
  const remainingBalance = Math.round((totalSanctioned - totalSpent) * 100) / 100;
  const utilizationPct =
    totalSanctioned > 0 ? Math.round((totalSpent / totalSanctioned) * 1000) / 10 : 0;

  const monthNames = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  const monthKeys = new Set<string>([
    '2026-06',
    '2026-07',
    '2026-08',
    '2026-09',
    '2026-10',
    '2026-11',
  ]);
  for (const t of scopedTxs) {
    if (t.date && t.date.length >= 7) {
      monthKeys.add(t.date.slice(0, 7));
    }
  }
  const sortedMonths = Array.from(monthKeys).sort();
  const monthlyPace = Math.round((totalSanctioned / Math.max(sortedMonths.length, 1)) * 100) / 100;

  const monthlySeries = sortedMonths.map((mk) => {
    const [yr, mo] = mk.split('-');
    const label = `${monthNames[Math.max(0, Number(mo) - 1)]} ${yr}`;
    const monthTxs = scopedTxs.filter((t) => t.date.startsWith(mk));
    const expense = monthTxs
      .filter((t) => t.type === 'expense')
      .reduce((s, t) => s + t.amount, 0);
    const income = monthTxs
      .filter((t) => t.type === 'income')
      .reduce((s, t) => s + t.amount, 0);
    return {
      month: label,
      monthKey: mk,
      expense: Math.round(expense * 100) / 100,
      income: Math.round(income * 100) / 100,
      sanctionPace: monthlyPace,
    };
  });

  const shareMap = new Map<string, { name: string; amount: number; color: string; count: number }>();
  for (const t of scopedTxs) {
    if (t.type !== 'expense') continue;
    const head = allHeads.find((h) => h.id === t.budgetHeadId);
    const key = head?.id || 'other';
    const existing = shareMap.get(key) || {
      name: head?.name || 'Other',
      amount: 0,
      color: head?.color || '#475569',
      count: 0,
    };
    existing.amount += t.amount;
    existing.count += 1;
    shareMap.set(key, existing);
  }
  const totalShareAmount = Array.from(shareMap.values()).reduce((s, v) => s + v.amount, 0);
  const headShareBreakdown = Array.from(shareMap.entries())
    .map(([id, info]) => ({
      id,
      name: info.name,
      amount: Math.round(info.amount * 100) / 100,
      sharePct:
        totalShareAmount > 0 ? Math.round((info.amount / totalShareAmount) * 1000) / 10 : 0,
      color: info.color,
      count: info.count,
    }))
    .sort((a, b) => b.amount - a.amount);

  const headComparison = allHeads
    .map((h) => {
      const sanctioned = relevantSanctions
        .filter((s) => s.budgetHeadId === h.id)
        .reduce((sum, s) => sum + s.sanctionAmount, 0);
      const txs = scopedTxs.filter((t) => t.budgetHeadId === h.id);
      const spent = netSpendForTransactions(txs);
      const remaining = Math.round((sanctioned - spent) * 100) / 100;
      return {
        id: h.id,
        name: h.name,
        color: h.color,
        sanctioned: Math.round(sanctioned * 100) / 100,
        spent,
        remaining,
        utilizationPct: sanctioned > 0 ? Math.round((spent / sanctioned) * 1000) / 10 : 0,
      };
    })
    .filter((item) => item.sanctioned > 0 || item.spent > 0)
    .sort((a, b) => b.sanctioned - a.sanctioned);

  const financialYearBreakdown = availableFinancialYears.map((fy) => {
    const fySanctions = approvedSanctions.filter((s) => s.financialYear === fy);
    const fyTxs = baseTxs.filter((t) => (t.financialYear || computeFinancialYear(t.date)) === fy);
    const sanctioned =
      Math.round(fySanctions.reduce((s, x) => s + x.sanctionAmount, 0) * 100) / 100;
    const spent = netSpendForTransactions(fyTxs);
    return {
      financialYear: fy,
      sanctioned,
      spent,
      utilizationPct: sanctioned > 0 ? Math.round((spent / sanctioned) * 1000) / 10 : 0,
      sanctionCount: fySanctions.length,
    };
  });

  const departmentBreakdown = isAdmin
    ? allUsers
        .map((u) => {
          const uTxs = scopedTxs.filter((t) => t.userId === u.id);
          return {
            userId: u.id,
            userName: u.fullName,
            department: u.department,
            spent: netSpendForTransactions(uTxs),
            transactionCount: uTxs.length,
          };
        })
        .filter((d) => d.spent > 0 || d.transactionCount > 0)
        .sort((a, b) => b.spent - a.spent)
    : [];

  const pmMap = new Map<string, { amount: number; count: number }>();
  for (const t of scopedTxs) {
    if (t.type !== 'expense') continue;
    const prev = pmMap.get(t.paymentMethod) || { amount: 0, count: 0 };
    prev.amount += t.amount;
    prev.count += 1;
    pmMap.set(t.paymentMethod, prev);
  }
  const paymentMethodBreakdown = Array.from(pmMap.entries())
    .map(([method, info]) => ({
      method,
      amount: Math.round(info.amount * 100) / 100,
      count: info.count,
    }))
    .sort((a, b) => b.amount - a.amount);

  const alerts: AnalyticsSummary['alerts'] = headComparison
    .filter((h) => h.sanctioned > 0 && h.utilizationPct >= 75)
    .map((h) => ({
      id: h.id,
      label: h.name,
      context: fyFilter || 'All Financial Years',
      utilizationPct: h.utilizationPct,
      spent: h.spent,
      limit: h.sanctioned,
      severity: h.utilizationPct >= 95 ? ('critical' as const) : ('warning' as const),
    }))
    .sort((a, b) => b.utilizationPct - a.utilizationPct);

  return {
    scope: isAdmin ? 'organization' : 'personal',
    totalSanctioned,
    totalSpent,
    totalIncome: Math.round(totalIncome * 100) / 100,
    remainingBalance,
    utilizationPct,
    sanctionCount: relevantSanctions.length,
    pendingCount: scopedTxs.filter((t) => t.status === 'pending').length,
    flaggedCount: scopedTxs.filter((t) => t.status === 'flagged').length,
    transactionCount: scopedTxs.length,
    availableFinancialYears,
    monthlySeries,
    headShareBreakdown,
    headComparison,
    financialYearBreakdown,
    departmentBreakdown,
    paymentMethodBreakdown,
    alerts,
  };
}

// ── Express Application & Auth Middleware ────────────────────────────────────

const app = express();
app.use(express.json({ limit: '25mb' }));

// Allow bundled Android APK WebView (https://appassets.androidplatform.net) to talk live to Cloud SQL APIs
const ALLOWED_MOBILE_ORIGINS = new Set([
  'https://appassets.androidplatform.net',
  'http://localhost',
  'https://localhost',
  'capacitor://localhost',
]);

app.use((req: Request, res: Response, next: NextFunction) => {
  const origin = req.headers.origin;
  if (origin && ALLOWED_MOBILE_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Expose-Headers', 'X-Refreshed-Token, Content-Disposition');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
  }
  next();
});

app.get('/api/health', (_req: Request, res: Response) => {
  res.json({ ok: true, service: 'ledgerflow', database: databaseMode });
});

async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  try {
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
    const cookies = parseCookies(req);
    const cookieToken = cookies[SESSION_COOKIE_NAME] || '';

    // 1. Prefer HttpOnly session cookie (has sliding lastActivity), or Bearer custom JWT
    const customCandidate = cookieToken || bearerToken;
    const decoded = customCandidate ? verifyToken(customCandidate) : null;
    if (decoded) {
      const idleMs = Date.now() - decoded.lastActivity;
      if (idleMs > INACTIVITY_TIMEOUT_MS) {
        clearSessionCookie(req, res);
        res.status(401).json({
          error: 'Session expired due to 5 minutes of inactivity. Please sign in again.',
        });
        return;
      }

      const found = await findUserById(decoded.userId);
      if (!found) {
        clearSessionCookie(req, res);
        res.status(401).json({ error: 'Account no longer exists. Please sign in again.' });
        return;
      }

      const access = evaluateUserAccess(found);
      if (!access.allowed) {
        clearSessionCookie(req, res);
        res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
        return;
      }

      req.user = found;
      req.sessionLoginAt = decoded.loginAt;
      req.sessionLastActivity = decoded.lastActivity;

      // Refresh sliding inactivity cookie & Bearer token periodically on authenticated requests
      if (idleMs > 15_000 || !cookieToken) {
        const refreshed = issueUserSession(req, res, found, decoded.loginAt);
        req.sessionLastActivity = refreshed.lastActivity;
        res.setHeader('X-Refreshed-Token', refreshed.token);
      }
      next();
      return;
    }

    if (!bearerToken) {
      res.status(401).json({ error: 'Authentication required. Please sign in.' });
      return;
    }

    // 2. Fallback to Firebase Auth ID Token (Google Sign-In)
    try {
      const fbDecoded = await adminAuth.verifyIdToken(bearerToken);
      const syncedUser = await upsertFirebaseUser({
        uid: fbDecoded.uid,
        email: fbDecoded.email,
        displayName: fbDecoded.name,
        photoURL: fbDecoded.picture,
      });
      const access = evaluateUserAccess(syncedUser);
      if (!access.allowed) {
        clearSessionCookie(req, res);
        res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
        return;
      }
      const session = issueUserSession(req, res, syncedUser);
      req.user = syncedUser;
      req.sessionLoginAt = session.loginAt;
      req.sessionLastActivity = session.lastActivity;
      next();
      return;
    } catch {
      res.status(401).json({ error: 'Session expired or invalid. Please sign in again.' });
      return;
    }
  } catch (err) {
    console.error('Authentication middleware error:', err);
    res.status(500).json({ error: 'Unable to verify session right now. Please try again.' });
  }
}

function requireAdmin(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  if (!req.user || req.user.role !== 'admin') {
    res.status(403).json({ error: 'Administrator privileges are required for this action.' });
    return;
  }
  next();
}

// ── Auth Routes (Password + OTP, Direct Mobile/Email OTP, Google Sign-In) ────

app.post('/api/auth/login', async (req: Request, res: Response) => {
  try {
    const identifier = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');

    if (!identifier || !password) {
      res.status(400).json({ error: 'Username and password are required.' });
      return;
    }

    const user = await findUserByIdentifier(identifier);
    if (!user || !verifyPassword(password, user.passwordHash, user.passwordSalt)) {
      res.status(401).json({ error: 'Invalid username or password.' });
      return;
    }

    const access = evaluateUserAccess(user);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
      return;
    }

    const challenge = await issueOtpChallengeForUser(user, 'login');
    res.json(challenge);
  } catch (err) {
    console.error('POST /api/auth/login error:', err);
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to initiate OTP login.',
    });
  }
});

app.post('/api/auth/otp/request', async (req: Request, res: Response) => {
  try {
    const identifier = String(req.body?.identifier || '').trim();
    if (!identifier) {
      res.status(400).json({ error: 'Enter your registered mobile number, email, or username.' });
      return;
    }

    const user = await findUserByIdentifier(identifier);
    if (!user) {
      res.status(404).json({
        error: 'No account found matching that registered mobile number, email, or username.',
      });
      return;
    }

    const access = evaluateUserAccess(user);
    if (!access.allowed) {
      res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
      return;
    }

    const latest = await getLatestOtpChallengeForUser(user.id);
    if (latest && !latest.consumedAt) {
      const elapsedSec = Math.floor((Date.now() - latest.createdAt.getTime()) / 1000);
      if (elapsedSec < OTP_RESEND_COOLDOWN_SECONDS) {
        const waitSec = OTP_RESEND_COOLDOWN_SECONDS - elapsedSec;
        res.status(429).json({
          error: `Please wait ${waitSec}s before requesting a new OTP.`,
        });
        return;
      }
    }

    const challenge = await issueOtpChallengeForUser(user, 'direct-otp');
    res.json(challenge);
  } catch (err) {
    console.error('POST /api/auth/otp/request error:', err);
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to send OTP right now.',
    });
  }
});

app.post('/api/auth/otp/resend', async (req: Request, res: Response) => {
  try {
    const challengeId = String(req.body?.challengeId || '').trim();
    if (!challengeId) {
      res.status(400).json({ error: 'Verification session is required.' });
      return;
    }

    const existing = await getOtpChallengeById(challengeId);
    if (!existing) {
      res.status(404).json({ error: 'Verification session not found. Please start sign in again.' });
      return;
    }

    const elapsedSec = Math.floor((Date.now() - existing.createdAt.getTime()) / 1000);
    if (elapsedSec < OTP_RESEND_COOLDOWN_SECONDS) {
      const waitSec = OTP_RESEND_COOLDOWN_SECONDS - elapsedSec;
      res.status(429).json({ error: `Please wait ${waitSec}s before resending OTP.` });
      return;
    }

    const user = await findUserById(existing.userId);
    if (!user) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    const nextPurpose: OtpPurpose =
      existing.purpose === 'register'
        ? 'register'
        : existing.purpose === 'direct-otp'
          ? 'direct-otp'
          : 'login';

    if (nextPurpose !== 'register') {
      const access = evaluateUserAccess(user);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
        return;
      }
    }

    const nextChallenge = await issueOtpChallengeForUser(user, nextPurpose);
    res.json(nextChallenge);
  } catch (err) {
    console.error('POST /api/auth/otp/resend error:', err);
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Unable to resend OTP.',
    });
  }
});

app.post('/api/auth/otp/verify', async (req: Request, res: Response) => {
  try {
    const challengeId = String(req.body?.challengeId || '').trim();
    const otp = String(req.body?.otp || '').trim().replace(/\s+/g, '');

    if (!challengeId || !/^\d{6}$/.test(otp)) {
      res.status(400).json({ error: 'Enter the 6-digit OTP sent to your registered email.' });
      return;
    }

    const challenge = await getOtpChallengeById(challengeId);
    if (!challenge) {
      res.status(404).json({ error: 'Verification session expired. Please request a new OTP.' });
      return;
    }

    if (challenge.consumedAt) {
      res.status(400).json({ error: 'This OTP has already been used. Please request a new OTP.' });
      return;
    }

    if (Date.now() > challenge.expiresAt.getTime()) {
      res.status(401).json({ error: 'This OTP has expired. Request a fresh OTP to continue.' });
      return;
    }

    if (challenge.attempts >= challenge.maxAttempts) {
      res.status(429).json({
        error: 'Too many invalid OTP attempts. Please request a new verification code.',
      });
      return;
    }

    if (!verifyOtpHash(otp, challenge.codeHash)) {
      const nextAttempts = challenge.attempts + 1;
      await incrementOtpAttempts(challenge.id, nextAttempts);
      const remaining = Math.max(0, challenge.maxAttempts - nextAttempts);
      res.status(401).json({
        error:
          remaining > 0
            ? `Incorrect OTP. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`
            : 'Too many invalid OTP attempts. Please request a new OTP.',
      });
      return;
    }

    const user = await findUserById(challenge.userId);
    if (!user) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    if (challenge.purpose === 'register') {
      await consumeOtpChallenge(challenge.id);
      const access = evaluateUserAccess(user);
      if (!access.allowed) {
        res.json({
          pendingApproval: true,
          emailVerified: true,
          message:
            'Your registered email has been verified. Your account is pending administrator approval — you will be able to sign in once an administrator approves your account.',
          user: toSafeUser(user),
        });
        return;
      }
    } else {
      const access = evaluateUserAccess(user);
      if (!access.allowed) {
        res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
        return;
      }
      await consumeOtpChallenge(challenge.id);
    }

    const session = issueUserSession(req, res, user);
    res.json({ token: session.token, user: toSafeUser(user), loginAt: session.loginAt });
  } catch (err) {
    console.error('POST /api/auth/otp/verify error:', err);
    res.status(500).json({ error: 'Unable to verify OTP right now. Please try again.' });
  }
});

app.post('/api/auth/register', async (req: Request, res: Response) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim();
    const department = String(req.body?.department || '').trim() || 'General';
    const email = normalizeEmail(String(req.body?.email || ''));
    const mobile = normalizeMobile(String(req.body?.mobile || ''));

    if (!/^[a-z0-9._@+-]{3,64}$/.test(username)) {
      res.status(400).json({
        error: 'Username or email ID must be 3–64 valid characters.',
      });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Password must be at least 6 characters long.' });
      return;
    }
    if (fullName.length < 2) {
      res.status(400).json({ error: 'Full name is required.' });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'Enter a valid email address to receive your verification OTP.' });
      return;
    }
    if (!isValidMobile(mobile)) {
      res.status(400).json({
        error: 'Enter a valid 10-digit mobile number (or with country code).',
      });
      return;
    }

    const existingUsername = await findUserByUsername(username);
    if (existingUsername) {
      res.status(409).json({ error: 'That username is already registered.' });
      return;
    }

    const existingContact = (await findUserByIdentifier(email)) || (await findUserByIdentifier(mobile));
    if (existingContact) {
      res.status(409).json({
        error: 'An account is already registered with that email address or mobile number.',
      });
      return;
    }

    const pw = hashPassword(password);
    // Self-registered accounts are always created as standard users pending admin approval.
    const newUser = await createUserRecord({
      username,
      fullName,
      department,
      email,
      mobile,
      role: 'user',
      active: false,
      passwordHash: pw.hash,
      passwordSalt: pw.salt,
    });

    let challenge: OtpChallengeResponse;
    try {
      challenge = await issueOtpChallengeForUser(newUser, 'register');
    } catch (otpErr) {
      await deleteUserRecord(newUser.id).catch(() => {});
      res.status(400).json({
        error:
          otpErr instanceof Error
            ? otpErr.message
            : 'Unable to send verification OTP email right now.',
      });
      return;
    }
    res.status(201).json(challenge);
  } catch (err) {
    console.error('POST /api/auth/register error:', err);
    res.status(500).json({ error: 'Unable to create account right now.' });
  }
});

app.post('/api/auth/google', async (req: Request, res: Response) => {
  try {
    const idToken = String(req.body?.idToken || '').trim();
    if (!idToken) {
      res.status(400).json({ error: 'Google authentication token is required.' });
      return;
    }
    const decoded = await adminAuth.verifyIdToken(idToken);
    const syncedUser = await upsertFirebaseUser({
      uid: decoded.uid,
      email: decoded.email,
      displayName: decoded.name,
      photoURL: decoded.picture,
    });
    const access = evaluateUserAccess(syncedUser);
    if (!access.allowed) {
      clearSessionCookie(req, res);
      res.status(403).json({ error: access.reason || PENDING_APPROVAL_MESSAGE });
      return;
    }
    const session = issueUserSession(req, res, syncedUser);
    res.json({ user: toSafeUser(syncedUser), loginAt: session.loginAt });
  } catch (err) {
    console.error('POST /api/auth/google error:', err);
    res.status(401).json({ error: 'Unable to verify Google Sign-In session.' });
  }
});

app.get('/api/auth/me', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  res.json({ user: toSafeUser(req.user!), loginAt: req.sessionLoginAt });
});

app.post('/api/auth/ping', requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const session = issueUserSession(req, res, req.user!, req.sessionLoginAt);
  res.json({ ok: true, loginAt: session.loginAt, lastActivity: session.lastActivity });
});

app.post('/api/auth/logout', (req: Request, res: Response) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// ── Users Management (Admin) ─────────────────────────────────────────────────

app.get('/api/users', requireAuth, requireAdmin, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [allUsers, allTransactions] = await Promise.all([listUsers(), listTransactions()]);
    const list = allUsers.map((u) => {
      const safe = toSafeUser(u);
      const uTxs = allTransactions.filter((t) => t.userId === u.id);
      return {
        ...safe,
        spentTotal: netSpendForTransactions(uTxs),
        transactionCount: uTxs.length,
      };
    });
    res.json({ users: list });
  } catch (err) {
    console.error('GET /api/users error:', err);
    res.status(500).json({ error: 'Unable to load user accounts.' });
  }
});

app.post('/api/users', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const username = String(req.body?.username || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const fullName = String(req.body?.fullName || '').trim();
    const department = String(req.body?.department || 'Operations').trim();
    const email = normalizeEmail(String(req.body?.email || ''));
    const mobile = normalizeMobile(String(req.body?.mobile || ''));
    const role: UserRole = req.body?.role === 'admin' ? 'admin' : 'user';

    if (!/^[a-z0-9._@+-]{3,64}$/.test(username)) {
      res
        .status(400)
        .json({ error: 'Username or email ID must be 3–64 valid characters.' });
      return;
    }
    if (password.length < 6) {
      res.status(400).json({ error: 'Initial password must be at least 6 characters.' });
      return;
    }
    if (!fullName) {
      res.status(400).json({ error: 'Full name is required.' });
      return;
    }
    if (!isValidEmail(email)) {
      res.status(400).json({ error: 'A valid registered email address is required for OTP login.' });
      return;
    }
    if (!isValidMobile(mobile)) {
      res.status(400).json({ error: 'A valid registered mobile number is required for OTP login.' });
      return;
    }

    const existing = await findUserByUsername(username);
    if (existing) {
      res.status(409).json({ error: 'Username already exists.' });
      return;
    }

    const pw = hashPassword(password);
    const newUser = await createUserRecord({
      username,
      fullName,
      department,
      email,
      mobile,
      role,
      passwordHash: pw.hash,
      passwordSalt: pw.salt,
    });
    res.status(201).json({ user: toSafeUser(newUser) });
  } catch (err) {
    console.error('POST /api/users error:', err);
    res.status(500).json({ error: 'Unable to create user account.' });
  }
});

app.patch('/api/users/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    if (target.id === req.user!.id && req.body?.active === false) {
      res.status(400).json({ error: 'You cannot deactivate your own active admin account.' });
      return;
    }
    if (target.id === req.user!.id && req.body?.role === 'user') {
      res.status(400).json({ error: 'You cannot demote your own admin role.' });
      return;
    }

    const updates: Parameters<typeof updateUserRecord>[1] = {};
    if (typeof req.body?.fullName === 'string' && req.body.fullName.trim()) {
      updates.fullName = req.body.fullName.trim();
    }
    if (typeof req.body?.department === 'string' && req.body.department.trim()) {
      updates.department = req.body.department.trim();
    }
    if (typeof req.body?.email === 'string') {
      const nextEmail = normalizeEmail(req.body.email);
      if (nextEmail && !isValidEmail(nextEmail)) {
        res.status(400).json({ error: 'Please provide a valid email address.' });
        return;
      }
      updates.email = nextEmail;
    }
    if (typeof req.body?.mobile === 'string') {
      const nextMobile = normalizeMobile(req.body.mobile);
      if (nextMobile && !isValidMobile(nextMobile)) {
        res.status(400).json({ error: 'Please provide a valid 10-digit or E.164 mobile number.' });
        return;
      }
      updates.mobile = nextMobile;
    }
    if (req.body?.role === 'admin' || req.body?.role === 'user') {
      updates.role = req.body.role;
    }
    if (typeof req.body?.active === 'boolean') {
      updates.active = req.body.active;
    }

    const activeFromParsed = parseOptionalTimestampInput(req.body?.activeFrom);
    const activeUntilParsed = parseOptionalTimestampInput(req.body?.activeUntil);
    const deactivatedFromParsed = parseOptionalTimestampInput(req.body?.deactivatedFrom);
    const deactivatedUntilParsed = parseOptionalTimestampInput(req.body?.deactivatedUntil);

    for (const check of [activeFromParsed, activeUntilParsed, deactivatedFromParsed, deactivatedUntilParsed]) {
      if (check.error) {
        res.status(400).json({ error: check.error });
        return;
      }
    }

    if (
      target.id === req.user!.id &&
      (deactivatedFromParsed.value || deactivatedUntilParsed.value || activeUntilParsed.value)
    ) {
      res.status(400).json({ error: 'You cannot schedule deactivation on your own admin account.' });
      return;
    }

    if (activeFromParsed.provided) updates.activeFrom = activeFromParsed.value;
    if (activeUntilParsed.provided) updates.activeUntil = activeUntilParsed.value;
    if (deactivatedFromParsed.provided) updates.deactivatedFrom = deactivatedFromParsed.value;
    if (deactivatedUntilParsed.provided) updates.deactivatedUntil = deactivatedUntilParsed.value;

    const effActiveFrom =
      updates.activeFrom !== undefined
        ? updates.activeFrom
        : target.activeFrom
          ? new Date(target.activeFrom)
          : null;
    const effActiveUntil =
      updates.activeUntil !== undefined
        ? updates.activeUntil
        : target.activeUntil
          ? new Date(target.activeUntil)
          : null;
    if (effActiveFrom && effActiveUntil && effActiveFrom.getTime() >= effActiveUntil.getTime()) {
      res.status(400).json({ error: 'Active "From" time must be earlier than "Until" time.' });
      return;
    }

    const effDeactFrom =
      updates.deactivatedFrom !== undefined
        ? updates.deactivatedFrom
        : target.deactivatedFrom
          ? new Date(target.deactivatedFrom)
          : null;
    const effDeactUntil =
      updates.deactivatedUntil !== undefined
        ? updates.deactivatedUntil
        : target.deactivatedUntil
          ? new Date(target.deactivatedUntil)
          : null;
    if (effDeactFrom && effDeactUntil && effDeactFrom.getTime() >= effDeactUntil.getTime()) {
      res.status(400).json({ error: 'Deactivation "From" time must be earlier than "Until" time.' });
      return;
    }

    if (typeof req.body?.password === 'string' && req.body.password.length >= 6) {
      const pw = hashPassword(req.body.password);
      updates.passwordHash = pw.hash;
      updates.passwordSalt = pw.salt;
    }

    const updated = await updateUserRecord(target.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }
    res.json({ user: toSafeUser(updated) });
  } catch (err) {
    console.error('PATCH /api/users/:id error:', err);
    res.status(500).json({ error: 'Unable to update user account.' });
  }
});

app.delete('/api/users/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const target = await findUserById(req.params.id);
    if (!target) {
      res.status(404).json({ error: 'User account not found.' });
      return;
    }
    if (target.id === req.user!.id) {
      res.status(400).json({ error: 'You cannot delete your own active admin account.' });
      return;
    }
    await deleteUserRecord(target.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/users/:id error:', err);
    res.status(500).json({ error: 'Unable to delete user account.' });
  }
});

// ── Budget Heads Routes (Name, Color, Description only) ──────────────────────

app.get('/api/budget-heads', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [allHeads, allSanctions, allTransactions] = await Promise.all([
      listBudgetHeads(),
      listSanctions(),
      listTransactions(),
    ]);
    const enriched = allHeads.map((h) => enrichBudgetHead(h, allSanctions, allTransactions));
    res.json({ budgetHeads: enriched });
  } catch (err) {
    console.error('GET /api/budget-heads error:', err);
    res.status(500).json({ error: 'Unable to load budget heads.' });
  }
});

app.post('/api/budget-heads', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const name = String(req.body?.name || '').trim();
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(req.body?.color || ''))
      ? String(req.body.color)
      : '#0F766E';
    const description = String(req.body?.description || '').trim();

    if (!name) {
      res.status(400).json({ error: 'Budget head name is required.' });
      return;
    }

    const existingHeads = await listBudgetHeads();
    if (existingHeads.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
      res.status(409).json({ error: `A budget head named "${name}" already exists.` });
      return;
    }

    const head = await createBudgetHeadRecord({
      name,
      color,
      description,
      createdBy: req.user!.id,
    });

    res.status(201).json({ budgetHead: enrichBudgetHead(head, [], []) });
  } catch (err) {
    console.error('POST /api/budget-heads error:', err);
    res.status(500).json({ error: 'Unable to create budget head.' });
  }
});

app.patch('/api/budget-heads/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [head, allHeads, allSanctions, allTransactions] = await Promise.all([
      findBudgetHeadById(req.params.id),
      listBudgetHeads(),
      listSanctions(),
      listTransactions(),
    ]);
    if (!head) {
      res.status(404).json({ error: 'Budget head not found.' });
      return;
    }

    const updates: Partial<{ name: string; color: string; description: string }> = {};
    if (typeof req.body?.name === 'string' && req.body.name.trim()) {
      const nextName = req.body.name.trim();
      if (allHeads.some((h) => h.id !== head.id && h.name.toLowerCase() === nextName.toLowerCase())) {
        res.status(409).json({ error: `Budget head "${nextName}" already exists.` });
        return;
      }
      updates.name = nextName;
    }
    if (typeof req.body?.color === 'string' && /^#[0-9A-Fa-f]{6}$/.test(req.body.color)) {
      updates.color = req.body.color;
    }
    if (typeof req.body?.description === 'string') {
      updates.description = req.body.description.trim();
    }

    const updated = await updateBudgetHeadRecord(head.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Budget head not found.' });
      return;
    }
    res.json({ budgetHead: enrichBudgetHead(updated, allSanctions, allTransactions) });
  } catch (err) {
    console.error('PATCH /api/budget-heads/:id error:', err);
    res.status(500).json({ error: 'Unable to update budget head.' });
  }
});

app.delete('/api/budget-heads/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [head, allSanctions, allTransactions] = await Promise.all([
      findBudgetHeadById(req.params.id),
      listSanctions(),
      listTransactions(),
    ]);
    if (!head) {
      res.status(404).json({ error: 'Budget head not found.' });
      return;
    }
    const hasTxs = allTransactions.some((t) => t.budgetHeadId === head.id);
    if (hasTxs) {
      res.status(400).json({
        error:
          'Cannot delete a budget head that has recorded transactions. Remove or reassign transactions first.',
      });
      return;
    }
    const relatedSanctions = allSanctions.filter((s) => s.budgetHeadId === head.id);
    relatedSanctions.forEach((s) => removeStoredAttachment(s.attachment));
    await deleteBudgetHeadRecord(head.id);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/budget-heads/:id error:', err);
    res.status(500).json({ error: 'Unable to delete budget head.' });
  }
});

app.post(
  '/api/budget-heads/bulk-delete',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? Array.from(new Set(req.body.ids.map((x: unknown) => String(x || '').trim()).filter(Boolean)))
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'Select at least one budget head to delete.' });
        return;
      }

      const [allHeads, allSanctions, allTransactions] = await Promise.all([
        listBudgetHeads(),
        listSanctions(),
        listTransactions(),
      ]);

      let deletedCount = 0;
      let skippedCount = 0;
      const errors: string[] = [];

      for (const id of ids) {
        const head = allHeads.find((h) => h.id === id);
        if (!head) continue;
        const hasTxs = allTransactions.some((t) => t.budgetHeadId === head.id);
        if (hasTxs) {
          skippedCount += 1;
          errors.push(`"${head.name}" has recorded transactions and cannot be deleted.`);
          continue;
        }
        const relatedSanctions = allSanctions.filter((s) => s.budgetHeadId === head.id);
        relatedSanctions.forEach((s) => removeStoredAttachment(s.attachment));
        await deleteBudgetHeadRecord(head.id);
        deletedCount += 1;
      }

      res.json({ deletedCount, skippedCount, errors });
    } catch (err) {
      console.error('POST /api/budget-heads/bulk-delete error:', err);
      res.status(500).json({ error: 'Unable to delete selected budget heads.' });
    }
  }
);

// ── Budget Sanctions Routes (with auto Financial Year, Approval Gate & PDF Attachments) ──

app.get('/api/sanctions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [allSanctions, allHeads, allUsers] = await Promise.all([
      listSanctions(),
      listBudgetHeads(),
      listUsers(),
    ]);
    const isAdmin = req.user!.role === 'admin';
    const visible = isAdmin
      ? allSanctions
      : allSanctions.filter(
          (s) => s.approvalStatus === 'approved' || s.createdBy === req.user!.id
        );
    res.json({ sanctions: visible.map((s) => enrichSanction(s, allHeads, allUsers)) });
  } catch (err) {
    console.error('GET /api/sanctions error:', err);
    res.status(500).json({ error: 'Unable to load budget sanctions.' });
  }
});

app.post('/api/sanctions', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const isAdmin = req.user!.role === 'admin';
    const budgetHeadId = String(req.body?.budgetHeadId || '');
    const sanctionAmount = Number(req.body?.sanctionAmount);
    const rawDate = String(req.body?.sanctionDate || '').trim().slice(0, 10);
    const sanctionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().slice(0, 10);
    const financialYear = computeFinancialYear(sanctionDate);
    const sanctionOrderNo =
      String(req.body?.sanctionOrderNo || '').trim() ||
      `SO/${financialYear.replace('FY ', '')}/${crypto.randomInt(100, 1000)}`;
    const sanctionedBy = String(req.body?.sanctionedBy || 'Technical Director RISL').trim();
    const notes = String(req.body?.notes || '').trim();

    const [head, allHeads, allUsers] = await Promise.all([
      findBudgetHeadById(budgetHeadId),
      listBudgetHeads(),
      listUsers(),
    ]);
    if (!head) {
      res.status(404).json({ error: 'Selected budget head does not exist.' });
      return;
    }
    if (!Number.isFinite(sanctionAmount) || sanctionAmount <= 0) {
      res.status(400).json({ error: 'Sanction amount must be greater than ₹0.' });
      return;
    }

    const sanctionId = `sanc-${crypto.randomUUID().slice(0, 8)}`;
    let attachment: SanctionAttachment | undefined;
    if (typeof req.body?.attachmentBase64 === 'string' && req.body.attachmentBase64.trim()) {
      try {
        attachment = saveSanctionPdfFromBase64(
          sanctionId,
          req.body.attachmentBase64,
          String(req.body?.attachmentName || `${sanctionOrderNo}.pdf`),
          req.body?.attachmentSource === 'camera-scan' ? 'camera-scan' : 'pdf-upload'
        );
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid PDF attachment.' });
        return;
      }
    }

    // Standard user submissions ALWAYS remain pending until approved by an administrator.
    const approvalStatus: SanctionApprovalStatus = isAdmin ? 'approved' : 'pending';

    const sanction = await createSanctionRecord({
      id: sanctionId,
      budgetHeadId,
      sanctionAmount: Math.round(sanctionAmount * 100) / 100,
      sanctionDate,
      financialYear,
      sanctionOrderNo,
      sanctionedBy: sanctionedBy || 'Technical Director RISL',
      notes,
      attachment,
      approvalStatus,
      approvedBy: isAdmin ? req.user!.id : null,
      approvedAt: isAdmin ? new Date() : null,
      createdBy: req.user!.id,
    });

    res.status(201).json({ sanction: enrichSanction(sanction, allHeads, allUsers) });
  } catch (err) {
    console.error('POST /api/sanctions error:', err);
    res.status(500).json({ error: 'Unable to save budget sanction.' });
  }
});

app.patch('/api/sanctions/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [sanction, allHeads, allUsers] = await Promise.all([
      findSanctionById(req.params.id),
      listBudgetHeads(),
      listUsers(),
    ]);
    if (!sanction) {
      res.status(404).json({ error: 'Budget sanction not found.' });
      return;
    }

    const updates: Parameters<typeof updateSanctionRecord>[1] = {};

    if (typeof req.body?.budgetHeadId === 'string' && req.body.budgetHeadId) {
      const head = allHeads.find((h) => h.id === req.body.budgetHeadId);
      if (!head) {
        res.status(404).json({ error: 'Selected budget head does not exist.' });
        return;
      }
      updates.budgetHeadId = head.id;
    }

    if (req.body?.sanctionAmount !== undefined) {
      const amt = Number(req.body.sanctionAmount);
      if (!Number.isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: 'Sanction amount must be greater than ₹0.' });
        return;
      }
      updates.sanctionAmount = Math.round(amt * 100) / 100;
    }

    if (
      typeof req.body?.sanctionDate === 'string' &&
      /^\d{4}-\d{2}-\d{2}$/.test(req.body.sanctionDate.slice(0, 10))
    ) {
      const nextDate = req.body.sanctionDate.slice(0, 10);
      updates.sanctionDate = nextDate;
      updates.financialYear = computeFinancialYear(nextDate);
    }

    if (typeof req.body?.sanctionOrderNo === 'string' && req.body.sanctionOrderNo.trim()) {
      updates.sanctionOrderNo = req.body.sanctionOrderNo.trim();
    }
    if (typeof req.body?.sanctionedBy === 'string' && req.body.sanctionedBy.trim()) {
      updates.sanctionedBy = req.body.sanctionedBy.trim();
    }
    if (typeof req.body?.notes === 'string') {
      updates.notes = req.body.notes.trim();
    }
    if (
      req.body?.approvalStatus === 'approved' ||
      req.body?.approvalStatus === 'pending' ||
      req.body?.approvalStatus === 'rejected'
    ) {
      updates.approvalStatus = req.body.approvalStatus as SanctionApprovalStatus;
      if (req.body.approvalStatus === 'approved') {
        updates.approvedBy = req.user!.id;
        updates.approvedAt = new Date();
      } else {
        updates.approvedBy = null;
        updates.approvedAt = null;
      }
    }

    if (req.body?.removeAttachment === true) {
      removeStoredAttachment(sanction.attachment);
      updates.clearAttachment = true;
    }

    if (typeof req.body?.attachmentBase64 === 'string' && req.body.attachmentBase64.trim()) {
      try {
        const nextAttachment = saveSanctionPdfFromBase64(
          sanction.id,
          req.body.attachmentBase64,
          String(req.body?.attachmentName || `${updates.sanctionOrderNo || sanction.sanctionOrderNo}.pdf`),
          req.body?.attachmentSource === 'camera-scan' ? 'camera-scan' : 'pdf-upload'
        );
        removeStoredAttachment(sanction.attachment);
        updates.attachment = nextAttachment;
        updates.clearAttachment = false;
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : 'Invalid PDF attachment.' });
        return;
      }
    }

    const updated = await updateSanctionRecord(sanction.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Budget sanction not found.' });
      return;
    }
    res.json({ sanction: enrichSanction(updated, allHeads, allUsers) });
  } catch (err) {
    console.error('PATCH /api/sanctions/:id error:', err);
    res.status(500).json({ error: 'Unable to update budget sanction.' });
  }
});

app.delete('/api/sanctions/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const removed = await deleteSanctionRecord(req.params.id);
    if (!removed) {
      res.status(404).json({ error: 'Budget sanction not found.' });
      return;
    }
    removeStoredAttachment(removed.attachment);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/sanctions/:id error:', err);
    res.status(500).json({ error: 'Unable to delete budget sanction.' });
  }
});

app.post(
  '/api/sanctions/bulk-delete',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids)
        ? Array.from(
            new Set<string>(req.body.ids.map((x: unknown) => String(x || '').trim()).filter(Boolean))
          )
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'Select at least one sanction entry to delete.' });
        return;
      }

      let deletedCount = 0;
      for (const id of ids) {
        const removed = await deleteSanctionRecord(id);
        if (removed) {
          removeStoredAttachment(removed.attachment);
          deletedCount += 1;
        }
      }
      res.json({ deletedCount });
    } catch (err) {
      console.error('POST /api/sanctions/bulk-delete error:', err);
      res.status(500).json({ error: 'Unable to delete selected sanctions.' });
    }
  }
);

app.get('/api/sanctions/:id/attachment', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const sanction = await findSanctionById(req.params.id);
    if (!sanction || !sanction.attachment) {
      res.status(404).json({ error: 'No PDF attachment found for this sanction.' });
      return;
    }
    if (
      req.user!.role !== 'admin' &&
      sanction.approvalStatus !== 'approved' &&
      sanction.createdBy !== req.user!.id
    ) {
      res.status(403).json({ error: 'You do not have permission to view this attachment.' });
      return;
    }
    const fullPath = resolveUploadPath(sanction.attachment.storedFileName);
    if (!fullPath || !fs.existsSync(fullPath)) {
      res.status(404).json({ error: 'Attached PDF file is missing on server.' });
      return;
    }
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader(
      'Content-Disposition',
      `inline; filename="${sanitizeFileName(sanction.attachment.fileName)}"`
    );
    res.sendFile(fullPath);
  } catch (err) {
    console.error('GET /api/sanctions/:id/attachment error:', err);
    res.status(500).json({ error: 'Unable to load PDF attachment.' });
  }
});

// ── Transactions Routes ──────────────────────────────────────────────────────

app.get('/api/transactions', requireAuth, async (_req: AuthenticatedRequest, res: Response) => {
  try {
    const [allTransactions, allHeads, allUsers] = await Promise.all([
      listTransactions(),
      listBudgetHeads(),
      listUsers(),
    ]);

    // Standard users have full view-only access to all credited and debited ledger entries.
    res.json({ transactions: allTransactions.map((t) => enrichTransaction(t, allHeads, allUsers)) });
  } catch (err) {
    console.error('GET /api/transactions error:', err);
    res.status(500).json({ error: 'Unable to load transactions.' });
  }
});

app.post('/api/transactions', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const budgetHeadId = String(req.body?.budgetHeadId || '');
    const rawTitle = String(req.body?.title || '').trim();
    const merchant = String(req.body?.merchant || '').trim();
    const amount = Number(req.body?.amount);
    const type: TransactionType = req.body?.type === 'income' ? 'income' : 'expense';
    const paymentMethod: PaymentMethod = (
      ['Cheque', 'Corporate Card', 'Bank Transfer', 'UPI / Mobile', 'Cash Voucher', 'Direct Debit'].includes(
        req.body?.paymentMethod
      )
        ? req.body.paymentMethod
        : 'Cheque'
    ) as PaymentMethod;
    const rawDate = String(req.body?.date || new Date().toISOString().slice(0, 10)).slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate) ? rawDate : new Date().toISOString().slice(0, 10);
    const reference =
      String(req.body?.reference || '').trim() || `TX-${crypto.randomInt(10000, 100000)}`;
    const notes = String(req.body?.notes || '').trim();

    const chequeNumber = String(req.body?.chequeNumber || '').trim() || undefined;
    const rawChequeDate = String(req.body?.chequeIssueDate || '').trim().slice(0, 10);
    const chequeIssueDate = /^\d{4}-\d{2}-\d{2}$/.test(rawChequeDate) ? rawChequeDate : undefined;
    const sanctionNumber = String(req.body?.sanctionNumber || '').trim() || undefined;
    const rawSanctionDate = String(req.body?.sanctionDate || '').trim().slice(0, 10);
    const sanctionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawSanctionDate) ? rawSanctionDate : undefined;
    const paymentSanctionedByHod = String(req.body?.paymentSanctionedByHod || '').trim() || undefined;

    const [head, allHeads, allUsers] = await Promise.all([
      findBudgetHeadById(budgetHeadId),
      listBudgetHeads(),
      listUsers(),
    ]);
    if (!head) {
      res.status(404).json({ error: 'Selected budget head does not exist.' });
      return;
    }

    const title = rawTitle || (type === 'expense' ? head.name : '');
    if (!title || !merchant) {
      res.status(400).json({ error: 'Budget head / title and merchant/vendor are required.' });
      return;
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      res.status(400).json({ error: 'Amount must be greater than ₹0.' });
      return;
    }

    const txId = `tx-${crypto.randomUUID().slice(0, 8)}`;
    let chequeAttachment: SanctionAttachment | undefined;
    let sanctionAttachment: SanctionAttachment | undefined;

    if (typeof req.body?.chequeAttachmentBase64 === 'string' && req.body.chequeAttachmentBase64.trim()) {
      try {
        chequeAttachment = saveSanctionPdfFromBase64(
          `${txId}-cheque`,
          req.body.chequeAttachmentBase64,
          String(req.body?.chequeAttachmentName || `${chequeNumber || txId}-cheque.pdf`),
          req.body?.chequeAttachmentSource === 'camera-scan' ? 'camera-scan' : 'pdf-upload'
        );
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? `Cheque PDF: ${err.message}` : 'Invalid cheque PDF attachment.',
        });
        return;
      }
    }

    if (
      typeof req.body?.sanctionAttachmentBase64 === 'string' &&
      req.body.sanctionAttachmentBase64.trim()
    ) {
      try {
        sanctionAttachment = saveSanctionPdfFromBase64(
          `${txId}-sanction`,
          req.body.sanctionAttachmentBase64,
          String(req.body?.sanctionAttachmentName || `${sanctionNumber || txId}-sanction.pdf`),
          req.body?.sanctionAttachmentSource === 'camera-scan' ? 'camera-scan' : 'pdf-upload'
        );
      } catch (err) {
        removeStoredAttachment(chequeAttachment);
        res.status(400).json({
          error:
            err instanceof Error ? `Sanction PDF: ${err.message}` : 'Invalid sanction PDF attachment.',
        });
        return;
      }
    }

    const targetUserId = req.body?.userId ? String(req.body.userId) : req.user!.id;
    const status: TransactionStatus = ['approved', 'pending', 'flagged'].includes(req.body?.status)
      ? (req.body.status as TransactionStatus)
      : 'approved';

    const tx = await createTransactionRecord({
      id: txId,
      budgetHeadId,
      userId: targetUserId,
      title,
      merchant,
      amount: Math.round(amount * 100) / 100,
      type,
      status,
      paymentMethod,
      date,
      financialYear: computeFinancialYear(date),
      reference,
      notes,
      chequeNumber,
      chequeIssueDate,
      sanctionNumber,
      sanctionDate,
      paymentSanctionedByHod,
      chequeAttachment,
      sanctionAttachment,
    });

    res.status(201).json({ transaction: enrichTransaction(tx, allHeads, allUsers) });
  } catch (err) {
    console.error('POST /api/transactions error:', err);
    res.status(500).json({ error: 'Unable to record transaction.' });
  }
});

app.patch('/api/transactions/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const [tx, allHeads, allUsers] = await Promise.all([
      findTransactionById(req.params.id),
      listBudgetHeads(),
      listUsers(),
    ]);
    if (!tx) {
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }

    const updates: Parameters<typeof updateTransactionRecord>[1] = {};
    if (typeof req.body?.budgetHeadId === 'string' && req.body.budgetHeadId) {
      const head = allHeads.find((h) => h.id === req.body.budgetHeadId);
      if (!head) {
        res.status(404).json({ error: 'Selected budget head does not exist.' });
        return;
      }
      updates.budgetHeadId = head.id;
      if (typeof req.body?.title !== 'string' || !req.body.title.trim()) {
        updates.title = head.name;
      }
    }
    if (typeof req.body?.title === 'string' && req.body.title.trim()) {
      updates.title = req.body.title.trim();
    }
    if (typeof req.body?.merchant === 'string' && req.body.merchant.trim()) {
      updates.merchant = req.body.merchant.trim();
    }
    if (req.body?.amount !== undefined) {
      const amt = Number(req.body.amount);
      if (!Number.isFinite(amt) || amt <= 0) {
        res.status(400).json({ error: 'Amount must be greater than ₹0.' });
        return;
      }
      updates.amount = Math.round(amt * 100) / 100;
    }
    if (req.body?.type === 'expense' || req.body?.type === 'income') {
      updates.type = req.body.type;
    }
    if (
      typeof req.body?.paymentMethod === 'string' &&
      ['Cheque', 'Corporate Card', 'Bank Transfer', 'UPI / Mobile', 'Cash Voucher', 'Direct Debit'].includes(
        req.body.paymentMethod
      )
    ) {
      updates.paymentMethod = req.body.paymentMethod as PaymentMethod;
    }
    if (typeof req.body?.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.body.date.slice(0, 10))) {
      const nextDate = req.body.date.slice(0, 10);
      updates.date = nextDate;
      updates.financialYear = computeFinancialYear(nextDate);
    }
    if (typeof req.body?.notes === 'string') {
      updates.notes = req.body.notes.trim();
    }
    if (typeof req.body?.reference === 'string' && req.body.reference.trim()) {
      updates.reference = req.body.reference.trim();
    }
    if (typeof req.body?.chequeNumber === 'string') {
      updates.chequeNumber = req.body.chequeNumber.trim() || null;
    }
    if (typeof req.body?.chequeIssueDate === 'string') {
      const d = req.body.chequeIssueDate.trim().slice(0, 10);
      updates.chequeIssueDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    }
    if (typeof req.body?.sanctionNumber === 'string') {
      updates.sanctionNumber = req.body.sanctionNumber.trim() || null;
    }
    if (typeof req.body?.sanctionDate === 'string') {
      const d = req.body.sanctionDate.trim().slice(0, 10);
      updates.sanctionDate = /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null;
    }
    if (typeof req.body?.paymentSanctionedByHod === 'string') {
      updates.paymentSanctionedByHod = req.body.paymentSanctionedByHod.trim() || null;
    }
    if (['approved', 'pending', 'flagged'].includes(req.body?.status)) {
      updates.status = req.body.status as TransactionStatus;
    }

    if (req.body?.removeChequeAttachment === true) {
      removeStoredAttachment(tx.chequeAttachment);
      updates.clearChequeAttachment = true;
    }
    if (typeof req.body?.chequeAttachmentBase64 === 'string' && req.body.chequeAttachmentBase64.trim()) {
      try {
        const nextAtt = saveSanctionPdfFromBase64(
          `${tx.id}-cheque`,
          req.body.chequeAttachmentBase64,
          String(req.body?.chequeAttachmentName || `${updates.chequeNumber || tx.chequeNumber || tx.id}-cheque.pdf`),
          req.body?.chequeAttachmentSource === 'camera-scan' ? 'camera-scan' : 'pdf-upload'
        );
        removeStoredAttachment(tx.chequeAttachment);
        updates.chequeAttachment = nextAtt;
        updates.clearChequeAttachment = false;
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? `Cheque PDF: ${err.message}` : 'Invalid cheque PDF attachment.',
        });
        return;
      }
    }

    if (req.body?.removeSanctionAttachment === true) {
      removeStoredAttachment(tx.sanctionAttachment);
      updates.clearSanctionAttachment = true;
    }
    if (
      typeof req.body?.sanctionAttachmentBase64 === 'string' &&
      req.body.sanctionAttachmentBase64.trim()
    ) {
      try {
        const nextAtt = saveSanctionPdfFromBase64(
          `${tx.id}-sanction`,
          req.body.sanctionAttachmentBase64,
          String(req.body?.sanctionAttachmentName || `${updates.sanctionNumber || tx.sanctionNumber || tx.id}-sanction.pdf`),
          req.body?.sanctionAttachmentSource === 'camera-scan' ? 'camera-scan' : 'pdf-upload'
        );
        removeStoredAttachment(tx.sanctionAttachment);
        updates.sanctionAttachment = nextAtt;
        updates.clearSanctionAttachment = false;
      } catch (err) {
        res.status(400).json({
          error: err instanceof Error ? `Sanction PDF: ${err.message}` : 'Invalid sanction PDF attachment.',
        });
        return;
      }
    }

    const updated = await updateTransactionRecord(tx.id, updates);
    if (!updated) {
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    res.json({ transaction: enrichTransaction(updated, allHeads, allUsers) });
  } catch (err) {
    console.error('PATCH /api/transactions/:id error:', err);
    res.status(500).json({ error: 'Unable to update transaction.' });
  }
});

app.get(
  '/api/transactions/:id/attachments/:kind',
  requireAuth,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const tx = await findTransactionById(req.params.id);
      if (!tx) {
        res.status(404).json({ error: 'Transaction not found.' });
        return;
      }
      const kind = req.params.kind;
      if (kind !== 'cheque' && kind !== 'sanction') {
        res.status(400).json({ error: 'Attachment type must be "cheque" or "sanction".' });
        return;
      }
      const attachment = kind === 'cheque' ? tx.chequeAttachment : tx.sanctionAttachment;
      if (!attachment) {
        res.status(404).json({ error: `No ${kind} PDF attachment found for this transaction.` });
        return;
      }
      const fullPath = resolveUploadPath(attachment.storedFileName);
      if (!fullPath || !fs.existsSync(fullPath)) {
        res.status(404).json({ error: 'Attached PDF file is missing on server.' });
        return;
      }
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader(
        'Content-Disposition',
        `inline; filename="${sanitizeFileName(attachment.fileName)}"`
      );
      res.sendFile(fullPath);
    } catch (err) {
      console.error('GET /api/transactions/:id/attachments/:kind error:', err);
      res.status(500).json({ error: 'Unable to load attachment.' });
    }
  }
);

app.delete('/api/transactions/:id', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const tx = await findTransactionById(req.params.id);
    if (!tx) {
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }
    await deleteTransactionRecord(tx.id);
    removeStoredAttachment(tx.chequeAttachment);
    removeStoredAttachment(tx.sanctionAttachment);
    res.json({ deleted: true });
  } catch (err) {
    console.error('DELETE /api/transactions/:id error:', err);
    res.status(500).json({ error: 'Unable to delete transaction.' });
  }
});

app.post(
  '/api/transactions/bulk-delete',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const ids: string[] = Array.isArray(req.body?.ids)
        ? Array.from(
            new Set<string>(req.body.ids.map((x: unknown) => String(x || '').trim()).filter(Boolean))
          )
        : [];
      if (ids.length === 0) {
        res.status(400).json({ error: 'Select at least one transaction to delete.' });
        return;
      }
      let deletedCount = 0;
      for (const id of ids) {
        const removed = await deleteTransactionRecord(id);
        if (removed) {
          removeStoredAttachment(removed.chequeAttachment);
          removeStoredAttachment(removed.sanctionAttachment);
          deletedCount += 1;
        }
      }
      res.json({ deletedCount });
    } catch (err) {
      console.error('POST /api/transactions/bulk-delete error:', err);
      res.status(500).json({ error: 'Unable to delete selected transactions.' });
    }
  }
);

// ── Analytics Route ──────────────────────────────────────────────────────────

app.get('/api/analytics', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  try {
    const rangeParam = Number(req.query.days || 0);
    const fyParam = typeof req.query.fy === 'string' ? req.query.fy : '';
    const [allUsers, allHeads, allSanctions, allTransactions] = await Promise.all([
      listUsers(),
      listBudgetHeads(),
      listSanctions(),
      listTransactions(),
    ]);
    const analytics = buildAnalytics(
      req.user!,
      allUsers,
      allHeads,
      allSanctions,
      allTransactions,
      Number.isFinite(rangeParam) ? rangeParam : 0,
      fyParam
    );
    res.json({ analytics });
  } catch (err) {
    console.error('GET /api/analytics error:', err);
    res.status(500).json({ error: 'Unable to compute financial analytics.' });
  }
});

// ── Bulk Excel Import Helpers & Routes ───────────────────────────────────────

const MAX_IMPORT_ROWS = 500;
const VALID_PM: PaymentMethod[] = [
  'Cheque',
  'Corporate Card',
  'Bank Transfer',
  'UPI / Mobile',
  'Cash Voucher',
  'Direct Debit',
];

function normImportText(value: unknown): string {
  return String(value ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function isAutoGeneratedReference(ref: string): boolean {
  return /^tx-\d{5}$/i.test(ref.trim());
}

function isAutoGeneratedSanctionOrder(orderNo: string): boolean {
  return /^so\/\d{4}-\d{2}\/\d{3}$/i.test(orderNo.trim());
}

async function processBudgetHeadImport(
  rows: ImportBudgetHeadRow[],
  actorId: string
): Promise<ImportResultSummary> {
  const summary: ImportResultSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    errors: [],
  };
  const safeRows = rows.slice(0, MAX_IMPORT_ROWS);
  const existingHeads = await listBudgetHeads();

  for (const item of safeRows) {
    const rowNum = Number(item.rowNumber) || 0;
    const name = String(item.name || '').trim();
    const normName = normImportText(name);
    const color = /^#[0-9A-Fa-f]{6}$/.test(String(item.color || ''))
      ? String(item.color)
      : '#0F766E';
    const description = String(item.description || '').trim();

    if (!normName) {
      summary.skipped += 1;
      summary.errors.push({ row: rowNum, message: 'Budget Head Name is required.' });
      continue;
    }

    const existing = existingHeads.find((h) => normImportText(h.name) === normName);
    if (existing) {
      summary.skipped += 1;
      summary.duplicates = (summary.duplicates || 0) + 1;
      summary.errors.push({
        row: rowNum,
        message: `Duplicate skipped: Budget head "${name}" already exists.`,
      });
      continue;
    }

    const created = await createBudgetHeadRecord({
      name,
      color,
      description,
      createdBy: actorId,
    });
    existingHeads.push(created);
    summary.created += 1;
  }

  return summary;
}

async function processSanctionsImport(
  rows: ImportSanctionRow[],
  actorId: string
): Promise<ImportResultSummary> {
  const summary: ImportResultSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    errors: [],
  };
  const safeRows = rows.slice(0, MAX_IMPORT_ROWS);
  const [allHeads, existingSanctions] = await Promise.all([listBudgetHeads(), listSanctions()]);

  for (const item of safeRows) {
    const rowNum = Number(item.rowNumber) || 0;
    const headRef = normImportText(item.budgetHeadName);
    const sanctionAmount = Number(item.sanctionAmount);
    const roundedAmount = Math.round(sanctionAmount * 100) / 100;
    const rawDate = String(item.sanctionDate || '').trim().slice(0, 10);
    const sanctionDate = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().slice(0, 10);
    const financialYear = computeFinancialYear(sanctionDate);
    const explicitOrderNo = String(item.sanctionOrderNo || '').trim();
    const normExplicitOrderNo = normImportText(explicitOrderNo);
    const sanctionedBy = String(item.sanctionedBy || 'Technical Director RISL').trim() || 'Technical Director RISL';
    const normSanctionedBy = normImportText(sanctionedBy);
    const notes = String(item.notes || '').trim();
    const normNotes = normImportText(notes);

    if (!headRef || !Number.isFinite(sanctionAmount) || sanctionAmount <= 0) {
      summary.skipped += 1;
      summary.errors.push({
        row: rowNum,
        message: 'Requires Budget Head Name and positive Sanction Amount (INR).',
      });
      continue;
    }

    const head = allHeads.find((h) => normImportText(h.name) === headRef);
    if (!head) {
      summary.skipped += 1;
      summary.errors.push({
        row: rowNum,
        message: `Budget head "${item.budgetHeadName}" not found.`,
      });
      continue;
    }

    const isDuplicate = existingSanctions.some((s) => {
      if (s.budgetHeadId !== head.id) return false;
      const existingAmt = Math.round(Number(s.sanctionAmount) * 100) / 100;
      const existingOrderNo = normImportText(s.sanctionOrderNo);

      // 1. Same budget head + same explicit sanction order number + same date + same amount
      if (
        normExplicitOrderNo &&
        existingOrderNo === normExplicitOrderNo &&
        existingAmt === roundedAmount &&
        s.sanctionDate === sanctionDate
      ) {
        return true;
      }

      // 2. Same budget head + same non-empty explicit sanction order number (even if date/notes formatting differed)
      if (
        normExplicitOrderNo &&
        existingOrderNo &&
        !isAutoGeneratedSanctionOrder(s.sanctionOrderNo) &&
        existingOrderNo === normExplicitOrderNo &&
        existingAmt === roundedAmount
      ) {
        return true;
      }

      // 3. Content match when order number is blank or auto-generated (prevents double entry on re-import)
      const hasDistinctExplicitOrder =
        normExplicitOrderNo !== '' &&
        existingOrderNo !== '' &&
        !isAutoGeneratedSanctionOrder(s.sanctionOrderNo) &&
        existingOrderNo !== normExplicitOrderNo;

      if (
        !hasDistinctExplicitOrder &&
        s.sanctionDate === sanctionDate &&
        existingAmt === roundedAmount &&
        normImportText(s.sanctionedBy) === normSanctionedBy &&
        normImportText(s.notes) === normNotes
      ) {
        return true;
      }

      return false;
    });

    if (isDuplicate) {
      summary.skipped += 1;
      summary.duplicates = (summary.duplicates || 0) + 1;
      summary.errors.push({
        row: rowNum,
        message: `Duplicate skipped: Sanction for "${head.name}" (${sanctionDate}, ₹${roundedAmount}${explicitOrderNo ? `, ${explicitOrderNo}` : ''}) already exists.`,
      });
      continue;
    }

    const sanctionOrderNo =
      explicitOrderNo ||
      `SO/${financialYear.replace('FY ', '')}/${crypto.randomInt(100, 1000)}`;

    const createdSanction = await createSanctionRecord({
      budgetHeadId: head.id,
      sanctionAmount: roundedAmount,
      sanctionDate,
      financialYear,
      sanctionOrderNo,
      sanctionedBy,
      notes,
      createdBy: actorId,
    });
    existingSanctions.push(createdSanction);
    summary.created += 1;
  }

  return summary;
}

async function processTransactionsImport(
  rows: ImportTransactionRow[],
  actor: StoredUser
): Promise<ImportResultSummary> {
  const summary: ImportResultSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    duplicates: 0,
    errors: [],
  };
  const isAdmin = actor.role === 'admin';
  const safeRows = rows.slice(0, MAX_IMPORT_ROWS);

  const [allHeads, allSanctions, allTransactions, allUsers] = await Promise.all([
    listBudgetHeads(),
    listSanctions(),
    listTransactions(),
    listUsers(),
  ]);

  for (const item of safeRows) {
    const rowNum = Number(item.rowNumber) || 0;
    const title = String(item.title || '').trim();
    const merchant = String(item.merchant || '').trim();
    const headRef = normImportText(item.budgetHeadName);
    const amount = Number(item.amount);
    const roundedAmount = Math.round(amount * 100) / 100;
    const type: TransactionType = item.type === 'income' ? 'income' : 'expense';
    const paymentMethod: PaymentMethod = VALID_PM.includes(item.paymentMethod)
      ? item.paymentMethod
      : 'Cheque';
    const rawDate = String(item.date || '').trim().slice(0, 10);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(rawDate)
      ? rawDate
      : new Date().toISOString().slice(0, 10);
    const explicitReference = String(item.reference || '').trim();
    const normExplicitRef = normImportText(explicitReference);
    const normTitle = normImportText(title);
    const normMerchant = normImportText(merchant);
    const notes = String(item.notes || '').trim();

    if (!title || !merchant || !headRef || !Number.isFinite(amount) || amount <= 0) {
      summary.skipped += 1;
      summary.errors.push({
        row: rowNum,
        message: 'Requires Title, Merchant, Budget Head Name, and positive Amount (INR).',
      });
      continue;
    }

    const head = allHeads.find((h) => normImportText(h.name) === headRef);
    if (!head) {
      summary.skipped += 1;
      summary.errors.push({
        row: rowNum,
        message: `Budget head "${item.budgetHeadName}" not found.`,
      });
      continue;
    }

    let targetUserId = actor.id;
    if (isAdmin && item.username) {
      const userRef = normImportText(item.username);
      const matchedUser = allUsers.find(
        (u) => normImportText(u.username) === userRef || normImportText(u.fullName) === userRef
      );
      if (!matchedUser) {
        summary.skipped += 1;
        summary.errors.push({
          row: rowNum,
          message: `User "${item.username}" not found.`,
        });
        continue;
      }
      targetUserId = matchedUser.id;
    }

    const isDuplicate = allTransactions.some((t) => {
      if (t.budgetHeadId !== head.id || t.type !== type) return false;
      const existingAmt = Math.round(Number(t.amount) * 100) / 100;
      if (existingAmt !== roundedAmount) return false;

      const existingRef = normImportText(t.reference);

      // 1. Explicit bill/invoice reference match on same budget head, amount, and date/merchant
      if (
        normExplicitRef &&
        existingRef &&
        !isAutoGeneratedReference(t.reference) &&
        existingRef === normExplicitRef &&
        (t.date === date || normImportText(t.merchant) === normMerchant)
      ) {
        return true;
      }

      // 2. Content fingerprint match (catches duplicate imports even when Reference is blank)
      const hasDistinctExplicitRefs =
        normExplicitRef !== '' &&
        existingRef !== '' &&
        !isAutoGeneratedReference(t.reference) &&
        existingRef !== normExplicitRef;

      if (
        !hasDistinctExplicitRefs &&
        t.date === date &&
        normImportText(t.title) === normTitle &&
        normImportText(t.merchant) === normMerchant &&
        t.paymentMethod === paymentMethod
      ) {
        return true;
      }

      return false;
    });

    if (isDuplicate) {
      summary.skipped += 1;
      summary.duplicates = (summary.duplicates || 0) + 1;
      summary.errors.push({
        row: rowNum,
        message: `Duplicate skipped: "${title}" (${date}, ₹${roundedAmount}${explicitReference ? `, Ref: ${explicitReference}` : ''}) already exists.`,
      });
      continue;
    }

    const reference = explicitReference || `TX-${crypto.randomInt(10000, 100000)}`;

    const headSummary = enrichBudgetHead(head, allSanctions, allTransactions);
    let status: TransactionStatus = 'approved';
    if (!isAdmin && type === 'expense') {
      if (headSummary.sanctionedTotal > 0 && headSummary.spentTotal + amount > headSummary.sanctionedTotal) {
        status = 'flagged';
      } else if (amount >= 25000) {
        status = 'pending';
      }
    }

    const createdTx = await createTransactionRecord({
      budgetHeadId: head.id,
      userId: targetUserId,
      title,
      merchant,
      amount: roundedAmount,
      type,
      status,
      paymentMethod,
      date,
      financialYear: computeFinancialYear(date),
      reference,
      notes,
    });
    allTransactions.push(createdTx);
    summary.created += 1;
  }

  return summary;
}

app.post(
  '/api/import/budget-heads',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? (req.body.rows as ImportBudgetHeadRow[]) : [];
      if (rows.length === 0) {
        res.status(400).json({ error: 'No budget head rows provided for import.' });
        return;
      }
      const summary = await processBudgetHeadImport(rows, req.user!.id);
      res.json({ summary });
    } catch (err) {
      console.error('POST /api/import/budget-heads error:', err);
      res.status(500).json({ error: 'Unable to import budget heads.' });
    }
  }
);

app.post(
  '/api/import/sanctions',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? (req.body.rows as ImportSanctionRow[]) : [];
      if (rows.length === 0) {
        res.status(400).json({ error: 'No budget sanction rows provided for import.' });
        return;
      }
      const summary = await processSanctionsImport(rows, req.user!.id);
      res.json({ summary });
    } catch (err) {
      console.error('POST /api/import/sanctions error:', err);
      res.status(500).json({ error: 'Unable to import budget sanctions.' });
    }
  }
);

app.post(
  '/api/import/transactions',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? (req.body.rows as ImportTransactionRow[]) : [];
      if (rows.length === 0) {
        res.status(400).json({ error: 'No transaction rows provided for import.' });
        return;
      }
      const summary = await processTransactionsImport(rows, req.user!);
      res.json({ summary });
    } catch (err) {
      console.error('POST /api/import/transactions error:', err);
      res.status(500).json({ error: 'Unable to import transactions.' });
    }
  }
);

app.post(
  '/api/import/workbook',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const budgetHeadRows = Array.isArray(req.body?.budgetHeads)
        ? (req.body.budgetHeads as ImportBudgetHeadRow[])
        : [];
      const sanctionRows = Array.isArray(req.body?.sanctions)
        ? (req.body.sanctions as ImportSanctionRow[])
        : [];
      const transactionRows = Array.isArray(req.body?.transactions)
        ? (req.body.transactions as ImportTransactionRow[])
        : [];

      if (budgetHeadRows.length === 0 && sanctionRows.length === 0 && transactionRows.length === 0) {
        res.status(400).json({ error: 'Uploaded workbook contains no valid rows to import.' });
        return;
      }

      const budgetHeadsResult = await processBudgetHeadImport(budgetHeadRows, req.user!.id);
      const sanctionsResult = await processSanctionsImport(sanctionRows, req.user!.id);
      const transactionsResult = await processTransactionsImport(transactionRows, req.user!);

      res.json({
        result: {
          budgetHeads: budgetHeadsResult,
          sanctions: sanctionsResult,
          transactions: transactionsResult,
        },
      });
    } catch (err) {
      console.error('POST /api/import/workbook error:', err);
      res.status(500).json({ error: 'Unable to import workbook.' });
    }
  }
);

// ── Admin Database Auto-Backup (Daily 00:00 hrs IST) & Restore Routes ────────

const BACKUPS_DIR = path.resolve(DATA_DIR, 'backups');
const BACKUP_STATE_FILE = path.resolve(BACKUPS_DIR, 'backup-state.json');
const MAX_SERVER_BACKUPS = 30;
const BACKUP_FILENAME_RE = /^[a-zA-Z0-9._-]+\.json$/;

interface PersistedServerBackupRecord {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore';
  istDate: string;
  counts: {
    users: number;
    budgetHeads: number;
    budgetSanctions: number;
    transactions: number;
  };
  driveSyncedAt: string | null;
  driveFileId: string | null;
}

interface BackupPersistedState {
  autoBackupEnabled: boolean;
  lastScheduledIstDate: string | null;
  lastServerBackupAt: string | null;
  lastDriveSyncAt: string | null;
  lastDriveFileName: string | null;
  lastDriveEmail: string | null;
  snapshots: PersistedServerBackupRecord[];
}

function getIstClockParts(date = new Date()): {
  istDate: string;
  istHour: number;
  istMinute: number;
  istTimeStamp: string;
} {
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const pick = (type: string) => parts.find((p) => p.type === type)?.value || '00';
  const yr = pick('year');
  const mo = pick('month');
  const da = pick('day');
  const rawHour = Number(pick('hour'));
  const hr = rawHour === 24 ? 0 : rawHour;
  const min = Number(pick('minute'));
  const sec = pick('second');
  return {
    istDate: `${yr}-${mo}-${da}`,
    istHour: hr,
    istMinute: min,
    istTimeStamp: `${yr}-${mo}-${da}_${String(hr).padStart(2, '0')}-${String(min).padStart(2, '0')}-${sec}`,
  };
}

function ensureBackupsDir(): void {
  if (!fs.existsSync(BACKUPS_DIR)) {
    fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  }
}

function resolveBackupFilePath(fileName: string): string | null {
  const clean = path.basename(String(fileName || '').trim());
  if (!clean || clean === 'backup-state.json' || !BACKUP_FILENAME_RE.test(clean)) {
    return null;
  }
  const resolved = path.resolve(BACKUPS_DIR, clean);
  if (!resolved.startsWith(BACKUPS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

function readBackupState(): BackupPersistedState {
  ensureBackupsDir();
  const fallback: BackupPersistedState = {
    autoBackupEnabled: true,
    lastScheduledIstDate: null,
    lastServerBackupAt: null,
    lastDriveSyncAt: null,
    lastDriveFileName: null,
    lastDriveEmail: null,
    snapshots: [],
  };
  if (!fs.existsSync(BACKUP_STATE_FILE)) return fallback;
  try {
    const raw = fs.readFileSync(BACKUP_STATE_FILE, 'utf8');
    const parsed = JSON.parse(raw) as Partial<BackupPersistedState>;
    const existingSnapshots = Array.isArray(parsed.snapshots)
      ? parsed.snapshots.filter((s) => {
          const p = resolveBackupFilePath(s?.fileName);
          return Boolean(p && fs.existsSync(p));
        })
      : [];
    return {
      autoBackupEnabled: parsed.autoBackupEnabled !== false,
      lastScheduledIstDate: parsed.lastScheduledIstDate || null,
      lastServerBackupAt: parsed.lastServerBackupAt || null,
      lastDriveSyncAt: parsed.lastDriveSyncAt || null,
      lastDriveFileName: parsed.lastDriveFileName || null,
      lastDriveEmail: parsed.lastDriveEmail || null,
      snapshots: existingSnapshots,
    };
  } catch {
    return fallback;
  }
}

function writeBackupState(state: BackupPersistedState): void {
  ensureBackupsDir();
  fs.writeFileSync(BACKUP_STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function buildBackupStatusResponse(): {
  autoBackupEnabled: boolean;
  scheduleTime: string;
  timezone: string;
  adminEmail: string;
  lastScheduledIstDate: string | null;
  lastServerBackupAt: string | null;
  lastDriveSyncAt: string | null;
  lastDriveFileName: string | null;
  lastDriveEmail: string | null;
  nextScheduledRunLabel: string;
  serverSnapshots: PersistedServerBackupRecord[];
  pendingDriveSyncFiles: PersistedServerBackupRecord[];
} {
  const state = readBackupState();
  const sorted = [...state.snapshots].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const pendingDriveSyncFiles = sorted.filter(
    (s) => s.trigger === 'scheduled-00:00' && !s.driveSyncedAt
  );
  const { istDate } = getIstClockParts();
  const nextLabel = state.autoBackupEnabled
    ? state.lastScheduledIstDate === istDate
      ? 'Tomorrow at 00:00 hrs IST'
      : 'Today at 00:00 hrs IST (pending)'
    : 'Paused by Admin';

  return {
    autoBackupEnabled: state.autoBackupEnabled,
    scheduleTime: '00:00',
    timezone: 'Asia/Kolkata',
    adminEmail: ADMIN_GMAIL,
    lastScheduledIstDate: state.lastScheduledIstDate,
    lastServerBackupAt: state.lastServerBackupAt,
    lastDriveSyncAt: state.lastDriveSyncAt,
    lastDriveFileName: state.lastDriveFileName,
    lastDriveEmail: state.lastDriveEmail,
    nextScheduledRunLabel: nextLabel,
    serverSnapshots: sorted,
    pendingDriveSyncFiles,
  };
}

async function captureServerBackupSnapshot(
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore'
): Promise<{
  snapshot: DatabaseBackupSnapshot;
  meta: PersistedServerBackupRecord;
}> {
  ensureBackupsDir();
  const snapshot = await exportDatabaseSnapshot(trigger);
  const { istDate, istTimeStamp } = getIstClockParts();
  const prefix =
    trigger === 'scheduled-00:00'
      ? `ledgerflow-auto-00-00_${istDate}`
      : trigger === 'pre-restore'
        ? `ledgerflow-pre-restore_${istTimeStamp}`
        : `ledgerflow-backup_${istTimeStamp}`;
  const fileName = `${prefix}.json`;
  const targetPath = resolveBackupFilePath(fileName);
  if (!targetPath) {
    throw new Error('Unable to generate safe backup filename.');
  }

  const serialized = JSON.stringify(snapshot, null, 2);
  fs.writeFileSync(targetPath, serialized, 'utf8');

  const meta: PersistedServerBackupRecord = {
    fileName,
    sizeBytes: Buffer.byteLength(serialized, 'utf8'),
    createdAt: snapshot.exportedAt,
    trigger,
    istDate,
    counts: snapshot.counts,
    driveSyncedAt: null,
    driveFileId: null,
  };

  const state = readBackupState();
  const filtered = state.snapshots.filter((s) => s.fileName !== fileName);
  filtered.unshift(meta);

  // Prune older snapshots beyond MAX_SERVER_BACKUPS
  while (filtered.length > MAX_SERVER_BACKUPS) {
    const oldest = filtered.pop();
    if (oldest) {
      const oldPath = resolveBackupFilePath(oldest.fileName);
      if (oldPath && fs.existsSync(oldPath)) {
        try {
          fs.unlinkSync(oldPath);
        } catch {
          // Ignore unlink failure
        }
      }
    }
  }

  state.snapshots = filtered;
  state.lastServerBackupAt = meta.createdAt;
  if (trigger === 'scheduled-00:00') {
    state.lastScheduledIstDate = istDate;
  }
  writeBackupState(state);

  return { snapshot, meta };
}

let midnightBackupInProgress = false;

async function checkAndRunDailyMidnightBackup(): Promise<void> {
  if (midnightBackupInProgress) return;
  try {
    const state = readBackupState();
    if (!state.autoBackupEnabled) return;
    const { istDate, istHour, istMinute } = getIstClockParts();
    // Trigger daily at 00:00 hrs IST (or catch up automatically if the server restarted after midnight)
    const isMidnightWindow = istHour === 0 && istMinute <= 5;
    const missedToday = state.lastScheduledIstDate !== istDate && state.lastScheduledIstDate !== null;
    if (state.lastScheduledIstDate !== istDate && (isMidnightWindow || missedToday)) {
      midnightBackupInProgress = true;
      await captureServerBackupSnapshot('scheduled-00:00');
      console.log(`Daily 00:00 hrs IST database backup snapshot captured for ${istDate}.`);
    }
  } catch (err) {
    console.error('Daily 00:00 hrs backup check failed:', err);
  } finally {
    midnightBackupInProgress = false;
  }
}

app.get(
  '/api/admin/backup/status',
  requireAuth,
  requireAdmin,
  (_req: AuthenticatedRequest, res: Response) => {
    try {
      res.json(buildBackupStatusResponse());
    } catch (err) {
      console.error('GET /api/admin/backup/status error:', err);
      res.status(500).json({ error: 'Unable to load backup status.' });
    }
  }
);

app.get(
  '/api/admin/backup/export',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      const saveServer = req.query.saveServer === '1' || req.query.saveServer === 'true';
      if (saveServer) {
        const { snapshot, meta } = await captureServerBackupSnapshot('manual');
        res.json({
          snapshot,
          suggestedFileName: meta.fileName,
          serverMeta: meta,
        });
        return;
      }
      const snapshot = await exportDatabaseSnapshot('manual');
      const { istTimeStamp } = getIstClockParts();
      res.json({
        snapshot,
        suggestedFileName: `ledgerflow-backup_${istTimeStamp}.json`,
      });
    } catch (err) {
      console.error('GET /api/admin/backup/export error:', err);
      res.status(500).json({ error: 'Unable to export database backup.' });
    }
  }
);

app.get(
  '/api/admin/backup/server/:fileName',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const targetPath = resolveBackupFilePath(req.params.fileName);
      if (!targetPath || !fs.existsSync(targetPath)) {
        res.status(404).json({ error: 'Requested server backup snapshot was not found.' });
        return;
      }
      const raw = fs.readFileSync(targetPath, 'utf8');
      const snapshot = validateDatabaseBackupSnapshot(JSON.parse(raw));
      res.json({
        fileName: path.basename(targetPath),
        snapshot,
      });
    } catch (err) {
      console.error('GET /api/admin/backup/server/:fileName error:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to read server backup snapshot.',
      });
    }
  }
);

app.post(
  '/api/admin/backup/drive-synced',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const driveFileId = String(req.body?.driveFileId || '').trim();
      const driveFileName = String(req.body?.driveFileName || '').trim();
      const driveEmail = String(req.body?.driveEmail || '').trim();
      const serverFileName = String(req.body?.serverFileName || '').trim();

      if (!driveFileId || !driveFileName) {
        res.status(400).json({ error: 'Google Drive file details are required.' });
        return;
      }

      const nowIso = new Date().toISOString();
      const state = readBackupState();
      state.lastDriveSyncAt = nowIso;
      state.lastDriveFileName = driveFileName;
      if (driveEmail) state.lastDriveEmail = driveEmail;

      if (serverFileName) {
        const cleanServerName = path.basename(serverFileName);
        state.snapshots = state.snapshots.map((s) =>
          s.fileName === cleanServerName
            ? { ...s, driveSyncedAt: nowIso, driveFileId }
            : s
        );
      }
      writeBackupState(state);
      res.json({ ok: true, status: buildBackupStatusResponse() });
    } catch (err) {
      console.error('POST /api/admin/backup/drive-synced error:', err);
      res.status(500).json({ error: 'Unable to record Google Drive sync status.' });
    }
  }
);

app.patch(
  '/api/admin/backup/config',
  requireAuth,
  requireAdmin,
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const autoBackupEnabled = Boolean(req.body?.autoBackupEnabled);
      const state = readBackupState();
      state.autoBackupEnabled = autoBackupEnabled;
      writeBackupState(state);
      res.json({ ok: true, status: buildBackupStatusResponse() });
    } catch (err) {
      console.error('PATCH /api/admin/backup/config error:', err);
      res.status(500).json({ error: 'Unable to update backup schedule configuration.' });
    }
  }
);

app.post(
  '/api/admin/backup/restore',
  requireAuth,
  requireAdmin,
  async (req: AuthenticatedRequest, res: Response) => {
    try {
      let rawSnapshot: unknown = req.body?.snapshot;
      const serverFileName = String(req.body?.serverFileName || '').trim();

      if (!rawSnapshot && serverFileName) {
        const targetPath = resolveBackupFilePath(serverFileName);
        if (!targetPath || !fs.existsSync(targetPath)) {
          res.status(404).json({ error: 'Selected server backup file was not found.' });
          return;
        }
        rawSnapshot = JSON.parse(fs.readFileSync(targetPath, 'utf8'));
      }

      if (!rawSnapshot) {
        res.status(400).json({ error: 'Provide a valid LedgerFlow backup snapshot to restore.' });
        return;
      }

      // Validate before touching the database
      const validated = validateDatabaseBackupSnapshot(rawSnapshot);

      // Save an automatic pre-restore safety snapshot first
      let preRestoreFileName: string | null = null;
      try {
        const safety = await captureServerBackupSnapshot('pre-restore');
        preRestoreFileName = safety.meta.fileName;
      } catch (safetyErr) {
        console.error('Pre-restore safety snapshot warning:', safetyErr);
      }

      const counts = await restoreDatabaseSnapshot(validated, req.user);
      res.json({
        restored: true,
        counts,
        preRestoreFileName,
      });
    } catch (err) {
      console.error('POST /api/admin/backup/restore error:', err);
      res.status(400).json({
        error: err instanceof Error ? err.message : 'Unable to restore database backup.',
      });
    }
  }
);

// ── Vite Dev Middleware / Static Production Serving ──────────────────────────

async function startServer() {
  const distDir = path.resolve(process.cwd(), 'dist');
  const publicDir = path.resolve(process.cwd(), 'public');
  const hasDistBuild = fs.existsSync(path.join(distDir, 'index.html'));
  const isDevRunner =
    process.env.NODE_ENV === 'development' ||
    process.execArgv.some((arg) => arg.includes('tsx'));
  // Always serve prebuilt dist/ on Cloud Run (K_SERVICE), when NODE_ENV=production,
  // or when launched directly via `node server.ts` with a compiled dist/ bundle.
  const isProd =
    process.env.NODE_ENV === 'production' ||
    (Boolean(process.env.K_SERVICE) && hasDistBuild) ||
    (!isDevRunner && hasDistBuild);

  const pwaRootDir = isProd ? distDir : publicDir;

  const rootManifestPath = path.resolve(process.cwd(), 'manifest.webmanifest');

  // Serve Web App Manifest and Service Worker with strict MIME, CORS, and scope headers
  app.get(['/manifest.webmanifest', '/manifest.json'], (_req, res) => {
    const prodManifestPath = path.join(distDir, 'manifest.webmanifest');
    const manifestPath =
      isProd && fs.existsSync(prodManifestPath)
        ? prodManifestPath
        : fs.existsSync(rootManifestPath)
          ? rootManifestPath
          : path.join(publicDir, 'manifest.webmanifest');
    if (!fs.existsSync(manifestPath)) {
      res.status(404).json({ error: 'Manifest not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/manifest+json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(manifestPath);
  });

  // Serve Android TWA Digital Asset Links (must return 200 application/json with no redirects)
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const prodAssetLinks = path.join(distDir, '.well-known', 'assetlinks.json');
    const publicAssetLinks = path.join(publicDir, '.well-known', 'assetlinks.json');
    const assetLinksPath =
      isProd && fs.existsSync(prodAssetLinks) ? prodAssetLinks : publicAssetLinks;
    if (!fs.existsSync(assetLinksPath)) {
      res.status(404).json({ error: 'assetlinks.json not found' });
      return;
    }
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(assetLinksPath);
  });

  app.get(['/sw.js', '/registerSW.js'], (req, res) => {
    const fileName = req.path === '/sw.js' ? 'sw.js' : 'registerSW.js';
    const filePath = path.join(pwaRootDir, fileName);
    if (!fs.existsSync(filePath)) {
      res.status(404).type('text/plain').send('Service worker not found');
      return;
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Service-Worker-Allowed', '/');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.sendFile(filePath);
  });

  if (!isProd) {
    const httpServer = http.createServer(app);
    let viteMiddlewares: ((req: Request, res: Response, next: NextFunction) => void) | null = null;
    const viteReady = import('vite').then(async ({ createServer: createViteServer }) => {
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          hmr: false,
          ws: false,
        },
        appType: 'spa',
      });
      viteMiddlewares = vite.middlewares;
      return vite;
    });

    // Serve a WebSocket-free @vite/client shim in AI Studio dev preview (HMR is disabled)
    // so CSS style injection works cleanly without opening a failing HMR WebSocket.
    app.get('/@vite/client', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.send(
        `const sheetsMap = new Map();\n` +
        `export function updateStyle(id, content) {\n` +
        `  let style = sheetsMap.get(id);\n` +
        `  if (!style) {\n` +
        `    style = document.createElement('style');\n` +
        `    style.setAttribute('type', 'text/css');\n` +
        `    style.setAttribute('data-vite-dev-id', id);\n` +
        `    style.textContent = content;\n` +
        `    document.head.appendChild(style);\n` +
        `    sheetsMap.set(id, style);\n` +
        `  } else if (style.textContent !== content) {\n` +
        `    style.textContent = content;\n` +
        `  }\n` +
        `}\n` +
        `export function removeStyle(id) {\n` +
        `  const style = sheetsMap.get(id);\n` +
        `  if (style) {\n` +
        `    style.remove();\n` +
        `    sheetsMap.delete(id);\n` +
        `  }\n` +
        `}\n` +
        `export function createHotContext() {\n` +
        `  return { data: {}, accept() {}, acceptExports() {}, dispose() {}, prune() {}, decline() {}, invalidate() {}, on() {}, off() {}, send() {} };\n` +
        `}\n` +
        `export function injectQuery(url, queryToInject) {\n` +
        `  if (!url || (url[0] !== '.' && url[0] !== '/')) return url;\n` +
        `  const pathname = url.replace(/[?#].*$/, '');\n` +
        `  const u = new URL(url, 'http://vite.dev');\n` +
        `  return pathname + '?' + queryToInject + (u.search ? '&' + u.search.slice(1) : '') + (u.hash || '');\n` +
        `}\n` +
        `export class ErrorOverlay {}\n`
      );
    });

    // Evict any previously registered dev-sw.js so stale dev caches are cleared
    app.get('/dev-sw.js', (_req, res) => {
      res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
      res.send(
        `self.addEventListener('install', () => self.skipWaiting());\n` +
        `self.addEventListener('activate', (event) => {\n` +
        `  event.waitUntil((async () => {\n` +
        `    const keys = await caches.keys();\n` +
        `    await Promise.all(keys.map((k) => caches.delete(k)));\n` +
        `    await self.registration.unregister();\n` +
        `  })());\n` +
        `});\n`
      );
    });

    app.use((req, res, next) => {
      if (req.method === 'GET' && req.accepts('html') && !req.path.startsWith('/api/')) {
        res.setHeader('Cache-Control', 'no-store');
      }
      if (viteMiddlewares) {
        viteMiddlewares(req, res, next);
        return;
      }
      viteReady.then((vite) => vite.middlewares(req, res, next)).catch(next);
    });

    const startBackupScheduler = () => {
      const backupInterval = setInterval(() => {
        void checkAndRunDailyMidnightBackup();
      }, 30_000);
      if (typeof backupInterval.unref === 'function') {
        backupInterval.unref();
      }
      void checkAndRunDailyMidnightBackup();
    };

    httpServer.listen(PORT, '0.0.0.0', () => {
      console.log(`LedgerFlow server running on http://0.0.0.0:${PORT}`);
      startBackupScheduler();
    });

    await viteReady;
  } else {
    app.use(express.static(distDir));
    app.use(express.static(publicDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`LedgerFlow server running on http://0.0.0.0:${PORT}`);
      const backupInterval = setInterval(() => {
        void checkAndRunDailyMidnightBackup();
      }, 30_000);
      if (typeof backupInterval.unref === 'function') {
        backupInterval.unref();
      }
      void checkAndRunDailyMidnightBackup();
    });
  }
}

startServer().catch((err) => {
  console.error('Failed to start LedgerFlow server:', err);
  process.exit(1);
});
