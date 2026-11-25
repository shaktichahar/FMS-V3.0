import { auth } from './firebase';
import {
  isAndroidEmailOtpReady,
  isAndroidSmsPermissionGranted,
  isStandaloneAndroidRuntime,
  localAppEngine,
  loginStandaloneWithPasswordOnly,
  requestAndroidDevicePermissions,
} from './localAppEngine';
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
  LoginResponse,
  OtpChallengeResponse,
  OtpVerifyResponse,
  PaymentMethod,
  RegisterResponse,
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

export {
  isAndroidEmailOtpReady,
  isAndroidSmsPermissionGranted,
  isStandaloneAndroidRuntime,
  loginStandaloneWithPasswordOnly,
  requestAndroidDevicePermissions,
};

const CLOUD_API_URL_STORAGE_KEY = 'ledgerflow_cloud_api_url_v1';

// Keep custom OTP session tokens strictly in JS memory (never localStorage/sessionStorage).
let memoryToken: string | null = null;

export function getSessionToken(): string | null {
  return memoryToken;
}

export function setSessionToken(token: string | null): void {
  memoryToken = token;
}

function normalizeServerBaseUrl(raw?: string | null): string {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return '';
  if (!/^https?:\/\//i.test(trimmed)) return '';
  return trimmed.replace(/\/+$/, '');
}

export function getCloudApiBaseUrl(): string {
  if (!isStandaloneAndroidRuntime()) {
    return '';
  }
  try {
    const saved = window.localStorage.getItem(CLOUD_API_URL_STORAGE_KEY);
    if (saved !== null) {
      return normalizeServerBaseUrl(saved);
    }
  } catch {
    // Ignore storage read errors
  }
  try {
    const nativeUrl = window.LedgerFlowAndroid?.getApiBaseUrl?.();
    if (nativeUrl) {
      return normalizeServerBaseUrl(nativeUrl);
    }
  } catch {
    // Ignore native bridge errors
  }
  const viteUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;
  return normalizeServerBaseUrl(viteUrl);
}

export function setCloudApiBaseUrl(url: string | null): void {
  try {
    if (!url || !url.trim()) {
      window.localStorage.setItem(CLOUD_API_URL_STORAGE_KEY, '');
    } else {
      const normalized = normalizeServerBaseUrl(url);
      window.localStorage.setItem(CLOUD_API_URL_STORAGE_KEY, normalized);
    }
  } catch {
    // Ignore storage errors
  }
  memoryToken = null;
}

export function isUsingCloudSqlApi(): boolean {
  if (!isStandaloneAndroidRuntime()) return true;
  return Boolean(getCloudApiBaseUrl());
}

export async function testCloudApiConnection(
  rawUrl: string
): Promise<{ ok: boolean; normalizedUrl: string; database?: string; error?: string }> {
  const normalizedUrl = normalizeServerBaseUrl(rawUrl);
  if (!normalizedUrl) {
    return {
      ok: false,
      normalizedUrl: '',
      error: 'Enter a valid https:// server URL (e.g. https://your-app.run.app).',
    };
  }
  try {
    const res = await fetch(`${normalizedUrl}/api/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.ok || data?.service !== 'ledgerflow') {
      return {
        ok: false,
        normalizedUrl,
        error: `Server responded with HTTP ${res.status} — make sure your published LedgerFlow backend is running.`,
      };
    }
    return {
      ok: true,
      normalizedUrl,
      database: typeof data.database === 'string' ? data.database : 'cloud-sql-postgresql',
    };
  } catch {
    return {
      ok: false,
      normalizedUrl,
      error: 'Unable to reach that server URL. Check your internet connection and verify the server is live.',
    };
  }
}

function buildApiUrl(path: string): string {
  const base = getCloudApiBaseUrl();
  if (!base) return path;
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
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
  const isCrossOriginApk = Boolean(getCloudApiBaseUrl());
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(buildApiUrl(path), {
    credentials: isCrossOriginApk ? 'omit' : 'same-origin',
    ...options,
    headers,
  });

  const refreshedToken = res.headers.get('X-Refreshed-Token');
  if (refreshedToken) {
    memoryToken = refreshedToken;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

const remoteApi = {
  // Auth & OTP Verification
  login: (username: string, password: string) =>
    request<LoginResponse>('/api/auth/login', {
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
    request<RegisterResponse>('/api/auth/register', {
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
    const isCrossOriginApk = Boolean(getCloudApiBaseUrl());
    const res = await fetch(buildApiUrl(`/api/sanctions/${id}/attachment`), {
      credentials: isCrossOriginApk ? 'omit' : 'same-origin',
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
    const isCrossOriginApk = Boolean(getCloudApiBaseUrl());
    const res = await fetch(buildApiUrl(`/api/transactions/${id}/attachments/${kind}`), {
      credentials: isCrossOriginApk ? 'omit' : 'same-origin',
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

export const api: typeof remoteApi = new Proxy(remoteApi, {
  get(_target, prop, receiver) {
    const activeBackend = isUsingCloudSqlApi() ? remoteApi : localAppEngine;
    return Reflect.get(activeBackend, prop, receiver);
  },
});
