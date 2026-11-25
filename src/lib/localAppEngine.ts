import type {
  AnalyticsSummary,
  BackupCounts,
  BackupStatusResponse,
  BudgetHead,
  BudgetHeadEnriched,
  BudgetSanction,
  BudgetSanctionEnriched,
  DatabaseBackupSnapshotPayload,
  ImportBudgetHeadRow,
  ImportResultSummary,
  ImportSanctionRow,
  ImportTransactionRow,
  LoginResponse,
  OtpChallengeResponse,
  OtpVerifyResponse,
  PaymentMethod,
  RegisterResponse,
  SafeUser,
  SanctionApprovalStatus,
  SanctionAttachment,
  ServerBackupSnapshotMeta,
  Transaction,
  TransactionEnriched,
  TransactionStatus,
  TransactionType,
  UserRole,
  UserWithStats,
  WorkbookImportResult,
} from '../types/finance';

const DB_STORAGE_KEY = 'ledgerflow_standalone_db_v1';
const SESSION_STORAGE_KEY = 'ledgerflow_standalone_session_v1';
const SNAPSHOTS_STORAGE_KEY = 'ledgerflow_standalone_snapshots_v1';
const ATTACHMENTS_STORAGE_KEY = 'ledgerflow_standalone_attachments_v1';
const DEFAULT_ADMIN_EMAIL = 'shakti.chahar@gmail.com';

interface LocalUserRecord extends SafeUser {
  password: string;
}

interface LocalOtpChallenge {
  id: string;
  userId: string;
  purpose: 'login' | 'direct-otp' | 'register';
  code: string;
  maskedEmail: string | null;
  maskedMobile: string | null;
  expiresAt: number;
  attempts: number;
  consumed: boolean;
}

interface LocalDatabaseState {
  users: LocalUserRecord[];
  budgetHeads: BudgetHead[];
  sanctions: BudgetSanction[];
  transactions: Transaction[];
  autoBackupEnabled: boolean;
  lastScheduledIstDate: string | null;
  lastServerBackupAt: string | null;
  lastDriveSyncAt: string | null;
  lastDriveFileName: string | null;
  lastDriveEmail: string | null;
}

interface LocalSessionState {
  token: string;
  userId: string;
  loginAt: string;
  lastActivity: number;
}

interface LocalStoredSnapshot {
  meta: ServerBackupSnapshotMeta;
  snapshot: DatabaseBackupSnapshotPayload;
}

const activeOtpChallenges = new Map<string, LocalOtpChallenge>();

export function isStandaloneAndroidRuntime(): boolean {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname.toLowerCase();
  return host === 'appassets.androidplatform.net' || window.location.protocol === 'file:';
}

export function isAndroidEmailOtpReady(): boolean {
  if (typeof window === 'undefined') return false;
  const bridge = window.LedgerFlowAndroid;
  if (!bridge || typeof bridge.isOtpEmailConfigured !== 'function') {
    return false;
  }
  try {
    return Boolean(bridge.isOtpEmailConfigured());
  } catch {
    return false;
  }
}

function uid(prefix: string): string {
  const rand =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
  return `${prefix}-${rand}`;
}

function normalizeEmail(email: string): string {
  return String(email || '').trim().toLowerCase();
}

function normalizeMobile(mobile: string): string {
  const trimmed = String(mobile || '').trim();
  if (!trimmed) return '';
  const digits = trimmed.replace(/\D/g, '');
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length > 10 && !trimmed.startsWith('+')) return `+${digits}`;
  return trimmed;
}

function maskEmail(email: string): string | null {
  const clean = normalizeEmail(email);
  const at = clean.indexOf('@');
  if (at <= 0) return null;
  const local = clean.slice(0, at);
  const domain = clean.slice(at);
  return `${local.slice(0, Math.min(2, local.length))}*****${domain}`;
}

function maskMobile(mobile: string): string | null {
  const digits = String(mobile || '').replace(/\D/g, '');
  if (digits.length < 4) return null;
  const last4 = digits.slice(-4);
  const prefix = digits.length > 10 ? `+${digits.slice(0, digits.length - 10)} ` : '+91 ';
  return `${prefix}••••••${last4}`;
}

function computeFinancialYear(isoDate: string): string {
  const match = String(isoDate || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) {
    const now = new Date();
    const yr = now.getFullYear();
    const mo = now.getMonth() + 1;
    const startYear = mo >= 4 ? yr : yr - 1;
    return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const startYear = month >= 4 ? year : year - 1;
  return `FY ${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

function getIstDateString(now = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const y = parts.find((p) => p.type === 'year')?.value || String(now.getFullYear());
  const m = parts.find((p) => p.type === 'month')?.value || '01';
  const d = parts.find((p) => p.type === 'day')?.value || '01';
  return `${y}-${m}-${d}`;
}

function createInitialSeedState(): LocalDatabaseState {
  return {
    users: [
      {
        id: 'usr-admin-1',
        username: DEFAULT_ADMIN_EMAIL,
        fullName: 'Shakti Chahar',
        department: 'Executive Finance',
        email: DEFAULT_ADMIN_EMAIL,
        mobile: '+919876543210',
        role: 'admin',
        avatarUrl: '/src/assets/images/avatar_admin_cfo_1795069504356.jpg',
        active: true,
        activeFrom: null,
        activeUntil: null,
        deactivatedFrom: null,
        deactivatedUntil: null,
        createdAt: '2026-01-10T09:00:00.000Z',
        password: 'admin123',
      },
      {
        id: 'usr-user-1',
        username: 'alex.chen',
        fullName: 'Alex Chen',
        department: 'Engineering & Cloud',
        email: 'alex.chen@ledgerflow.in',
        mobile: '+919811002233',
        role: 'user',
        avatarUrl: '/src/assets/images/avatar_user_alex_1795069503492.jpg',
        active: true,
        activeFrom: null,
        activeUntil: null,
        deactivatedFrom: null,
        deactivatedUntil: null,
        createdAt: '2026-01-14T10:30:00.000Z',
        password: 'user123',
      },
      {
        id: 'usr-user-2',
        username: 'priya.nair',
        fullName: 'Priya Nair',
        department: 'Field Operations',
        email: 'priya.nair@ledgerflow.in',
        mobile: '+919822004455',
        role: 'user',
        avatarUrl: '/src/assets/images/avatar_user_alex_1795069503492.jpg',
        active: true,
        activeFrom: null,
        activeUntil: null,
        deactivatedFrom: null,
        deactivatedUntil: null,
        createdAt: '2026-02-02T11:15:00.000Z',
        password: 'user123',
      },
    ],
    budgetHeads: [
      {
        id: 'bh-taxi-rent',
        name: 'Taxi(Rent)',
        color: '#0F766E',
        description: 'Hired taxi and vehicle rental expenditure.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:00:00.000Z',
      },
      {
        id: 'bh-taxi-security',
        name: 'Taxi(Security)',
        color: '#0D9488',
        description: 'Security escort and dedicated taxi deployment expenditure.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:01:00.000Z',
      },
      {
        id: 'bh-videowall',
        name: 'Videowall',
        color: '#2563EB',
        description: 'Control room videowall installation, display panels, and maintenance.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:02:00.000Z',
      },
      {
        id: 'bh-ofc',
        name: 'Optical Fiber Cable',
        color: '#0891B2',
        description: 'Optical fiber cable laying, splicing, and network connectivity works.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:03:00.000Z',
      },
      {
        id: 'bh-cctv-abhay',
        name: 'CCTV Abhay Command',
        color: '#4F46E5',
        description: 'Abhay Command Center CCTV cameras, surveillance network, and upkeep.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:04:00.000Z',
      },
      {
        id: 'bh-emitra-revenue',
        name: 'Emitra Revenue',
        color: '#16A34A',
        description: 'E-Mitra revenue account, kiosk operations, and settlements.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:05:00.000Z',
      },
      {
        id: 'bh-gst',
        name: 'GST',
        color: '#D97706',
        description: 'Goods and Services Tax remittances and compliance payments.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:06:00.000Z',
      },
      {
        id: 'bh-pop-room',
        name: 'POP_Room',
        color: '#7C3AED',
        description: 'Point of Presence (POP) room infrastructure, UPS, and upkeep.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:07:00.000Z',
      },
      {
        id: 'bh-emitra-plus',
        name: 'E-Mitra Plus',
        color: '#0284C7',
        description: 'E-Mitra Plus self-service kiosk deployment and operational expenses.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:08:00.000Z',
      },
      {
        id: 'bh-state-event',
        name: 'State Level Event',
        color: '#DB2777',
        description: 'State level events, exhibitions, IT stalls, and logistics.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:09:00.000Z',
      },
      {
        id: 'bh-pop-electricity',
        name: 'POP_Room Electricity Return',
        color: '#475569',
        description: 'POP room electricity reimbursements and utility return settlements.',
        createdBy: 'usr-admin-1',
        createdAt: '2026-04-01T09:10:00.000Z',
      },
    ],
    sanctions: [],
    transactions: [],
    autoBackupEnabled: true,
    lastScheduledIstDate: null,
    lastServerBackupAt: null,
    lastDriveSyncAt: null,
    lastDriveFileName: null,
    lastDriveEmail: null,
  };
}

function loadDb(): LocalDatabaseState {
  try {
    const raw = window.localStorage.getItem(DB_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LocalDatabaseState>;
      if (parsed && Array.isArray(parsed.users) && parsed.users.length > 0) {
        return {
          users: parsed.users,
          budgetHeads: Array.isArray(parsed.budgetHeads) ? parsed.budgetHeads : [],
          sanctions: Array.isArray(parsed.sanctions) ? parsed.sanctions : [],
          transactions: Array.isArray(parsed.transactions) ? parsed.transactions : [],
          autoBackupEnabled: parsed.autoBackupEnabled !== false,
          lastScheduledIstDate: parsed.lastScheduledIstDate ?? null,
          lastServerBackupAt: parsed.lastServerBackupAt ?? null,
          lastDriveSyncAt: parsed.lastDriveSyncAt ?? null,
          lastDriveFileName: parsed.lastDriveFileName ?? null,
          lastDriveEmail: parsed.lastDriveEmail ?? null,
        };
      }
    }
  } catch {
    // Fall through to seed
  }
  const seeded = createInitialSeedState();
  saveDb(seeded);
  return seeded;
}

function saveDb(state: LocalDatabaseState): void {
  try {
    window.localStorage.setItem(DB_STORAGE_KEY, JSON.stringify(state));
  } catch (err) {
    console.error('Unable to save local LedgerFlow state:', err);
  }
}

function loadSession(): LocalSessionState | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as LocalSessionState;
  } catch {
    return null;
  }
}

function saveSession(session: LocalSessionState | null): void {
  try {
    if (!session) {
      window.localStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // Ignore storage errors
  }
}

function loadSnapshots(): LocalStoredSnapshot[] {
  try {
    const raw = window.localStorage.getItem(SNAPSHOTS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as LocalStoredSnapshot[]) : [];
  } catch {
    return [];
  }
}

function saveSnapshots(list: LocalStoredSnapshot[]): void {
  try {
    window.localStorage.setItem(SNAPSHOTS_STORAGE_KEY, JSON.stringify(list.slice(0, 15)));
  } catch {
    // Ignore quota overflow for old snapshots
  }
}

function loadAttachmentMap(): Record<string, string> {
  try {
    const raw = window.localStorage.getItem(ATTACHMENTS_STORAGE_KEY);
    if (!raw) return {};
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

function saveAttachmentBase64(storedFileName: string, base64Data: string): void {
  try {
    const map = loadAttachmentMap();
    map[storedFileName] = base64Data;
    window.localStorage.setItem(ATTACHMENTS_STORAGE_KEY, JSON.stringify(map));
  } catch {
    // Ignore quota errors on large PDFs
  }
}

function toSafeUser(u: LocalUserRecord): SafeUser {
  const { password: _pw, ...safe } = u;
  return safe;
}

function checkUserAccessAllowed(user: LocalUserRecord): string | null {
  const now = Date.now();
  if (!user.active) {
    return 'Your account is pending administrator approval or currently deactivated.';
  }
  if (user.activeFrom && now < new Date(user.activeFrom).getTime()) {
    return 'Your account is not active yet for the scheduled window.';
  }
  if (user.activeUntil && now > new Date(user.activeUntil).getTime()) {
    return 'Your account access window has expired.';
  }
  if (user.deactivatedFrom && user.deactivatedUntil) {
    const from = new Date(user.deactivatedFrom).getTime();
    const until = new Date(user.deactivatedUntil).getTime();
    if (now >= from && now <= until) {
      return 'Your account is temporarily deactivated during the scheduled pause window.';
    }
  }
  return null;
}

function requireCurrentUser(db: LocalDatabaseState): { user: LocalUserRecord; session: LocalSessionState } {
  const session = loadSession();
  if (!session) {
    throw new Error('Authentication required. Please sign in.');
  }
  const user = db.users.find((u) => u.id === session.userId);
  if (!user) {
    saveSession(null);
    throw new Error('Session expired. Please sign in again.');
  }
  const accessErr = checkUserAccessAllowed(user);
  if (accessErr) {
    saveSession(null);
    throw new Error(accessErr);
  }
  return { user, session };
}

function requireAdminUser(db: LocalDatabaseState): { user: LocalUserRecord; session: LocalSessionState } {
  const ctx = requireCurrentUser(db);
  if (ctx.user.role !== 'admin') {
    throw new Error('Administrator privileges required.');
  }
  return ctx;
}

function findUserByIdentifierLocal(db: LocalDatabaseState, identifier: string): LocalUserRecord | null {
  const raw = String(identifier || '').trim();
  if (!raw) return null;
  const lower = raw.toLowerCase();
  const normMob = normalizeMobile(raw);
  const digitsOnly = raw.replace(/\D/g, '');

  return (
    db.users.find((u) => {
      if (u.username.toLowerCase() === lower) return true;
      if (normalizeEmail(u.email) === lower) return true;
      if (normMob && normalizeMobile(u.mobile) === normMob) return true;
      if (digitsOnly.length >= 10 && u.mobile.replace(/\D/g, '').endsWith(digitsOnly.slice(-10))) {
        return true;
      }
      return false;
    }) || null
  );
}

interface LedgerFlowAndroidNativeBridge {
  getApiBaseUrl?: () => string;
  isOtpEmailConfigured?: () => boolean;
  sendOtpEmail?: (
    requestId: string,
    toEmail: string,
    fullName: string,
    loginIdentifier: string,
    otp: string,
    purpose: string
  ) => void;
}

declare global {
  interface Window {
    LedgerFlowAndroid?: LedgerFlowAndroidNativeBridge;
    __lfOnOtpEmailResult?: (requestId: string, ok: boolean, errorMessage: string) => void;
  }
}

const pendingEmailOtpRequests = new Map<
  string,
  { resolve: () => void; reject: (err: Error) => void; timer: number }
>();

function ensureAndroidEmailCallbackRegistered(): void {
  if (typeof window === 'undefined' || window.__lfOnOtpEmailResult) return;
  window.__lfOnOtpEmailResult = (requestId: string, ok: boolean, errorMessage: string) => {
    const entry = pendingEmailOtpRequests.get(requestId);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    pendingEmailOtpRequests.delete(requestId);
    if (ok) {
      entry.resolve();
    } else {
      entry.reject(new Error(errorMessage || 'Failed to send OTP email.'));
    }
  };
}

async function deliverEmailOtpFromDevice(params: {
  toEmail: string;
  fullName: string;
  loginIdentifier: string;
  otp: string;
  purpose: 'login' | 'direct-otp' | 'register';
}): Promise<void> {
  const bridge = typeof window !== 'undefined' ? window.LedgerFlowAndroid : undefined;
  if (bridge && typeof bridge.sendOtpEmail === 'function') {
    if (typeof bridge.isOtpEmailConfigured === 'function' && !bridge.isOtpEmailConfigured()) {
      throw new Error(
        'Email OTP delivery is not configured for this APK yet. Add OTP_EMAIL_WEBHOOK_URL in GitHub Repository Secrets and rebuild the APK so OTPs are sent to your registered email.'
      );
    }
    ensureAndroidEmailCallbackRegistered();
    const requestId = uid('mail');
    return new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pendingEmailOtpRequests.delete(requestId);
        reject(new Error('Email OTP delivery timed out. Please check your internet connection and try again.'));
      }, 20000);
      pendingEmailOtpRequests.set(requestId, { resolve, reject, timer });
      try {
        bridge.sendOtpEmail!(
          requestId,
          params.toEmail,
          params.fullName,
          params.loginIdentifier,
          params.otp,
          params.purpose
        );
      } catch (err) {
        window.clearTimeout(timer);
        pendingEmailOtpRequests.delete(requestId);
        reject(err instanceof Error ? err : new Error('Unable to trigger email OTP delivery.'));
      }
    });
  }

  throw new Error(
    'Email OTP delivery is not configured for this build. Configure OTP_EMAIL_WEBHOOK_URL in GitHub Secrets and rebuild the APK so OTPs are sent to registered emails.'
  );
}

async function createOtpChallengeForUser(
  user: LocalUserRecord,
  purpose: 'login' | 'direct-otp' | 'register'
): Promise<OtpChallengeResponse> {
  const cleanEmail = normalizeEmail(user.email || user.username);
  if (!cleanEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(cleanEmail)) {
    throw new Error(
      'No valid registered email address is linked to this account. Please contact your administrator.'
    );
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  await deliverEmailOtpFromDevice({
    toEmail: cleanEmail,
    fullName: user.fullName,
    loginIdentifier: user.username,
    otp: code,
    purpose,
  });

  const id = uid('otp');
  const mEmail = maskEmail(cleanEmail);
  const mMobile = maskMobile(user.mobile);
  const challenge: LocalOtpChallenge = {
    id,
    userId: user.id,
    purpose,
    code,
    maskedEmail: mEmail,
    maskedMobile: mMobile,
    expiresAt: Date.now() + 5 * 60 * 1000,
    attempts: 0,
    consumed: false,
  };
  activeOtpChallenges.set(id, challenge);

  return {
    otpRequired: true,
    purpose,
    challengeId: id,
    maskedEmail: mEmail,
    maskedMobile: mMobile,
    expiresInSeconds: 300,
    resendCooldownSeconds: 30,
    delivery: {
      emailSent: true,
      smsSent: false,
      mode: 'live',
      channels: ['email'],
      notice: `OTP sent to your registered email (${mEmail || cleanEmail}). Please check your inbox (and spam folder).`,
    },
  };
}

function enrichBudgetHeads(db: LocalDatabaseState): BudgetHeadEnriched[] {
  return db.budgetHeads.map((head) => {
    const headSanctions = db.sanctions.filter(
      (s) => s.budgetHeadId === head.id && s.approvalStatus === 'approved'
    );
    const headTxs = db.transactions.filter(
      (t) => t.budgetHeadId === head.id && t.type === 'expense'
    );
    const sanctionedTotal = headSanctions.reduce((sum, s) => sum + Number(s.sanctionAmount || 0), 0);
    const spentTotal = headTxs.reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const remainingBalance = sanctionedTotal - spentTotal;
    const utilizationPct = sanctionedTotal > 0 ? Math.round((spentTotal / sanctionedTotal) * 1000) / 10 : 0;
    const latestFy =
      headSanctions
        .slice()
        .sort((a, b) => b.sanctionDate.localeCompare(a.sanctionDate))[0]?.financialYear || null;

    return {
      ...head,
      sanctionedTotal,
      spentTotal,
      remainingBalance,
      utilizationPct,
      sanctionCount: headSanctions.length,
      latestFinancialYear: latestFy,
    };
  });
}

function enrichSanctions(db: LocalDatabaseState): BudgetSanctionEnriched[] {
  const headMap = new Map(db.budgetHeads.map((h) => [h.id, h]));
  const userMap = new Map(db.users.map((u) => [u.id, u]));
  return db.sanctions
    .slice()
    .sort((a, b) => b.sanctionDate.localeCompare(a.sanctionDate))
    .map((s) => {
      const head = headMap.get(s.budgetHeadId);
      const creator = userMap.get(s.createdBy);
      return {
        ...s,
        budgetHeadName: head?.name || 'Budget Head',
        budgetHeadColor: head?.color || '#1D358F',
        createdByName: creator?.fullName || 'Administrator',
      };
    });
}

function enrichTransactions(db: LocalDatabaseState): TransactionEnriched[] {
  const headMap = new Map(db.budgetHeads.map((h) => [h.id, h]));
  const userMap = new Map(db.users.map((u) => [u.id, u]));
  return db.transactions
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt))
    .map((t) => {
      const head = headMap.get(t.budgetHeadId);
      const owner = userMap.get(t.userId);
      return {
        ...t,
        budgetHeadName: head?.name || 'Budget Head',
        budgetHeadColor: head?.color || '#1D358F',
        userName: owner?.fullName || 'Member',
        userDepartment: owner?.department || 'Operations',
      };
    });
}

function buildSnapshot(
  db: LocalDatabaseState,
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore'
): DatabaseBackupSnapshotPayload {
  return {
    schemaVersion: 1,
    app: 'LedgerFlow',
    exportedAt: new Date().toISOString(),
    timezone: 'Asia/Kolkata',
    trigger,
    counts: {
      users: db.users.length,
      budgetHeads: db.budgetHeads.length,
      budgetSanctions: db.sanctions.length,
      transactions: db.transactions.length,
    },
    data: {
      users: db.users.map((u) => ({ ...u })),
      budgetHeads: db.budgetHeads.map((h) => ({ ...h })),
      budgetSanctions: db.sanctions.map((s) => ({ ...s })),
      transactions: db.transactions.map((t) => ({ ...t })),
    },
  };
}

function captureLocalSnapshot(
  db: LocalDatabaseState,
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore'
): LocalStoredSnapshot {
  const snapshot = buildSnapshot(db, trigger);
  const istDate = getIstDateString();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const prefix =
    trigger === 'scheduled-00:00'
      ? 'ledgerflow-daily-00-00'
      : trigger === 'pre-restore'
        ? 'ledgerflow-pre-restore'
        : 'ledgerflow-backup';
  const fileName = `${prefix}_${stamp}.json`;
  const sizeBytes = new Blob([JSON.stringify(snapshot)]).size;
  const entry: LocalStoredSnapshot = {
    meta: {
      fileName,
      sizeBytes,
      createdAt: snapshot.exportedAt,
      trigger,
      istDate,
      counts: snapshot.counts,
      driveSyncedAt: null,
      driveFileId: null,
    },
    snapshot,
  };
  const list = [entry, ...loadSnapshots()];
  saveSnapshots(list);
  db.lastServerBackupAt = snapshot.exportedAt;
  if (trigger === 'scheduled-00:00') {
    db.lastScheduledIstDate = istDate;
  }
  saveDb(db);
  return entry;
}

function buildBackupStatus(db: LocalDatabaseState): BackupStatusResponse {
  const snapshots = loadSnapshots().map((s) => s.meta);
  return {
    autoBackupEnabled: db.autoBackupEnabled,
    scheduleTime: '00:00',
    timezone: 'Asia/Kolkata',
    adminEmail: DEFAULT_ADMIN_EMAIL,
    lastScheduledIstDate: db.lastScheduledIstDate,
    lastServerBackupAt: db.lastServerBackupAt,
    lastDriveSyncAt: db.lastDriveSyncAt,
    lastDriveFileName: db.lastDriveFileName,
    lastDriveEmail: db.lastDriveEmail,
    nextScheduledRunLabel: db.autoBackupEnabled
      ? 'Daily 00:00 hrs IST (On-Device Auto Snapshot)'
      : 'Auto-backup paused',
    serverSnapshots: snapshots,
    pendingDriveSyncFiles: snapshots.filter((s) => !s.driveSyncedAt),
  };
}

function storeOptionalAttachment(
  base64?: string,
  fileName?: string,
  source?: 'pdf-upload' | 'camera-scan'
): SanctionAttachment | undefined {
  if (!base64 || !fileName) return undefined;
  const storedFileName = `${uid('att')}-${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const cleanB64 = base64.includes(',') ? base64.split(',')[1] : base64;
  const sizeBytes = Math.round((cleanB64.length * 3) / 4);
  saveAttachmentBase64(storedFileName, cleanB64);
  return {
    fileName,
    storedFileName,
    mimeType: 'application/pdf',
    sizeBytes,
    source: source || 'pdf-upload',
    uploadedAt: new Date().toISOString(),
  };
}

function base64ToPdfBlob(storedFileName?: string): Blob {
  if (!storedFileName) {
    throw new Error('No PDF attachment found for this record.');
  }
  const map = loadAttachmentMap();
  const b64 = map[storedFileName];
  if (!b64) {
    throw new Error('PDF attachment is not stored on this device.');
  }
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return new Blob([bytes], { type: 'application/pdf' });
}

export const localAppEngine = {
  async login(username: string, password: string): Promise<LoginResponse> {
    const db = loadDb();
    const user = findUserByIdentifierLocal(db, username);
    if (!user || user.password !== password) {
      throw new Error('Invalid username/email or password.');
    }
    const accessErr = checkUserAccessAllowed(user);
    if (accessErr) throw new Error(accessErr);

    if (isAndroidEmailOtpReady()) {
      return createOtpChallengeForUser(user, 'login');
    }

    // Standalone APK without email webhook configured: sign in cleanly with verified password
    // without displaying any OTP on screen or blocking access.
    const token = uid('sess');
    const loginAt = new Date().toISOString();
    saveSession({
      token,
      userId: user.id,
      loginAt,
      lastActivity: Date.now(),
    });
    return {
      otpRequired: false,
      token,
      user: toSafeUser(user),
      loginAt,
    };
  },

  async requestDirectOtp(identifier: string): Promise<OtpChallengeResponse> {
    const db = loadDb();
    const user = findUserByIdentifierLocal(db, identifier);
    if (!user) {
      throw new Error('No account found matching that mobile number, email, or username.');
    }
    const accessErr = checkUserAccessAllowed(user);
    if (accessErr) throw new Error(accessErr);
    return createOtpChallengeForUser(user, 'direct-otp');
  },

  async verifyLoginOtp(challengeId: string, otp: string): Promise<OtpVerifyResponse> {
    const db = loadDb();
    const challenge = activeOtpChallenges.get(challengeId);
    if (!challenge || challenge.consumed) {
      throw new Error('OTP session expired or invalid. Please request a new OTP.');
    }
    if (Date.now() > challenge.expiresAt) {
      activeOtpChallenges.delete(challengeId);
      throw new Error('OTP has expired. Please request a new code.');
    }
    if (challenge.code !== String(otp || '').trim()) {
      challenge.attempts += 1;
      if (challenge.attempts >= 5) {
        activeOtpChallenges.delete(challengeId);
        throw new Error('Too many failed OTP attempts. Please request a new code.');
      }
      throw new Error('Incorrect OTP code. Please try again.');
    }

    challenge.consumed = true;
    activeOtpChallenges.delete(challengeId);

    const user = db.users.find((u) => u.id === challenge.userId);
    if (!user) throw new Error('Account not found.');

    if (challenge.purpose === 'register' && !user.active) {
      return {
        pendingApproval: true,
        emailVerified: true,
        message:
          'Your email OTP is verified. Your account is now awaiting administrator approval before you can sign in.',
        user: toSafeUser(user),
      };
    }

    const token = uid('sess');
    const loginAt = new Date().toISOString();
    saveSession({
      token,
      userId: user.id,
      loginAt,
      lastActivity: Date.now(),
    });

    return {
      token,
      user: toSafeUser(user),
      loginAt,
    };
  },

  async resendLoginOtp(challengeId: string): Promise<OtpChallengeResponse> {
    const db = loadDb();
    const prev = activeOtpChallenges.get(challengeId);
    if (!prev) throw new Error('OTP challenge not found. Please sign in again.');
    const user = db.users.find((u) => u.id === prev.userId);
    if (!user) throw new Error('Account not found.');
    activeOtpChallenges.delete(challengeId);
    return createOtpChallengeForUser(user, prev.purpose);
  },

  async register(payload: {
    username: string;
    password: string;
    fullName: string;
    department?: string;
    email: string;
    mobile: string;
  }): Promise<RegisterResponse> {
    const db = loadDb();
    const cleanUser = payload.username.trim().toLowerCase();
    const cleanEmail = normalizeEmail(payload.email);
    if (!cleanUser || !payload.password || !payload.fullName.trim()) {
      throw new Error('Please fill in all required registration fields.');
    }
    if (db.users.some((u) => u.username.toLowerCase() === cleanUser || (cleanEmail && normalizeEmail(u.email) === cleanEmail))) {
      throw new Error('An account with this username or email already exists.');
    }

    const created: LocalUserRecord = {
      id: uid('usr'),
      username: cleanUser,
      fullName: payload.fullName.trim(),
      department: payload.department?.trim() || 'Operations',
      email: cleanEmail,
      mobile: normalizeMobile(payload.mobile),
      role: 'user',
      active: false,
      activeFrom: null,
      activeUntil: null,
      deactivatedFrom: null,
      deactivatedUntil: null,
      createdAt: new Date().toISOString(),
      password: payload.password,
    };

    if (isAndroidEmailOtpReady()) {
      const challenge = await createOtpChallengeForUser(created, 'register');
      db.users.push(created);
      saveDb(db);
      return challenge;
    }

    db.users.push(created);
    saveDb(db);
    return {
      otpRequired: false,
      pendingApproval: true,
      message:
        'Your account has been created and is now awaiting administrator approval before you can sign in.',
      user: toSafeUser(created),
    };
  },

  async syncGoogleSession(_idToken: string): Promise<{ user: SafeUser; loginAt?: string }> {
    const db = loadDb();
    const { user, session } = requireCurrentUser(db);
    return { user: toSafeUser(user), loginAt: session.loginAt };
  },

  async me(): Promise<{ user: SafeUser; loginAt?: string }> {
    const db = loadDb();
    const { user, session } = requireCurrentUser(db);
    return { user: toSafeUser(user), loginAt: session.loginAt };
  },

  async pingSession(): Promise<{ ok: boolean; loginAt?: string; lastActivity?: number }> {
    const db = loadDb();
    const { session } = requireCurrentUser(db);
    session.lastActivity = Date.now();
    saveSession(session);
    return { ok: true, loginAt: session.loginAt, lastActivity: session.lastActivity };
  },

  async logout(): Promise<{ ok: boolean }> {
    saveSession(null);
    return { ok: true };
  },

  async getUsers(): Promise<{ users: UserWithStats[] }> {
    const db = loadDb();
    requireAdminUser(db);
    const list: UserWithStats[] = db.users.map((u) => {
      const userTxs = db.transactions.filter((t) => t.userId === u.id && t.type === 'expense');
      return {
        ...toSafeUser(u),
        spentTotal: userTxs.reduce((s, t) => s + Number(t.amount || 0), 0),
        transactionCount: userTxs.length,
      };
    });
    return { users: list };
  },

  async createUser(payload: {
    username: string;
    password: string;
    fullName: string;
    department: string;
    email: string;
    mobile: string;
    role: UserRole;
  }): Promise<{ user: SafeUser }> {
    const db = loadDb();
    requireAdminUser(db);
    const cleanUsername = payload.username.trim().toLowerCase();
    if (db.users.some((u) => u.username.toLowerCase() === cleanUsername)) {
      throw new Error('Username already exists.');
    }
    const created: LocalUserRecord = {
      id: uid('usr'),
      username: cleanUsername,
      fullName: payload.fullName.trim(),
      department: payload.department.trim() || 'Operations',
      email: normalizeEmail(payload.email),
      mobile: normalizeMobile(payload.mobile),
      role: payload.role,
      active: true,
      activeFrom: null,
      activeUntil: null,
      deactivatedFrom: null,
      deactivatedUntil: null,
      createdAt: new Date().toISOString(),
      password: payload.password,
    };
    db.users.push(created);
    saveDb(db);
    return { user: toSafeUser(created) };
  },

  async updateUser(
    id: string,
    payload: Partial<{
      fullName: string;
      department: string;
      email: string;
      mobile: string;
      role: UserRole;
      active: boolean;
      activeFrom: string | null;
      activeUntil: string | null;
      deactivatedFrom: string | null;
      deactivatedUntil: string | null;
      password: string;
    }>
  ): Promise<{ user: SafeUser }> {
    const db = loadDb();
    requireAdminUser(db);
    const target = db.users.find((u) => u.id === id);
    if (!target) throw new Error('User not found.');
    if (payload.fullName !== undefined) target.fullName = payload.fullName.trim();
    if (payload.department !== undefined) target.department = payload.department.trim();
    if (payload.email !== undefined) target.email = normalizeEmail(payload.email);
    if (payload.mobile !== undefined) target.mobile = normalizeMobile(payload.mobile);
    if (payload.role !== undefined) target.role = payload.role;
    if (payload.active !== undefined) target.active = payload.active;
    if (payload.activeFrom !== undefined) target.activeFrom = payload.activeFrom;
    if (payload.activeUntil !== undefined) target.activeUntil = payload.activeUntil;
    if (payload.deactivatedFrom !== undefined) target.deactivatedFrom = payload.deactivatedFrom;
    if (payload.deactivatedUntil !== undefined) target.deactivatedUntil = payload.deactivatedUntil;
    if (payload.password) target.password = payload.password;
    saveDb(db);
    return { user: toSafeUser(target) };
  },

  async deleteUser(id: string): Promise<{ deleted: boolean }> {
    const db = loadDb();
    const { user } = requireAdminUser(db);
    if (user.id === id) throw new Error('You cannot delete your own active admin account.');
    const before = db.users.length;
    db.users = db.users.filter((u) => u.id !== id);
    saveDb(db);
    return { deleted: db.users.length < before };
  },

  async getBudgetHeads(): Promise<{ budgetHeads: BudgetHeadEnriched[] }> {
    const db = loadDb();
    requireCurrentUser(db);
    return { budgetHeads: enrichBudgetHeads(db) };
  },

  async createBudgetHead(payload: {
    name: string;
    color: string;
    description: string;
  }): Promise<{ budgetHead: BudgetHeadEnriched }> {
    const db = loadDb();
    const { user } = requireAdminUser(db);
    const cleanName = payload.name.trim();
    if (!cleanName) throw new Error('Budget head name is required.');
    if (db.budgetHeads.some((h) => h.name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error('A budget head with this name already exists.');
    }
    const created: BudgetHead = {
      id: uid('bh'),
      name: cleanName,
      color: payload.color || '#1D358F',
      description: payload.description?.trim() || '',
      createdBy: user.id,
      createdAt: new Date().toISOString(),
    };
    db.budgetHeads.push(created);
    saveDb(db);
    const enriched = enrichBudgetHeads(db).find((h) => h.id === created.id)!;
    return { budgetHead: enriched };
  },

  async updateBudgetHead(
    id: string,
    payload: Partial<{ name: string; color: string; description: string }>
  ): Promise<{ budgetHead: BudgetHeadEnriched }> {
    const db = loadDb();
    requireAdminUser(db);
    const target = db.budgetHeads.find((h) => h.id === id);
    if (!target) throw new Error('Budget head not found.');
    if (payload.name !== undefined) target.name = payload.name.trim();
    if (payload.color !== undefined) target.color = payload.color;
    if (payload.description !== undefined) target.description = payload.description.trim();
    saveDb(db);
    const enriched = enrichBudgetHeads(db).find((h) => h.id === id)!;
    return { budgetHead: enriched };
  },

  async deleteBudgetHead(id: string): Promise<{ deleted: boolean }> {
    const db = loadDb();
    requireAdminUser(db);
    if (db.transactions.some((t) => t.budgetHeadId === id)) {
      throw new Error('Cannot delete a budget head that has ledger transactions.');
    }
    db.sanctions = db.sanctions.filter((s) => s.budgetHeadId !== id);
    const before = db.budgetHeads.length;
    db.budgetHeads = db.budgetHeads.filter((h) => h.id !== id);
    saveDb(db);
    return { deleted: db.budgetHeads.length < before };
  },

  async bulkDeleteBudgetHeads(
    ids: string[]
  ): Promise<{ deletedCount: number; skippedCount: number; errors: string[] }> {
    const db = loadDb();
    requireAdminUser(db);
    let deletedCount = 0;
    let skippedCount = 0;
    const errors: string[] = [];
    for (const id of ids) {
      const head = db.budgetHeads.find((h) => h.id === id);
      if (!head) continue;
      if (db.transactions.some((t) => t.budgetHeadId === id)) {
        skippedCount += 1;
        errors.push(`Skipped "${head.name}" because it has linked transactions.`);
        continue;
      }
      db.sanctions = db.sanctions.filter((s) => s.budgetHeadId !== id);
      db.budgetHeads = db.budgetHeads.filter((h) => h.id !== id);
      deletedCount += 1;
    }
    saveDb(db);
    return { deletedCount, skippedCount, errors };
  },

  async getSanctions(): Promise<{ sanctions: BudgetSanctionEnriched[] }> {
    const db = loadDb();
    requireCurrentUser(db);
    return { sanctions: enrichSanctions(db) };
  },

  async createSanction(payload: {
    budgetHeadId: string;
    sanctionAmount: number;
    sanctionDate: string;
    sanctionOrderNo: string;
    sanctionedBy: string;
    notes: string;
    attachmentBase64?: string;
    attachmentName?: string;
    attachmentSource?: 'pdf-upload' | 'camera-scan';
  }): Promise<{ sanction: BudgetSanctionEnriched }> {
    const db = loadDb();
    const { user } = requireCurrentUser(db);
    const now = new Date().toISOString();
    const status: SanctionApprovalStatus = user.role === 'admin' ? 'approved' : 'pending';
    const created: BudgetSanction = {
      id: uid('sanc'),
      budgetHeadId: payload.budgetHeadId,
      sanctionAmount: Number(payload.sanctionAmount),
      sanctionDate: payload.sanctionDate,
      financialYear: computeFinancialYear(payload.sanctionDate),
      sanctionOrderNo: payload.sanctionOrderNo.trim(),
      sanctionedBy: payload.sanctionedBy.trim() || 'Technical Director RISL',
      notes: payload.notes?.trim() || '',
      attachment: storeOptionalAttachment(
        payload.attachmentBase64,
        payload.attachmentName,
        payload.attachmentSource
      ),
      approvalStatus: status,
      approvedBy: status === 'approved' ? user.id : null,
      approvedAt: status === 'approved' ? now : null,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    db.sanctions.push(created);
    saveDb(db);
    return { sanction: enrichSanctions(db).find((s) => s.id === created.id)! };
  },

  async updateSanction(
    id: string,
    payload: Partial<{
      budgetHeadId: string;
      sanctionAmount: number;
      sanctionDate: string;
      sanctionOrderNo: string;
      sanctionedBy: string;
      notes: string;
      approvalStatus: SanctionApprovalStatus;
      attachmentBase64: string;
      attachmentName: string;
      attachmentSource: 'pdf-upload' | 'camera-scan';
      removeAttachment: boolean;
    }>
  ): Promise<{ sanction: BudgetSanctionEnriched }> {
    const db = loadDb();
    const { user } = requireAdminUser(db);
    const target = db.sanctions.find((s) => s.id === id);
    if (!target) throw new Error('Budget sanction not found.');
    if (payload.budgetHeadId !== undefined) target.budgetHeadId = payload.budgetHeadId;
    if (payload.sanctionAmount !== undefined) target.sanctionAmount = Number(payload.sanctionAmount);
    if (payload.sanctionDate !== undefined) {
      target.sanctionDate = payload.sanctionDate;
      target.financialYear = computeFinancialYear(payload.sanctionDate);
    }
    if (payload.sanctionOrderNo !== undefined) target.sanctionOrderNo = payload.sanctionOrderNo.trim();
    if (payload.sanctionedBy !== undefined) target.sanctionedBy = payload.sanctionedBy.trim();
    if (payload.notes !== undefined) target.notes = payload.notes.trim();
    if (payload.approvalStatus !== undefined) {
      target.approvalStatus = payload.approvalStatus;
      if (payload.approvalStatus === 'approved') {
        target.approvedBy = user.id;
        target.approvedAt = new Date().toISOString();
      }
    }
    if (payload.removeAttachment) {
      target.attachment = undefined;
    } else if (payload.attachmentBase64 && payload.attachmentName) {
      target.attachment = storeOptionalAttachment(
        payload.attachmentBase64,
        payload.attachmentName,
        payload.attachmentSource
      );
    }
    target.updatedAt = new Date().toISOString();
    saveDb(db);
    return { sanction: enrichSanctions(db).find((s) => s.id === id)! };
  },

  async deleteSanction(id: string): Promise<{ deleted: boolean }> {
    const db = loadDb();
    requireAdminUser(db);
    const before = db.sanctions.length;
    db.sanctions = db.sanctions.filter((s) => s.id !== id);
    saveDb(db);
    return { deleted: db.sanctions.length < before };
  },

  async bulkDeleteSanctions(ids: string[]): Promise<{ deletedCount: number }> {
    const db = loadDb();
    requireAdminUser(db);
    const set = new Set(ids);
    const before = db.sanctions.length;
    db.sanctions = db.sanctions.filter((s) => !set.has(s.id));
    saveDb(db);
    return { deletedCount: before - db.sanctions.length };
  },

  async fetchSanctionPdfBlob(id: string): Promise<Blob> {
    const db = loadDb();
    requireCurrentUser(db);
    const target = db.sanctions.find((s) => s.id === id);
    return base64ToPdfBlob(target?.attachment?.storedFileName);
  },

  async getTransactions(): Promise<{ transactions: TransactionEnriched[] }> {
    const db = loadDb();
    const { user } = requireCurrentUser(db);
    const all = enrichTransactions(db);
    if (user.role === 'admin') {
      return { transactions: all };
    }
    return { transactions: all };
  },

  async createTransaction(payload: {
    budgetHeadId: string;
    userId?: string;
    title: string;
    merchant: string;
    amount: number;
    type: TransactionType;
    paymentMethod: PaymentMethod;
    date: string;
    reference: string;
    notes: string;
    chequeNumber?: string;
    chequeIssueDate?: string;
    sanctionNumber?: string;
    sanctionDate?: string;
    paymentSanctionedByHod?: string;
    chequeAttachmentBase64?: string;
    chequeAttachmentName?: string;
    chequeAttachmentSource?: 'pdf-upload' | 'camera-scan';
    sanctionAttachmentBase64?: string;
    sanctionAttachmentName?: string;
    sanctionAttachmentSource?: 'pdf-upload' | 'camera-scan';
  }): Promise<{ transaction: TransactionEnriched }> {
    const db = loadDb();
    const { user } = requireCurrentUser(db);
    const created: Transaction = {
      id: uid('tx'),
      budgetHeadId: payload.budgetHeadId,
      userId: user.role === 'admin' && payload.userId ? payload.userId : user.id,
      title: payload.title.trim(),
      merchant: payload.merchant.trim(),
      amount: Number(payload.amount),
      type: payload.type,
      status: user.role === 'admin' ? 'approved' : 'pending',
      paymentMethod: payload.paymentMethod,
      date: payload.date,
      financialYear: computeFinancialYear(payload.date),
      reference: payload.reference?.trim() || '',
      notes: payload.notes?.trim() || '',
      chequeNumber: payload.chequeNumber?.trim() || undefined,
      chequeIssueDate: payload.chequeIssueDate || undefined,
      sanctionNumber: payload.sanctionNumber?.trim() || undefined,
      sanctionDate: payload.sanctionDate || undefined,
      paymentSanctionedByHod: payload.paymentSanctionedByHod?.trim() || undefined,
      chequeAttachment: storeOptionalAttachment(
        payload.chequeAttachmentBase64,
        payload.chequeAttachmentName,
        payload.chequeAttachmentSource
      ),
      sanctionAttachment: storeOptionalAttachment(
        payload.sanctionAttachmentBase64,
        payload.sanctionAttachmentName,
        payload.sanctionAttachmentSource
      ),
      createdAt: new Date().toISOString(),
    };
    db.transactions.push(created);
    saveDb(db);
    return { transaction: enrichTransactions(db).find((t) => t.id === created.id)! };
  },

  async updateTransaction(
    id: string,
    payload: Partial<{
      budgetHeadId: string;
      title: string;
      merchant: string;
      amount: number;
      type: TransactionType;
      status: TransactionStatus;
      paymentMethod: PaymentMethod;
      date: string;
      reference: string;
      notes: string;
      chequeNumber: string;
      chequeIssueDate: string;
      sanctionNumber: string;
      sanctionDate: string;
      paymentSanctionedByHod: string;
      chequeAttachmentBase64: string;
      chequeAttachmentName: string;
      chequeAttachmentSource: 'pdf-upload' | 'camera-scan';
      removeChequeAttachment: boolean;
      sanctionAttachmentBase64: string;
      sanctionAttachmentName: string;
      sanctionAttachmentSource: 'pdf-upload' | 'camera-scan';
      removeSanctionAttachment: boolean;
    }>
  ): Promise<{ transaction: TransactionEnriched }> {
    const db = loadDb();
    requireAdminUser(db);
    const target = db.transactions.find((t) => t.id === id);
    if (!target) throw new Error('Transaction not found.');
    if (payload.budgetHeadId !== undefined) target.budgetHeadId = payload.budgetHeadId;
    if (payload.title !== undefined) target.title = payload.title.trim();
    if (payload.merchant !== undefined) target.merchant = payload.merchant.trim();
    if (payload.amount !== undefined) target.amount = Number(payload.amount);
    if (payload.type !== undefined) target.type = payload.type;
    if (payload.status !== undefined) target.status = payload.status;
    if (payload.paymentMethod !== undefined) target.paymentMethod = payload.paymentMethod;
    if (payload.date !== undefined) {
      target.date = payload.date;
      target.financialYear = computeFinancialYear(payload.date);
    }
    if (payload.reference !== undefined) target.reference = payload.reference.trim();
    if (payload.notes !== undefined) target.notes = payload.notes.trim();
    if (payload.chequeNumber !== undefined) target.chequeNumber = payload.chequeNumber.trim() || undefined;
    if (payload.chequeIssueDate !== undefined) target.chequeIssueDate = payload.chequeIssueDate || undefined;
    if (payload.sanctionNumber !== undefined) target.sanctionNumber = payload.sanctionNumber.trim() || undefined;
    if (payload.sanctionDate !== undefined) target.sanctionDate = payload.sanctionDate || undefined;
    if (payload.paymentSanctionedByHod !== undefined) {
      target.paymentSanctionedByHod = payload.paymentSanctionedByHod.trim() || undefined;
    }
    if (payload.removeChequeAttachment) {
      target.chequeAttachment = undefined;
    } else if (payload.chequeAttachmentBase64 && payload.chequeAttachmentName) {
      target.chequeAttachment = storeOptionalAttachment(
        payload.chequeAttachmentBase64,
        payload.chequeAttachmentName,
        payload.chequeAttachmentSource
      );
    }
    if (payload.removeSanctionAttachment) {
      target.sanctionAttachment = undefined;
    } else if (payload.sanctionAttachmentBase64 && payload.sanctionAttachmentName) {
      target.sanctionAttachment = storeOptionalAttachment(
        payload.sanctionAttachmentBase64,
        payload.sanctionAttachmentName,
        payload.sanctionAttachmentSource
      );
    }
    saveDb(db);
    return { transaction: enrichTransactions(db).find((t) => t.id === id)! };
  },

  async deleteTransaction(id: string): Promise<{ deleted: boolean }> {
    const db = loadDb();
    requireAdminUser(db);
    const before = db.transactions.length;
    db.transactions = db.transactions.filter((t) => t.id !== id);
    saveDb(db);
    return { deleted: db.transactions.length < before };
  },

  async bulkDeleteTransactions(ids: string[]): Promise<{ deletedCount: number }> {
    const db = loadDb();
    requireAdminUser(db);
    const set = new Set(ids);
    const before = db.transactions.length;
    db.transactions = db.transactions.filter((t) => !set.has(t.id));
    saveDb(db);
    return { deletedCount: before - db.transactions.length };
  },

  async fetchTransactionAttachmentBlob(id: string, kind: 'cheque' | 'sanction'): Promise<Blob> {
    const db = loadDb();
    requireCurrentUser(db);
    const tx = db.transactions.find((t) => t.id === id);
    const att = kind === 'cheque' ? tx?.chequeAttachment : tx?.sanctionAttachment;
    return base64ToPdfBlob(att?.storedFileName);
  },

  async getAnalytics(days?: number, fy?: string): Promise<{ analytics: AnalyticsSummary }> {
    const db = loadDb();
    const { user } = requireCurrentUser(db);
    const approvedSanctions = db.sanctions.filter((s) => s.approvalStatus === 'approved');
    const fySet = new Set<string>();
    approvedSanctions.forEach((s) => fySet.add(s.financialYear));
    db.transactions.forEach((t) => fySet.add(t.financialYear));
    const availableFinancialYears = Array.from(fySet).sort().reverse();

    const cutoffMs = days && days > 0 ? Date.now() - days * 86400 * 1000 : null;
    const filteredSanctions = approvedSanctions.filter(
      (s) => !fy || fy === 'all' || s.financialYear === fy
    );
    const filteredTxs = db.transactions.filter((t) => {
      if (fy && fy !== 'all' && t.financialYear !== fy) return false;
      if (cutoffMs && new Date(t.date).getTime() < cutoffMs) return false;
      return true;
    });

    const totalSanctioned = filteredSanctions.reduce((sum, s) => sum + Number(s.sanctionAmount || 0), 0);
    const totalSpent = filteredTxs
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const totalIncome = filteredTxs
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + Number(t.amount || 0), 0);
    const remainingBalance = totalSanctioned - totalSpent;
    const utilizationPct =
      totalSanctioned > 0 ? Math.round((totalSpent / totalSanctioned) * 1000) / 10 : 0;

    // Monthly series
    const monthMap = new Map<string, { expense: number; income: number; sanctionPace: number }>();
    filteredTxs.forEach((t) => {
      const key = t.date.slice(0, 7);
      const entry = monthMap.get(key) || { expense: 0, income: 0, sanctionPace: 0 };
      if (t.type === 'expense') entry.expense += Number(t.amount || 0);
      else entry.income += Number(t.amount || 0);
      monthMap.set(key, entry);
    });
    filteredSanctions.forEach((s) => {
      const key = s.sanctionDate.slice(0, 7);
      const entry = monthMap.get(key) || { expense: 0, income: 0, sanctionPace: 0 };
      entry.sanctionPace += Number(s.sanctionAmount || 0);
      monthMap.set(key, entry);
    });
    const monthlySeries = Array.from(monthMap.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([monthKey, val]) => {
        const [y, m] = monthKey.split('-');
        const label = new Date(Number(y), Number(m) - 1, 1).toLocaleDateString('en-IN', {
          month: 'short',
          year: 'numeric',
        });
        return { month: label, monthKey, ...val };
      });

    // Head comparison & share
    const headComparison = db.budgetHeads.map((head) => {
      const sanctioned = filteredSanctions
        .filter((s) => s.budgetHeadId === head.id)
        .reduce((sum, s) => sum + Number(s.sanctionAmount || 0), 0);
      const spent = filteredTxs
        .filter((t) => t.budgetHeadId === head.id && t.type === 'expense')
        .reduce((sum, t) => sum + Number(t.amount || 0), 0);
      const remaining = sanctioned - spent;
      const pct = sanctioned > 0 ? Math.round((spent / sanctioned) * 1000) / 10 : 0;
      return {
        id: head.id,
        name: head.name,
        color: head.color,
        sanctioned,
        spent,
        remaining,
        utilizationPct: pct,
      };
    });

    const headShareBreakdown = headComparison
      .filter((h) => h.spent > 0)
      .map((h) => ({
        id: h.id,
        name: h.name,
        amount: h.spent,
        sharePct: totalSpent > 0 ? Math.round((h.spent / totalSpent) * 1000) / 10 : 0,
        color: h.color,
        count: filteredTxs.filter((t) => t.budgetHeadId === h.id && t.type === 'expense').length,
      }))
      .sort((a, b) => b.amount - a.amount);

    const financialYearBreakdown = availableFinancialYears.map((fyItem) => {
      const fySancs = approvedSanctions.filter((s) => s.financialYear === fyItem);
      const fyTxs = db.transactions.filter((t) => t.financialYear === fyItem && t.type === 'expense');
      const sanctioned = fySancs.reduce((sum, s) => sum + Number(s.sanctionAmount || 0), 0);
      const spent = fyTxs.reduce((sum, t) => sum + Number(t.amount || 0), 0);
      return {
        financialYear: fyItem,
        sanctioned,
        spent,
        utilizationPct: sanctioned > 0 ? Math.round((spent / sanctioned) * 1000) / 10 : 0,
        sanctionCount: fySancs.length,
      };
    });

    const userMap = new Map(db.users.map((u) => [u.id, u]));
    const deptMap = new Map<string, { userId: string; userName: string; department: string; spent: number; transactionCount: number }>();
    filteredTxs
      .filter((t) => t.type === 'expense')
      .forEach((t) => {
        const owner = userMap.get(t.userId);
        const key = owner?.id || 'unassigned';
        const cur = deptMap.get(key) || {
          userId: key,
          userName: owner?.fullName || 'Member',
          department: owner?.department || 'Operations',
          spent: 0,
          transactionCount: 0,
        };
        cur.spent += Number(t.amount || 0);
        cur.transactionCount += 1;
        deptMap.set(key, cur);
      });

    const pmMap = new Map<string, { method: string; amount: number; count: number }>();
    filteredTxs
      .filter((t) => t.type === 'expense')
      .forEach((t) => {
        const cur = pmMap.get(t.paymentMethod) || { method: t.paymentMethod, amount: 0, count: 0 };
        cur.amount += Number(t.amount || 0);
        cur.count += 1;
        pmMap.set(t.paymentMethod, cur);
      });

    const alerts = headComparison
      .filter((h) => h.sanctioned > 0 && h.utilizationPct >= 80)
      .map((h) => ({
        id: `alert-${h.id}`,
        label: h.name,
        context: h.utilizationPct >= 100 ? 'Sanction limit exceeded' : 'Nearing sanction limit',
        utilizationPct: h.utilizationPct,
        spent: h.spent,
        limit: h.sanctioned,
        severity: (h.utilizationPct >= 100 ? 'critical' : 'warning') as 'warning' | 'critical',
      }));

    return {
      analytics: {
        scope: user.role === 'admin' ? 'organization' : 'personal',
        totalSanctioned,
        totalSpent,
        totalIncome,
        remainingBalance,
        utilizationPct,
        sanctionCount: filteredSanctions.length,
        pendingCount: filteredTxs.filter((t) => t.status === 'pending').length,
        flaggedCount: filteredTxs.filter((t) => t.status === 'flagged').length,
        transactionCount: filteredTxs.length,
        availableFinancialYears,
        monthlySeries,
        headShareBreakdown,
        headComparison,
        financialYearBreakdown,
        departmentBreakdown: Array.from(deptMap.values()).sort((a, b) => b.spent - a.spent),
        paymentMethodBreakdown: Array.from(pmMap.values()).sort((a, b) => b.amount - a.amount),
        alerts,
      },
    };
  },

  async importBudgetHeads(rows: ImportBudgetHeadRow[]): Promise<{ summary: ImportResultSummary }> {
    const db = loadDb();
    const { user } = requireAdminUser(db);
    let created = 0;
    let skipped = 0;
    const errors: Array<{ row: number; message: string }> = [];
    for (const r of rows) {
      const name = String(r.name || '').trim();
      if (!name) {
        errors.push({ row: r.rowNumber, message: 'Missing budget head name' });
        continue;
      }
      if (db.budgetHeads.some((h) => h.name.toLowerCase() === name.toLowerCase())) {
        skipped += 1;
        continue;
      }
      db.budgetHeads.push({
        id: uid('bh'),
        name,
        color: r.color || '#1D358F',
        description: r.description || '',
        createdBy: user.id,
        createdAt: new Date().toISOString(),
      });
      created += 1;
    }
    saveDb(db);
    return { summary: { created, updated: 0, skipped, errors } };
  },

  async importSanctions(rows: ImportSanctionRow[]): Promise<{ summary: ImportResultSummary }> {
    const db = loadDb();
    const { user } = requireAdminUser(db);
    let created = 0;
    const errors: Array<{ row: number; message: string }> = [];
    const now = new Date().toISOString();
    for (const r of rows) {
      const head = db.budgetHeads.find(
        (h) => h.name.toLowerCase() === String(r.budgetHeadName || '').trim().toLowerCase()
      );
      if (!head) {
        errors.push({ row: r.rowNumber, message: `Unknown budget head "${r.budgetHeadName}"` });
        continue;
      }
      db.sanctions.push({
        id: uid('sanc'),
        budgetHeadId: head.id,
        sanctionAmount: Number(r.sanctionAmount) || 0,
        sanctionDate: r.sanctionDate || now.slice(0, 10),
        financialYear: computeFinancialYear(r.sanctionDate || now.slice(0, 10)),
        sanctionOrderNo: r.sanctionOrderNo || `SO-${uid('imp')}`,
        sanctionedBy: r.sanctionedBy || 'Technical Director RISL',
        notes: r.notes || '',
        approvalStatus: 'approved',
        approvedBy: user.id,
        approvedAt: now,
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      });
      created += 1;
    }
    saveDb(db);
    return { summary: { created, updated: 0, skipped: 0, errors } };
  },

  async importTransactions(rows: ImportTransactionRow[]): Promise<{ summary: ImportResultSummary }> {
    const db = loadDb();
    const { user } = requireAdminUser(db);
    let created = 0;
    const errors: Array<{ row: number; message: string }> = [];
    const now = new Date().toISOString();
    for (const r of rows) {
      const head = db.budgetHeads.find(
        (h) => h.name.toLowerCase() === String(r.budgetHeadName || '').trim().toLowerCase()
      );
      if (!head) {
        errors.push({ row: r.rowNumber, message: `Unknown budget head "${r.budgetHeadName}"` });
        continue;
      }
      const dateStr = r.date || now.slice(0, 10);
      db.transactions.push({
        id: uid('tx'),
        budgetHeadId: head.id,
        userId: user.id,
        title: r.title || 'Imported Entry',
        merchant: r.merchant || 'Vendor',
        amount: Number(r.amount) || 0,
        type: r.type === 'income' ? 'income' : 'expense',
        status: 'approved',
        paymentMethod: r.paymentMethod || 'Cheque',
        date: dateStr,
        financialYear: computeFinancialYear(dateStr),
        reference: r.reference || '',
        notes: r.notes || '',
        createdAt: now,
      });
      created += 1;
    }
    saveDb(db);
    return { summary: { created, updated: 0, skipped: 0, errors } };
  },

  async importWorkbook(payload: {
    budgetHeads: ImportBudgetHeadRow[];
    sanctions: ImportSanctionRow[];
    transactions: ImportTransactionRow[];
  }): Promise<{ result: WorkbookImportResult }> {
    const headsRes = await this.importBudgetHeads(payload.budgetHeads || []);
    const sanctionsRes = await this.importSanctions(payload.sanctions || []);
    const txRes = await this.importTransactions(payload.transactions || []);
    return {
      result: {
        budgetHeads: headsRes.summary,
        sanctions: sanctionsRes.summary,
        transactions: txRes.summary,
      },
    };
  },

  async getBackupStatus(): Promise<BackupStatusResponse> {
    const db = loadDb();
    requireAdminUser(db);
    return buildBackupStatus(db);
  },

  async exportDatabaseBackup(saveServer = true): Promise<{
    snapshot: DatabaseBackupSnapshotPayload;
    suggestedFileName: string;
    serverMeta?: ServerBackupSnapshotMeta;
  }> {
    const db = loadDb();
    requireAdminUser(db);
    if (saveServer) {
      const stored = captureLocalSnapshot(db, 'manual');
      return {
        snapshot: stored.snapshot,
        suggestedFileName: stored.meta.fileName,
        serverMeta: stored.meta,
      };
    }
    const snapshot = buildSnapshot(db, 'manual');
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return {
      snapshot,
      suggestedFileName: `ledgerflow-backup_${stamp}.json`,
    };
  },

  async fetchServerBackupSnapshot(fileName: string): Promise<{
    fileName: string;
    snapshot: DatabaseBackupSnapshotPayload;
  }> {
    const db = loadDb();
    requireAdminUser(db);
    const found = loadSnapshots().find((s) => s.meta.fileName === fileName);
    if (!found) throw new Error('Selected backup snapshot was not found on this device.');
    return { fileName, snapshot: found.snapshot };
  },

  async markDriveBackupSynced(payload: {
    driveFileId: string;
    driveFileName: string;
    driveEmail?: string;
    serverFileName?: string;
  }): Promise<{ ok: boolean; status: BackupStatusResponse }> {
    const db = loadDb();
    requireAdminUser(db);
    const now = new Date().toISOString();
    db.lastDriveSyncAt = now;
    db.lastDriveFileName = payload.driveFileName;
    if (payload.driveEmail) db.lastDriveEmail = payload.driveEmail;
    saveDb(db);
    if (payload.serverFileName) {
      const list = loadSnapshots().map((item) =>
        item.meta.fileName === payload.serverFileName
          ? {
              ...item,
              meta: { ...item.meta, driveSyncedAt: now, driveFileId: payload.driveFileId },
            }
          : item
      );
      saveSnapshots(list);
    }
    return { ok: true, status: buildBackupStatus(db) };
  },

  async updateBackupConfig(payload: {
    autoBackupEnabled: boolean;
  }): Promise<{ ok: boolean; status: BackupStatusResponse }> {
    const db = loadDb();
    requireAdminUser(db);
    db.autoBackupEnabled = Boolean(payload.autoBackupEnabled);
    saveDb(db);
    return { ok: true, status: buildBackupStatus(db) };
  },

  async restoreDatabaseBackup(payload: {
    snapshot?: DatabaseBackupSnapshotPayload;
    serverFileName?: string;
  }): Promise<{
    restored: boolean;
    counts: BackupCounts;
    preRestoreFileName: string | null;
  }> {
    const db = loadDb();
    const { user: activeAdmin } = requireAdminUser(db);

    let snap = payload.snapshot;
    if (!snap && payload.serverFileName) {
      snap = loadSnapshots().find((s) => s.meta.fileName === payload.serverFileName)?.snapshot;
    }
    if (!snap || snap.app !== 'LedgerFlow' || snap.schemaVersion !== 1 || !snap.data) {
      throw new Error('Provide a valid LedgerFlow JSON backup snapshot to restore.');
    }

    const safety = captureLocalSnapshot(db, 'pre-restore');

    const incomingUsers: LocalUserRecord[] = (snap.data.users as Array<Record<string, unknown>>).map((u) => ({
      id: String(u.id || uid('usr')),
      username: String(u.username || '').trim().toLowerCase(),
      fullName: String(u.fullName || u.username || 'User'),
      department: String(u.department || 'Operations'),
      email: String(u.email || ''),
      mobile: String(u.mobile || ''),
      role: (u.role === 'admin' ? 'admin' : 'user') as UserRole,
      avatarUrl: u.avatarUrl ? String(u.avatarUrl) : undefined,
      active: u.active !== false,
      activeFrom: u.activeFrom ? String(u.activeFrom) : null,
      activeUntil: u.activeUntil ? String(u.activeUntil) : null,
      deactivatedFrom: u.deactivatedFrom ? String(u.deactivatedFrom) : null,
      deactivatedUntil: u.deactivatedUntil ? String(u.deactivatedUntil) : null,
      createdAt: String(u.createdAt || new Date().toISOString()),
      password: typeof u.password === 'string' && u.password ? u.password : 'admin123',
    }));

    if (!incomingUsers.some((u) => u.id === activeAdmin.id || u.username === activeAdmin.username)) {
      incomingUsers.unshift(activeAdmin);
    }

    db.users = incomingUsers;
    db.budgetHeads = (snap.data.budgetHeads as BudgetHead[]) || [];
    db.sanctions = (snap.data.budgetSanctions as BudgetSanction[]) || [];
    db.transactions = (snap.data.transactions as Transaction[]) || [];
    saveDb(db);

    return {
      restored: true,
      counts: {
        users: db.users.length,
        budgetHeads: db.budgetHeads.length,
        budgetSanctions: db.sanctions.length,
        transactions: db.transactions.length,
      },
      preRestoreFileName: safety.meta.fileName,
    };
  },
};
