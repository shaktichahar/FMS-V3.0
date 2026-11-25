export type UserRole = 'admin' | 'user';

export interface SafeUser {
  id: string;
  username: string;
  fullName: string;
  department: string;
  email: string;
  mobile: string;
  role: UserRole;
  avatarUrl?: string;
  active: boolean;
  activeFrom?: string | null;
  activeUntil?: string | null;
  deactivatedFrom?: string | null;
  deactivatedUntil?: string | null;
  createdAt: string;
}

export interface OtpDeliveryInfo {
  emailSent: boolean;
  smsSent: boolean;
  mode: 'live';
  channels: Array<'email' | 'mobile'>;
  notice: string;
}

export type OtpPurpose = 'login' | 'direct-otp' | 'register';

export interface OtpChallengeResponse {
  otpRequired: true;
  purpose: OtpPurpose;
  challengeId: string;
  maskedEmail: string | null;
  maskedMobile: string | null;
  expiresInSeconds: number;
  resendCooldownSeconds: number;
  delivery: OtpDeliveryInfo;
}

export type OtpVerifyResponse =
  | {
      pendingApproval?: false;
      token: string;
      user: SafeUser;
      loginAt?: string;
    }
  | {
      pendingApproval: true;
      emailVerified: true;
      message: string;
      user: SafeUser;
    };

export interface UserWithStats extends SafeUser {
  spentTotal: number;
  transactionCount: number;
}

export interface BudgetHead {
  id: string;
  name: string;
  color: string;
  description: string;
  createdAt: string;
  createdBy: string;
}

export interface BudgetHeadEnriched extends BudgetHead {
  sanctionedTotal: number;
  spentTotal: number;
  remainingBalance: number;
  utilizationPct: number;
  sanctionCount: number;
  latestFinancialYear: string | null;
}

export interface SanctionAttachment {
  fileName: string;
  storedFileName: string;
  mimeType: string;
  sizeBytes: number;
  source: 'pdf-upload' | 'camera-scan';
  uploadedAt: string;
}

export type SanctionApprovalStatus = 'approved' | 'pending' | 'rejected';

export interface BudgetSanction {
  id: string;
  budgetHeadId: string;
  sanctionAmount: number;
  sanctionDate: string; // YYYY-MM-DD
  financialYear: string; // Auto-calculated e.g. "FY 2026-27"
  sanctionOrderNo: string;
  sanctionedBy: string;
  notes: string;
  attachment?: SanctionAttachment;
  approvalStatus: SanctionApprovalStatus;
  approvedBy?: string | null;
  approvedAt?: string | null;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
}

export interface BudgetSanctionEnriched extends BudgetSanction {
  budgetHeadName: string;
  budgetHeadColor: string;
  createdByName: string;
}

export type TransactionType = 'expense' | 'income';
export type TransactionStatus = 'approved' | 'pending' | 'flagged';
export type PaymentMethod =
  | 'Cheque'
  | 'Corporate Card'
  | 'Bank Transfer'
  | 'UPI / Mobile'
  | 'Cash Voucher'
  | 'Direct Debit';

export interface Transaction {
  id: string;
  budgetHeadId: string;
  userId: string;
  title: string;
  merchant: string;
  amount: number;
  type: TransactionType;
  status: TransactionStatus;
  paymentMethod: PaymentMethod;
  date: string; // YYYY-MM-DD
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
  createdAt: string;
}

export interface TransactionEnriched extends Transaction {
  budgetHeadName: string;
  budgetHeadColor: string;
  userName: string;
  userDepartment: string;
}

export interface MonthlyPoint {
  month: string; // e.g. "Jun 2026"
  monthKey: string; // YYYY-MM
  expense: number;
  income: number;
  sanctionPace: number;
}

export interface HeadSharePoint {
  id: string;
  name: string;
  amount: number;
  sharePct: number;
  color: string;
  count: number;
}

export interface HeadComparisonPoint {
  id: string;
  name: string;
  color: string;
  sanctioned: number;
  spent: number;
  remaining: number;
  utilizationPct: number;
}

export interface FinancialYearPoint {
  financialYear: string;
  sanctioned: number;
  spent: number;
  utilizationPct: number;
  sanctionCount: number;
}

export interface DepartmentSpendPoint {
  userId: string;
  userName: string;
  department: string;
  spent: number;
  transactionCount: number;
}

export interface PaymentMethodPoint {
  method: string;
  amount: number;
  count: number;
}

export interface AnalyticsSummary {
  scope: 'organization' | 'personal';
  totalSanctioned: number;
  totalSpent: number;
  totalIncome: number;
  remainingBalance: number;
  utilizationPct: number;
  sanctionCount: number;
  pendingCount: number;
  flaggedCount: number;
  transactionCount: number;
  availableFinancialYears: string[];
  monthlySeries: MonthlyPoint[];
  headShareBreakdown: HeadSharePoint[];
  headComparison: HeadComparisonPoint[];
  financialYearBreakdown: FinancialYearPoint[];
  departmentBreakdown: DepartmentSpendPoint[];
  paymentMethodBreakdown: PaymentMethodPoint[];
  alerts: Array<{
    id: string;
    label: string;
    context: string;
    utilizationPct: number;
    spent: number;
    limit: number;
    severity: 'warning' | 'critical';
  }>;
}

export interface ImportBudgetHeadRow {
  rowNumber: number;
  name: string;
  color?: string;
  description?: string;
}

export interface ImportSanctionRow {
  rowNumber: number;
  budgetHeadName: string;
  sanctionAmount: number;
  sanctionDate: string;
  sanctionOrderNo?: string;
  sanctionedBy?: string;
  notes?: string;
}

export interface ImportTransactionRow {
  rowNumber: number;
  date: string;
  title: string;
  merchant: string;
  budgetHeadName: string;
  amount: number;
  type: TransactionType;
  paymentMethod: PaymentMethod;
  reference?: string;
  notes?: string;
  username?: string;
}

export interface ImportResultSummary {
  created: number;
  updated: number;
  skipped: number;
  duplicates?: number;
  errors: Array<{ row: number; message: string }>;
}

export interface WorkbookImportResult {
  budgetHeads: ImportResultSummary;
  sanctions: ImportResultSummary;
  transactions: ImportResultSummary;
}

export interface BackupCounts {
  users: number;
  budgetHeads: number;
  budgetSanctions: number;
  transactions: number;
}

export interface DatabaseBackupSnapshotPayload {
  schemaVersion: 1;
  app: 'LedgerFlow';
  exportedAt: string;
  timezone: 'Asia/Kolkata';
  trigger?: 'scheduled-00:00' | 'manual' | 'pre-restore';
  counts: BackupCounts;
  data: {
    users: unknown[];
    budgetHeads: unknown[];
    budgetSanctions: unknown[];
    transactions: unknown[];
  };
}

export interface ServerBackupSnapshotMeta {
  fileName: string;
  sizeBytes: number;
  createdAt: string;
  trigger: 'scheduled-00:00' | 'manual' | 'pre-restore';
  istDate: string;
  counts: BackupCounts;
  driveSyncedAt: string | null;
  driveFileId: string | null;
}

export interface BackupStatusResponse {
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
  serverSnapshots: ServerBackupSnapshotMeta[];
  pendingDriveSyncFiles: ServerBackupSnapshotMeta[];
}

export interface DriveBackupFile {
  id: string;
  name: string;
  createdTime: string;
  sizeBytes: number;
  webViewLink?: string;
}
