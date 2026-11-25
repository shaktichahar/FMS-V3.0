import { jsPDF } from 'jspdf';
import type {
  BudgetHeadEnriched,
  BudgetSanctionEnriched,
  SafeUser,
  TransactionEnriched,
} from '../types/finance';

export interface UtilizationHeadRow {
  id: string;
  name: string;
  sanctionCount: number;
  sanctioned: number;
  spent: number;
  remaining: number;
  utilizationPct: number;
  txCount: number;
}

export interface UtilizationLedgerRow {
  date: string;
  financialYear: string;
  budgetHeadName: string;
  particulars: string;
  refNo: string;
  credit: number;
  debit: number;
  runningBalance: number;
}

export interface UtilizationReportPayload {
  user: SafeUser;
  selectedFy: string;
  dateFrom: string;
  dateTo: string;
  selectedHeadId: string;
  selectedHeadName: string;
  headRows: UtilizationHeadRow[];
  ledgerRows: UtilizationLedgerRow[];
  totalSanctioned: number;
  totalSpent: number;
  totalRemaining: number;
  utilizationPct: number;
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

export function computeUtilizationReportData(params: {
  user: SafeUser;
  budgetHeads: BudgetHeadEnriched[];
  sanctions: BudgetSanctionEnriched[];
  transactions: TransactionEnriched[];
  selectedFy: string;
  dateFrom: string;
  dateTo: string;
  selectedHeadId: string;
}): UtilizationReportPayload {
  const {
    user,
    budgetHeads,
    sanctions,
    transactions,
    selectedFy,
    dateFrom,
    dateTo,
    selectedHeadId,
  } = params;

  const targetHeads =
    selectedHeadId === 'all'
      ? budgetHeads
      : budgetHeads.filter((h) => h.id === selectedHeadId);

  const inFilter = (fy: string, date: string, headId: string): boolean => {
    if (selectedHeadId !== 'all' && headId !== selectedHeadId) return false;
    if (selectedFy !== 'all' && fy !== selectedFy) return false;
    if (dateFrom && date < dateFrom) return false;
    if (dateTo && date > dateTo) return false;
    return true;
  };

  // Only approved sanctions enter utilization & ledger figures
  const filteredSanctions = sanctions.filter(
    (s) => s.approvalStatus === 'approved' && inFilter(s.financialYear, s.sanctionDate, s.budgetHeadId)
  );
  const filteredTransactions = transactions.filter((t) =>
    inFilter(t.financialYear, t.date, t.budgetHeadId)
  );

  const headRows: UtilizationHeadRow[] = targetHeads.map((head) => {
    const hSanctions = filteredSanctions.filter((s) => s.budgetHeadId === head.id);
    const hTx = filteredTransactions.filter((t) => t.budgetHeadId === head.id);
    const sanctioned =
      Math.round(hSanctions.reduce((sum, s) => sum + s.sanctionAmount, 0) * 100) / 100;
    const grossExpense = hTx
      .filter((t) => t.type === 'expense')
      .reduce((sum, t) => sum + t.amount, 0);
    const refunds = hTx
      .filter((t) => t.type === 'income')
      .reduce((sum, t) => sum + t.amount, 0);
    const spent = Math.round(Math.max(0, grossExpense - refunds) * 100) / 100;
    const remaining = Math.round((sanctioned - spent) * 100) / 100;
    const utilizationPct =
      sanctioned > 0 ? Math.round((spent / sanctioned) * 1000) / 10 : 0;

    return {
      id: head.id,
      name: head.name,
      sanctionCount: hSanctions.length,
      sanctioned,
      spent,
      remaining,
      utilizationPct,
      txCount: hTx.length,
    };
  });

  const totalSanctioned =
    Math.round(headRows.reduce((s, r) => s + r.sanctioned, 0) * 100) / 100;
  const totalSpent =
    Math.round(headRows.reduce((s, r) => s + r.spent, 0) * 100) / 100;
  const totalRemaining = Math.round((totalSanctioned - totalSpent) * 100) / 100;
  const utilizationPct =
    totalSanctioned > 0 ? Math.round((totalSpent / totalSanctioned) * 1000) / 10 : 0;

  // Build chronological date-wise statement for the selected scope
  const rawEntries: Array<Omit<UtilizationLedgerRow, 'runningBalance'> & { createdAt: string }> = [];

  for (const s of filteredSanctions) {
    rawEntries.push({
      date: s.sanctionDate,
      createdAt: s.createdAt,
      financialYear: s.financialYear,
      budgetHeadName: s.budgetHeadName,
      particulars: `Sanction CR · ${s.sanctionedBy}`,
      refNo: s.sanctionOrderNo || '—',
      credit: s.sanctionAmount,
      debit: 0,
    });
  }

  for (const t of filteredTransactions) {
    const isCredit = t.type === 'income';
    const refParts: string[] = [];
    if (t.chequeNumber) refParts.push(`Chq ${t.chequeNumber}`);
    if (t.sanctionNumber) refParts.push(`DDO ${t.sanctionNumber}`);
    if (refParts.length === 0 && t.reference) refParts.push(t.reference);

    rawEntries.push({
      date: t.date,
      createdAt: t.createdAt,
      financialYear: t.financialYear,
      budgetHeadName: t.budgetHeadName,
      particulars: `${t.merchant} (${t.paymentMethod})`,
      refNo: refParts.join(' / ') || '—',
      credit: isCredit ? t.amount : 0,
      debit: isCredit ? 0 : t.amount,
    });
  }

  rawEntries.sort((a, b) => {
    if (a.date !== b.date) return a.date.localeCompare(b.date);
    const aRank = a.credit > 0 ? 0 : 1;
    const bRank = b.credit > 0 ? 0 : 1;
    if (aRank !== bRank) return aRank - bRank;
    return a.createdAt.localeCompare(b.createdAt);
  });

  let running = 0;
  const ledgerRows: UtilizationLedgerRow[] = rawEntries.map((item) => {
    running = Math.round((running + item.credit - item.debit) * 100) / 100;
    return {
      date: item.date,
      financialYear: item.financialYear,
      budgetHeadName: item.budgetHeadName,
      particulars: item.particulars,
      refNo: item.refNo,
      credit: item.credit,
      debit: item.debit,
      runningBalance: running,
    };
  });

  const selectedHeadName =
    selectedHeadId === 'all'
      ? 'All Budget Heads'
      : budgetHeads.find((h) => h.id === selectedHeadId)?.name || 'Selected Budget Head';

  return {
    user,
    selectedFy,
    dateFrom,
    dateTo,
    selectedHeadId,
    selectedHeadName,
    headRows,
    ledgerRows,
    totalSanctioned,
    totalSpent,
    totalRemaining,
    utilizationPct,
  };
}

export function downloadUtilizationReportPdf(report: UtilizationReportPayload): string {
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth(); // 210
  const pageHeight = doc.internal.pageSize.getHeight(); // 297
  const margin = 12;
  const contentWidth = pageWidth - margin * 2; // 186

  const generatedStamp = new Date().toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });

  const fyLabel = report.selectedFy === 'all' ? 'All Financial Years' : report.selectedFy;
  const dateRangeLabel =
    report.dateFrom || report.dateTo
      ? `${report.dateFrom ? formatPdfDate(report.dateFrom) : 'Start'} to ${
          report.dateTo ? formatPdfDate(report.dateTo) : 'Today'
        }`
      : 'Full Period';

  // Header Banner (Obsidian Navy + Champagne Gold accent line)
  doc.setFillColor(11, 18, 32);
  doc.rect(0, 0, pageWidth, 28, 'F');
  doc.setFillColor(200, 162, 74);
  doc.rect(0, 28, pageWidth, 1.2, 'F');

  doc.setTextColor(255, 255, 255);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(14);
  doc.text('BUDGET UTILIZATION REPORT', margin, 11.5);

  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.setTextColor(229, 198, 117);
  doc.text('LedgerFlow · Financial Management System', margin, 17);
  doc.setTextColor(226, 232, 240);
  doc.text(
    `Generated: ${generatedStamp}  |  By: ${report.user.fullName}`,
    margin,
    22.5
  );

  // Filter Scope Strip
  let y = 33;
  doc.setFillColor(248, 250, 252);
  doc.setDrawColor(226, 232, 240);
  doc.roundedRect(margin, y, contentWidth, 13, 2, 2, 'FD');

  doc.setTextColor(71, 85, 105);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(7.5);
  doc.text('FINANCIAL YEAR:', margin + 3, y + 5);
  doc.text('DATE RANGE:', margin + 62, y + 5);
  doc.text('BUDGET HEAD:', margin + 122, y + 5);

  doc.setTextColor(15, 23, 42);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(8.5);
  doc.text(fyLabel, margin + 3, y + 10);
  doc.text(dateRangeLabel, margin + 62, y + 10);
  const headText = doc.splitTextToSize(report.selectedHeadName, 60)[0] || report.selectedHeadName;
  doc.text(headText, margin + 122, y + 10);

  // 4 Executive KPI Cards
  y += 17;
  const kpiGap = 3;
  const kpiWidth = (contentWidth - kpiGap * 3) / 4;
  const kpis = [
    {
      label: 'TOTAL SANCTIONED',
      value: formatPdfInr(report.totalSanctioned),
      color: [15, 23, 42] as [number, number, number],
    },
    {
      label: 'NET UTILIZED / SPENT',
      value: formatPdfInr(report.totalSpent),
      color: [185, 28, 28] as [number, number, number],
    },
    {
      label: 'REMAINING BALANCE',
      value: formatPdfInr(report.totalRemaining),
      color:
        report.totalRemaining < 0
          ? ([185, 28, 28] as [number, number, number])
          : ([29, 53, 143] as [number, number, number]),
    },
    {
      label: 'UTILIZATION RATE',
      value: `${report.utilizationPct.toFixed(1)}%`,
      color:
        report.utilizationPct >= 95
          ? ([185, 28, 28] as [number, number, number])
          : report.utilizationPct >= 80
            ? ([180, 83, 9] as [number, number, number])
            : ([29, 53, 143] as [number, number, number]),
    },
  ];

  kpis.forEach((kpi, idx) => {
    const x = margin + idx * (kpiWidth + kpiGap);
    doc.setFillColor(255, 255, 255);
    doc.setDrawColor(226, 232, 240);
    doc.roundedRect(x, y, kpiWidth, 16, 2, 2, 'FD');

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(6.8);
    doc.setTextColor(100, 116, 139);
    doc.text(kpi.label, x + 3, y + 5.2);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9.5);
    doc.setTextColor(kpi.color[0], kpi.color[1], kpi.color[2]);
    doc.text(kpi.value, x + 3, y + 12.2);
  });

  y += 22;

  const ensureSpace = (neededMm: number, onNewPage?: () => void) => {
    if (y + neededMm > pageHeight - 16) {
      doc.addPage();
      y = 14;
      onNewPage?.();
    }
  };

  // ── Section 1: Budget Head-wise Utilization Table ─────────────────────────
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text('1. Budget Head-wise Utilization Summary', margin, y);
  y += 4.5;

  const headCols = {
    sno: margin + 2,
    name: margin + 11,
    sanctioned: margin + 104,
    spent: margin + 135,
    remaining: margin + 166,
    util: margin + contentWidth - 2,
  };

  const drawHeadTableHeader = () => {
    doc.setFillColor(15, 23, 42);
    doc.rect(margin, y, contentWidth, 7.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.text('#', headCols.sno, y + 5);
    doc.text('Budget Head', headCols.name, y + 5);
    doc.text('Sanctioned', headCols.sanctioned, y + 5, { align: 'right' });
    doc.text('Net Spent', headCols.spent, y + 5, { align: 'right' });
    doc.text('Remaining', headCols.remaining, y + 5, { align: 'right' });
    doc.text('Util. %', headCols.util, y + 5, { align: 'right' });
    y += 7.5;
  };

  drawHeadTableHeader();

  if (report.headRows.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text('No budget heads match the selected filters.', margin + 3, y + 6);
    y += 10;
  } else {
    report.headRows.forEach((row, idx) => {
      const nameLines = doc.splitTextToSize(row.name, 62) as string[];
      const rowHeight = Math.max(7, nameLines.length * 4 + 3);
      ensureSpace(rowHeight + 2, drawHeadTableHeader);

      if (idx % 2 === 1) {
        doc.setFillColor(248, 250, 252);
        doc.rect(margin, y, contentWidth, rowHeight, 'F');
      }
      doc.setDrawColor(226, 232, 240);
      doc.line(margin, y + rowHeight, margin + contentWidth, y + rowHeight);

      doc.setFont('helvetica', 'normal');
      doc.setFontSize(8);
      doc.setTextColor(71, 85, 105);
      doc.text(String(idx + 1), headCols.sno, y + 4.8);

      doc.setTextColor(15, 23, 42);
      doc.text(nameLines, headCols.name, y + 4.8);

      doc.text(formatPdfInr(row.sanctioned), headCols.sanctioned, y + 4.8, { align: 'right' });
      doc.text(formatPdfInr(row.spent), headCols.spent, y + 4.8, { align: 'right' });

      if (row.remaining < 0) {
        doc.setTextColor(185, 28, 28);
      } else {
        doc.setTextColor(15, 118, 110);
      }
      doc.text(formatPdfInr(row.remaining), headCols.remaining, y + 4.8, { align: 'right' });

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(
        row.utilizationPct >= 95 ? 185 : row.utilizationPct >= 80 ? 180 : 15,
        row.utilizationPct >= 95 ? 28 : row.utilizationPct >= 80 ? 83 : 23,
        row.utilizationPct >= 95 ? 28 : row.utilizationPct >= 80 ? 9 : 42
      );
      doc.text(`${row.utilizationPct.toFixed(1)}%`, headCols.util, y + 4.8, { align: 'right' });

      y += rowHeight;
    });

    // Grand Total Row
    ensureSpace(9, drawHeadTableHeader);
    doc.setFillColor(240, 253, 250);
    doc.setDrawColor(15, 118, 110);
    doc.rect(margin, y, contentWidth, 8, 'F');
    doc.line(margin, y, margin + contentWidth, y);
    doc.line(margin, y + 8, margin + contentWidth, y + 8);

    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.2);
    doc.setTextColor(15, 23, 42);
    doc.text('TOTAL', headCols.name, y + 5.3);
    doc.text(formatPdfInr(report.totalSanctioned), headCols.sanctioned, y + 5.3, {
      align: 'right',
    });
    doc.text(formatPdfInr(report.totalSpent), headCols.spent, y + 5.3, { align: 'right' });
    doc.setTextColor(
      report.totalRemaining < 0 ? 185 : 15,
      report.totalRemaining < 0 ? 28 : 118,
      report.totalRemaining < 0 ? 28 : 110
    );
    doc.text(formatPdfInr(report.totalRemaining), headCols.remaining, y + 5.3, {
      align: 'right',
    });
    doc.setTextColor(15, 23, 42);
    doc.text(`${report.utilizationPct.toFixed(1)}%`, headCols.util, y + 5.3, { align: 'right' });
    y += 13;
  }

  // ── Section 2: Date-wise Credit & Debit Utilization Statement ──────────────
  ensureSpace(22);
  doc.setFont('helvetica', 'bold');
  doc.setFontSize(10);
  doc.setTextColor(15, 23, 42);
  doc.text(
    `2. Date-wise Sanction & Expenditure Statement (${report.ledgerRows.length} ${
      report.ledgerRows.length === 1 ? 'Entry' : 'Entries'
    })`,
    margin,
    y
  );
  y += 4.5;

  const txCols = {
    date: margin + 2,
    head: margin + 22,
    part: margin + 56,
    credit: margin + 128,
    debit: margin + 157,
    balance: margin + contentWidth - 2,
  };

  const drawLedgerHeader = () => {
    doc.setFillColor(30, 41, 59);
    doc.rect(margin, y, contentWidth, 7.5, 'F');
    doc.setTextColor(255, 255, 255);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.2);
    doc.text('Date', txCols.date, y + 5);
    doc.text('Budget Head', txCols.head, y + 5);
    doc.text('Particulars / Ref No.', txCols.part, y + 5);
    doc.text('Credit', txCols.credit, y + 5, { align: 'right' });
    doc.text('Debit', txCols.debit, y + 5, { align: 'right' });
    doc.text('Balance', txCols.balance, y + 5, { align: 'right' });
    y += 7.5;
  };

  drawLedgerHeader();

  if (report.ledgerRows.length === 0) {
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.5);
    doc.setTextColor(100, 116, 139);
    doc.text(
      'No approved sanctions or expenditure entries recorded for the selected period & budget head.',
      margin + 3,
      y + 6
    );
    y += 10;
  } else {
    report.ledgerRows.forEach((row, idx) => {
      const headLines = doc.splitTextToSize(row.budgetHeadName, 32) as string[];
      const partText =
        row.refNo && row.refNo !== '—' ? `${row.particulars} [${row.refNo}]` : row.particulars;
      const partLines = doc.splitTextToSize(partText, 46) as string[];
      const maxLines = Math.max(headLines.length, partLines.length);
      const rowHeight = Math.max(6.8, maxLines * 3.6 + 2.8);

      ensureSpace(rowHeight + 2, drawLedgerHeader);

      if (row.credit > 0) {
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
      doc.text(formatPdfDate(row.date), txCols.date, y + 4.4);
      doc.text(headLines, txCols.head, y + 4.4);
      doc.setTextColor(15, 23, 42);
      doc.text(partLines, txCols.part, y + 4.4);

      if (row.credit > 0) {
        doc.setTextColor(4, 120, 87);
        doc.setFont('helvetica', 'bold');
        doc.text(formatPdfInr(row.credit), txCols.credit, y + 4.4, { align: 'right' });
      } else {
        doc.setTextColor(148, 163, 184);
        doc.text('-', txCols.credit, y + 4.4, { align: 'right' });
      }

      if (row.debit > 0) {
        doc.setTextColor(185, 28, 28);
        doc.setFont('helvetica', 'bold');
        doc.text(formatPdfInr(row.debit), txCols.debit, y + 4.4, { align: 'right' });
      } else {
        doc.setTextColor(148, 163, 184);
        doc.setFont('helvetica', 'normal');
        doc.text('-', txCols.debit, y + 4.4, { align: 'right' });
      }

      doc.setFont('helvetica', 'bold');
      doc.setTextColor(
        row.runningBalance < 0 ? 185 : 15,
        row.runningBalance < 0 ? 28 : 23,
        row.runningBalance < 0 ? 28 : 42
      );
      doc.text(formatPdfInr(row.runningBalance), txCols.balance, y + 4.4, { align: 'right' });

      y += rowHeight;
    });
  }

  // Page Footers across all pages
  const totalPages = doc.getNumberOfPages();
  for (let p = 1; p <= totalPages; p += 1) {
    doc.setPage(p);
    doc.setDrawColor(226, 232, 240);
    doc.line(margin, pageHeight - 11, pageWidth - margin, pageHeight - 11);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text('LedgerFlow · Budget Utilization Report', margin, pageHeight - 6.5);
    doc.text(`Page ${p} of ${totalPages}`, pageWidth - margin, pageHeight - 6.5, {
      align: 'right',
    });
  }

  const fySeg = report.selectedFy === 'all' ? 'All-FY' : safeFileSegment(report.selectedFy);
  const dateSeg =
    report.dateFrom || report.dateTo
      ? `_${report.dateFrom || 'start'}_to_${report.dateTo || 'today'}`
      : '';
  const headSeg =
    report.selectedHeadId === 'all' ? 'All-Heads' : safeFileSegment(report.selectedHeadName);
  const fileName = `Utilization_Report_${fySeg}${dateSeg}_${headSeg}.pdf`;

  doc.save(fileName);
  return fileName;
}
