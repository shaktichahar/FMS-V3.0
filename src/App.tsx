import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  BarChart3,
  Clock,
  DatabaseBackup,
  FileSpreadsheet,
  FileText,
  FolderKanban,
  Landmark,
  LayoutDashboard,
  LogOut,
  Plus,
  ReceiptText,
  Users,
  Wallet,
} from 'lucide-react';
import { AuthScreen } from './components/AuthScreen';
import { Avatar } from './components/Avatar';
import { BackupRestoreView } from './components/BackupRestoreView';
import { BottomSheetModal } from './components/BottomSheetModal';
import { BudgetHeadsView } from './components/BudgetHeadsView';
import { ImportExcelModal } from './components/ImportExcelModal';
import { OverviewView } from './components/OverviewView';
import { OfflineIndicator, PWAInstallButton } from './components/PWAInstallButton';
import { ReportsView } from './components/ReportsView';
import { SanctionsView } from './components/SanctionsView';
import { TransactionsView } from './components/TransactionsView';
import { UsersView } from './components/UsersView';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { api, getSessionToken, setSessionToken } from './lib/api';
import { auth } from './lib/firebase';
import {
  disconnectAdminGoogleDrive,
  getDriveAccessToken,
  getDriveConnectionState,
  initDriveAuthWatcher,
  uploadBackupSnapshotToDrive,
} from './lib/googleDriveBackup';
import { buildFullPassbookExportPayload, downloadPassbookPdf } from './lib/passbookExport';
import type { ImportMode } from './lib/excel';
import type {
  AnalyticsSummary,
  BudgetHeadEnriched,
  BudgetSanctionEnriched,
  SafeUser,
  TransactionEnriched,
  UserWithStats,
} from './types/finance';

type TabKey = 'overview' | 'heads' | 'sanctions' | 'transactions' | 'reports' | 'users' | 'backup';

interface NavItem {
  key: TabKey;
  label: string;
  shortLabel: string;
  icon: React.ComponentType<{ className?: string }>;
}

const INACTIVITY_LIMIT_MS = 5 * 60 * 1000; // 5 minutes
const LAST_ACTIVITY_STORAGE_KEY = 'lf_last_activity_ms';

function formatLoginTimestamp(iso: string | null): string {
  if (!iso) return 'Just now';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return 'Just now';
  return d.toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function formatCountdown(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const m = Math.floor(safe / 60);
  const s = safe % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function App() {
  const [user, setUser] = useState<SafeUser | null>(null);
  const [loginAt, setLoginAt] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [idleRemainingSec, setIdleRemainingSec] = useState<number>(Math.floor(INACTIVITY_LIMIT_MS / 1000));
  const [authChecking, setAuthChecking] = useState(true);
  const [activeTab, setActiveTab] = useState<TabKey>('overview');
  const [mobileAccountOpen, setMobileAccountOpen] = useState(false);

  const lastActivityRef = useRef<number>(Date.now());
  const lastPingRef = useRef<number>(Date.now());

  // Domain Data
  const [budgetHeads, setBudgetHeads] = useState<BudgetHeadEnriched[]>([]);
  const [sanctions, setSanctions] = useState<BudgetSanctionEnriched[]>([]);
  const [transactions, setTransactions] = useState<TransactionEnriched[]>([]);
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(null);
  const [users, setUsers] = useState<UserWithStats[]>([]);
  const [dataLoading, setDataLoading] = useState(false);
  const [dataError, setDataError] = useState<string | null>(null);

  // Cross-tab quick-action triggers
  const [openCreateTrigger, setOpenCreateTrigger] = useState<TabKey | null>(null);
  const [exportLedgerPdfTrigger, setExportLedgerPdfTrigger] = useState(false);
  const [preselectedHeadId, setPreselectedHeadId] = useState<string | null>(null);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [importDefaultMode, setImportDefaultMode] = useState<ImportMode>('workbook');

  const openImportModal = (mode: ImportMode) => {
    if (user?.role !== 'admin') return;
    setImportDefaultMode(mode);
    setImportModalOpen(true);
  };

  const fetchAllData = useCallback(async (currentUser: SafeUser) => {
    setDataLoading(true);
    setDataError(null);
    try {
      const requests: Promise<unknown>[] = [
        api.getBudgetHeads(),
        api.getSanctions(),
        api.getTransactions(),
        api.getAnalytics(0),
      ];
      if (currentUser.role === 'admin') {
        requests.push(api.getUsers());
      }
      const results = await Promise.all(requests);
      setBudgetHeads((results[0] as { budgetHeads: BudgetHeadEnriched[] }).budgetHeads);
      setSanctions((results[1] as { sanctions: BudgetSanctionEnriched[] }).sanctions);
      setTransactions((results[2] as { transactions: TransactionEnriched[] }).transactions);
      setAnalytics((results[3] as { analytics: AnalyticsSummary }).analytics);
      if (currentUser.role === 'admin' && results[4]) {
        setUsers((results[4] as { users: UserWithStats[] }).users);
      } else {
        setUsers([]);
      }
    } catch (err) {
      setDataError(err instanceof Error ? err.message : 'Unable to sync financial records.');
    } finally {
      setDataLoading(false);
    }
  }, []);

  const handleSignOut = useCallback((notice?: string) => {
    setSessionToken(null);
    disconnectAdminGoogleDrive();
    try {
      window.localStorage.removeItem(LAST_ACTIVITY_STORAGE_KEY);
    } catch {
      // Ignore storage errors
    }
    void api.logout().catch(() => {});
    void signOut(auth).catch(() => {});
    setUser(null);
    setLoginAt(null);
    setSessionNotice(notice || null);
    setBudgetHeads([]);
    setSanctions([]);
    setTransactions([]);
    setAnalytics(null);
    setUsers([]);
    setMobileAccountOpen(false);
  }, []);

  // Restore session from HttpOnly cookie on mount/reload (prevents WebAPK scroll-reload logout)
  useEffect(() => {
    let active = true;

    const restoreCookieSession = async () => {
      try {
        const storedLast = Number(window.localStorage.getItem(LAST_ACTIVITY_STORAGE_KEY) || '0');
        if (storedLast > 0 && Date.now() - storedLast >= INACTIVITY_LIMIT_MS) {
          void api.logout().catch(() => {});
          window.localStorage.removeItem(LAST_ACTIVITY_STORAGE_KEY);
          if (active) {
            setSessionNotice('Signed out automatically after 5 minutes of inactivity.');
            setAuthChecking(false);
          }
          return;
        }
      } catch {
        // Ignore storage errors
      }

      try {
        const res = await api.me();
        if (!active) return;
        const now = Date.now();
        lastActivityRef.current = now;
        lastPingRef.current = now;
        try {
          window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
        } catch {
          // Ignore storage errors
        }
        setUser(res.user);
        setLoginAt(res.loginAt || new Date().toISOString());
        setSessionNotice(null);
        await fetchAllData(res.user);
      } catch {
        // No active HttpOnly cookie session — check Firebase Auth fallback below
      } finally {
        if (active) setAuthChecking(false);
      }
    };

    void restoreCookieSession();

    const unsubscribe = onAuthStateChanged(auth, async (fbUser) => {
      if (!active || getSessionToken() || !fbUser) return;
      try {
        const res = await api.me();
        if (!active) return;
        setUser((prev) => prev || res.user);
        setLoginAt((prev) => prev || res.loginAt || new Date().toISOString());
        await fetchAllData(res.user);
      } catch {
        // Ignore
      } finally {
        if (active) setAuthChecking(false);
      }
    });

    return () => {
      active = false;
      unsubscribe();
    };
  }, [fetchAllData]);

  // 5-Minute Inactivity Auto-Logout Watcher + Sliding Session Heartbeat
  useEffect(() => {
    if (!user) return;

    const nowInit = Date.now();
    lastActivityRef.current = nowInit;
    lastPingRef.current = nowInit;
    setIdleRemainingSec(Math.floor(INACTIVITY_LIMIT_MS / 1000));
    try {
      window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(nowInit));
    } catch {
      // Ignore storage errors
    }

    const recordActivity = () => {
      const now = Date.now();
      lastActivityRef.current = now;
      try {
        window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
      } catch {
        // Ignore
      }
      if (now - lastPingRef.current >= 45_000) {
        lastPingRef.current = now;
        void api.pingSession().catch(() => {});
      }
    };

    const events: Array<keyof WindowEventMap> = [
      'mousemove',
      'mousedown',
      'keydown',
      'touchstart',
      'scroll',
      'pointerdown',
      'click',
    ];
    events.forEach((evt) => window.addEventListener(evt, recordActivity, { passive: true }));

    const handleVisibility = () => {
      if (document.visibilityState === 'visible') {
        const elapsed = Date.now() - lastActivityRef.current;
        if (elapsed >= INACTIVITY_LIMIT_MS) {
          handleSignOut('Signed out automatically after 5 minutes of inactivity.');
        }
      }
    };
    document.addEventListener('visibilitychange', handleVisibility);

    const interval = window.setInterval(() => {
      const elapsed = Date.now() - lastActivityRef.current;
      const remainingMs = INACTIVITY_LIMIT_MS - elapsed;
      if (remainingMs <= 0) {
        window.clearInterval(interval);
        handleSignOut('Signed out automatically after 5 minutes of inactivity.');
        return;
      }
      setIdleRemainingSec(Math.ceil(remainingMs / 1000));
    }, 1000);

    return () => {
      events.forEach((evt) => window.removeEventListener(evt, recordActivity));
      document.removeEventListener('visibilitychange', handleVisibility);
      window.clearInterval(interval);
    };
  }, [user, handleSignOut]);

  // Watch Google Drive OAuth state & auto-sync any daily 00:00 hrs IST backups when Admin Drive is connected
  useEffect(() => {
    initDriveAuthWatcher();
  }, []);

  useEffect(() => {
    if (!user || user.role !== 'admin') return;
    let running = false;

    const runAutoDriveSync = async () => {
      if (running || !getDriveAccessToken()) return;
      running = true;
      try {
        const status = await api.getBackupStatus();
        if (!status.autoBackupEnabled || status.pendingDriveSyncFiles.length === 0) return;
        const driveInfo = getDriveConnectionState();
        for (const pending of status.pendingDriveSyncFiles) {
          if (!getDriveAccessToken()) break;
          const { snapshot } = await api.fetchServerBackupSnapshot(pending.fileName);
          const uploaded = await uploadBackupSnapshotToDrive({
            fileName: pending.fileName,
            snapshot,
            description: `LedgerFlow Daily 00:00 hrs Auto Backup (${pending.istDate})`,
          });
          await api.markDriveBackupSynced({
            driveFileId: uploaded.id,
            driveFileName: uploaded.name,
            driveEmail: driveInfo.email || user.email,
            serverFileName: pending.fileName,
          });
        }
      } catch {
        // Silent retry on next interval; interactive errors are shown in Backup & Restore tab
      } finally {
        running = false;
      }
    };

    const timer = window.setInterval(() => {
      void runAutoDriveSync();
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [user]);

  const handleAuthenticated = (loggedInUser: SafeUser, sessionLoginAt?: string) => {
    const now = Date.now();
    lastActivityRef.current = now;
    lastPingRef.current = now;
    try {
      window.localStorage.setItem(LAST_ACTIVITY_STORAGE_KEY, String(now));
    } catch {
      // Ignore
    }
    setUser(loggedInUser);
    setLoginAt(sessionLoginAt || new Date(now).toISOString());
    setSessionNotice(null);
    setActiveTab('overview');
    fetchAllData(loggedInUser);
  };

  const navItems: NavItem[] = useMemo(() => {
    if (!user) return [];
    if (user.role === 'admin') {
      return [
        { key: 'overview', label: 'Overview', shortLabel: 'Home', icon: LayoutDashboard },
        { key: 'heads', label: 'Budget Heads', shortLabel: 'Heads', icon: FolderKanban },
        { key: 'sanctions', label: 'Budget Sanctions', shortLabel: 'Sanctions', icon: Landmark },
        { key: 'transactions', label: 'Transactions', shortLabel: 'Ledger', icon: ReceiptText },
        { key: 'reports', label: 'Visual Reports', shortLabel: 'Reports', icon: BarChart3 },
        { key: 'users', label: 'Users', shortLabel: 'Users', icon: Users },
        { key: 'backup', label: 'Backup & Restore', shortLabel: 'Backup', icon: DatabaseBackup },
      ];
    }
    return [
      { key: 'overview', label: 'Overview', shortLabel: 'Home', icon: LayoutDashboard },
      { key: 'sanctions', label: 'Budget Sanctions', shortLabel: 'Sanctions', icon: Landmark },
      { key: 'transactions', label: 'Transactions', shortLabel: 'Ledger', icon: ReceiptText },
      { key: 'reports', label: 'Spending Analysis', shortLabel: 'Analysis', icon: BarChart3 },
    ];
  }, [user]);

  const mobileBottomItems = useMemo(() => {
    if (!user) return [];
    if (user.role === 'admin') {
      return navItems.filter((item) => item.key !== 'users' && item.key !== 'backup');
    }
    return navItems;
  }, [user, navItems]);

  const handleQuickExportFullLedgerPdf = useCallback(() => {
    if (!user) return;
    const payload = buildFullPassbookExportPayload({
      user,
      sanctions,
      transactions,
    });
    if (payload.rows.length === 0) {
      setActiveTab('transactions');
      return;
    }
    downloadPassbookPdf(payload);
  }, [user, sanctions, transactions]);

  const isUserLedgerExportPrimary = user?.role !== 'admin' && activeTab === 'transactions';

  const handlePrimaryAction = () => {
    if (!user) return;
    if (user.role !== 'admin') {
      if (activeTab === 'transactions') {
        setExportLedgerPdfTrigger(true);
        return;
      }
      setPreselectedHeadId(null);
      setActiveTab('sanctions');
      setOpenCreateTrigger('sanctions');
      return;
    }
    if (activeTab === 'heads') {
      setOpenCreateTrigger('heads');
      return;
    }
    if (activeTab === 'sanctions') {
      setPreselectedHeadId(null);
      setOpenCreateTrigger('sanctions');
      return;
    }
    if (activeTab === 'users') {
      setOpenCreateTrigger('users');
      return;
    }
    if (activeTab === 'backup') {
      setActiveTab('backup');
      return;
    }
    setPreselectedHeadId(null);
    setActiveTab('transactions');
    setOpenCreateTrigger('transactions');
  };

  const primaryActionLabel = useMemo(() => {
    if (!user) return 'Log Transaction';
    if (user.role !== 'admin') {
      return activeTab === 'transactions' ? 'Export Ledger PDF' : 'Submit Sanction';
    }
    if (activeTab === 'heads') return 'New Budget Head';
    if (activeTab === 'sanctions') return 'Enter Sanction';
    if (activeTab === 'users') return 'Add Account';
    return 'Log Transaction';
  }, [activeTab, user]);

  const pageMeta = useMemo(() => {
    const isAdmin = user?.role === 'admin';
    switch (activeTab) {
      case 'overview':
        return {
          title: isAdmin ? 'Executive Overview' : 'Finance Overview',
          subtitle: isAdmin
            ? 'Admin Panel · Budget heads, sanctions, and spending cashflow'
            : `User Panel · Read-only ledger, PDF export & sanction submissions`,
        };
      case 'heads':
        return {
          title: 'Budget Heads',
          subtitle: 'Create and organize budget heads before entering sanction amounts',
        };
      case 'sanctions':
        return {
          title: 'Budget Sanctions',
          subtitle: isAdmin
            ? 'Approve pending sanctions, enter sanction amounts & manage PDF orders'
            : 'Submit sanction entries for admin approval and view approved orders',
        };
      case 'transactions':
        return {
          title: 'Passbook Ledger',
          subtitle: isAdmin
            ? 'Datewise credit (sanctions) and debit (expenses) passbook with running balance'
            : 'View-only datewise passbook ledger with PDF & Excel export',
        };
      case 'reports':
        return {
          title: isAdmin ? 'Visual Reports & Analysis' : 'Spending Analysis',
          subtitle: 'Interactive charts, sanction variance tracking, and PDF utilization reports',
        };
      case 'users':
        return {
          title: 'User Accounts',
          subtitle: 'Approve, schedule active/deactive windows, or delete user accounts',
        };
      case 'backup':
        return {
          title: 'Backup & Restore',
          subtitle: 'Daily 00:00 hrs IST auto-backup to Admin Google Drive & full database restore',
        };
    }
  }, [activeTab, user]);

  if (authChecking) {
    return (
      <div className="min-h-screen bg-[#F4F6FA] flex items-center justify-center">
        <div className="flex items-center gap-3 text-slate-600">
          <div className="w-9 h-9 rounded-xl bg-teal-700 flex items-center justify-center">
            <Wallet className="w-5 h-5 text-white" />
          </div>
          <span className="font-display font-semibold text-slate-900">Loading LedgerFlow...</span>
        </div>
      </div>
    );
  }

  if (!user) {
    return (
      <>
        <AuthScreen onAuthenticated={handleAuthenticated} sessionMessage={sessionNotice} />
        <OfflineIndicator />
      </>
    );
  }

  const refreshCurrentUser = async () => {
    await fetchAllData(user);
  };

  return (
    <div className="min-h-screen bg-[#F4F6FA] flex flex-col lg:flex-row">
      {/* Desktop Persistent Obsidian Navy Navigation Rail (260px) */}
      <aside className="hidden lg:flex lg:w-[260px] lg:shrink-0 lg:flex-col bg-[#0B1220] text-slate-200 border-r border-slate-800/80 sticky top-0 h-screen">
        <div className="h-16 px-6 flex items-center gap-3 border-b border-white/10 shrink-0">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-[#2845B8] to-[#15286E] ring-1 ring-[#E5C675]/40 flex items-center justify-center shrink-0">
            <Wallet className="w-5 h-5 text-[#E5C675]" />
          </div>
          <span className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap">
            LedgerFlow
          </span>
        </div>

        <nav className="flex-1 px-3 py-5 space-y-1 overflow-y-auto" aria-label="Primary navigation">
          <p className="px-3 pb-2 text-xs font-medium text-slate-400">
            {user.role === 'admin' ? 'Admin Panel' : 'User Panel'}
          </p>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className={`w-full min-h-[44px] px-3.5 rounded-xl flex items-center gap-3 text-sm font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  active
                    ? 'bg-white/12 text-white font-semibold shadow-[inset_0_0_0_1px_rgba(229,198,117,0.22)]'
                    : 'text-slate-300 hover:bg-white/6 hover:text-white'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[#E5C675]' : 'text-slate-400'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}

          <div className="pt-4 mt-4 border-t border-white/10 space-y-2">
            {user.role === 'admin' && (
              <button
                type="button"
                onClick={() => openImportModal('workbook')}
                className="w-full min-h-[44px] px-3.5 rounded-xl flex items-center gap-3 text-sm font-medium text-[#E5C675] bg-white/6 hover:bg-white/10 border border-white/10 transition-colors cursor-pointer whitespace-nowrap"
              >
                <FileSpreadsheet className="w-4 h-4 shrink-0 text-[#E5C675]" />
                <span className="truncate">Import Excel Data</span>
              </button>
            )}
            <PWAInstallButton variant="sidebar" />
          </div>
        </nav>

        <div className="p-4 border-t border-white/10 shrink-0 space-y-2.5 bg-[#080E1A]">
          <div className="flex items-center gap-3">
            <Avatar name={user.fullName} src={user.avatarUrl} size="md" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-white truncate">{user.fullName}</p>
              <p className="text-xs text-slate-400 truncate">
                @{user.username} · {user.role === 'admin' ? 'Admin' : 'User'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => handleSignOut()}
              title="Sign Out"
              aria-label="Sign Out"
              className="min-w-[38px] min-h-[38px] flex items-center justify-center rounded-xl text-slate-400 hover:text-white hover:bg-white/10 cursor-pointer shrink-0"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
          <div className="px-2.5 py-2 rounded-xl bg-white/5 border border-white/10 flex items-center justify-between text-[11px] text-slate-300">
            <span className="inline-flex items-center gap-1.5">
              <Clock className="w-3 h-3 text-[#E5C675] shrink-0" />
              <span>Login: <strong className="font-mono text-white">{formatLoginTimestamp(loginAt)}</strong></span>
            </span>
            <span
              className={`font-mono tabular-nums font-medium ${
                idleRemainingSec <= 60 ? 'text-amber-300' : 'text-slate-400'
              }`}
              title="Auto-logout after 5 minutes of inactivity"
            >
              {formatCountdown(idleRemainingSec)}
            </span>
          </div>
          <p className="text-[10px] text-slate-400 text-center leading-tight pt-0.5">
            App Developed by <span className="text-[#E5C675] font-medium">Shakti Chahar</span> · v2.0.0
          </p>
        </div>
      </aside>

      {/* Main Viewport Column */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="sticky top-0 z-30 h-14 lg:h-16 bg-white/90 backdrop-blur-md border-b border-slate-200/80 px-4 sm:px-6 lg:px-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <div className="lg:hidden w-8 h-8 rounded-lg bg-[#0B1220] ring-1 ring-[#E5C675]/40 flex items-center justify-center shrink-0">
              <Wallet className="w-4 h-4 text-[#E5C675]" />
            </div>
            <div className="min-w-0">
              <h1 className="text-base lg:text-lg font-semibold text-slate-900 tracking-tight truncate">
                {pageMeta.title}
              </h1>
              <p className="hidden sm:block text-xs text-slate-500 truncate">{pageMeta.subtitle}</p>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <div className="hidden md:flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-50 border border-slate-200/80 text-xs text-slate-600 whitespace-nowrap">
              <Clock className="w-3.5 h-3.5 text-teal-700 shrink-0" />
              <span>Login {formatLoginTimestamp(loginAt)}</span>
            </div>

            <div className="lg:hidden">
              <PWAInstallButton variant="header" />
            </div>

            {activeTab !== 'backup' && (
              <button
                type="button"
                onClick={handlePrimaryAction}
                className="hidden sm:inline-flex min-h-[40px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 active:scale-[0.99] text-white text-xs font-semibold items-center gap-1.5 transition-all whitespace-nowrap cursor-pointer shadow-[0_4px_12px_-4px_rgba(29,53,143,0.4)]"
              >
                {isUserLedgerExportPrimary ? (
                  <FileText className="w-4 h-4" />
                ) : (
                  <Plus className="w-4 h-4" />
                )}
                <span>{primaryActionLabel}</span>
              </button>
            )}

            <button
              type="button"
              onClick={() => setMobileAccountOpen(true)}
              aria-label="Open account menu"
              className="lg:hidden min-w-[44px] min-h-[44px] flex items-center justify-center rounded-full cursor-pointer"
            >
              <Avatar name={user.fullName} src={user.avatarUrl} size="sm" />
            </button>
          </div>
        </header>

        <main className="flex-1 px-4 sm:px-6 lg:px-8 py-5 lg:py-7 pb-24 lg:pb-10 max-w-7xl w-full mx-auto">
          {dataError && (
            <div className="mb-5 px-4 py-3 rounded-xl bg-red-50 border border-red-200 text-xs sm:text-sm text-red-700 flex items-center justify-between gap-3">
              <span>{dataError}</span>
              <button
                type="button"
                onClick={refreshCurrentUser}
                className="font-semibold underline cursor-pointer shrink-0"
              >
                Retry
              </button>
            </div>
          )}

          {activeTab === 'overview' && (
            <OverviewView
              user={user}
              analytics={analytics}
              budgetHeads={budgetHeads}
              transactions={transactions}
              loading={dataLoading}
              onNavigate={(tab) => setActiveTab(tab)}
              onExportLedgerPdf={handleQuickExportFullLedgerPdf}
              onQuickLogTransaction={(headId) => {
                setPreselectedHeadId(headId || null);
                if (user.role === 'admin') {
                  setActiveTab('transactions');
                  setOpenCreateTrigger('transactions');
                } else {
                  setActiveTab('sanctions');
                  setOpenCreateTrigger('sanctions');
                }
              }}
            />
          )}

          {activeTab === 'heads' && user.role === 'admin' && (
            <BudgetHeadsView
              budgetHeads={budgetHeads}
              onRefresh={refreshCurrentUser}
              onOpenImport={() => openImportModal('budget-heads')}
              onAddSanctionForHead={(headId) => {
                setPreselectedHeadId(headId);
                setActiveTab('sanctions');
                setOpenCreateTrigger('sanctions');
              }}
              externalOpenCreate={openCreateTrigger === 'heads'}
              onConsumeExternalCreate={() => setOpenCreateTrigger(null)}
            />
          )}

          {activeTab === 'sanctions' && (
            <SanctionsView
              user={user}
              sanctions={sanctions}
              budgetHeads={budgetHeads}
              onRefresh={refreshCurrentUser}
              onOpenImport={() => openImportModal('sanctions')}
              preselectedHeadId={preselectedHeadId}
              externalOpenCreate={openCreateTrigger === 'sanctions'}
              onConsumeExternalCreate={() => setOpenCreateTrigger(null)}
            />
          )}

          {activeTab === 'transactions' && (
            <TransactionsView
              user={user}
              transactions={transactions}
              budgetHeads={budgetHeads}
              sanctions={sanctions}
              onRefresh={refreshCurrentUser}
              onOpenImport={() => openImportModal('transactions')}
              preselectedHeadId={preselectedHeadId}
              externalOpenCreate={openCreateTrigger === 'transactions'}
              onConsumeExternalCreate={() => setOpenCreateTrigger(null)}
              externalExportPdf={exportLedgerPdfTrigger}
              onConsumeExternalExportPdf={() => setExportLedgerPdfTrigger(false)}
            />
          )}

          {activeTab === 'reports' && (
            <ReportsView
              user={user}
              initialAnalytics={analytics}
              budgetHeads={budgetHeads}
              sanctions={sanctions}
              transactions={transactions}
            />
          )}

          {activeTab === 'users' && user.role === 'admin' && (
            <UsersView
              currentUser={user}
              users={users}
              onRefresh={refreshCurrentUser}
              externalOpenCreate={openCreateTrigger === 'users'}
              onConsumeExternalCreate={() => setOpenCreateTrigger(null)}
            />
          )}

          {activeTab === 'backup' && user.role === 'admin' && (
            <BackupRestoreView user={user} onDatabaseRestored={refreshCurrentUser} />
          )}
        </main>
      </div>

      {/* Mobile Android Floating Action Button */}
      {activeTab !== 'backup' && (
        <button
          type="button"
          onClick={handlePrimaryAction}
          aria-label={primaryActionLabel}
          className="sm:hidden fixed right-4 bottom-20 z-30 w-14 h-14 rounded-2xl bg-teal-700 hover:bg-teal-800 active:scale-95 text-white shadow-lg shadow-teal-900/20 flex items-center justify-center transition-transform cursor-pointer"
        >
          {isUserLedgerExportPrimary ? (
            <FileText className="w-6 h-6" />
          ) : (
            <Plus className="w-6 h-6" />
          )}
        </button>
      )}

      {/* Mobile Android Fixed Bottom Navigation Bar */}
      <nav
        aria-label="Mobile navigation"
        className="lg:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-md border-t border-slate-200 pb-safe"
      >
        <div
          className={`grid ${
            mobileBottomItems.length === 5 ? 'grid-cols-5' : 'grid-cols-4'
          } items-center h-16 px-1`}
        >
          {mobileBottomItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.key;
            return (
              <button
                key={item.key}
                type="button"
                onClick={() => setActiveTab(item.key)}
                className="min-h-[48px] flex flex-col items-center justify-center gap-1 cursor-pointer"
              >
                <span
                  className={`w-12 h-7 rounded-full flex items-center justify-center transition-colors ${
                    active ? 'bg-teal-100 text-teal-900' : 'text-slate-500'
                  }`}
                >
                  <Icon className="w-5 h-5" />
                </span>
                <span
                  className={`text-[11px] leading-none tracking-tight whitespace-nowrap ${
                    active ? 'font-semibold text-teal-900' : 'font-medium text-slate-500'
                  }`}
                >
                  {item.shortLabel}
                </span>
              </button>
            );
          })}
        </div>
      </nav>

      {/* Mobile Account & Role Drawer Sheet */}
      <BottomSheetModal
        open={mobileAccountOpen}
        onClose={() => setMobileAccountOpen(false)}
        title="Account & Workspace"
        subtitle={user.role === 'admin' ? 'Admin Panel Session' : 'User Panel Session'}
      >
        <div className="space-y-4">
          <div className="flex items-center gap-3.5 pb-4 border-b border-slate-100">
            <Avatar name={user.fullName} src={user.avatarUrl} size="lg" />
            <div className="min-w-0">
              <p className="text-base font-semibold text-slate-900 truncate">{user.fullName}</p>
              <p className="text-xs text-slate-500 mt-0.5">
                @{user.username} · {user.role === 'admin' ? 'Administrator' : 'Standard User'}
              </p>
            </div>
          </div>

          <div className="px-3.5 py-3 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between text-xs text-slate-700">
            <span className="inline-flex items-center gap-2">
              <Clock className="w-4 h-4 text-teal-700 shrink-0" />
              <span>
                Logged in at <strong className="font-mono text-slate-900">{formatLoginTimestamp(loginAt)}</strong>
              </span>
            </span>
            <span className="font-mono tabular-nums text-[11px] text-slate-500">
              Idle logout {formatCountdown(idleRemainingSec)}
            </span>
          </div>

          {user.role === 'admin' && (
            <>
              <button
                type="button"
                onClick={() => {
                  setActiveTab('users');
                  setMobileAccountOpen(false);
                }}
                className="w-full min-h-[48px] px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium text-slate-800 flex items-center justify-between cursor-pointer"
              >
                <span className="inline-flex items-center gap-2.5">
                  <Users className="w-4 h-4 text-teal-700" />
                  <span>Manage User Accounts</span>
                </span>
                <span className="font-mono text-xs text-slate-500">{users.length}</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setActiveTab('backup');
                  setMobileAccountOpen(false);
                }}
                className="w-full min-h-[48px] px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium text-slate-800 flex items-center justify-between cursor-pointer"
              >
                <span className="inline-flex items-center gap-2.5">
                  <DatabaseBackup className="w-4 h-4 text-teal-700" />
                  <span>Backup &amp; Restore (Drive)</span>
                </span>
                <span className="font-mono text-xs text-slate-500">00:00</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setMobileAccountOpen(false);
                  openImportModal('workbook');
                }}
                className="w-full min-h-[48px] px-4 rounded-xl border border-slate-200 hover:bg-slate-50 text-sm font-medium text-slate-800 flex items-center justify-between cursor-pointer"
              >
                <span className="inline-flex items-center gap-2.5">
                  <FileSpreadsheet className="w-4 h-4 text-teal-700" />
                  <span>Import Excel &amp; Templates</span>
                </span>
                <span className="text-xs text-slate-500">.xlsx</span>
              </button>
            </>
          )}

          <PWAInstallButton
            variant="mobile-sheet"
            onAction={() => setMobileAccountOpen(false)}
          />

          <button
            type="button"
            onClick={() => handleSignOut()}
            className="w-full min-h-[48px] px-4 rounded-xl bg-[#0B1220] hover:bg-slate-900 text-white text-sm font-semibold flex items-center justify-center gap-2 cursor-pointer"
          >
            <LogOut className="w-4 h-4" />
            <span>Sign Out</span>
          </button>

          <p className="pt-1 text-center text-[11px] text-slate-500">
            App Developed by <span className="font-semibold text-slate-800">Shakti Chahar</span> · Version 2.0.0
          </p>
        </div>
      </BottomSheetModal>

      {/* Excel Bulk Upload & Template Modal */}
      <ImportExcelModal
        open={importModalOpen}
        onClose={() => setImportModalOpen(false)}
        defaultMode={importDefaultMode}
        user={user}
        budgetHeads={budgetHeads}
        users={users}
        onImported={refreshCurrentUser}
      />

      <OfflineIndicator />
    </div>
  );
}
