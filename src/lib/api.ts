import { auth } from './firebase';
import { isStandaloneAndroidRuntime, localAppEngine } from './localAppEngine';
import type {
  AnalyticsSummary,
  BackupCounts,
  BackupStatusResponse,
  BudgetHeadEnriched,
  BudgetSanctionEnriched,
  DatabaseBackupSnapshotPayload,
  ImportBudgetHeadRow,
  ImportResultSummary,
  ImportSanctionRow,
  ImportTransactionRow,
  OtpChallengeResponse,
  OtpVerifyResponse,
  PaymentMethod,
  SafeUser,
  SanctionApprovalStatus,
  ServerBackupSnapshotMeta,
  TransactionEnriched,
  TransactionStatus,
  TransactionType,
  UserRole,
  UserWithStats,
  WorkbookImportResult,
} from '../types/finance';

// Keep custom OTP session tokens strictly in JS memory (never localStorage/sessionStorage).
let memoryToken: string | null = null;

export function getSessionToken(): string | null {
  return memoryToken;
}

export function setSessionToken(token: string | null): void {
  memoryToken = token;
}

async function resolveBearerToken(): Promise<string | null> {
  if (memoryToken) return memoryToken;
  const fbUser = auth.currentUser;
  if (fbUser) {
    try {
      return await fbUser.getIdToken();
    } catch {
      return null;
    }
  }
  return null;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await resolveBearerToken();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers,
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

const remoteApi = {
  // Auth & OTP Verification
  login: (username: string, password: string) =>
    request<OtpChallengeResponse>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  requestDirectOtp: (identifier: string) =>
    request<OtpChallengeResponse>('/api/auth/otp/request', {
      method: 'POST',
      body: JSON.stringify({ identifier }),
    }),

  verifyLoginOtp: (challengeId: string, otp: string) =>
    request<OtpVerifyResponse>('/api/auth/otp/verify', {
      method: 'POST',
      body: JSON.stringify({ challengeId, otp }),
    }),

  resendLoginOtp: (challengeId: string) =>
    request<OtpChallengeResponse>('/api/auth/otp/resend', {
      method: 'POST',
      body: JSON.stringify({ challengeId }),
    }),

  register: (payload: {
    username: string;
    password: string;
    fullName: string;
    department?: string;
    email: string;
    mobile: string;
  }) =>
    request<OtpChallengeResponse>('/api/auth/register', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  syncGoogleSession: (idToken: string) =>
    request<{ user: SafeUser; loginAt?: string }>('/api/auth/google', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    }),

  me: () => request<{ user: SafeUser; loginAt?: string }>('/api/auth/me'),

  pingSession: () =>
    request<{ ok: boolean; loginAt?: string; lastActivity?: number }>('/api/auth/ping', {
      method: 'POST',
    }),

  logout: () =>
    request<{ ok: boolean }>('/api/auth/logout', {
      method: 'POST',
    }),

  // Users (Admin)
  getUsers: () => request<{ users: UserWithStats[] }>('/api/users'),

  createUser: (payload: {
    username: string;
    password: string;
    fullName: string;
    department: string;
    email: string;
    mobile: string;
    role: UserRole;
  }) =>
    request<{ user: SafeUser }>('/api/users', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateUser: (
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
  ) =>
    request<{ user: SafeUser }>(`/api/users/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteUser: (id: string) =>
    request<{ deleted: boolean }>(`/api/users/${id}`, {
      method: 'DELETE',
    }),

  // Budget Heads (Name, Color, Description only)
  getBudgetHeads: () => request<{ budgetHeads: BudgetHeadEnriched[] }>('/api/budget-heads'),

  createBudgetHead: (payload: { name: string; color: string; description: string }) =>
    request<{ budgetHead: BudgetHeadEnriched }>('/api/budget-heads', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateBudgetHead: (
    id: string,
    payload: Partial<{ name: string; color: string; description: string }>
  ) =>
    request<{ budgetHead: BudgetHeadEnriched }>(`/api/budget-heads/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteBudgetHead: (id: string) =>
    request<{ deleted: boolean }>(`/api/budget-heads/${id}`, {
      method: 'DELETE',
    }),

  bulkDeleteBudgetHeads: (ids: string[]) =>
    request<{ deletedCount: number; skippedCount: number; errors: string[] }>(
      '/api/budget-heads/bulk-delete',
      {
        method: 'POST',
        body: JSON.stringify({ ids }),
      }
    ),

  // Budget Sanctions
  getSanctions: () => request<{ sanctions: BudgetSanctionEnriched[] }>('/api/sanctions'),

  createSanction: (payload: {
    budgetHeadId: string;
    sanctionAmount: number;
    sanctionDate: string;
    sanctionOrderNo: string;
    sanctionedBy: string;
    notes: string;
    attachmentBase64?: string;
    attachmentName?: string;
    attachmentSource?: 'pdf-upload' | 'camera-scan';
  }) =>
    request<{ sanction: BudgetSanctionEnriched }>('/api/sanctions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateSanction: (
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
  ) =>
    request<{ sanction: BudgetSanctionEnriched }>(`/api/sanctions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteSanction: (id: string) =>
    request<{ deleted: boolean }>(`/api/sanctions/${id}`, {
      method: 'DELETE',
    }),

  bulkDeleteSanctions: (ids: string[]) =>
    request<{ deletedCount: number }>('/api/sanctions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  fetchSanctionPdfBlob: async (id: string): Promise<Blob> => {
    const token = await resolveBearerToken();
    const res = await fetch(`/api/sanctions/${id}/attachment`, {
      credentials: 'same-origin',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error || 'Unable to load sanction PDF attachment.');
    }
    return res.blob();
  },

  // Transactions
  getTransactions: () => request<{ transactions: TransactionEnriched[] }>('/api/transactions'),

  createTransaction: (payload: {
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
  }) =>
    request<{ transaction: TransactionEnriched }>('/api/transactions', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateTransaction: (
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
  ) =>
    request<{ transaction: TransactionEnriched }>(`/api/transactions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  deleteTransaction: (id: string) =>
    request<{ deleted: boolean }>(`/api/transactions/${id}`, {
      method: 'DELETE',
    }),

  bulkDeleteTransactions: (ids: string[]) =>
    request<{ deletedCount: number }>('/api/transactions/bulk-delete', {
      method: 'POST',
      body: JSON.stringify({ ids }),
    }),

  fetchTransactionAttachmentBlob: async (
    id: string,
    kind: 'cheque' | 'sanction'
  ): Promise<Blob> => {
    const token = await resolveBearerToken();
    const res = await fetch(`/api/transactions/${id}/attachments/${kind}`, {
      credentials: 'same-origin',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw new Error(errData?.error || `Unable to load ${kind} PDF attachment.`);
    }
    return res.blob();
  },

  // Analytics
  getAnalytics: (days?: number, fy?: string) => {
    const params = new URLSearchParams();
    if (days && days > 0) params.set('days', String(days));
    if (fy && fy !== 'all') params.set('fy', fy);
    const qs = params.toString();
    return request<{ analytics: AnalyticsSummary }>(qs ? `/api/analytics?${qs}` : '/api/analytics');
  },

  // Bulk Excel Imports
  importBudgetHeads: (rows: ImportBudgetHeadRow[]) =>
    request<{ summary: ImportResultSummary }>('/api/import/budget-heads', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),

  importSanctions: (rows: ImportSanctionRow[]) =>
    request<{ summary: ImportResultSummary }>('/api/import/sanctions', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),

  importTransactions: (rows: ImportTransactionRow[]) =>
    request<{ summary: ImportResultSummary }>('/api/import/transactions', {
      method: 'POST',
      body: JSON.stringify({ rows }),
    }),

  importWorkbook: (payload: {
    budgetHeads: ImportBudgetHeadRow[];
    sanctions: ImportSanctionRow[];
    transactions: ImportTransactionRow[];
  }) =>
    request<{ result: WorkbookImportResult }>('/api/import/workbook', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  // Admin Database Backup & Restore (Daily 00:00 hrs + Google Drive Sync)
  getBackupStatus: () => request<BackupStatusResponse>('/api/admin/backup/status'),

  exportDatabaseBackup: (saveServer = true) =>
    request<{
      snapshot: DatabaseBackupSnapshotPayload;
      suggestedFileName: string;
      serverMeta?: ServerBackupSnapshotMeta;
    }>(`/api/admin/backup/export${saveServer ? '?saveServer=1' : ''}`),

  fetchServerBackupSnapshot: (fileName: string) =>
    request<{
      fileName: string;
      snapshot: DatabaseBackupSnapshotPayload;
    }>(`/api/admin/backup/server/${encodeURIComponent(fileName)}`),

  markDriveBackupSynced: (payload: {
    driveFileId: string;
    driveFileName: string;
    driveEmail?: string;
    serverFileName?: string;
  }) =>
    request<{ ok: boolean; status: BackupStatusResponse }>('/api/admin/backup/drive-synced', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  updateBackupConfig: (payload: { autoBackupEnabled: boolean }) =>
    request<{ ok: boolean; status: BackupStatusResponse }>('/api/admin/backup/config', {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  restoreDatabaseBackup: (payload: {
    snapshot?: DatabaseBackupSnapshotPayload;
    serverFileName?: string;
  }) =>
    request<{
      restored: boolean;
      counts: BackupCounts;
      preRestoreFileName: string | null;
    }>('/api/admin/backup/restore', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),
};

export const api: typeof remoteApi = isStandaloneAndroidRuntime() ? localAppEngine : remoteApi;
