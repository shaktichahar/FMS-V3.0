import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  Cloud,
  CloudOff,
  CloudUpload,
  Database,
  Download,
  HardDrive,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  Trash2,
  Upload,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  connectAdminGoogleDrive,
  deleteDriveBackupFile,
  disconnectAdminGoogleDrive,
  downloadDriveBackupSnapshot,
  listDriveBackups,
  subscribeDriveConnection,
  uploadBackupSnapshotToDrive,
  type DriveConnectionState,
} from '../lib/googleDriveBackup';
import type {
  BackupStatusResponse,
  DatabaseBackupSnapshotPayload,
  DriveBackupFile,
  SafeUser,
  ServerBackupSnapshotMeta,
} from '../types/finance';
import { BottomSheetModal } from './BottomSheetModal';

interface BackupRestoreViewProps {
  user: SafeUser;
  onDatabaseRestored: () => Promise<void>;
}

interface PendingRestoreTarget {
  sourceLabel: string;
  fileName: string;
  snapshot?: DatabaseBackupSnapshotPayload;
  serverFileName?: string;
  exportedAt?: string;
  counts?: {
    users: number;
    budgetHeads: number;
    budgetSanctions: number;
    transactions: number;
  };
}

function formatDateTimeIst(iso?: string | null): string {
  if (!iso) return 'Never';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function triggerJsonDownload(snapshot: DatabaseBackupSnapshotPayload, fileName: string): void {
  const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
    type: 'application/json;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  window.setTimeout(() => {
    a.remove();
    URL.revokeObjectURL(url);
  }, 3000);
}

export function BackupRestoreView({ user, onDatabaseRestored }: BackupRestoreViewProps) {
  const [status, setStatus] = useState<BackupStatusResponse | null>(null);
  const [driveState, setDriveState] = useState<DriveConnectionState>({
    connected: false,
    email: null,
    displayName: null,
  });
  const [driveFiles, setDriveFiles] = useState<DriveBackupFile[]>([]);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [loadingDriveFiles, setLoadingDriveFiles] = useState(false);

  const [connectingDrive, setConnectingDrive] = useState(false);
  const [backingUp, setBackingUp] = useState(false);
  const [syncingPending, setSyncingPending] = useState(false);
  const [downloadingLocal, setDownloadingLocal] = useState(false);
  const [togglingSchedule, setTogglingSchedule] = useState(false);

  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Explicit Confirmation Modals (mandatory for Restore & Drive Delete)
  const [restoreTarget, setRestoreTarget] = useState<PendingRestoreTarget | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [deleteDriveTarget, setDeleteDriveTarget] = useState<DriveBackupFile | null>(null);
  const [deletingDriveFile, setDeletingDriveFile] = useState(false);

  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    return subscribeDriveConnection(setDriveState);
  }, []);

  const loadStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const res = await api.getBackupStatus();
      setStatus(res);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to load backup status.');
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  const loadDriveList = useCallback(async () => {
    setLoadingDriveFiles(true);
    try {
      const files = await listDriveBackups();
      setDriveFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to list Google Drive backups.');
    } finally {
      setLoadingDriveFiles(false);
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  useEffect(() => {
    if (driveState.connected) {
      void loadDriveList();
    } else {
      setDriveFiles([]);
    }
  }, [driveState.connected, loadDriveList]);

  const syncPendingMidnightBackups = useCallback(
    async (driveEmail?: string) => {
      const currentStatus = await api.getBackupStatus();
      setStatus(currentStatus);
      if (currentStatus.pendingDriveSyncFiles.length === 0) return 0;

      setSyncingPending(true);
      let syncedCount = 0;
      try {
        for (const pending of currentStatus.pendingDriveSyncFiles) {
          const { snapshot } = await api.fetchServerBackupSnapshot(pending.fileName);
          const uploaded = await uploadBackupSnapshotToDrive({
            fileName: pending.fileName,
            snapshot,
            description: `LedgerFlow Daily 00:00 hrs Auto Backup (${pending.istDate})`,
          });
          const markRes = await api.markDriveBackupSynced({
            driveFileId: uploaded.id,
            driveFileName: uploaded.name,
            driveEmail: driveEmail || driveState.email || user.email,
            serverFileName: pending.fileName,
          });
          setStatus(markRes.status);
          syncedCount += 1;
        }
        await loadDriveList();
      } finally {
        setSyncingPending(false);
      }
      return syncedCount;
    },
    [driveState.email, loadDriveList, user.email]
  );

  const handleConnectGoogleDrive = async () => {
    setError(null);
    setFeedback(null);
    setConnectingDrive(true);
    try {
      const conn = await connectAdminGoogleDrive(status?.adminEmail || user.email);
      const synced = await syncPendingMidnightBackups(conn.email);
      if (synced > 0) {
        setFeedback(
          `Connected Google Drive (${conn.email}) and synced ${synced} pending 00:00 hrs ${
            synced === 1 ? 'backup' : 'backups'
          }.`
        );
      } else {
        setFeedback(`Connected Google Drive (${conn.email}).`);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Unable to connect Google Drive right now.'
      );
    } finally {
      setConnectingDrive(false);
    }
  };

  const handleDisconnectDrive = () => {
    disconnectAdminGoogleDrive();
    setDriveFiles([]);
    setFeedback('Disconnected Google Drive session from this browser.');
  };

  const handleToggleAutoBackup = async () => {
    if (!status) return;
    setError(null);
    setTogglingSchedule(true);
    try {
      const res = await api.updateBackupConfig({
        autoBackupEnabled: !status.autoBackupEnabled,
      });
      setStatus(res.status);
      setFeedback(
        res.status.autoBackupEnabled
          ? 'Daily 00:00 hrs IST automatic database backup enabled.'
          : 'Daily 00:00 hrs automatic backup paused.'
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to update schedule setting.');
    } finally {
      setTogglingSchedule(false);
    }
  };

  const handleBackupToDriveNow = async () => {
    if (!driveState.connected) {
      setError('Connect Admin Google Drive first to upload a cloud backup.');
      return;
    }
    setError(null);
    setFeedback(null);
    setBackingUp(true);
    try {
      const { snapshot, suggestedFileName, serverMeta } = await api.exportDatabaseBackup(true);
      const uploaded = await uploadBackupSnapshotToDrive({
        fileName: suggestedFileName,
        snapshot,
      });
      const markRes = await api.markDriveBackupSynced({
        driveFileId: uploaded.id,
        driveFileName: uploaded.name,
        driveEmail: driveState.email || user.email,
        serverFileName: serverMeta?.fileName,
      });
      setStatus(markRes.status);
      await loadDriveList();
      setFeedback(`Backup saved to Google Drive: ${uploaded.name}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Backup to Google Drive failed.');
    } finally {
      setBackingUp(false);
    }
  };

  const handleDownloadLocalBackup = async () => {
    setError(null);
    setDownloadingLocal(true);
    try {
      const { snapshot, suggestedFileName } = await api.exportDatabaseBackup(false);
      triggerJsonDownload(snapshot, suggestedFileName);
      setFeedback(`Downloaded local database backup: ${suggestedFileName}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to download backup file.');
    } finally {
      setDownloadingLocal(false);
    }
  };

  const handleSyncSingleServerSnapshot = async (snap: ServerBackupSnapshotMeta) => {
    if (!driveState.connected) {
      setError('Connect Google Drive first to sync this snapshot.');
      return;
    }
    setError(null);
    setSyncingPending(true);
    try {
      const { snapshot } = await api.fetchServerBackupSnapshot(snap.fileName);
      const uploaded = await uploadBackupSnapshotToDrive({
        fileName: snap.fileName,
        snapshot,
        description: `LedgerFlow DB Backup (${snap.trigger} · ${snap.istDate})`,
      });
      const markRes = await api.markDriveBackupSynced({
        driveFileId: uploaded.id,
        driveFileName: uploaded.name,
        driveEmail: driveState.email || user.email,
        serverFileName: snap.fileName,
      });
      setStatus(markRes.status);
      await loadDriveList();
      setFeedback(`Synced "${snap.fileName}" to Google Drive.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to sync snapshot to Google Drive.');
    } finally {
      setSyncingPending(false);
    }
  };

  const handlePrepareRestoreFromDrive = async (file: DriveBackupFile) => {
    setError(null);
    try {
      const snapshot = await downloadDriveBackupSnapshot(file.id);
      setRestoreTarget({
        sourceLabel: 'Google Drive Backup',
        fileName: file.name,
        snapshot,
        exportedAt: snapshot.exportedAt,
        counts: snapshot.counts,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to inspect Drive backup file.');
    }
  };

  const handleDownloadFromDrive = async (file: DriveBackupFile) => {
    setError(null);
    try {
      const snapshot = await downloadDriveBackupSnapshot(file.id);
      triggerJsonDownload(snapshot, file.name);
      setFeedback(`Downloaded "${file.name}" from Google Drive.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to download Drive backup file.');
    }
  };

  const handlePrepareRestoreFromServer = (snap: ServerBackupSnapshotMeta) => {
    setError(null);
    setRestoreTarget({
      sourceLabel:
        snap.trigger === 'scheduled-00:00'
          ? 'Daily 00:00 hrs Auto Snapshot'
          : snap.trigger === 'pre-restore'
            ? 'Pre-Restore Safety Snapshot'
            : 'Server Snapshot',
      fileName: snap.fileName,
      serverFileName: snap.fileName,
      exportedAt: snap.createdAt,
      counts: snap.counts,
    });
  };

  const handleLocalFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    try {
      const text = await file.text();
      const parsed = JSON.parse(text) as DatabaseBackupSnapshotPayload;
      if (!parsed || parsed.app !== 'LedgerFlow' || parsed.schemaVersion !== 1 || !parsed.data) {
        throw new Error('Selected file is not a valid LedgerFlow JSON database backup.');
      }
      setRestoreTarget({
        sourceLabel: 'Uploaded Local Backup File',
        fileName: file.name,
        snapshot: parsed,
        exportedAt: parsed.exportedAt,
        counts: parsed.counts,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to read selected backup file.');
    }
  };

  const handleConfirmRestore = async () => {
    if (!restoreTarget) return;
    setRestoring(true);
    setError(null);
    try {
      const res = await api.restoreDatabaseBackup({
        snapshot: restoreTarget.snapshot,
        serverFileName: restoreTarget.serverFileName,
      });
      setRestoreTarget(null);
      setFeedback(
        `Database restored successfully (${res.counts.budgetHeads} heads, ${res.counts.budgetSanctions} sanctions, ${res.counts.transactions} transactions, ${res.counts.users} users).${
          res.preRestoreFileName ? ` Pre-restore safety copy saved as ${res.preRestoreFileName}.` : ''
        }`
      );
      await Promise.all([loadStatus(), onDatabaseRestored()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Database restore failed.');
    } finally {
      setRestoring(false);
    }
  };

  const handleConfirmDeleteDriveFile = async () => {
    if (!deleteDriveTarget) return;
    setDeletingDriveFile(true);
    setError(null);
    try {
      await deleteDriveBackupFile(deleteDriveTarget.id);
      const removedName = deleteDriveTarget.name;
      setDeleteDriveTarget(null);
      await loadDriveList();
      setFeedback(`Deleted "${removedName}" from Google Drive.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to delete Google Drive backup.');
    } finally {
      setDeletingDriveFile(false);
    }
  };

  return (
    <div className="space-y-6">
      {feedback && (
        <div className="px-4 py-3 rounded-xl bg-slate-900 text-white text-xs sm:text-sm flex items-center justify-between gap-3">
          <span className="inline-flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4 text-[#E5C675] shrink-0" />
            <span>{feedback}</span>
          </span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-300 hover:text-white text-xs font-medium px-2 py-1 cursor-pointer shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div
          role="alert"
          className="px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700 flex items-center justify-between gap-3"
        >
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-red-700 hover:text-red-900 text-xs font-semibold px-2 py-1 cursor-pointer shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top Executive KPI & Schedule Summary */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">Daily Auto-Backup Schedule</p>
            <Clock className="w-4 h-4 text-teal-700" />
          </div>
          <p className="mt-1.5 font-mono tabular-nums text-xl font-semibold text-slate-900">
            00:00 hrs IST
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {status?.nextScheduledRunLabel || 'Loading schedule...'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">Google Drive Connection</p>
            {driveState.connected ? (
              <Cloud className="w-4 h-4 text-emerald-600" />
            ) : (
              <CloudOff className="w-4 h-4 text-slate-400" />
            )}
          </div>
          <p
            className={`mt-1.5 text-lg font-semibold truncate ${
              driveState.connected ? 'text-emerald-700' : 'text-slate-900'
            }`}
          >
            {driveState.connected ? 'Connected' : 'Not Connected'}
          </p>
          <p className="mt-1 text-xs text-slate-500 truncate">
            {driveState.connected
              ? driveState.email
              : `Target: ${status?.adminEmail || user.email}`}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs font-medium text-slate-500">Last Google Drive Sync</p>
            <ShieldCheck className="w-4 h-4 text-teal-700" />
          </div>
          <p className="mt-1.5 font-mono text-sm font-semibold text-slate-900">
            {formatDateTimeIst(status?.lastDriveSyncAt)}
          </p>
          <p className="mt-1 text-xs text-slate-500 truncate">
            {status?.lastDriveFileName || 'No backup synced to Drive yet'}
          </p>
        </div>
      </div>

      {/* Google Drive Connection & Daily 00:00 Auto-Backup Control Card */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-base font-semibold text-slate-900">
              Admin Google Drive Auto-Backup (Daily 00:00 hrs)
            </h2>
            <p className="text-xs sm:text-sm text-slate-500">
              Automatically captures a full database snapshot every day at{' '}
              <strong className="text-slate-800">00:00 hrs IST</strong> and saves it to{' '}
              <span className="font-mono text-slate-700">Google Drive / LedgerFlow Database Backups</span>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={handleToggleAutoBackup}
              disabled={togglingSchedule || !status}
              className={`min-h-[42px] px-3.5 rounded-xl border text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap ${
                status?.autoBackupEnabled
                  ? 'border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
                  : 'border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100'
              }`}
            >
              <Clock className="w-3.5 h-3.5" />
              <span>
                {status?.autoBackupEnabled ? 'Daily 00:00 Auto-Backup: ON' : 'Daily 00:00 Auto-Backup: OFF'}
              </span>
            </button>

            {driveState.connected ? (
              <button
                type="button"
                onClick={handleDisconnectDrive}
                className="min-h-[42px] px-3.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 cursor-pointer whitespace-nowrap"
              >
                Disconnect Drive
              </button>
            ) : (
              /* Official "Sign in with Google" button styling */
              <button
                type="button"
                onClick={handleConnectGoogleDrive}
                disabled={connectingDrive}
                className="min-h-[42px] px-4 rounded-xl border border-[#747775] bg-white hover:bg-[#f8faff] active:bg-[#eef2ff] disabled:opacity-60 text-[#1f1f1f] text-sm font-medium inline-flex items-center gap-2.5 shadow-xs transition-colors cursor-pointer whitespace-nowrap"
              >
                <svg
                  className="w-4 h-4 shrink-0"
                  viewBox="0 0 48 48"
                  aria-hidden="true"
                >
                  <path
                    fill="#EA4335"
                    d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
                  />
                  <path
                    fill="#4285F4"
                    d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
                  />
                  <path
                    fill="#FBBC05"
                    d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
                  />
                  <path
                    fill="#34A853"
                    d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
                  />
                </svg>
                <span>
                  {connectingDrive ? 'Connecting Google Drive...' : 'Sign in with Google'}
                </span>
              </button>
            )}
          </div>
        </div>

        {/* Pending Midnight Sync Alert */}
        {status && status.pendingDriveSyncFiles.length > 0 && (
          <div className="px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 flex flex-wrap items-center justify-between gap-3 text-xs text-amber-900">
            <span>
              <strong>
                {status.pendingDriveSyncFiles.length} daily 00:00 hrs{' '}
                {status.pendingDriveSyncFiles.length === 1 ? 'snapshot' : 'snapshots'}
              </strong>{' '}
              captured by the server and waiting to upload to Admin Google Drive.
            </span>
            {driveState.connected ? (
              <button
                type="button"
                disabled={syncingPending}
                onClick={() => void syncPendingMidnightBackups()}
                className="min-h-[34px] px-3 rounded-lg bg-amber-700 hover:bg-amber-800 disabled:opacity-60 text-white font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <CloudUpload className="w-3.5 h-3.5" />
                <span>{syncingPending ? 'Syncing...' : 'Sync Pending to Drive'}</span>
              </button>
            ) : (
              <span className="font-medium text-amber-800">
                Sign in with Google above to auto-upload
              </span>
            )}
          </div>
        )}

        {/* Primary Backup & Restore Action Bar */}
        <div className="pt-4 border-t border-slate-100 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={handleBackupToDriveNow}
            disabled={!driveState.connected || backingUp}
            className="min-h-[44px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap shadow-[0_4px_12px_-4px_rgba(29,53,143,0.4)]"
          >
            <CloudUpload className="w-4 h-4" />
            <span>{backingUp ? 'Uploading Backup...' : 'Backup to Google Drive Now'}</span>
          </button>

          <button
            type="button"
            onClick={handleDownloadLocalBackup}
            disabled={downloadingLocal}
            className="min-h-[44px] px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Download className="w-4 h-4 text-teal-700" />
            <span>{downloadingLocal ? 'Exporting...' : 'Download Backup (.json)'}</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            accept=".json,application/json"
            onChange={handleLocalFileSelected}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="min-h-[44px] px-4 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold inline-flex items-center gap-2 transition-colors cursor-pointer whitespace-nowrap"
          >
            <Upload className="w-4 h-4 text-teal-700" />
            <span>Restore from Local File</span>
          </button>
        </div>
      </section>

      {/* Google Drive Backups List */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 sm:px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Google Drive Backups
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Folder: <span className="font-mono">LedgerFlow Database Backups</span>
              {driveState.connected && driveState.email ? ` · ${driveState.email}` : ''}
            </p>
          </div>

          {driveState.connected && (
            <button
              type="button"
              onClick={() => void loadDriveList()}
              disabled={loadingDriveFiles}
              className="min-h-[36px] px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loadingDriveFiles ? 'animate-spin' : ''}`} />
              <span>Refresh Drive</span>
            </button>
          )}
        </div>

        {!driveState.connected ? (
          <div className="px-6 py-10 text-center space-y-2">
            <CloudOff className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-sm font-medium text-slate-700">
              Google Drive is not connected in this session
            </p>
            <p className="text-xs text-slate-500 max-w-md mx-auto">
              Use the <strong>Sign in with Google</strong> button above with your admin Gmail account to view, upload, and restore backups directly from Google Drive.
            </p>
          </div>
        ) : loadingDriveFiles ? (
          <div className="px-6 py-10 text-center text-xs text-slate-500">
            Loading backup files from Google Drive...
          </div>
        ) : driveFiles.length === 0 ? (
          <div className="px-6 py-10 text-center space-y-2">
            <Cloud className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-sm font-medium text-slate-700">
              No backups uploaded to Google Drive yet
            </p>
            <p className="text-xs text-slate-500">
              Click <strong>Backup to Google Drive Now</strong> above to create your first cloud backup, or wait for the automatic 00:00 hrs daily run.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {driveFiles.map((file) => (
              <div
                key={file.id}
                className="px-5 sm:px-6 py-3.5 flex flex-col sm:flex-row sm:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
              >
                <div className="min-w-0">
                  <p className="text-sm font-medium text-slate-900 font-mono truncate">
                    {file.name}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5">
                    Saved {formatDateTimeIst(file.createdTime)} · {formatBytes(file.sizeBytes)}
                  </p>
                </div>
                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => void handlePrepareRestoreFromDrive(file)}
                    className="min-h-[36px] px-3 rounded-lg bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restore</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDownloadFromDrive(file)}
                    className="min-h-[36px] px-3 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-slate-700 text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <Download className="w-3.5 h-3.5" />
                    <span>Download</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteDriveTarget(file)}
                    aria-label={`Delete ${file.name} from Google Drive`}
                    className="min-h-[36px] min-w-[36px] rounded-lg border border-slate-200 bg-white hover:bg-red-50 hover:border-red-200 text-slate-500 hover:text-red-700 flex items-center justify-center cursor-pointer"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Server Daily 00:00 hrs & Safety Snapshots */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 sm:px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-slate-900">
              Server Daily 00:00 hrs &amp; Safety Snapshots
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Captured automatically at 00:00 hrs IST and before every restore operation (up to 30 snapshots retained)
            </p>
          </div>
          <button
            type="button"
            onClick={() => void loadStatus()}
            disabled={loadingStatus}
            className="min-h-[36px] px-3 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 cursor-pointer"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loadingStatus ? 'animate-spin' : ''}`} />
            <span>Refresh</span>
          </button>
        </div>

        {loadingStatus && !status ? (
          <div className="px-6 py-8 text-center text-xs text-slate-500">
            Loading server snapshots...
          </div>
        ) : !status || status.serverSnapshots.length === 0 ? (
          <div className="px-6 py-10 text-center space-y-2">
            <HardDrive className="w-8 h-8 text-slate-300 mx-auto" />
            <p className="text-sm font-medium text-slate-700">No server snapshots recorded yet</p>
            <p className="text-xs text-slate-500">
              Snapshots are created automatically every midnight (00:00 hrs IST) or whenever you trigger a backup.
            </p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {status.serverSnapshots.map((snap) => (
              <div
                key={snap.fileName}
                className="px-5 sm:px-6 py-3.5 flex flex-col md:flex-row md:items-center justify-between gap-3 hover:bg-slate-50/70 transition-colors"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Database className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                    <span className="text-sm font-medium text-slate-900 font-mono truncate">
                      {snap.fileName}
                    </span>
                    <span className="text-[11px] font-medium text-slate-500">
                      ·{' '}
                      {snap.trigger === 'scheduled-00:00'
                        ? 'Auto 00:00 hrs'
                        : snap.trigger === 'pre-restore'
                          ? 'Pre-Restore Safety'
                          : 'Manual'}
                    </span>
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatDateTimeIst(snap.createdAt)} · {formatBytes(snap.sizeBytes)} ·{' '}
                    {snap.counts.budgetHeads} heads, {snap.counts.budgetSanctions} sanctions,{' '}
                    {snap.counts.transactions} transactions, {snap.counts.users} users
                  </p>
                  <p className="text-[11px] font-medium">
                    {snap.driveSyncedAt ? (
                      <span className="text-emerald-700">
                        Synced to Google Drive ({formatDateTimeIst(snap.driveSyncedAt)})
                      </span>
                    ) : (
                      <span className="text-amber-700">Pending Google Drive upload</span>
                    )}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2 shrink-0">
                  {driveState.connected && !snap.driveSyncedAt && (
                    <button
                      type="button"
                      disabled={syncingPending}
                      onClick={() => void handleSyncSingleServerSnapshot(snap)}
                      className="min-h-[36px] px-3 rounded-lg border border-teal-200 bg-teal-50 hover:bg-teal-100 text-teal-900 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <CloudUpload className="w-3.5 h-3.5" />
                      <span>Upload to Drive</span>
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handlePrepareRestoreFromServer(snap)}
                    className="min-h-[36px] px-3 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                  >
                    <RotateCcw className="w-3.5 h-3.5" />
                    <span>Restore</span>
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Explicit Restore Confirmation Modal */}
      <BottomSheetModal
        open={Boolean(restoreTarget)}
        onClose={() => {
          if (!restoring) setRestoreTarget(null);
        }}
        title="Confirm Database Restore"
        subtitle="Review backup contents before replacing live database records"
      >
        {restoreTarget && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-700 shrink-0 mt-0.5" />
              <div className="text-xs text-amber-900 space-y-1">
                <p className="font-semibold">
                  This will replace all current budget heads, sanctions, transactions, and users with the selected backup.
                </p>
                <p>
                  For safety, LedgerFlow will automatically save a <strong>pre-restore snapshot</strong> of your current database before restoring, and your active administrator login will remain protected.
                </p>
              </div>
            </div>

            <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Source</span>
                <span className="font-semibold text-slate-900">{restoreTarget.sourceLabel}</span>
              </div>
              <div className="flex items-center justify-between gap-2">
                <span className="text-slate-500">Backup File</span>
                <span className="font-mono font-medium text-slate-900 truncate max-w-[240px]">
                  {restoreTarget.fileName}
                </span>
              </div>
              {restoreTarget.exportedAt && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-slate-500">Backup Timestamp</span>
                  <span className="font-mono text-slate-800">
                    {formatDateTimeIst(restoreTarget.exportedAt)}
                  </span>
                </div>
              )}
              {restoreTarget.counts && (
                <div className="pt-2 mt-2 border-t border-slate-200 grid grid-cols-2 sm:grid-cols-4 gap-2 text-center">
                  <div className="bg-white rounded-lg p-2 border border-slate-200">
                    <p className="font-mono text-sm font-semibold text-slate-900">
                      {restoreTarget.counts.budgetHeads}
                    </p>
                    <p className="text-[11px] text-slate-500">Heads</p>
                  </div>
                  <div className="bg-white rounded-lg p-2 border border-slate-200">
                    <p className="font-mono text-sm font-semibold text-slate-900">
                      {restoreTarget.counts.budgetSanctions}
                    </p>
                    <p className="text-[11px] text-slate-500">Sanctions</p>
                  </div>
                  <div className="bg-white rounded-lg p-2 border border-slate-200">
                    <p className="font-mono text-sm font-semibold text-slate-900">
                      {restoreTarget.counts.transactions}
                    </p>
                    <p className="text-[11px] text-slate-500">Ledger Txs</p>
                  </div>
                  <div className="bg-white rounded-lg p-2 border border-slate-200">
                    <p className="font-mono text-sm font-semibold text-slate-900">
                      {restoreTarget.counts.users}
                    </p>
                    <p className="text-[11px] text-slate-500">Users</p>
                  </div>
                </div>
              )}
            </div>

            <div className="flex items-center justify-end gap-2.5 pt-2">
              <button
                type="button"
                disabled={restoring}
                onClick={() => setRestoreTarget(null)}
                className="min-h-[42px] px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={restoring}
                onClick={handleConfirmRestore}
                className="min-h-[42px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-2 cursor-pointer"
              >
                <RotateCcw className="w-4 h-4" />
                <span>{restoring ? 'Restoring Database...' : 'Confirm & Restore Database'}</span>
              </button>
            </div>
          </div>
        )}
      </BottomSheetModal>

      {/* Explicit Delete Google Drive File Confirmation Modal */}
      <BottomSheetModal
        open={Boolean(deleteDriveTarget)}
        onClose={() => {
          if (!deletingDriveFile) setDeleteDriveTarget(null);
        }}
        title="Delete Backup from Google Drive?"
        subtitle="This permanently deletes the selected backup file from your Google Drive"
      >
        {deleteDriveTarget && (
          <div className="space-y-4">
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 space-y-1">
              <p className="font-semibold">
                Are you sure you want to permanently delete this backup file from Google Drive?
              </p>
              <p className="font-mono text-red-900 break-all">{deleteDriveTarget.name}</p>
              <p>This action cannot be undone.</p>
            </div>

            <div className="flex items-center justify-end gap-2.5">
              <button
                type="button"
                disabled={deletingDriveFile}
                onClick={() => setDeleteDriveTarget(null)}
                className="min-h-[42px] px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-700 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={deletingDriveFile}
                onClick={handleConfirmDeleteDriveFile}
                className="min-h-[42px] px-4 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
                <span>{deletingDriveFile ? 'Deleting...' : 'Confirm Delete'}</span>
              </button>
            </div>
          </div>
        )}
      </BottomSheetModal>
    </div>
  );
}
