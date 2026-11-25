import crypto from 'node:crypto';
import { desc, eq, or } from 'drizzle-orm';
import {
  db,
  ensureDatabaseReady,
  isEmbeddedDatabase,
  readEmbeddedSnapshotFromDisk,
  writeEmbeddedSnapshotToDisk,
} from './index.ts';
import {
  budgetHeads,
  budgetSanctions,
  otpChallenges,
  transactions,
  users,
} from './schema.ts';
import { ADMIN_GMAIL, normalizeEmail, normalizeMobile } from '../lib/otp-delivery.ts';
import type {
  BudgetHead,
  BudgetSanction,
  PaymentMethod,
  SafeUser,
  SanctionApprovalStatus,
  SanctionAttachment,
  Transaction,
  TransactionStatus,
  TransactionType,
  UserRole,
} from '../types/finance.ts';

export interface StoredUser extends SafeUser {
  firebaseUid?: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
}

export interface StoredOtpChallenge {
  id: string;
  userId: string;
  purpose: string;
  codeHash: string;
  channels: string;
  maskedEmail: string | null;
  maskedMobile: string | null;
  deliverySummary: string | null;
  attempts: number;
  maxAttempts: number;
  expiresAt: Date;
  consumedAt: Date | null;
  createdAt: Date;
}

const DEFAULT_ADMIN_EMAIL = ADMIN_GMAIL;

export function computeFinancialYear(isoDate: string): string {
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

export function hashPassword(password: string, existingSalt?: string): { hash: string; salt: string } {
  const salt = existingSalt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { hash, salt };
}

export function verifyPassword(password: string, storedHash: string | null, salt: string | null): boolean {
  if (!storedHash || !salt) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(storedHash, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

function parseAttachment(raw: string | null | undefined): SanctionAttachment | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SanctionAttachment;
  } catch {
    return undefined;
  }
}

function serializeAttachment(att?: SanctionAttachment): string | null {
  if (!att) return null;
  return JSON.stringify(att);
}

function mapOptionalDate(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return d instanceof Date ? d.toISOString() : String(d);
}

function mapUserRow(row: typeof users.$inferSelect): StoredUser {
  return {
    id: row.id,
    firebaseUid: row.firebaseUid,
    username: row.username,
    fullName: row.fullName,
    department: row.department,
    email: row.email || '',
    mobile: row.mobile || '',
    role: row.role === 'admin' ? 'admin' : 'user',
    avatarUrl: row.avatarUrl || undefined,
    active: row.active,
    activeFrom: mapOptionalDate(row.activeFrom),
    activeUntil: mapOptionalDate(row.activeUntil),
    deactivatedFrom: mapOptionalDate(row.deactivatedFrom),
    deactivatedUntil: mapOptionalDate(row.deactivatedUntil),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    passwordHash: row.passwordHash,
    passwordSalt: row.passwordSalt,
  };
}

function mapBudgetHeadRow(row: typeof budgetHeads.$inferSelect): BudgetHead {
  return {
    id: row.id,
    name: row.name,
    color: row.color,
    description: row.description,
    createdBy: row.createdBy || 'usr-admin-1',
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

function mapSanctionRow(row: typeof budgetSanctions.$inferSelect): BudgetSanction {
  const statusRaw = row.approvalStatus;
  const approvalStatus: SanctionApprovalStatus =
    statusRaw === 'pending' || statusRaw === 'rejected' ? statusRaw : 'approved';
  return {
    id: row.id,
    budgetHeadId: row.budgetHeadId,
    sanctionAmount: Number(row.sanctionAmount),
    sanctionDate: row.sanctionDate,
    financialYear: row.financialYear,
    sanctionOrderNo: row.sanctionOrderNo,
    sanctionedBy: row.sanctionedBy,
    notes: row.notes,
    attachment: parseAttachment(row.attachmentJson),
    approvalStatus,
    approvedBy: row.approvedBy || null,
    approvedAt: mapOptionalDate(row.approvedAt),
    createdBy: row.createdBy || 'usr-admin-1',
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
    updatedAt: row.updatedAt instanceof Date ? row.updatedAt.toISOString() : String(row.updatedAt),
  };
}

function mapTransactionRow(row: typeof transactions.$inferSelect): Transaction {
  return {
    id: row.id,
    budgetHeadId: row.budgetHeadId,
    userId: row.userId || '',
    title: row.title,
    merchant: row.merchant,
    amount: Number(row.amount),
    type: row.type === 'income' ? 'income' : 'expense',
    status: (['approved', 'pending', 'flagged'].includes(row.status)
      ? row.status
      : 'approved') as TransactionStatus,
    paymentMethod: row.paymentMethod as PaymentMethod,
    date: row.date,
    financialYear: row.financialYear,
    reference: row.reference,
    notes: row.notes,
    chequeNumber: row.chequeNumber || undefined,
    chequeIssueDate: row.chequeIssueDate || undefined,
    sanctionNumber: row.sanctionNumber || undefined,
    sanctionDate: row.sanctionDate || undefined,
    paymentSanctionedByHod: row.paymentSanctionedByHod || undefined,
    chequeAttachment: parseAttachment(row.chequeAttachmentJson),
    sanctionAttachment: parseAttachment(row.sanctionAttachmentJson),
    createdAt: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
  };
}

// ── Idempotent Lazy Seed ─────────────────────────────────────────────────────

let seedPromise: Promise<void> | null = null;
let seeded = false;

async function persistEmbeddedStateIfNeeded(): Promise<void> {
  if (!isEmbeddedDatabase) return;
  try {
    const snapshot = await collectCurrentDatabaseSnapshot('manual');
    writeEmbeddedSnapshotToDisk(snapshot);
  } catch (err) {
    console.error('persistEmbeddedStateIfNeeded failed:', err);
  }
}

export async function ensureInitialSeed(): Promise<void> {
  if (seeded) return;
  if (seedPromise) return seedPromise;

  seedPromise = (async () => {
    try {
      await ensureDatabaseReady();
      const existingUsers = await db.select({ id: users.id }).from(users).limit(1);
      if (existingUsers.length > 0) {
        seeded = true;
        return;
      }

      // In embedded mode, restore persisted atomic snapshot from disk if available
      if (isEmbeddedDatabase) {
        const diskSnapshot = readEmbeddedSnapshotFromDisk();
        if (diskSnapshot) {
          try {
            await applySnapshotWithoutSeedCheck(diskSnapshot);
            const restoredUsers = await db.select({ id: users.id }).from(users).limit(1);
            if (restoredUsers.length > 0) {
              seeded = true;
              return;
            }
          } catch (hydrateErr) {
            console.warn('Could not hydrate embedded DB from disk snapshot; seeding defaults:', hydrateErr);
          }
        }
      }

      const adminPw = hashPassword('admin123');
      const userPw = hashPassword('user123');

      await db
        .insert(users)
        .values([
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
            passwordHash: adminPw.hash,
            passwordSalt: adminPw.salt,
            createdAt: new Date('2026-01-10T09:00:00.000Z'),
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
            passwordHash: userPw.hash,
            passwordSalt: userPw.salt,
            createdAt: new Date('2026-01-14T10:30:00.000Z'),
          },
          {
            id: 'usr-user-2',
            username: 'priya.nair',
            fullName: 'Priya Nair',
            department: 'Field Operations',
            email: 'priya.nair@ledgerflow.in',
            mobile: '+919822004455',
            role: 'user',
            active: true,
            passwordHash: userPw.hash,
            passwordSalt: userPw.salt,
            createdAt: new Date('2026-02-02T11:15:00.000Z'),
          },
        ])
        .onConflictDoNothing();

      await db
        .insert(budgetHeads)
        .values([
          {
            id: 'bh-taxi-rent',
            name: 'Taxi(Rent)',
            color: '#0F766E',
            description: 'Hired taxi and vehicle rental expenditure.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:00:00.000Z'),
          },
          {
            id: 'bh-taxi-security',
            name: 'Taxi(Security)',
            color: '#0D9488',
            description: 'Security escort and dedicated taxi deployment expenditure.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:01:00.000Z'),
          },
          {
            id: 'bh-videowall',
            name: 'Videowall',
            color: '#2563EB',
            description: 'Control room videowall installation, display panels, and maintenance.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:02:00.000Z'),
          },
          {
            id: 'bh-ofc',
            name: 'Optical Fiber Cable',
            color: '#0891B2',
            description: 'Optical fiber cable laying, splicing, and network connectivity works.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:03:00.000Z'),
          },
          {
            id: 'bh-cctv-abhay',
            name: 'CCTV Abhay Command',
            color: '#4F46E5',
            description: 'Abhay Command Center CCTV cameras, surveillance network, and upkeep.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:04:00.000Z'),
          },
          {
            id: 'bh-emitra-revenue',
            name: 'Emitra Revenue',
            color: '#16A34A',
            description: 'E-Mitra revenue account, kiosk operations, and settlements.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:05:00.000Z'),
          },
          {
            id: 'bh-gst',
            name: 'GST',
            color: '#D97706',
            description: 'Goods and Services Tax remittances and compliance payments.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:06:00.000Z'),
          },
          {
            id: 'bh-pop-room',
            name: 'POP_Room',
            color: '#7C3AED',
            description: 'Point of Presence (POP) room infrastructure, UPS, and upkeep.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:07:00.000Z'),
          },
          {
            id: 'bh-emitra-plus',
            name: 'E-Mitra Plus',
            color: '#0284C7',
            description: 'E-Mitra Plus self-service kiosk deployment and operational expenses.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:08:00.000Z'),
          },
          {
            id: 'bh-state-event',
            name: 'State Level Event',
            color: '#DB2777',
            description: 'State level events, exhibitions, IT stalls, and logistics.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:09:00.000Z'),
          },
          {
            id: 'bh-pop-electricity',
            name: 'POP_Room Electricity Return',
            color: '#475569',
            description: 'POP room electricity reimbursements and utility return settlements.',
            createdBy: 'usr-admin-1',
            createdAt: new Date('2026-04-01T09:10:00.000Z'),
          },
        ])
        .onConflictDoNothing();

      seeded = true;
      await persistEmbeddedStateIfNeeded();
    } catch (error) {
      seedPromise = null;
      console.error('Database seed failed:', error);
      throw new Error('Failed to initialize workspace records.', { cause: error });
    }
  })();

  return seedPromise;
}

// ── Users Repository ─────────────────────────────────────────────────────────

export async function listUsers(): Promise<StoredUser[]> {
  try {
    await ensureInitialSeed();
    const rows = await db.select().from(users).orderBy(users.createdAt);
    return rows.map(mapUserRow);
  } catch (error) {
    console.error('listUsers failed:', error);
    throw new Error('Failed to load user accounts.', { cause: error });
  }
}

export async function findUserById(id: string): Promise<StoredUser | null> {
  try {
    await ensureInitialSeed();
    const rows = await db.select().from(users).where(eq(users.id, id)).limit(1);
    return rows[0] ? mapUserRow(rows[0]) : null;
  } catch (error) {
    console.error('findUserById failed:', error);
    throw new Error('Failed to look up user account.', { cause: error });
  }
}

export async function findUserByUsername(username: string): Promise<StoredUser | null> {
  try {
    await ensureInitialSeed();
    const clean = username.trim().toLowerCase();
    const rows = await db.select().from(users).where(eq(users.username, clean)).limit(1);
    return rows[0] ? mapUserRow(rows[0]) : null;
  } catch (error) {
    console.error('findUserByUsername failed:', error);
    throw new Error('Failed to look up user account.', { cause: error });
  }
}

export async function findUserByIdentifier(identifier: string): Promise<StoredUser | null> {
  try {
    await ensureInitialSeed();
    const raw = identifier.trim();
    const lower = raw.toLowerCase();
    const normEmail = normalizeEmail(raw);
    const normMobile = normalizeMobile(raw);

    const conditions = [eq(users.username, lower)];
    if (normEmail) conditions.push(eq(users.email, normEmail));
    if (normMobile) conditions.push(eq(users.mobile, normMobile));

    const rows = await db
      .select()
      .from(users)
      .where(or(...conditions))
      .limit(1);

    return rows[0] ? mapUserRow(rows[0]) : null;
  } catch (error) {
    console.error('findUserByIdentifier failed:', error);
    throw new Error('Failed to look up account by email, mobile, or username.', { cause: error });
  }
}

export async function createUserRecord(input: {
  username: string;
  fullName: string;
  department?: string;
  email: string;
  mobile: string;
  role: UserRole;
  active?: boolean;
  passwordHash: string | null;
  passwordSalt: string | null;
  firebaseUid?: string | null;
  avatarUrl?: string | null;
}): Promise<StoredUser> {
  try {
    await ensureInitialSeed();
    const id = `usr-${crypto.randomUUID().slice(0, 8)}`;
    const [inserted] = await db
      .insert(users)
      .values({
        id,
        firebaseUid: input.firebaseUid || null,
        username: input.username.trim().toLowerCase(),
        fullName: input.fullName.trim(),
        department: (input.department || '').trim() || 'General',
        email: normalizeEmail(input.email),
        mobile: normalizeMobile(input.mobile),
        role: input.role,
        avatarUrl: input.avatarUrl || null,
        active: input.active ?? true,
        passwordHash: input.passwordHash,
        passwordSalt: input.passwordSalt,
      })
      .returning();
    await persistEmbeddedStateIfNeeded();
    return mapUserRow(inserted);
  } catch (error) {
    console.error('createUserRecord failed:', error);
    throw new Error('Failed to create user account.', { cause: error });
  }
}

export async function updateUserRecord(
  id: string,
  updates: Partial<{
    fullName: string;
    department: string;
    email: string;
    mobile: string;
    role: UserRole;
    active: boolean;
    activeFrom: Date | null;
    activeUntil: Date | null;
    deactivatedFrom: Date | null;
    deactivatedUntil: Date | null;
    passwordHash: string;
    passwordSalt: string;
    firebaseUid: string;
    avatarUrl: string;
  }>
): Promise<StoredUser | null> {
  try {
    await ensureInitialSeed();
    const payload: Partial<typeof users.$inferInsert> = {};
    if (updates.fullName !== undefined) payload.fullName = updates.fullName;
    if (updates.department !== undefined) payload.department = updates.department;
    if (updates.email !== undefined) payload.email = normalizeEmail(updates.email);
    if (updates.mobile !== undefined) payload.mobile = normalizeMobile(updates.mobile);
    if (updates.role !== undefined) payload.role = updates.role;
    if (updates.active !== undefined) payload.active = updates.active;
    if (updates.activeFrom !== undefined) payload.activeFrom = updates.activeFrom;
    if (updates.activeUntil !== undefined) payload.activeUntil = updates.activeUntil;
    if (updates.deactivatedFrom !== undefined) payload.deactivatedFrom = updates.deactivatedFrom;
    if (updates.deactivatedUntil !== undefined) payload.deactivatedUntil = updates.deactivatedUntil;
    if (updates.passwordHash !== undefined) payload.passwordHash = updates.passwordHash;
    if (updates.passwordSalt !== undefined) payload.passwordSalt = updates.passwordSalt;
    if (updates.firebaseUid !== undefined) payload.firebaseUid = updates.firebaseUid;
    if (updates.avatarUrl !== undefined) payload.avatarUrl = updates.avatarUrl;

    const [updated] = await db
      .update(users)
      .set(payload)
      .where(eq(users.id, id))
      .returning();
    if (updated) await persistEmbeddedStateIfNeeded();
    return updated ? mapUserRow(updated) : null;
  } catch (error) {
    console.error('updateUserRecord failed:', error);
    throw new Error('Failed to update user account.', { cause: error });
  }
}

export async function deleteUserRecord(id: string): Promise<boolean> {
  try {
    await ensureInitialSeed();
    const deleted = await db.delete(users).where(eq(users.id, id)).returning({ id: users.id });
    if (deleted.length > 0) await persistEmbeddedStateIfNeeded();
    return deleted.length > 0;
  } catch (error) {
    console.error('deleteUserRecord failed:', error);
    throw new Error('Failed to delete user account.', { cause: error });
  }
}

export async function upsertFirebaseUser(params: {
  uid: string;
  email?: string | null;
  displayName?: string | null;
  photoURL?: string | null;
}): Promise<StoredUser> {
  try {
    await ensureInitialSeed();
    const cleanEmail = normalizeEmail(params.email || '');

    // 1. Check by firebaseUid
    const byUid = await db
      .select()
      .from(users)
      .where(eq(users.firebaseUid, params.uid))
      .limit(1);
    if (byUid[0]) {
      const existing = byUid[0];
      const nextAvatar = params.photoURL || existing.avatarUrl || undefined;
      if (nextAvatar && nextAvatar !== existing.avatarUrl) {
        const updated = await updateUserRecord(existing.id, { avatarUrl: nextAvatar });
        if (updated) return updated;
      }
      return mapUserRow(existing);
    }

    // 2. Link by verified email if an account already exists (e.g. seeded admin)
    if (cleanEmail) {
      const byEmail = await db
        .select()
        .from(users)
        .where(eq(users.email, cleanEmail))
        .limit(1);
      if (byEmail[0]) {
        const linked = await updateUserRecord(byEmail[0].id, {
          firebaseUid: params.uid,
          avatarUrl: params.photoURL || byEmail[0].avatarUrl || undefined,
        });
        if (linked) return linked;
      }
    }

    // 3. Provision a new Cloud SQL user record using upsert
    const baseHandle = (cleanEmail.split('@')[0] || params.displayName || 'member')
      .toLowerCase()
      .replace(/[^a-z0-9._-]/g, '.')
      .replace(/\.+/g, '.')
      .replace(/^\.|\.$/g, '')
      .slice(0, 22);
    const candidateUsername = baseHandle.length >= 3 ? baseHandle : `user.${params.uid.slice(0, 6).toLowerCase()}`;
    const existingHandle = await findUserByUsername(candidateUsername);
    const finalUsername = existingHandle
      ? `${candidateUsername.slice(0, 24)}.${crypto.randomBytes(2).toString('hex')}`
      : candidateUsername;

    const assignedRole: UserRole = cleanEmail === DEFAULT_ADMIN_EMAIL ? 'admin' : 'user';
    const isInitialActive = assignedRole === 'admin';
    const newId = `usr-${crypto.randomUUID().slice(0, 8)}`;

    const [upserted] = await db
      .insert(users)
      .values({
        id: newId,
        firebaseUid: params.uid,
        username: finalUsername,
        fullName: params.displayName?.trim() || finalUsername,
        department: assignedRole === 'admin' ? 'Executive Finance' : 'General',
        email: cleanEmail,
        mobile: '',
        role: assignedRole,
        avatarUrl: params.photoURL || null,
        active: isInitialActive,
        passwordHash: null,
        passwordSalt: null,
      })
      .onConflictDoUpdate({
        target: users.firebaseUid,
        set: {
          email: cleanEmail,
          avatarUrl: params.photoURL || null,
        },
      })
      .returning();

    await persistEmbeddedStateIfNeeded();
    return mapUserRow(upserted);
  } catch (error) {
    console.error('upsertFirebaseUser failed:', error);
    throw new Error('Failed to sync authenticated user account.', { cause: error });
  }
}

// ── OTP Challenges Repository ────────────────────────────────────────────────

export async function createOtpChallengeRecord(input: {
  userId: string;
  purpose: 'login' | 'direct-otp' | 'register';
  codeHash: string;
  channels: string;
  maskedEmail: string | null;
  maskedMobile: string | null;
  deliverySummary: string;
  expiresAt: Date;
}): Promise<StoredOtpChallenge> {
  try {
    await ensureInitialSeed();
    const id = `otp-${crypto.randomUUID()}`;
    const [inserted] = await db
      .insert(otpChallenges)
      .values({
        id,
        userId: input.userId,
        purpose: input.purpose,
        codeHash: input.codeHash,
        channels: input.channels,
        maskedEmail: input.maskedEmail,
        maskedMobile: input.maskedMobile,
        deliverySummary: input.deliverySummary,
        attempts: 0,
        maxAttempts: 5,
        expiresAt: input.expiresAt,
      })
      .returning();
    return inserted;
  } catch (error) {
    console.error('createOtpChallengeRecord failed:', error);
    throw new Error('Failed to create verification challenge.', { cause: error });
  }
}

export async function getOtpChallengeById(id: string): Promise<StoredOtpChallenge | null> {
  try {
    await ensureInitialSeed();
    const rows = await db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.id, id))
      .limit(1);
    return rows[0] || null;
  } catch (error) {
    console.error('getOtpChallengeById failed:', error);
    throw new Error('Failed to load verification challenge.', { cause: error });
  }
}

export async function getLatestOtpChallengeForUser(userId: string): Promise<StoredOtpChallenge | null> {
  try {
    await ensureInitialSeed();
    const rows = await db
      .select()
      .from(otpChallenges)
      .where(eq(otpChallenges.userId, userId))
      .orderBy(desc(otpChallenges.createdAt))
      .limit(1);
    return rows[0] || null;
  } catch (error) {
    console.error('getLatestOtpChallengeForUser failed:', error);
    throw new Error('Failed to check recent verification requests.', { cause: error });
  }
}

export async function incrementOtpAttempts(id: string, nextAttempts: number): Promise<void> {
  try {
    await db
      .update(otpChallenges)
      .set({ attempts: nextAttempts })
      .where(eq(otpChallenges.id, id));
  } catch (error) {
    console.error('incrementOtpAttempts failed:', error);
    throw new Error('Failed to update verification attempts.', { cause: error });
  }
}

export async function consumeOtpChallenge(id: string): Promise<void> {
  try {
    await db
      .update(otpChallenges)
      .set({ consumedAt: new Date() })
      .where(eq(otpChallenges.id, id));
  } catch (error) {
    console.error('consumeOtpChallenge failed:', error);
    throw new Error('Failed to complete verification challenge.', { cause: error });
  }
}

// ── Budget Heads Repository ──────────────────────────────────────────────────

export async function listBudgetHeads(): Promise<BudgetHead[]> {
  try {
    await ensureInitialSeed();
    const rows = await db.select().from(budgetHeads).orderBy(budgetHeads.createdAt);
    return rows.map(mapBudgetHeadRow);
  } catch (error) {
    console.error('listBudgetHeads failed:', error);
    throw new Error('Failed to load budget heads.', { cause: error });
  }
}

export async function findBudgetHeadById(id: string): Promise<BudgetHead | null> {
  try {
    await ensureInitialSeed();
    const rows = await db.select().from(budgetHeads).where(eq(budgetHeads.id, id)).limit(1);
    return rows[0] ? mapBudgetHeadRow(rows[0]) : null;
  } catch (error) {
    console.error('findBudgetHeadById failed:', error);
    throw new Error('Failed to look up budget head.', { cause: error });
  }
}

export async function createBudgetHeadRecord(input: {
  name: string;
  color: string;
  description: string;
  createdBy: string;
}): Promise<BudgetHead> {
  try {
    await ensureInitialSeed();
    const id = `bh-${crypto.randomUUID().slice(0, 8)}`;
    const [inserted] = await db
      .insert(budgetHeads)
      .values({
        id,
        name: input.name,
        color: input.color,
        description: input.description,
        createdBy: input.createdBy,
      })
      .returning();
    await persistEmbeddedStateIfNeeded();
    return mapBudgetHeadRow(inserted);
  } catch (error) {
    console.error('createBudgetHeadRecord failed:', error);
    throw new Error('Failed to create budget head.', { cause: error });
  }
}

export async function updateBudgetHeadRecord(
  id: string,
  updates: Partial<{ name: string; color: string; description: string }>
): Promise<BudgetHead | null> {
  try {
    await ensureInitialSeed();
    const [updated] = await db
      .update(budgetHeads)
      .set(updates)
      .where(eq(budgetHeads.id, id))
      .returning();
    if (updated) await persistEmbeddedStateIfNeeded();
    return updated ? mapBudgetHeadRow(updated) : null;
  } catch (error) {
    console.error('updateBudgetHeadRecord failed:', error);
    throw new Error('Failed to update budget head.', { cause: error });
  }
}

export async function deleteBudgetHeadRecord(id: string): Promise<boolean> {
  try {
    await ensureInitialSeed();
    const deleted = await db.delete(budgetHeads).where(eq(budgetHeads.id, id)).returning({ id: budgetHeads.id });
    if (deleted.length > 0) await persistEmbeddedStateIfNeeded();
    return deleted.length > 0;
  } catch (error) {
    console.error('deleteBudgetHeadRecord failed:', error);
    throw new Error('Failed to delete budget head.', { cause: error });
  }
}

// ── Budget Sanctions Repository ──────────────────────────────────────────────

export async function listSanctions(): Promise<BudgetSanction[]> {
  try {
    await ensureInitialSeed();
    const rows = await db
      .select()
      .from(budgetSanctions)
      .orderBy(desc(budgetSanctions.sanctionDate), desc(budgetSanctions.createdAt));
    return rows.map(mapSanctionRow);
  } catch (error) {
    console.error('listSanctions failed:', error);
    throw new Error('Failed to load budget sanctions.', { cause: error });
  }
}

export async function findSanctionById(id: string): Promise<BudgetSanction | null> {
  try {
    await ensureInitialSeed();
    const rows = await db.select().from(budgetSanctions).where(eq(budgetSanctions.id, id)).limit(1);
    return rows[0] ? mapSanctionRow(rows[0]) : null;
  } catch (error) {
    console.error('findSanctionById failed:', error);
    throw new Error('Failed to look up budget sanction.', { cause: error });
  }
}

export async function createSanctionRecord(input: {
  id?: string;
  budgetHeadId: string;
  sanctionAmount: number;
  sanctionDate: string;
  financialYear: string;
  sanctionOrderNo: string;
  sanctionedBy: string;
  notes: string;
  attachment?: SanctionAttachment;
  approvalStatus?: SanctionApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  createdBy: string;
}): Promise<BudgetSanction> {
  try {
    await ensureInitialSeed();
    const id = input.id || `sanc-${crypto.randomUUID().slice(0, 8)}`;
    const now = new Date();
    const status: SanctionApprovalStatus = input.approvalStatus || 'approved';
    const [inserted] = await db
      .insert(budgetSanctions)
      .values({
        id,
        budgetHeadId: input.budgetHeadId,
        sanctionAmount: input.sanctionAmount,
        sanctionDate: input.sanctionDate,
        financialYear: input.financialYear,
        sanctionOrderNo: input.sanctionOrderNo,
        sanctionedBy: input.sanctionedBy,
        notes: input.notes,
        attachmentJson: serializeAttachment(input.attachment),
        approvalStatus: status,
        approvedBy: input.approvedBy ?? (status === 'approved' ? input.createdBy : null),
        approvedAt: input.approvedAt ?? (status === 'approved' ? now : null),
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await persistEmbeddedStateIfNeeded();
    return mapSanctionRow(inserted);
  } catch (error) {
    console.error('createSanctionRecord failed:', error);
    throw new Error('Failed to record budget sanction.', { cause: error });
  }
}

export async function updateSanctionRecord(
  id: string,
  updates: Partial<{
    budgetHeadId: string;
    sanctionAmount: number;
    sanctionDate: string;
    financialYear: string;
    sanctionOrderNo: string;
    sanctionedBy: string;
    notes: string;
    attachment: SanctionAttachment | undefined;
    clearAttachment: boolean;
    approvalStatus: SanctionApprovalStatus;
    approvedBy: string | null;
    approvedAt: Date | null;
  }>
): Promise<BudgetSanction | null> {
  try {
    await ensureInitialSeed();
    const payload: Partial<typeof budgetSanctions.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (updates.budgetHeadId !== undefined) payload.budgetHeadId = updates.budgetHeadId;
    if (updates.sanctionAmount !== undefined) payload.sanctionAmount = updates.sanctionAmount;
    if (updates.sanctionDate !== undefined) payload.sanctionDate = updates.sanctionDate;
    if (updates.financialYear !== undefined) payload.financialYear = updates.financialYear;
    if (updates.sanctionOrderNo !== undefined) payload.sanctionOrderNo = updates.sanctionOrderNo;
    if (updates.sanctionedBy !== undefined) payload.sanctionedBy = updates.sanctionedBy;
    if (updates.notes !== undefined) payload.notes = updates.notes;
    if (updates.approvalStatus !== undefined) payload.approvalStatus = updates.approvalStatus;
    if (updates.approvedBy !== undefined) payload.approvedBy = updates.approvedBy;
    if (updates.approvedAt !== undefined) payload.approvedAt = updates.approvedAt;
    if (updates.clearAttachment) {
      payload.attachmentJson = null;
    } else if (updates.attachment !== undefined) {
      payload.attachmentJson = serializeAttachment(updates.attachment);
    }

    const [updated] = await db
      .update(budgetSanctions)
      .set(payload)
      .where(eq(budgetSanctions.id, id))
      .returning();
    if (updated) await persistEmbeddedStateIfNeeded();
    return updated ? mapSanctionRow(updated) : null;
  } catch (error) {
    console.error('updateSanctionRecord failed:', error);
    throw new Error('Failed to update budget sanction.', { cause: error });
  }
}

export async function deleteSanctionRecord(id: string): Promise<BudgetSanction | null> {
  try {
    await ensureInitialSeed();
    const [deleted] = await db
      .delete(budgetSanctions)
      .where(eq(budgetSanctions.id, id))
      .returning();
    if (deleted) await persistEmbeddedStateIfNeeded();
    return deleted ? mapSanctionRow(deleted) : null;
  } catch (error) {
    console.error('deleteSanctionRecord failed:', error);
    throw new Error('Failed to delete budget sanction.', { cause: error });
  }
}

// ── Transactions Repository ──────────────────────────────────────────────────

export async function listTransactions(): Promise<Transaction[]> {
  try {
    await ensureInitialSeed();
    const rows = await db
      .select()
      .from(transactions)
      .orderBy(desc(transactions.date), desc(transactions.createdAt));
    return rows.map(mapTransactionRow);
  } catch (error) {
    console.error('listTransactions failed:', error);
    throw new Error('Failed to load transactions.', { cause: error });
  }
}

export async function findTransactionById(id: string): Promise<Transaction | null> {
  try {
    await ensureInitialSeed();
    const rows = await db.select().from(transactions).where(eq(transactions.id, id)).limit(1);
    return rows[0] ? mapTransactionRow(rows[0]) : null;
  } catch (error) {
    console.error('findTransactionById failed:', error);
    throw new Error('Failed to look up transaction.', { cause: error });
  }
}

export async function createTransactionRecord(input: {
  id?: string;
  budgetHeadId: string;
  userId: string;
  title: string;
  merchant: string;
  amount: number;
  type: TransactionType;
  status: TransactionStatus;
  paymentMethod: PaymentMethod;
  date: string;
  financialYear: string;
  reference: string;
  notes: string;
  chequeNumber?: string;
  chequeIssueDate?: string;
  sanctionNumber?: string;
  sanctionDate?: string;
  paymentSanctionedByHod?: string;
  chequeAttachment?: SanctionAttachment;
  sanctionAttachment?: SanctionAttachment;
}): Promise<Transaction> {
  try {
    await ensureInitialSeed();
    const id = input.id || `tx-${crypto.randomUUID().slice(0, 8)}`;
    const [inserted] = await db
      .insert(transactions)
      .values({
        id,
        budgetHeadId: input.budgetHeadId,
        userId: input.userId,
        title: input.title,
        merchant: input.merchant,
        amount: input.amount,
        type: input.type,
        status: input.status,
        paymentMethod: input.paymentMethod,
        date: input.date,
        financialYear: input.financialYear,
        reference: input.reference,
        notes: input.notes,
        chequeNumber: input.chequeNumber || null,
        chequeIssueDate: input.chequeIssueDate || null,
        sanctionNumber: input.sanctionNumber || null,
        sanctionDate: input.sanctionDate || null,
        paymentSanctionedByHod: input.paymentSanctionedByHod || null,
        chequeAttachmentJson: serializeAttachment(input.chequeAttachment),
        sanctionAttachmentJson: serializeAttachment(input.sanctionAttachment),
      })
      .returning();
    await persistEmbeddedStateIfNeeded();
    return mapTransactionRow(inserted);
  } catch (error) {
    console.error('createTransactionRecord failed:', error);
    throw new Error('Failed to record transaction.', { cause: error });
  }
}

export async function updateTransactionRecord(
  id: string,
  updates: Partial<{
    budgetHeadId: string;
    title: string;
    merchant: string;
    amount: number;
    type: TransactionType;
    status: TransactionStatus;
    paymentMethod: PaymentMethod;
    date: string;
    financialYear: string;
    reference: string;
    notes: string;
    chequeNumber: string | null;
    chequeIssueDate: string | null;
    sanctionNumber: string | null;
    sanctionDate: string | null;
    paymentSanctionedByHod: string | null;
    chequeAttachment: SanctionAttachment | undefined;
    clearChequeAttachment: boolean;
    sanctionAttachment: SanctionAttachment | undefined;
    clearSanctionAttachment: boolean;
  }>
): Promise<Transaction | null> {
  try {
    await ensureInitialSeed();
    const payload: Partial<typeof transactions.$inferInsert> = {};
    if (updates.budgetHeadId !== undefined) payload.budgetHeadId = updates.budgetHeadId;
    if (updates.title !== undefined) payload.title = updates.title;
    if (updates.merchant !== undefined) payload.merchant = updates.merchant;
    if (updates.amount !== undefined) payload.amount = updates.amount;
    if (updates.type !== undefined) payload.type = updates.type;
    if (updates.status !== undefined) payload.status = updates.status;
    if (updates.paymentMethod !== undefined) payload.paymentMethod = updates.paymentMethod;
    if (updates.date !== undefined) payload.date = updates.date;
    if (updates.financialYear !== undefined) payload.financialYear = updates.financialYear;
    if (updates.reference !== undefined) payload.reference = updates.reference;
    if (updates.notes !== undefined) payload.notes = updates.notes;
    if (updates.chequeNumber !== undefined) payload.chequeNumber = updates.chequeNumber;
    if (updates.chequeIssueDate !== undefined) payload.chequeIssueDate = updates.chequeIssueDate;
    if (updates.sanctionNumber !== undefined) payload.sanctionNumber = updates.sanctionNumber;
    if (updates.sanctionDate !== undefined) payload.sanctionDate = updates.sanctionDate;
    if (updates.paymentSanctionedByHod !== undefined) {
      payload.paymentSanctionedByHod = updates.paymentSanctionedByHod;
    }
    if (updates.clearChequeAttachment) {
      payload.chequeAttachmentJson = null;
    } else if (updates.chequeAttachment !== undefined) {
      payload.chequeAttachmentJson = serializeAttachment(updates.chequeAttachment);
    }
    if (updates.clearSanctionAttachment) {
      payload.sanctionAttachmentJson = null;
    } else if (updates.sanctionAttachment !== undefined) {
      payload.sanctionAttachmentJson = serializeAttachment(updates.sanctionAttachment);
    }

    const [updated] = await db
      .update(transactions)
      .set(payload)
      .where(eq(transactions.id, id))
      .returning();
    if (updated) await persistEmbeddedStateIfNeeded();
    return updated ? mapTransactionRow(updated) : null;
  } catch (error) {
    console.error('updateTransactionRecord failed:', error);
    throw new Error('Failed to update transaction.', { cause: error });
  }
}

export async function deleteTransactionRecord(id: string): Promise<Transaction | null> {
  try {
    await ensureInitialSeed();
    const [deleted] = await db
      .delete(transactions)
      .where(eq(transactions.id, id))
      .returning();
    if (deleted) await persistEmbeddedStateIfNeeded();
    return deleted ? mapTransactionRow(deleted) : null;
  } catch (error) {
    console.error('deleteTransactionRecord failed:', error);
    throw new Error('Failed to delete transaction.', { cause: error });
  }
}

// ── Full Database Backup Export & Atomic Transactional Restore ───────────────

export interface DatabaseBackupUserRow {
  id: string;
  firebaseUid: string | null;
  username: string;
  fullName: string;
  department: string;
  email: string;
  mobile: string;
  role: string;
  avatarUrl: string | null;
  active: boolean;
  activeFrom: string | null;
  activeUntil: string | null;
  deactivatedFrom: string | null;
  deactivatedUntil: string | null;
  passwordHash: string | null;
  passwordSalt: string | null;
  createdAt: string;
}

export interface DatabaseBackupHeadRow {
  id: string;
  name: string;
  color: string;
  description: string;
  createdBy: string | null;
  createdAt: string;
}

export interface DatabaseBackupSanctionRow {
  id: string;
  budgetHeadId: string;
  sanctionAmount: number;
  sanctionDate: string;
  financialYear: string;
  sanctionOrderNo: string;
  sanctionedBy: string;
  notes: string;
  attachmentJson: string | null;
  approvalStatus: string;
  approvedBy: string | null;
  approvedAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface DatabaseBackupTransactionRow {
  id: string;
  budgetHeadId: string;
  userId: string | null;
  title: string;
  merchant: string;
  amount: number;
  type: string;
  status: string;
  paymentMethod: string;
  date: string;
  financialYear: string;
  reference: string;
  notes: string;
  chequeNumber: string | null;
  chequeIssueDate: string | null;
  sanctionNumber: string | null;
  sanctionDate: string | null;
  paymentSanctionedByHod: string | null;
  chequeAttachmentJson: string | null;
  sanctionAttachmentJson: string | null;
  createdAt: string;
}

export interface DatabaseBackupSnapshot {
  schemaVersion: 1;
  app: 'LedgerFlow';
  exportedAt: string;
  timezone: 'Asia/Kolkata';
  trigger?: 'scheduled-00:00' | 'manual' | 'pre-restore';
  counts: {
    users: number;
    budgetHeads: number;
    budgetSanctions: number;
    transactions: number;
  };
  data: {
    users: DatabaseBackupUserRow[];
    budgetHeads: DatabaseBackupHeadRow[];
    budgetSanctions: DatabaseBackupSanctionRow[];
    transactions: DatabaseBackupTransactionRow[];
  };
}

function toIsoOrNull(val: Date | string | null | undefined): string | null {
  if (!val) return null;
  if (val instanceof Date) return val.toISOString();
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function toDateOrNull(val: string | Date | null | undefined): Date | null {
  if (!val) return null;
  if (val instanceof Date) return Number.isNaN(val.getTime()) ? null : val;
  const parsed = new Date(val);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toDateOrNow(val: string | Date | null | undefined): Date {
  return toDateOrNull(val) || new Date();
}

async function collectCurrentDatabaseSnapshot(
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore' = 'manual'
): Promise<DatabaseBackupSnapshot> {
  const [userRows, headRows, sanctionRows, txRows] = await Promise.all([
    db.select().from(users),
    db.select().from(budgetHeads),
    db.select().from(budgetSanctions),
    db.select().from(transactions),
  ]);

    const mappedUsers: DatabaseBackupUserRow[] = userRows.map((u) => ({
      id: u.id,
      firebaseUid: u.firebaseUid ?? null,
      username: u.username,
      fullName: u.fullName,
      department: u.department,
      email: u.email,
      mobile: u.mobile,
      role: u.role,
      avatarUrl: u.avatarUrl ?? null,
      active: Boolean(u.active),
      activeFrom: toIsoOrNull(u.activeFrom),
      activeUntil: toIsoOrNull(u.activeUntil),
      deactivatedFrom: toIsoOrNull(u.deactivatedFrom),
      deactivatedUntil: toIsoOrNull(u.deactivatedUntil),
      passwordHash: u.passwordHash ?? null,
      passwordSalt: u.passwordSalt ?? null,
      createdAt: toIsoOrNull(u.createdAt) || new Date().toISOString(),
    }));

    const mappedHeads: DatabaseBackupHeadRow[] = headRows.map((h) => ({
      id: h.id,
      name: h.name,
      color: h.color,
      description: h.description,
      createdBy: h.createdBy ?? null,
      createdAt: toIsoOrNull(h.createdAt) || new Date().toISOString(),
    }));

    const mappedSanctions: DatabaseBackupSanctionRow[] = sanctionRows.map((s) => ({
      id: s.id,
      budgetHeadId: s.budgetHeadId,
      sanctionAmount: Number(s.sanctionAmount),
      sanctionDate: s.sanctionDate,
      financialYear: s.financialYear,
      sanctionOrderNo: s.sanctionOrderNo,
      sanctionedBy: s.sanctionedBy,
      notes: s.notes,
      attachmentJson: s.attachmentJson ?? null,
      approvalStatus: s.approvalStatus,
      approvedBy: s.approvedBy ?? null,
      approvedAt: toIsoOrNull(s.approvedAt),
      createdBy: s.createdBy ?? null,
      createdAt: toIsoOrNull(s.createdAt) || new Date().toISOString(),
      updatedAt: toIsoOrNull(s.updatedAt) || new Date().toISOString(),
    }));

    const mappedTxs: DatabaseBackupTransactionRow[] = txRows.map((t) => ({
      id: t.id,
      budgetHeadId: t.budgetHeadId,
      userId: t.userId ?? null,
      title: t.title,
      merchant: t.merchant,
      amount: Number(t.amount),
      type: t.type,
      status: t.status,
      paymentMethod: t.paymentMethod,
      date: t.date,
      financialYear: t.financialYear,
      reference: t.reference,
      notes: t.notes,
      chequeNumber: t.chequeNumber ?? null,
      chequeIssueDate: t.chequeIssueDate ?? null,
      sanctionNumber: t.sanctionNumber ?? null,
      sanctionDate: t.sanctionDate ?? null,
      paymentSanctionedByHod: t.paymentSanctionedByHod ?? null,
      chequeAttachmentJson: t.chequeAttachmentJson ?? null,
      sanctionAttachmentJson: t.sanctionAttachmentJson ?? null,
      createdAt: toIsoOrNull(t.createdAt) || new Date().toISOString(),
    }));

    return {
      schemaVersion: 1,
      app: 'LedgerFlow',
      exportedAt: new Date().toISOString(),
      timezone: 'Asia/Kolkata',
      trigger,
      counts: {
        users: mappedUsers.length,
        budgetHeads: mappedHeads.length,
        budgetSanctions: mappedSanctions.length,
        transactions: mappedTxs.length,
      },
      data: {
        users: mappedUsers,
        budgetHeads: mappedHeads,
        budgetSanctions: mappedSanctions,
        transactions: mappedTxs,
      },
    };
}

export async function exportDatabaseSnapshot(
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore' = 'manual'
): Promise<DatabaseBackupSnapshot> {
  try {
    await ensureInitialSeed();
    return await collectCurrentDatabaseSnapshot(trigger);
  } catch (error) {
    console.error('exportDatabaseSnapshot failed:', error);
    throw new Error('Failed to export database backup snapshot.', { cause: error });
  }
}

export function validateDatabaseBackupSnapshot(raw: unknown): DatabaseBackupSnapshot {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid backup file: expected a JSON object.');
  }
  const obj = raw as Record<string, unknown>;
  if (obj.app !== 'LedgerFlow' || obj.schemaVersion !== 1) {
    throw new Error('Unsupported or invalid LedgerFlow backup file format.');
  }
  if (!obj.data || typeof obj.data !== 'object') {
    throw new Error('Invalid backup file: missing database tables.');
  }
  const data = obj.data as Record<string, unknown>;
  if (
    !Array.isArray(data.users) ||
    !Array.isArray(data.budgetHeads) ||
    !Array.isArray(data.budgetSanctions) ||
    !Array.isArray(data.transactions)
  ) {
    throw new Error('Invalid backup file: one or more database tables are missing or corrupted.');
  }

  return obj as unknown as DatabaseBackupSnapshot;
}

async function applySnapshotWithoutSeedCheck(
  rawSnapshot: unknown,
  currentAdmin?: StoredUser
): Promise<{
  users: number;
  budgetHeads: number;
  budgetSanctions: number;
  transactions: number;
}> {
  const snapshot = validateDatabaseBackupSnapshot(rawSnapshot);

  // Build normalized user list and guarantee current active admin is never locked out
  const incomingUsers: DatabaseBackupUserRow[] = snapshot.data.users
    .filter((u) => u && typeof u.id === 'string' && typeof u.username === 'string')
    .map((u) => ({
      id: String(u.id),
      firebaseUid: u.firebaseUid ? String(u.firebaseUid) : null,
      username: String(u.username).trim().toLowerCase(),
      fullName: String(u.fullName || u.username),
      department: String(u.department || 'Operations'),
      email: String(u.email || ''),
      mobile: String(u.mobile || ''),
      role: u.role === 'admin' ? 'admin' : 'user',
      avatarUrl: u.avatarUrl ? String(u.avatarUrl) : null,
      active: u.active !== false,
      activeFrom: u.activeFrom ?? null,
      activeUntil: u.activeUntil ?? null,
      deactivatedFrom: u.deactivatedFrom ?? null,
      deactivatedUntil: u.deactivatedUntil ?? null,
      passwordHash: u.passwordHash ? String(u.passwordHash) : null,
      passwordSalt: u.passwordSalt ? String(u.passwordSalt) : null,
      createdAt: u.createdAt || new Date().toISOString(),
    }));

  if (currentAdmin) {
    const adminIdx = incomingUsers.findIndex(
      (u) =>
        u.id === currentAdmin.id ||
        (currentAdmin.email && u.email.toLowerCase() === currentAdmin.email.toLowerCase())
    );
    if (adminIdx === -1) {
      incomingUsers.push({
        id: currentAdmin.id,
        firebaseUid: currentAdmin.firebaseUid ?? null,
        username: currentAdmin.username,
        fullName: currentAdmin.fullName,
        department: currentAdmin.department || 'Finance',
        email: currentAdmin.email || '',
        mobile: currentAdmin.mobile || '',
        role: 'admin',
        avatarUrl: currentAdmin.avatarUrl ?? null,
        active: true,
        activeFrom: null,
        activeUntil: null,
        deactivatedFrom: null,
        deactivatedUntil: null,
        passwordHash: currentAdmin.passwordHash,
        passwordSalt: currentAdmin.passwordSalt,
        createdAt: currentAdmin.createdAt || new Date().toISOString(),
      });
    } else {
      incomingUsers[adminIdx] = {
        ...incomingUsers[adminIdx],
        role: 'admin',
        active: true,
      };
    }
  }

  const userIdSet = new Set(incomingUsers.map((u) => u.id));

  const incomingHeads: DatabaseBackupHeadRow[] = snapshot.data.budgetHeads
    .filter((h) => h && typeof h.id === 'string' && typeof h.name === 'string')
    .map((h) => ({
      id: String(h.id),
      name: String(h.name).trim(),
      color: String(h.color || '#1D358F'),
      description: String(h.description || ''),
      createdBy: h.createdBy && userIdSet.has(String(h.createdBy)) ? String(h.createdBy) : null,
      createdAt: h.createdAt || new Date().toISOString(),
    }));

  const headIdSet = new Set(incomingHeads.map((h) => h.id));

  const incomingSanctions: DatabaseBackupSanctionRow[] = snapshot.data.budgetSanctions
    .filter(
      (s) =>
        s &&
        typeof s.id === 'string' &&
        typeof s.budgetHeadId === 'string' &&
        headIdSet.has(String(s.budgetHeadId))
    )
    .map((s) => ({
      id: String(s.id),
      budgetHeadId: String(s.budgetHeadId),
      sanctionAmount: Number(s.sanctionAmount) || 0,
      sanctionDate: String(s.sanctionDate || new Date().toISOString().slice(0, 10)),
      financialYear: String(s.financialYear || computeFinancialYear(String(s.sanctionDate || ''))),
      sanctionOrderNo: String(s.sanctionOrderNo || 'RESTORED'),
      sanctionedBy: String(s.sanctionedBy || 'Technical Director RISL'),
      notes: String(s.notes || ''),
      attachmentJson: s.attachmentJson ?? null,
      approvalStatus:
        s.approvalStatus === 'pending' || s.approvalStatus === 'rejected'
          ? s.approvalStatus
          : 'approved',
      approvedBy: s.approvedBy && userIdSet.has(String(s.approvedBy)) ? String(s.approvedBy) : null,
      approvedAt: s.approvedAt ?? null,
      createdBy: s.createdBy && userIdSet.has(String(s.createdBy)) ? String(s.createdBy) : null,
      createdAt: s.createdAt || new Date().toISOString(),
      updatedAt: s.updatedAt || s.createdAt || new Date().toISOString(),
    }));

  const incomingTxs: DatabaseBackupTransactionRow[] = snapshot.data.transactions
    .filter(
      (t) =>
        t &&
        typeof t.id === 'string' &&
        typeof t.budgetHeadId === 'string' &&
        headIdSet.has(String(t.budgetHeadId))
    )
    .map((t) => ({
      id: String(t.id),
      budgetHeadId: String(t.budgetHeadId),
      userId: t.userId && userIdSet.has(String(t.userId)) ? String(t.userId) : null,
      title: String(t.title || 'Transaction'),
      merchant: String(t.merchant || 'Vendor'),
      amount: Number(t.amount) || 0,
      type: t.type === 'income' ? 'income' : 'expense',
      status:
        t.status === 'pending' || t.status === 'flagged' ? t.status : 'approved',
      paymentMethod: String(t.paymentMethod || 'Cheque'),
      date: String(t.date || new Date().toISOString().slice(0, 10)),
      financialYear: String(t.financialYear || computeFinancialYear(String(t.date || ''))),
      reference: String(t.reference || ''),
      notes: String(t.notes || ''),
      chequeNumber: t.chequeNumber ? String(t.chequeNumber) : null,
      chequeIssueDate: t.chequeIssueDate ? String(t.chequeIssueDate) : null,
      sanctionNumber: t.sanctionNumber ? String(t.sanctionNumber) : null,
      sanctionDate: t.sanctionDate ? String(t.sanctionDate) : null,
      paymentSanctionedByHod: t.paymentSanctionedByHod ? String(t.paymentSanctionedByHod) : null,
      chequeAttachmentJson: t.chequeAttachmentJson ?? null,
      sanctionAttachmentJson: t.sanctionAttachmentJson ?? null,
      createdAt: t.createdAt || new Date().toISOString(),
    }));

  try {
    await db.transaction(async (tx) => {
      // Clear child tables first to satisfy foreign key constraints
      await tx.delete(otpChallenges);
      await tx.delete(transactions);
      await tx.delete(budgetSanctions);
      await tx.delete(budgetHeads);
      await tx.delete(users);

      if (incomingUsers.length > 0) {
        await tx.insert(users).values(
          incomingUsers.map((u) => ({
            id: u.id,
            firebaseUid: u.firebaseUid,
            username: u.username,
            fullName: u.fullName,
            department: u.department,
            email: u.email,
            mobile: u.mobile,
            role: u.role,
            avatarUrl: u.avatarUrl,
            active: u.active,
            activeFrom: toDateOrNull(u.activeFrom),
            activeUntil: toDateOrNull(u.activeUntil),
            deactivatedFrom: toDateOrNull(u.deactivatedFrom),
            deactivatedUntil: toDateOrNull(u.deactivatedUntil),
            passwordHash: u.passwordHash,
            passwordSalt: u.passwordSalt,
            createdAt: toDateOrNow(u.createdAt),
          }))
        );
      }

      if (incomingHeads.length > 0) {
        await tx.insert(budgetHeads).values(
          incomingHeads.map((h) => ({
            id: h.id,
            name: h.name,
            color: h.color,
            description: h.description,
            createdBy: h.createdBy,
            createdAt: toDateOrNow(h.createdAt),
          }))
        );
      }

      if (incomingSanctions.length > 0) {
        await tx.insert(budgetSanctions).values(
          incomingSanctions.map((s) => ({
            id: s.id,
            budgetHeadId: s.budgetHeadId,
            sanctionAmount: s.sanctionAmount,
            sanctionDate: s.sanctionDate,
            financialYear: s.financialYear,
            sanctionOrderNo: s.sanctionOrderNo,
            sanctionedBy: s.sanctionedBy,
            notes: s.notes,
            attachmentJson: s.attachmentJson,
            approvalStatus: s.approvalStatus,
            approvedBy: s.approvedBy,
            approvedAt: toDateOrNull(s.approvedAt),
            createdBy: s.createdBy,
            createdAt: toDateOrNow(s.createdAt),
            updatedAt: toDateOrNow(s.updatedAt),
          }))
        );
      }

      if (incomingTxs.length > 0) {
        await tx.insert(transactions).values(
          incomingTxs.map((t) => ({
            id: t.id,
            budgetHeadId: t.budgetHeadId,
            userId: t.userId,
            title: t.title,
            merchant: t.merchant,
            amount: t.amount,
            type: t.type,
            status: t.status,
            paymentMethod: t.paymentMethod,
            date: t.date,
            financialYear: t.financialYear,
            reference: t.reference,
            notes: t.notes,
            chequeNumber: t.chequeNumber,
            chequeIssueDate: t.chequeIssueDate,
            sanctionNumber: t.sanctionNumber,
            sanctionDate: t.sanctionDate,
            paymentSanctionedByHod: t.paymentSanctionedByHod,
            chequeAttachmentJson: t.chequeAttachmentJson,
            sanctionAttachmentJson: t.sanctionAttachmentJson,
            createdAt: toDateOrNow(t.createdAt),
          }))
        );
      }
    });

    return {
      users: incomingUsers.length,
      budgetHeads: incomingHeads.length,
      budgetSanctions: incomingSanctions.length,
      transactions: incomingTxs.length,
    };
  } catch (error) {
    console.error('restoreDatabaseSnapshot failed:', error);
    throw new Error('Failed to restore database snapshot. Existing data was preserved.', {
      cause: error,
    });
  }
}

export async function restoreDatabaseSnapshot(
  rawSnapshot: unknown,
  currentAdmin?: StoredUser
): Promise<{
  users: number;
  budgetHeads: number;
  budgetSanctions: number;
  transactions: number;
}> {
  await ensureInitialSeed();
  const counts = await applySnapshotWithoutSeedCheck(rawSnapshot, currentAdmin);
  await persistEmbeddedStateIfNeeded();
  return counts;
}
