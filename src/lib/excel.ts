import * as XLSX from 'xlsx';
import type {
  BudgetHeadEnriched,
  ImportBudgetHeadRow,
  ImportSanctionRow,
  ImportTransactionRow,
  PaymentMethod,
  SafeUser,
  TransactionType,
  UserWithStats,
} from '../types/finance';

export type ImportMode = 'transactions' | 'sanctions' | 'budget-heads' | 'workbook';

export interface ParsedExcelPayload {
  budgetHeads: ImportBudgetHeadRow[];
  sanctions: ImportSanctionRow[];
  transactions: ImportTransactionRow[];
  warnings: string[];
  detectedSheets: string[];
}

const VALID_PAYMENT_METHODS: PaymentMethod[] = [
  'Cheque',
  'Corporate Card',
  'Bank Transfer',
  'UPI / Mobile',
  'Cash Voucher',
  'Direct Debit',
];

function normalizeKey(key: string): string {
  return key
    .toLowerCase()
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]/g, '');
}

function getField(row: Record<string, unknown>, aliases: string[]): unknown {
  const map = new Map<string, unknown>();
  for (const [k, v] of Object.entries(row)) {
    map.set(normalizeKey(k), v);
  }
  for (const alias of aliases) {
    const val = map.get(normalizeKey(alias));
    if (val !== undefined && val !== null && String(val).trim() !== '') {
      return val;
    }
  }
  return '';
}

function parseAmount(raw: unknown): number {
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : NaN;
  const cleaned = String(raw ?? '')
    .replace(/[₹$,\s]/g, '')
    .replace(/^inr/i, '')
    .trim();
  if (!cleaned) return NaN;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : NaN;
}

function parseExcelDate(raw: unknown): string {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const y = raw.getFullYear();
    const m = String(raw.getMonth() + 1).padStart(2, '0');
    const d = String(raw.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof raw === 'number' && raw > 20000 && raw < 80000) {
    const parsed = XLSX.SSF.parse_date_code(raw);
    if (parsed && parsed.y && parsed.m && parsed.d) {
      return `${parsed.y}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
    }
  }
  const str = String(raw ?? '').trim();
  if (!str) return new Date().toISOString().slice(0, 10);

  const isoMatch = str.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
  if (isoMatch) {
    return `${isoMatch[1]}-${isoMatch[2].padStart(2, '0')}-${isoMatch[3].padStart(2, '0')}`;
  }
  const dmyMatch = str.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (dmyMatch) {
    const day = Number(dmyMatch[1]);
    const month = Number(dmyMatch[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      return `${dmyMatch[3]}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }
  const fallback = new Date(str);
  if (!Number.isNaN(fallback.getTime())) {
    return fallback.toISOString().slice(0, 10);
  }
  return new Date().toISOString().slice(0, 10);
}

function normalizePaymentMethod(raw: unknown): PaymentMethod {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return 'UPI / Mobile';
  const exact = VALID_PAYMENT_METHODS.find((m) => m.toLowerCase() === s);
  if (exact) return exact;
  if (s.includes('cheque') || s.includes('check') || s.includes('chq')) {
    return 'Cheque';
  }
  if (s.includes('upi') || s.includes('mobile') || s.includes('gpay') || s.includes('phonepe')) {
    return 'UPI / Mobile';
  }
  if (s.includes('bank') || s.includes('neft') || s.includes('rtgs') || s.includes('imps') || s.includes('transfer')) {
    return 'Bank Transfer';
  }
  if (s.includes('card') || s.includes('credit') || s.includes('debit card')) {
    return 'Corporate Card';
  }
  if (s.includes('direct') || s.includes('auto')) {
    return 'Direct Debit';
  }
  if (s.includes('cash') || s.includes('voucher') || s.includes('petty')) {
    return 'Cash Voucher';
  }
  return 'UPI / Mobile';
}

function normalizeTxType(raw: unknown): TransactionType {
  const s = String(raw ?? '').trim().toLowerCase();
  if (s === 'income' || s === 'credit' || s === 'rebate' || s === 'refund') {
    return 'income';
  }
  return 'expense';
}

function parseBudgetHeadsSheet(rows: Record<string, unknown>[], warnings: string[]): ImportBudgetHeadRow[] {
  const out: ImportBudgetHeadRow[] = [];
  rows.forEach((row, idx) => {
    const rowNumber = idx + 2;
    const name = String(getField(row, ['Name', 'Budget Head', 'Budget Head Name', 'Head Name', 'Title'])).trim();
    const color = String(getField(row, ['Color', 'Chart Color', 'Hex']) || '#0F766E').trim();
    const description = String(getField(row, ['Description', 'Notes', 'Scope']) || '').trim();

    if (!name && !description) return;
    if (!name) {
      warnings.push(`Budget Heads row ${rowNumber}: Budget Head Name is required.`);
      return;
    }
    out.push({
      rowNumber,
      name,
      color: /^#[0-9A-Fa-f]{6}$/.test(color) ? color : '#0F766E',
      description,
    });
  });
  return out;
}

function parseSanctionsSheet(rows: Record<string, unknown>[], warnings: string[]): ImportSanctionRow[] {
  const out: ImportSanctionRow[] = [];
  rows.forEach((row, idx) => {
    const rowNumber = idx + 2;
    const budgetHeadName = String(
      getField(row, ['Budget Head Name', 'Budget Head', 'Head Name', 'Head'])
    ).trim();
    const sanctionAmount = parseAmount(
      getField(row, ['Sanction Amount', 'Sanction Amount (INR)', 'Amount', 'Sanctioned Amount'])
    );
    const sanctionDate = parseExcelDate(
      getField(row, ['Sanction Date', 'Date', 'Order Date'])
    );
    const sanctionOrderNo = String(
      getField(row, ['Sanction Order No', 'Order No', 'Sanction Ref', 'Reference', 'Letter No']) || ''
    ).trim();
    const sanctionedBy = String(
      getField(row, ['Sanctioned By', 'Authority', 'Approved By']) || 'Technical Director RISL'
    ).trim();
    const notes = String(getField(row, ['Notes', 'Remarks', 'Description']) || '').trim();

    if (!budgetHeadName && Number.isNaN(sanctionAmount)) return;
    if (!budgetHeadName || !Number.isFinite(sanctionAmount) || sanctionAmount <= 0) {
      warnings.push(
        `Budget Sanctions row ${rowNumber}: requires Budget Head Name and positive Sanction Amount (INR).`
      );
      return;
    }
    out.push({
      rowNumber,
      budgetHeadName,
      sanctionAmount: Math.round(sanctionAmount * 100) / 100,
      sanctionDate,
      sanctionOrderNo,
      sanctionedBy,
      notes,
    });
  });
  return out;
}

function parseTransactionsSheet(rows: Record<string, unknown>[], warnings: string[]): ImportTransactionRow[] {
  const out: ImportTransactionRow[] = [];
  rows.forEach((row, idx) => {
    const rowNumber = idx + 2;
    const title = String(getField(row, ['Title', 'Expense Title', 'Description', 'Particulars', 'Item'])).trim();
    const merchant = String(getField(row, ['Merchant', 'Vendor', 'Payee', 'Party', 'Store'])).trim();
    const budgetHeadName = String(
      getField(row, ['Budget Head Name', 'Budget Head', 'Head Name', 'Head'])
    ).trim();
    const amount = parseAmount(getField(row, ['Amount', 'Amount (INR)', 'Expense Amount', 'Value', 'Total']));
    const type = normalizeTxType(getField(row, ['Type', 'Transaction Type', 'Entry Type']));
    const paymentMethod = normalizePaymentMethod(
      getField(row, ['Payment Method', 'Payment Mode', 'Mode', 'Channel'])
    );
    const date = parseExcelDate(getField(row, ['Date', 'Transaction Date', 'Expense Date']));
    const reference = String(getField(row, ['Reference', 'Invoice Ref', 'Receipt Ref', 'Ref', 'Bill No']) || '').trim();
    const notes = String(getField(row, ['Notes', 'Remarks', 'Comments']) || '').trim();
    const username = String(getField(row, ['Username', 'User', 'Custodian', 'Employee']) || '').trim();

    if (!title && !merchant && Number.isNaN(amount)) return;
    if (!title || !merchant || !budgetHeadName || !Number.isFinite(amount) || amount <= 0) {
      warnings.push(
        `Transactions row ${rowNumber}: requires Title, Merchant, Budget Head Name, and positive Amount (INR).`
      );
      return;
    }

    out.push({
      rowNumber,
      date,
      title,
      merchant,
      budgetHeadName,
      amount: Math.round(amount * 100) / 100,
      type,
      paymentMethod,
      reference,
      notes,
      username: username || undefined,
    });
  });
  return out;
}

export async function parseExcelFile(file: File, mode: ImportMode): Promise<ParsedExcelPayload> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true });
  const warnings: string[] = [];
  const detectedSheets: string[] = [];

  let budgetHeads: ImportBudgetHeadRow[] = [];
  let sanctions: ImportSanctionRow[] = [];
  let transactions: ImportTransactionRow[] = [];

  const getSheetRows = (sheetName: string): Record<string, unknown>[] => {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' });
  };

  if (mode === 'workbook') {
    for (const sheetName of workbook.SheetNames) {
      const lower = sheetName.toLowerCase();
      if (lower.includes('guide') || lower.includes('instruction') || lower.includes('reference')) {
        continue;
      }
      const rows = getSheetRows(sheetName);
      if (rows.length === 0) continue;

      if (lower.includes('head')) {
        detectedSheets.push(sheetName);
        budgetHeads = budgetHeads.concat(parseBudgetHeadsSheet(rows, warnings));
      } else if (lower.includes('sanct')) {
        detectedSheets.push(sheetName);
        sanctions = sanctions.concat(parseSanctionsSheet(rows, warnings));
      } else if (lower.includes('trans') || lower.includes('expense') || lower.includes('ledger')) {
        detectedSheets.push(sheetName);
        transactions = transactions.concat(parseTransactionsSheet(rows, warnings));
      }
    }
    if (detectedSheets.length === 0 && workbook.SheetNames.length > 0) {
      warnings.push(
        'No sheets named "Budget Heads", "Budget Sanctions", or "Transactions" were detected. Use the downloadable Excel template or choose a specific single-sheet import type.'
      );
    }
  } else {
    const targetSheet =
      workbook.SheetNames.find((name) => {
        const lower = name.toLowerCase();
        if (mode === 'budget-heads') return lower.includes('head');
        if (mode === 'sanctions') return lower.includes('sanct');
        return lower.includes('trans') || lower.includes('expense') || lower.includes('ledger');
      }) || workbook.SheetNames[0];

    if (targetSheet) {
      detectedSheets.push(targetSheet);
      const rows = getSheetRows(targetSheet);
      if (mode === 'budget-heads') {
        budgetHeads = parseBudgetHeadsSheet(rows, warnings);
      } else if (mode === 'sanctions') {
        sanctions = parseSanctionsSheet(rows, warnings);
      } else {
        transactions = parseTransactionsSheet(rows, warnings);
      }
    }
  }

  return {
    budgetHeads,
    sanctions,
    transactions,
    warnings,
    detectedSheets,
  };
}

// ── Downloadable .xlsx Excel Templates ───────────────────────────────────────

function setColWidths(ws: XLSX.WorkSheet, widths: number[]) {
  ws['!cols'] = widths.map((wch) => ({ wch }));
}

export function downloadTransactionsTemplate(
  budgetHeads: BudgetHeadEnriched[],
  user: SafeUser
) {
  const wb = XLSX.utils.book_new();
  const sampleHead1 = budgetHeads[0]?.name || 'Cloud & Infrastructure';
  const sampleHead2 = budgetHeads[1]?.name || sampleHead1;
  const isAdmin = user.role === 'admin';

  const headers = [
    'Date (YYYY-MM-DD)',
    'Title',
    'Merchant',
    'Budget Head Name',
    'Amount (INR)',
    'Type (expense/income)',
    'Payment Method',
    'Reference',
    'Notes',
    ...(isAdmin ? ['Username'] : []),
  ];

  const rows = [
    [
      '2026-11-18',
      'November Server Hosting',
      'Google Cloud India',
      sampleHead1,
      45000,
      'expense',
      'Direct Debit',
      'INV-2026-881',
      'Monthly production cluster billing',
      ...(isAdmin ? ['alex.chen'] : []),
    ],
    [
      '2026-11-19',
      'Client Site Visit Cab & Rail',
      'MakeMyTrip Corporate',
      sampleHead2,
      12350,
      'expense',
      'UPI / Mobile',
      'TRV-2026-114',
      'Bengaluru client onboarding visit',
      ...(isAdmin ? ['priya.nair'] : []),
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  setColWidths(ws, [18, 28, 24, 26, 15, 22, 18, 16, 32, ...(isAdmin ? [16] : [])]);
  XLSX.utils.book_append_sheet(wb, ws, 'Transactions');

  const refRows = [
    ['Available Budget Heads', 'Total Sanctioned (INR)', 'Remaining Balance (INR)'],
    ...budgetHeads.map((h) => [h.name, h.sanctionedTotal, h.remainingBalance]),
    [],
    ['Valid Payment Methods'],
    ...VALID_PAYMENT_METHODS.map((pm) => [pm]),
  ];
  const refWs = XLSX.utils.aoa_to_sheet(refRows);
  setColWidths(refWs, [30, 22, 24]);
  XLSX.utils.book_append_sheet(wb, refWs, 'Reference Budget Heads');

  XLSX.writeFile(wb, 'LedgerFlow_Expenses_Template.xlsx');
}

export function downloadSanctionsTemplate(budgetHeads: BudgetHeadEnriched[]) {
  const wb = XLSX.utils.book_new();
  const sampleHead1 = budgetHeads[0]?.name || 'Cloud & Infrastructure';
  const sampleHead2 = budgetHeads[1]?.name || sampleHead1;

  const headers = [
    'Budget Head Name',
    'Sanction Amount (INR)',
    'Sanction Date (YYYY-MM-DD)',
    'Sanction Order No',
    'Sanctioned By',
    'Notes',
  ];
  const rows = [
    [
      sampleHead1,
      150000,
      '2026-11-20',
      'SO/2026-27/INF-204',
      'Technical Director RISL',
      'Supplementary FY 2026-27 infrastructure sanction (Financial Year auto-calculated from date)',
    ],
    [
      sampleHead2,
      85000,
      '2027-01-15',
      'SO/2026-27/OPS-219',
      'Chief Financial Officer',
      'Q4 field operations travel sanction (Jan 2027 automatically maps to FY 2026-27)',
    ],
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  setColWidths(ws, [28, 22, 26, 22, 24, 42]);
  XLSX.utils.book_append_sheet(wb, ws, 'Budget Sanctions');

  const refRows = [
    ['Existing Budget Head Names', 'Current Sanctioned Total (INR)'],
    ...budgetHeads.map((h) => [h.name, h.sanctionedTotal]),
    [],
    ['Financial Year Rule'],
    ['Financial Year is automatically derived from Sanction Date (April 1 – March 31 Indian FY).'],
  ];
  const refWs = XLSX.utils.aoa_to_sheet(refRows);
  setColWidths(refWs, [34, 28]);
  XLSX.utils.book_append_sheet(wb, refWs, 'Reference Directory');

  XLSX.writeFile(wb, 'LedgerFlow_Budget_Sanctions_Template.xlsx');
}

export function downloadBudgetHeadsTemplate() {
  const wb = XLSX.utils.book_new();
  const headers = ['Name', 'Color', 'Description'];
  const rows = [
    ['Security & Audits', '#0F766E', 'Annual penetration testing and compliance reviews'],
    ['Legal & Advisory', '#2563EB', 'Contract drafting, IP filings, and external counsel'],
  ];

  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  setColWidths(ws, [28, 12, 48]);
  XLSX.utils.book_append_sheet(wb, ws, 'Budget Heads');

  XLSX.writeFile(wb, 'LedgerFlow_Budget_Heads_Template.xlsx');
}

export function downloadFullWorkbookTemplate(
  budgetHeads: BudgetHeadEnriched[],
  users: UserWithStats[]
) {
  const wb = XLSX.utils.book_new();
  const sampleUser1 = users.find((u) => u.role === 'user')?.username || 'alex.chen';

  const headWs = XLSX.utils.aoa_to_sheet([
    ['Name', 'Color', 'Description'],
    ['Security & Audits', '#0F766E', 'External security audits and monitoring tools'],
  ]);
  setColWidths(headWs, [28, 12, 44]);
  XLSX.utils.book_append_sheet(wb, headWs, 'Budget Heads');

  const sanctionWs = XLSX.utils.aoa_to_sheet([
    [
      'Budget Head Name',
      'Sanction Amount (INR)',
      'Sanction Date (YYYY-MM-DD)',
      'Sanction Order No',
      'Sanctioned By',
      'Notes',
    ],
    [
      'Security & Audits',
      200000,
      '2026-11-18',
      'SO/2026-27/SEC-101',
      'Technical Director RISL',
      'FY 2026-27 security audit sanction',
    ],
  ]);
  setColWidths(sanctionWs, [28, 22, 26, 22, 22, 38]);
  XLSX.utils.book_append_sheet(wb, sanctionWs, 'Budget Sanctions');

  const txWs = XLSX.utils.aoa_to_sheet([
    [
      'Date (YYYY-MM-DD)',
      'Title',
      'Merchant',
      'Budget Head Name',
      'Amount (INR)',
      'Type (expense/income)',
      'Payment Method',
      'Reference',
      'Notes',
      'Username',
    ],
    [
      '2026-11-20',
      'VAPT External Audit Deposit',
      'CertIn Security Labs',
      'Security & Audits',
      85000,
      'expense',
      'Bank Transfer',
      'SEC-INV-901',
      '50% advance for mobile app penetration test',
      sampleUser1,
    ],
  ]);
  setColWidths(txWs, [18, 28, 24, 24, 15, 22, 18, 16, 36, 16]);
  XLSX.utils.book_append_sheet(wb, txWs, 'Transactions');

  const guideWs = XLSX.utils.aoa_to_sheet([
    ['LedgerFlow Excel Upload Guide'],
    ['1. Keep the sheet names: "Budget Heads", "Budget Sanctions", and "Transactions".'],
    ['2. All monetary amounts are in Indian Rupees (INR / ₹). Enter plain numbers like 150000.'],
    ['3. Financial Year (April – March) is automatically calculated from the Sanction Date.'],
    ['4. Upload order is automatic: Budget Heads are created first, followed by Budget Sanctions, then Transactions.'],
    [],
    ['Existing Budget Heads', 'Sanctioned Total (INR)'],
    ...budgetHeads.map((h) => [h.name, h.sanctionedTotal]),
  ]);
  setColWidths(guideWs, [44, 24]);
  XLSX.utils.book_append_sheet(wb, guideWs, 'Guide & Budget Heads');

  XLSX.writeFile(wb, 'LedgerFlow_Complete_Data_Template.xlsx');
}
