import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, type User } from 'firebase/auth';
import { auth } from './firebase';
import type { DatabaseBackupSnapshotPayload, DriveBackupFile } from '../types/finance';

// Least-privilege scope: access only files/folders created by LedgerFlow in Google Drive.
export const GOOGLE_DRIVE_SCOPES = ['https://www.googleapis.com/auth/drive.file'] as const;

const DRIVE_BACKUP_FOLDER_NAME = 'LedgerFlow Database Backups';
const DRIVE_API_BASE = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_BASE = 'https://www.googleapis.com/upload/drive/v3';

export interface DriveConnectionState {
  connected: boolean;
  email: string | null;
  displayName: string | null;
}

// Keep Google Drive OAuth access tokens strictly in JS memory (never localStorage/sessionStorage).
let isSigningIn = false;
let cachedAccessToken: string | null = null;
let cachedUserEmail: string | null = null;
let cachedDisplayName: string | null = null;
let cachedFolderId: string | null = null;

const listeners = new Set<(state: DriveConnectionState) => void>();

function notifyListeners(): void {
  const state = getDriveConnectionState();
  listeners.forEach((cb) => cb(state));
}

export function getDriveConnectionState(): DriveConnectionState {
  return {
    connected: Boolean(cachedAccessToken),
    email: cachedAccessToken ? cachedUserEmail : null,
    displayName: cachedAccessToken ? cachedDisplayName : null,
  };
}

export function getDriveAccessToken(): string | null {
  return cachedAccessToken;
}

export function subscribeDriveConnection(
  onChange: (state: DriveConnectionState) => void
): () => void {
  listeners.add(onChange);
  onChange(getDriveConnectionState());
  return () => {
    listeners.delete(onChange);
  };
}

let authListenerInitialized = false;

export function initDriveAuthWatcher(): () => void {
  if (authListenerInitialized) {
    return () => {};
  }
  authListenerInitialized = true;
  return onAuthStateChanged(auth, (fbUser: User | null) => {
    if (!fbUser) {
      cachedAccessToken = null;
      cachedUserEmail = null;
      cachedDisplayName = null;
      cachedFolderId = null;
      notifyListeners();
    } else if (!cachedAccessToken && !isSigningIn) {
      cachedUserEmail = null;
      cachedDisplayName = null;
      cachedFolderId = null;
      notifyListeners();
    }
  });
}

function parseDriveApiError(status: number, rawBody: string): {
  message: string;
  isInsufficientScope: boolean;
} {
  let apiMessage = '';
  let reason = '';
  try {
    const parsed = JSON.parse(rawBody) as {
      error?: {
        message?: string;
        status?: string;
        errors?: Array<{ reason?: string; message?: string }>;
        details?: Array<{ reason?: string }>;
      };
    };
    apiMessage = parsed?.error?.message || '';
    reason =
      parsed?.error?.errors?.[0]?.reason ||
      parsed?.error?.details?.[0]?.reason ||
      parsed?.error?.status ||
      '';
  } catch {
    apiMessage = rawBody.trim().slice(0, 180);
  }

  const combined = `${reason} ${apiMessage}`.toLowerCase();
  const isInsufficientScope =
    status === 403 &&
    (combined.includes('insufficient') ||
      combined.includes('scope') ||
      combined.includes('access_token_scope_insufficient'));

  if (isInsufficientScope) {
    return {
      isInsufficientScope: true,
      message:
        'Google Drive file permission was not granted during sign-in. Please click "Sign in with Google" again and check the box to allow access to Google Drive files on the Google permission screen.',
    };
  }

  if (
    status === 403 &&
    (combined.includes('accessnotconfigured') ||
      combined.includes('has not been used') ||
      combined.includes('disabled'))
  ) {
    return {
      isInsufficientScope: false,
      message:
        'Google Drive API is not enabled on the linked Google Cloud project yet. Enable the Google Drive API and try connecting again.',
    };
  }

  return {
    isInsufficientScope: false,
    message: apiMessage || `Google Drive request failed (HTTP ${status}).`,
  };
}

/**
 * Prompts the administrator to sign in with Google and grant Google Drive file permission.
 * Must be called from an explicit button click / user interaction.
 */
export async function connectAdminGoogleDrive(
  adminHintEmail?: string
): Promise<{ email: string; displayName: string; accessToken: string }> {
  const provider = new GoogleAuthProvider();
  for (const scope of GOOGLE_DRIVE_SCOPES) {
    provider.addScope(scope);
  }
  const params: Record<string, string> = {
    // Force consent + account chooser so Google always presents the Drive permission checkbox
    prompt: 'consent select_account',
    include_granted_scopes: 'true',
  };
  if (adminHintEmail && adminHintEmail.includes('@')) {
    params.login_hint = adminHintEmail.trim().toLowerCase();
  }
  provider.setCustomParameters(params);

  try {
    isSigningIn = true;
    const result = await signInWithPopup(auth, provider);
    const credential = GoogleAuthProvider.credentialFromResult(result);
    if (!credential?.accessToken) {
      throw new Error('Could not obtain Google Drive access permission. Please try again.');
    }

    cachedAccessToken = credential.accessToken;
    cachedUserEmail = result.user.email || adminHintEmail || 'Google Account';
    cachedDisplayName = result.user.displayName || cachedUserEmail;
    cachedFolderId = null;

    // Immediately verify that Google Drive file permission was actually granted
    // before marking the connection active in the UI.
    try {
      await ensureBackupFolderId();
    } catch (verifyErr) {
      disconnectAdminGoogleDrive();
      throw verifyErr;
    }

    notifyListeners();

    return {
      email: cachedUserEmail,
      displayName: cachedDisplayName,
      accessToken: cachedAccessToken,
    };
  } finally {
    isSigningIn = false;
  }
}

export function disconnectAdminGoogleDrive(): void {
  cachedAccessToken = null;
  cachedUserEmail = null;
  cachedDisplayName = null;
  cachedFolderId = null;
  notifyListeners();
}

async function driveFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = cachedAccessToken;
  if (!token) {
    throw new Error('Google Drive is not connected. Sign in with Google to continue.');
  }

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${token}`);

  const res = await fetch(url, { ...init, headers });
  if (res.status === 401) {
    // Access token expired — clear in-memory cache so UI prompts reconnect cleanly
    disconnectAdminGoogleDrive();
    throw new Error('Google Drive session expired. Please reconnect Google Drive to continue.');
  }
  if (res.status === 403) {
    const errBody = await res.clone().text().catch(() => '');
    const parsed = parseDriveApiError(403, errBody);
    if (parsed.isInsufficientScope) {
      disconnectAdminGoogleDrive();
      throw new Error(parsed.message);
    }
  }
  return res;
}

async function ensureBackupFolderId(): Promise<string> {
  if (cachedFolderId) return cachedFolderId;

  const query = encodeURIComponent(
    `name='${DRIVE_BACKUP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`
  );
  const searchRes = await driveFetch(
    `${DRIVE_API_BASE}/files?q=${query}&fields=files(id,name)&pageSize=1`
  );
  if (!searchRes.ok) {
    const errBody = await searchRes.text().catch(() => '');
    const parsed = parseDriveApiError(searchRes.status, errBody);
    throw new Error(`Unable to inspect Google Drive backup folder: ${parsed.message}`);
  }
  const searchData = (await searchRes.json()) as { files?: Array<{ id: string; name: string }> };
  if (searchData.files && searchData.files.length > 0) {
    cachedFolderId = searchData.files[0].id;
    return cachedFolderId;
  }

  // Create dedicated backup folder inside Admin's Google Drive
  const createRes = await driveFetch(`${DRIVE_API_BASE}/files?fields=id,name`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: DRIVE_BACKUP_FOLDER_NAME,
      mimeType: 'application/vnd.google-apps.folder',
      description: 'Automated daily 00:00 hrs & manual LedgerFlow database backups',
    }),
  });
  if (!createRes.ok) {
    const errBody = await createRes.text().catch(() => '');
    const parsed = parseDriveApiError(createRes.status, errBody);
    throw new Error(`Unable to create Google Drive backup folder: ${parsed.message}`);
  }
  const created = (await createRes.json()) as { id: string };
  cachedFolderId = created.id;
  return cachedFolderId;
}

export async function uploadBackupSnapshotToDrive(params: {
  fileName: string;
  snapshot: DatabaseBackupSnapshotPayload;
  description?: string;
}): Promise<DriveBackupFile> {
  const folderId = await ensureBackupFolderId();
  const boundary = `ledgerflow_backup_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const metadata = {
    name: params.fileName,
    mimeType: 'application/json',
    parents: [folderId],
    description:
      params.description ||
      `LedgerFlow DB Backup (${params.snapshot.counts.budgetHeads} heads, ${params.snapshot.counts.budgetSanctions} sanctions, ${params.snapshot.counts.transactions} transactions)`,
  };
  const jsonText = JSON.stringify(params.snapshot, null, 2);

  const multipartBody =
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\n` +
    `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
    `${jsonText}\r\n` +
    `--${boundary}--`;

  const uploadRes = await driveFetch(
    `${DRIVE_UPLOAD_BASE}/files?uploadType=multipart&fields=id,name,createdTime,size,webViewLink`,
    {
      method: 'POST',
      headers: {
        'Content-Type': `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
    }
  );

  if (!uploadRes.ok) {
    const errText = await uploadRes.text().catch(() => '');
    const parsed = parseDriveApiError(uploadRes.status, errText);
    throw new Error(`Google Drive upload failed: ${parsed.message}`);
  }

  const uploaded = (await uploadRes.json()) as {
    id: string;
    name: string;
    createdTime: string;
    size?: string;
    webViewLink?: string;
  };

  return {
    id: uploaded.id,
    name: uploaded.name,
    createdTime: uploaded.createdTime || new Date().toISOString(),
    sizeBytes: Number(uploaded.size || jsonText.length),
    webViewLink: uploaded.webViewLink,
  };
}

export async function listDriveBackups(): Promise<DriveBackupFile[]> {
  const folderId = await ensureBackupFolderId();
  const query = encodeURIComponent(
    `'${folderId}' in parents and mimeType='application/json' and trashed=false`
  );
  const res = await driveFetch(
    `${DRIVE_API_BASE}/files?q=${query}&orderBy=createdTime desc&pageSize=30&fields=files(id,name,createdTime,size,webViewLink)`
  );
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const parsed = parseDriveApiError(res.status, errText);
    throw new Error(`Unable to list Google Drive backups: ${parsed.message}`);
  }
  const data = (await res.json()) as {
    files?: Array<{
      id: string;
      name: string;
      createdTime: string;
      size?: string;
      webViewLink?: string;
    }>;
  };

  return (data.files || []).map((f) => ({
    id: f.id,
    name: f.name,
    createdTime: f.createdTime,
    sizeBytes: Number(f.size || 0),
    webViewLink: f.webViewLink,
  }));
}

export async function downloadDriveBackupSnapshot(
  fileId: string
): Promise<DatabaseBackupSnapshotPayload> {
  const safeId = encodeURIComponent(fileId);
  const res = await driveFetch(`${DRIVE_API_BASE}/files/${safeId}?alt=media`);
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    const parsed = parseDriveApiError(res.status, errText);
    throw new Error(`Unable to download backup from Google Drive: ${parsed.message}`);
  }
  const parsed = (await res.json()) as DatabaseBackupSnapshotPayload;
  if (!parsed || parsed.app !== 'LedgerFlow' || parsed.schemaVersion !== 1 || !parsed.data) {
    throw new Error('The selected Google Drive file is not a valid LedgerFlow database backup.');
  }
  return parsed;
}

export async function deleteDriveBackupFile(fileId: string): Promise<void> {
  const safeId = encodeURIComponent(fileId);
  const res = await driveFetch(`${DRIVE_API_BASE}/files/${safeId}`, {
    method: 'DELETE',
  });
  if (!res.ok && res.status !== 204) {
    const errText = await res.text().catch(() => '');
    const parsed = parseDriveApiError(res.status, errText);
    throw new Error(`Unable to delete backup from Google Drive: ${parsed.message}`);
  }
}
