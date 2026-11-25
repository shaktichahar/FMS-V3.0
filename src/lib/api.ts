import { auth } from './firebase';
import { isStandaloneAndroidRuntime } from './localAppEngine';
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

export { isStandaloneAndroidRuntime };

// Default published LedgerFlow Cloud Run backend (auto-connected to Cloud SQL / PostgreSQL)
const DEFAULT_CLOUD_API_BASE_URL =
  'https://ais-pre-mon76kn4wttmrf7tqaxi6e-616579702543.asia-northeast1.run.app';

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
    const nativeUrl = window.LedgerFlowAndroid?.getApiBaseUrl?.();
    if (nativeUrl) {
      const normalized = normalizeServerBaseUrl(nativeUrl);
      if (normalized) return normalized;
    }
  } catch {
    // Ignore native bridge errors
  }
  const viteUrl = (import.meta as unknown as { env?: Record<string, string | undefined> }).env
    ?.VITE_API_BASE_URL;
  const normalizedVite = normalizeServerBaseUrl(viteUrl);
  if (normalizedVite) return normalizedVite;
  return DEFAULT_CLOUD_API_BASE_URL;
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

interface NativeApiBridgeResponse {
  status: number;
  contentType: string;
  body: string;
  refreshedToken: string;
  error: string;
}

const pendingNativeApiRequests = new Map<
  string,
  { resolve: (res: NativeApiBridgeResponse) => void; reject: (err: Error) => void; timer: number }
>();

function getNativeApiRequestFn():
  | ((requestId: string, method: string, url: string, headersJson: string, body: string) => void)
  | null {
  if (typeof window === 'undefined') return null;
  const bridge = window.LedgerFlowAndroid as
    | (typeof window.LedgerFlowAndroid & {
        apiRequest?: (
          requestId: string,
          method: string,
          url: string,
          headersJson: string,
          body: string
        ) => void;
      })
    | undefined;
  return bridge && typeof bridge.apiRequest === 'function' ? bridge.apiRequest.bind(bridge) : null;
}

function ensureNativeApiCallbackRegistered(): void {
  if (typeof window === 'undefined') return;
  const win = window as unknown as {
    __lfOnApiResult?: (requestId: string, result: NativeApiBridgeResponse) => void;
  };
  if (win.__lfOnApiResult) return;
  win.__lfOnApiResult = (requestId: string, result: NativeApiBridgeResponse) => {
    const entry = pendingNativeApiRequests.get(requestId);
    if (!entry) return;
    window.clearTimeout(entry.timer);
    pendingNativeApiRequests.delete(requestId);
    entry.resolve(result);
  };
}

function nativeAndroidRequest(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string
): Promise<NativeApiBridgeResponse> {
  const apiRequestFn = getNativeApiRequestFn();
  if (!apiRequestFn) {
    return Promise.reject(new Error('Native bridge unavailable'));
  }
  ensureNativeApiCallbackRegistered();
  const requestId = `api-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise<NativeApiBridgeResponse>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      pendingNativeApiRequests.delete(requestId);
      reject(new Error('Request timed out while contacting Cloud SQL server.'));
    }, 30000);
    pendingNativeApiRequests.set(requestId, { resolve, reject, timer });
    try {
      apiRequestFn(requestId, method, url, JSON.stringify(headers), body);
    } catch (err) {
      window.clearTimeout(timer);
      pendingNativeApiRequests.delete(requestId);
      reject(err instanceof Error ? err : new Error('Unable to invoke native HTTPS request.'));
    }
  });
}

function extractHostLabel(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function fetchWithColdStartRetry(url: string, init: RequestInit): Promise<Response> {
  const maxAttempts = 2;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const res = await fetch(url, init);
      if (
        attempt < maxAttempts &&
        (res.status === 502 || res.status === 503 || res.status === 504)
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      if (attempt < maxAttempts) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Network request failed');
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = await resolveBearerToken();
  const isCrossOriginApk = Boolean(getCloudApiBaseUrl());
  const fullUrl = buildApiUrl(path);
  const hostLabel = isCrossOriginApk ? extractHostLabel(fullUrl) : 'this server';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  // Prefer native Android HTTPS bridge inside the APK (zero CORS preflight failures)
  if (isCrossOriginApk && getNativeApiRequestFn()) {
    const method = (options.method || 'GET').toUpperCase();
    const bodyStr = typeof options.body === 'string' ? options.body : '';
    let nativeRes = await nativeAndroidRequest(fullUrl, method, headers, bodyStr);
    if (nativeRes.status === 502 || nativeRes.status === 503 || nativeRes.status === 504) {
      await new Promise((r) => setTimeout(r, 1500));
      nativeRes = await nativeAndroidRequest(fullUrl, method, headers, bodyStr);
    }

    if (nativeRes.refreshedToken) {
      memoryToken = nativeRes.refreshedToken;
    }

    if (nativeRes.status === 0) {
      throw new Error(
        `Unable to reach live server (${hostLabel}): ${nativeRes.error || 'Check your internet connection.'}`
      );
    }

    if (nativeRes.status === 301 || nativeRes.status === 302 || nativeRes.status === 303 || nativeRes.status === 307) {
      throw new Error(
        `Server (${hostLabel}) requires browser login (HTTP ${nativeRes.status}). Deploy LedgerFlow to a public Cloud Run URL and set API_BASE_URL in GitHub Settings, then rebuild the APK.`
      );
    }

    if (nativeRes.status === 502 || nativeRes.status === 503 || nativeRes.status === 504) {
      throw new Error(
        `Server (${hostLabel}) is currently offline (HTTP ${nativeRes.status}). Deploy LedgerFlow to Cloud Run and set its public https://...run.app URL as API_BASE_URL in GitHub Settings, then rebuild the APK.`
      );
    }

    const isJson = nativeRes.contentType.includes('application/json');
    let parsed: Record<string, unknown> = {};
    if (isJson || nativeRes.body.trim().startsWith('{') || nativeRes.body.trim().startsWith('[')) {
      try {
        parsed = JSON.parse(nativeRes.body) as Record<string, unknown>;
      } catch {
        parsed = {};
      }
    }

    if (nativeRes.status < 200 || nativeRes.status >= 300) {
      throw new Error(
        (typeof parsed.error === 'string' && parsed.error) ||
          `Server (${hostLabel}) returned HTTP ${nativeRes.status}.`
      );
    }

    if (!isJson && !nativeRes.body.trim().startsWith('{') && !nativeRes.body.trim().startsWith('[')) {
      throw new Error(
        `Server (${hostLabel}) returned HTML instead of API JSON. Set API_BASE_URL to your deployed Cloud Run URL and rebuild the APK.`
      );
    }

    return parsed as T;
  }

  let res: Response;
  try {
    res = await fetchWithColdStartRetry(fullUrl, {
      credentials: isCrossOriginApk ? 'omit' : 'same-origin',
      ...options,
      headers,
    });
  } catch {
    throw new Error(
      `Live server (${hostLabel}) is offline or unreachable (503/CORS). Deploy LedgerFlow to Cloud Run, set its public https://...run.app URL in GitHub API_BASE_URL, and rebuild the APK.`
    );
  }

  const refreshedToken = res.headers.get('X-Refreshed-Token');
  if (refreshedToken) {
    memoryToken = refreshedToken;
  }

  const contentType = res.headers.get('content-type') || '';
  const isJson = contentType.includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : {};
  if (!res.ok) {
    if (res.status === 503 || res.status === 502 || res.status === 504) {
      throw new Error(
        `Live server (${hostLabel}) is currently offline (HTTP ${res.status}). Deploy LedgerFlow to Cloud Run and set API_BASE_URL to its live URL.`
      );
    }
    throw new Error(data?.error || `Request failed (${res.status})`);
  }
  if (!isJson) {
    throw new Error(
      `Server (${hostLabel}) returned HTML instead of API data. Deploy LedgerFlow to a public Cloud Run URL and rebuild the APK with API_BASE_URL set.`
    );
  }
  return data as T;
}

export const api = {
  // Live sync fingerprint (background poll without resetting 5-min idle timer)
  getSyncVersion: () =>
    request<{ version: string }>('/api/sync/version', {
      headers: { 'X-Background-Sync': '1' },
    }),
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
