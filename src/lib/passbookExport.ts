import { jsPDF } from 'jspdf';
import * as XLSX from 'xlsx';
import type {
  BudgetSanctionEnriched,
  SafeUser,
  TransactionEnriched,
} from '../types/finance';

export interface PassbookExportRow {
  date: string;
  financialYear: string;
  entryType: 'Credit (Sanction)' | 'Credit (Refund)' | 'Debit (Expense)';
  budgetHeadName: string;
  particulars: string;
  subDetails: string;
  refNo: string;
  chequeIssueDate: string;
  sanctionNumber: string;
  sanctionDate: string;
  paymentSanctionedByHod: string;
  creditAmount: number;
  debitAmount: number;
  runningBalance: number;
  status: string;
}

export interface PassbookExportPayload {
  user: SafeUser;
  rows: PassbookExportRow[];
  totalCredit: number;
  totalDebit: number;
  closingBalance: number;
  filterHeadName: string;
  filterFy: string;
  entryFilterLabel: string;
  searchQuery?: string;
}

export function buildFullPassbookExportPayload(params: {
  user: SafeUser;
  sanctions: BudgetSanctionEnriched[];
  transactions: TransactionEnriched[];
}): PassbookExportPayload {
  const { user, sanctions, transactions } = params;
  const approvedSanctions = sanctions.filter((s) => s.approvalStatus === 'approved');

  const rawEntries: Array<Omit<PassbookExportRow, 'runningBalance'> & { createdAt: string }> = [];

  for (const s of approvedSanctions) {
    rawEntries.push({
      date: s.sanctionDate,
      createdAt: s.createdAt,
      financialYear: s.financialYear,
      entryType: 'Credit (Sanction)',
      budgetHeadName: s.budgetHeadName,
      particulars: `Budget Sanction · ${s.budgetHeadName}`,
      subDetails: `Sanctioned by ${s.sanctionedBy}${s.notes ? ` · ${s.notes}` : ''}`,
      refNo: s.sanctionOrderNo,
      chequeIssueDate: '',
      sanctionNumber: s.sanctionOrderNo,
      sanctionDate: s.sanctionDate,
      paymentSanctionedByHod: s.sanctionedBy,
      creditAmount: s.sanctionAmount,
      debitAmount: 0,
      status: 'credited',
    });
  }

  for (const tx of transactions) {
    const isCreditTx = tx.type === 'income';
    const refParts: string[] = [];
    if (tx.chequeNumber) refParts.push(`Chq ${tx.chequeNumber}`);
    if (tx.sanctionNumber) refParts.push(`DDO ${tx.sanctionNumber}`);
    if (refParts.length === 0 && tx.reference) refParts.push(tx.reference);

    rawEntries.push({
      date: tx.date,
      createdAt: tx.createdAt,
      financialYear: tx.financialYear,
      entryType: isCreditTx ? 'Credit (Refund)' : 'Debit (Expense)',
      budgetHeadName: tx.budgetHeadName,
      particulars: tx.budgetHeadName,
      subDetails: `${tx.merchant} · ${tx.paymentMethod}`,
      refNo: refParts.join(' / ') || '—',
      chequeIssueDate: tx.chequeIssueDate || '',
      sanctionNumber: tx.sanctionNumber || '',
      sanctionDate: tx.sanctionDate || '',
      paymentSanctionedByHod: tx.paymentSanctionedByHod || '',
      creditAmount: isCreditTx ? tx.amount : 0,
      debitAmount: isCreditTx ? 0 : tx.amount,
      status: tx.status,
    });
  }

  rawEntries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const aRank = a.creditAmount > 0 ? 0 : 1;
    const bRank = b.creditAmount > 0 ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.createdAt.localeCompare(b.createdAt);
  });

  let running = 0;
  let totalCredit = 0;
  let totalDebit = 0;

  const rows: PassbookExportRow[] = rawEntries.map(({ createdAt: _createdAt, ...item }) => {
    running = Math.round((running + item.creditAmount - item.debitAmount) * 100) / 100;
    totalCredit = Math.round((totalCredit + item.creditAmount) * 100) / 100;
    totalDebit = Math.round((totalDebit + item.debitAmount) * 100) / 100;
    return {
      ...item,
      runningBalance: running,
    };
  });

  return {
    user,
    rows,
    totalCredit,
    totalDebit,
    closingBalance: running,
    filterHeadName: 'All Budget Heads',
    filterFy: 'all',
    entryFilterLabel: 'All Passbook Entries',
  };
}

function triggerBlobDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.style.display = 'none';
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 3000);
}

function formatPdfInr(amount: number): string {
  const abs = Math.abs(Math.round((amount || 0) * 100) / 100);
  const formatted = abs.toLocaleString('en-IN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-Rs. ${formatted}` : `Rs. ${formatted}`;
}

function formatPdfDate(iso: string): string {
  if (!iso) return '—';
  const parts = iso.split('-');
  if (parts.length === 3) {
    return `${parts[2]}-${parts[1]}-${parts[0]}`;
  }
  return iso;
}

function safeFileSegment(input: string): string {
  return (
    input
      .trim()
      .replace(/[^a-zA-Z0-9-_]+/g, '-')
      .replace(/-+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 32) || 'All'
  );
}

/**
 * Prevents spreadsheet formula injection (CSV/Excel DDE) when exporting user-entered text.
 */
function sanitizeExcelCell(value: string): string {
  const str = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(str)) {
    return `'${str}`;
  }
  return str;
}

function buildPassbookFileBase(payload: PassbookExportPayload): string {
  const fySeg = payload.filterFy === 'all' ? 'All-FY' : safeFileSegment(payload.filterFy);
  const headSeg =
    payload.filterHeadName === 'All Budget Heads'
      ? 'All-Heads'
      : safeFileSegment(payload.filterHeadName);
  const today = new Date().toISOString().slice(0, 10);
  return `LedgerFlow_Passbook_${fySeg}_${headSeg}_${today}`;
}

export function downloadPassbookPdf(payload: PassbookExportPayload): string {
  // Landscape A4 gives generous room for a crisp bank-passbook statement layout
  const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth(); // 297
  const pageHeight = doc.internal.pageSize.getHeight(); // 210
  const margin = 12;
  const contentWidth = pageWidth - margin * 2; // 273

  const generatedStamp = new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const fyLabel = payload.filterFy === 'all' ? 'All Financial Years' : payload.filterFy;

  // Header Banner (Obsidian Navy + Champagne Gold accent bar)
  doc.setFillColor(11, 18, 32);
  doc.rect(0, 0, pageWidth, 25, 'F');
  doc.setFillColor(200, 162, 74);
  doc.rect(0, 25, pageWidth, 1.2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('PASSBOOK LEDGER STATEMENT', margin, 10.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(229, 198, 117);
  doc.text('LedgerFlow · Financial Management System', margin, 16);

  doc.setTextColor(226, 232, 240);
  doc.text(
    `Generated: ${generatedStamp}  |  User: ${payload.user.fullName} (${payload.user.role === 'admin' ? 'Administrator' : 'User'})`,
    margin,
    21.2
  );

  // Filter Scope Strip
  let y = 30;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(margin, y, contentWidth, 11.5, 2, 2, 'FD');

  doc.setTextColor(71, 85, 105);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.2);
  doc.text('BUDGET HEAD:', margin + 3, y + 4.4);
  doc.text('FINANCIAL YEAR:', margin + 96, y + 4.4);
  doc.text('ENTRY SCOPE:', margin + 158, y + 4.4);
  doc.text('TOTAL ENTRIES:', margin + 225, y + 4.4);

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.2);
  const headText = doc.splitTextToSize(payload.filterHeadName, 88)[0] || payload.filterHeadName;
  doc.text(headText, margin + 3, y + 9.2);
  doc.text(fyLabel, margin + 96, y + 9.2);
  const scopeText = payload.searchQuery?.trim()
    ? `${payload.entryFilterLabel} · "${payload.searchQuery.trim().slice(0, 24)}"`
    : payload.entryFilterLabel;
  doc.text(scopeText, margin + 158, y + 9.2);
  doc.text(String(payload.rows.length), margin + 225, y + 9.2);

  // 3 Executive KPI Cards
  y += 14.5;
  const kpiGap = 4;
  const kpiWidth = (contentWidth - kpiGap * 2) / 3;
  const kpis = [
    {
      label: 'TOTAL CREDIT (SANCTIONS)',
      value: `+${formatPdfInr(payload.totalCredit)}`,
      color: [4, 120, 87] as [number, number, number],
    },
    {
      label: 'TOTAL DEBIT (EXPENSES)',
      value: `-${formatPdfInr(payload.totalDebit)}`,
      color: [185, 28, 28] as [number, number, number],
    },
    {
      label: 'CLOSING PASSBOOK BALANCE',
      value: formatPdfInr(payload.closingBalance),
      color:
        payload.closingBalance < 0
          ? ([185, 28, 28] as [number, number, number])
          : ([29, 53, 143] as [number, number, number]),
    },
  ];

  kpis.forEach((kpi, idx) => {
    const x = margin + idx * (kpiWidth + kpiGap);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, y, kpiWidth, 14.5, 2, 2, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7);
    doc.setTextColor(100, 116, 139);
    doc.text(kpi.label, x + 3.5, y + 4.8);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(10.5);
    doc.setTextColor(kpi.color[0], kpi.color[1], kpi.color[2]);
    doc.text(kpi.value, x + 3.5, y + 11.4);
  });

  y += 19;

  // Column x-positions inside [margin = 12, margin + 273 = 285]
  const cols = {
    date: margin + 2,
    head: margin + 24,
    particulars: margin + 68,
    ref: margin + 148,
    credit: margin + 206,
    debit: margin + 239,
    balance: margin + contentWidth - 2,
  };

  const drawTableHeader = () => {
    doc.setFillColor(11, 18, 32);
    doc.rect(margin, y, contentWidth, 7.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('Date', cols.date, y + 5);
    doc.text('Budget Head', cols.head, y + 5);
    doc.text('Particulars / Vendor / Authority', cols.particulars, y + 5);
    doc.text('Ref / Cheque / Order No.', cols.ref, y + 5);
    doc.text('Credit (INR)', cols.credit, y + 5, { align: 'right' });
    doc.text('Debit (INR)', cols.debit, y + 5, { align: 'right' });
    doc.text('Balance (INR)', cols.balance, y + 5, { align: 'right' });
    y += 7.5;
  };

  const ensureSpace = (neededMm: number) => {
    if (y + neededMm > pageHeight - 15) {
      doc.addPage();
      y = 14;
      drawTableHeader();
    }
  };

  drawTableHeader();

  if (payload.rows.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text('No passbook entries match the selected filters.', margin + 3, y + 6.5);
    y += 10;
  } else {
    payload.rows.forEach((row, idx) => {
      const headLines = doc.splitTextToSize(row.budgetHeadName, 41) as string[];
      const detailsText = row.paymentSanctionedByHod
        ? `${row.subDetails} · HOD: ${row.paymentSanctionedByHod}`
        : row.subDetails;
      const partLines = doc.splitTextToSize(detailsText, 76) as string[];
      const refLines = doc.splitTextToSize(row.refNo || '—', 32) as string[];
      const maxLines = Math.max(headLines.length, partLines.length, refLines.length, 1);
      const rowHeight = Math.max(6.8, maxLines * 3.6 + 2.8);

      ensureSpace(rowHeight + 2);

      if (row.creditAmount > 0) {
        doc.setFillColor(236, 253, 245);
        doc.rect(margin, y, contentWidth, rowHeight, 'F');
      } else if (idx % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(margin, y, contentWidth, rowHeight, 'F');
      }
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + rowHeight, margin + contentWidth, y + rowHeight);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(7.4);
      doc.setTextColor(51, 65, 85);
      doc.text(formatPdfDate(row.date), cols.date, y + 4.4);
      doc.setTextColor(15, 23, 42);
      doc.text(headLines, cols.head, y + 4.4);
      doc.text(partLines, cols.particulars, y + 4.4);
      doc.setTextColor(71, 85, 105);
      doc.text(refLines, cols.ref, y + 4.4);

      if (row.creditAmount > 0) {
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(4, 120, 87);
        doc.text(formatPdfInr(row.creditAmount), cols.credit, y + 4.4, { align: 'right' });
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(148, 163, 184);
        doc.text('-', cols.credit, y + 4.4, { align: 'right' });
      }

      if (row.debitAmount > 0) {
        doc.setFont('helvetica', 'bold');
        doc.setTextColor(185, 28, 28);
        doc.text(formatPdfInr(row.debitAmount), cols.debit, y + 4.4, { align: 'right' });
      } else {
        doc.setFont('helvetica', 'normal');
        doc.setTextColor(148, 163, 184);
        doc.text('-', cols.debit, y + 4.4, { align: 'right' });
      }

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(
        row.runningBalance < 0 ? 185 : 15,
        row.runningBalance < 0 ? 28 : 23,
        row.runningBalance < 0 ? 28 : 42
      );
      doc.text(formatPdfInr(row.runningBalance), cols.balance, y + 4.4, { align: 'right' });

      y += rowHeight;
    });

    // Grand Total Row
    ensureSpace(10);
    doc.setFillColor(238, 242, 255);
    doc.setDrawColor(29, 53, 143);
    doc.rect(margin, y, contentWidth, 8, 'F');
    doc.line(margin, y, margin + contentWidth, y);
    doc.line(margin, y + 8, margin + contentWidth, y + 8);

    const visibleCredit =
      Math.round(payload.rows.reduce((s, r) => s + r.creditAmount, 0) * 100) / 100;
    const visibleDebit =
      Math.round(payload.rows.reduce((s, r) => s + r.debitAmount, 0) * 100) / 100;

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8);
    doc.setTextColor(15, 23, 42);
    doc.text(`TOTAL (${payload.rows.length} Entries)`, cols.head, y + 5.3);

    doc.setTextColor(4, 120, 87);
    doc.text(formatPdfInr(visibleCredit), cols.credit, y + 5.3, { align: 'right' });

    doc.setTextColor(185, 28, 28);
    doc.text(formatPdfInr(visibleDebit), cols.debit, y + 5.3, { align: 'right' });

    doc.setTextColor(
      payload.closingBalance < 0 ? 185 : 29,
      payload.closingBalance < 0 ? 28 : 53,
      payload.closingBalance < 0 ? 28 : 143
    );
    doc.text(formatPdfInr(payload.closingBalance), cols.balance, y + 5.3, { align: 'right' });
  }

  // Page Footers
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, pageHeight - 10, pageWidth - margin, pageHeight - 10);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text('LedgerFlow · Passbook Ledger Statement', margin, pageHeight - 5.8);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - 5.8, {
      align: 'right',
    });
  }

  const fileName = `${buildPassbookFileBase(payload)}.pdf`;
  try {
    const blob = doc.output('blob');
    triggerBlobDownload(blob, fileName);
  } catch {
    doc.save(fileName);
  }
  return fileName;
}

export function downloadPassbookExcel(payload: PassbookExportPayload): string {
  const generatedStamp = new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const fyLabel = payload.filterFy === 'all' ? 'All Financial Years' : payload.filterFy;
  const visibleCredit =
    Math.round(payload.rows.reduce((s, r) => s + r.creditAmount, 0) * 100) / 100;
  const visibleDebit =
    Math.round(payload.rows.reduce((s, r) => s + r.debitAmount, 0) * 100) / 100;

  // Sheet 1: Passbook Statement
  const sheetRows: Array<Array<string | number>> = [
    ['LedgerFlow — Passbook Ledger Statement'],
    ['Generated By', sanitizeExcelCell(payload.user.fullName), 'Generated On', generatedStamp],
    [
      'Budget Head',
      sanitizeExcelCell(payload.filterHeadName),
      'Financial Year',
      sanitizeExcelCell(fyLabel),
    ],
    [
      'Entry Scope',
      sanitizeExcelCell(payload.entryFilterLabel),
      'Total Entries',
      payload.rows.length,
    ],
    [
      'Total Credit (INR)',
      payload.totalCredit,
      'Total Debit (INR)',
      payload.totalDebit,
      'Closing Balance (INR)',
      payload.closingBalance,
    ],
    [],
    [
      'Date',
      'Financial Year',
      'Entry Type',
      'Budget Head',
      'Particulars / Vendor / Authority',
      'Ref / Order / Cheque No.',
      'Cheque Issue Date',
      'DDO Sanction No.',
      'DDO Sanction Date',
      'Payment Sanctioned by HOD',
      'Credit Amount (INR)',
      'Debit Amount (INR)',
      'Running Balance (INR)',
      'Status',
    ],
  ];

  for (const row of payload.rows) {
    sheetRows.push([
      row.date,
      sanitizeExcelCell(row.financialYear),
      row.entryType,
      sanitizeExcelCell(row.budgetHeadName),
      sanitizeExcelCell(row.subDetails),
      sanitizeExcelCell(row.refNo),
      row.chequeIssueDate || '',
      sanitizeExcelCell(row.sanctionNumber),
      row.sanctionDate || '',
      sanitizeExcelCell(row.paymentSanctionedByHod),
      row.creditAmount > 0 ? row.creditAmount : '',
      row.debitAmount > 0 ? row.debitAmount : '',
      row.runningBalance,
      sanitizeExcelCell(row.status),
    ]);
  }

  sheetRows.push([
    'TOTAL',
    '',
    '',
    '',
    `${payload.rows.length} Entries`,
    '',
    '',
    '',
    '',
    '',
    visibleCredit,
    visibleDebit,
    payload.closingBalance,
    '',
  ]);

  const passbookSheet = XLSX.utils.aoa_to_sheet(sheetRows);
  passbookSheet['!cols'] = [
    { wch: 13 }, // Date
    { wch: 14 }, // FY
    { wch: 18 }, // Entry Type
    { wch: 26 }, // Budget Head
    { wch: 36 }, // Particulars
    { wch: 22 }, // Ref No
    { wch: 16 }, // Cheque Issue Date
    { wch: 18 }, // DDO Sanction No
    { wch: 16 }, // DDO Sanction Date
    { wch: 24 }, // HOD
    { wch: 18 }, // Credit
    { wch: 18 }, // Debit
    { wch: 20 }, // Balance
    { wch: 14 }, // Status
  ];

  // Sheet 2: Budget Head Summary
  const headMap = new Map<string, { credit: number; debit: number; count: number }>();
  for (const row of payload.rows) {
    const existing = headMap.get(row.budgetHeadName) || { credit: 0, debit: 0, count: 0 };
    existing.credit = Math.round((existing.credit + row.creditAmount) * 100) / 100;
    existing.debit = Math.round((existing.debit + row.debitAmount) * 100) / 100;
    existing.count += 1;
    headMap.set(row.budgetHeadName, existing);
  }

  const summaryRows: Array<Array<string | number>> = [
    ['LedgerFlow — Passbook Head-wise Summary'],
    ['Generated On', generatedStamp, 'Financial Year', sanitizeExcelCell(fyLabel)],
    [],
    ['Budget Head', 'Entries', 'Total Credit (INR)', 'Total Debit (INR)', 'Net Balance (INR)'],
  ];

  Array.from(headMap.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .forEach(([headName, totals]) => {
      summaryRows.push([
        sanitizeExcelCell(headName),
        totals.count,
        totals.credit,
        totals.debit,
        Math.round((totals.credit - totals.debit) * 100) / 100,
      ]);
    });

  summaryRows.push([
    'GRAND TOTAL',
    payload.rows.length,
    visibleCredit,
    visibleDebit,
    Math.round((visibleCredit - visibleDebit) * 100) / 100,
  ]);

  const summarySheet = XLSX.utils.aoa_to_sheet(summaryRows);
  summarySheet['!cols'] = [
    { wch: 30 },
    { wch: 12 },
    { wch: 20 },
    { wch: 20 },
    { wch: 20 },
  ];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, passbookSheet, 'Passbook Statement');
  XLSX.utils.book_append_sheet(wb, summarySheet, 'Summary');

  const fileName = `${buildPassbookFileBase(payload)}.xlsx`;
  try {
    const arrayBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    const blob = new Blob([arrayBuffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    triggerBlobDownload(blob, fileName);
  } catch {
    XLSX.writeFile(wb, fileName);
  }
  return fileName;
}
