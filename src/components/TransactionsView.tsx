import React, { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowDownUp,
  Check,
  CheckCircle2,
  Clock,
  Download,
  Eye,
  FileSpreadsheet,
  FileText,
  Flag,
  Pencil,
  Plus,
  Search,
  Trash2,
} from 'lucide-react';
import { api } from '../lib/api';
import { formatCurrency, formatShortDate } from '../lib/format';
import {
  downloadPassbookExcel,
  downloadPassbookPdf,
  type PassbookExportPayload,
} from '../lib/passbookExport';
import type {
  BudgetHeadEnriched,
  BudgetSanctionEnriched,
  PaymentMethod,
  SafeUser,
  TransactionEnriched,
  TransactionStatus,
} from '../types/finance';
import { BottomSheetModal } from './BottomSheetModal';
import { PdfCameraField, type PendingPdfDraft } from './PdfCameraField';

interface TransactionsViewProps {
  user: SafeUser;
  transactions: TransactionEnriched[];
  budgetHeads: BudgetHeadEnriched[];
  sanctions: BudgetSanctionEnriched[];
  onRefresh: () => Promise<void>;
  onOpenImport: () => void;
  preselectedHeadId?: string | null;
  externalOpenCreate?: boolean;
  onConsumeExternalCreate?: () => void;
  externalExportPdf?: boolean;
  onConsumeExternalExportPdf?: () => void;
}

interface PassbookEntry {
  id: string;
  kind: 'sanction-credit' | 'tx-debit' | 'tx-credit';
  date: string;
  createdAt: string;
  financialYear: string;
  budgetHeadId: string;
  budgetHeadName: string;
  budgetHeadColor: string;
  particulars: string;
  subDetails: string;
  refNo: string;
  creditAmount: number;
  debitAmount: number;
  runningBalance: number;
  sanction?: BudgetSanctionEnriched;
  tx?: TransactionEnriched;
}

const PAYMENT_METHODS: PaymentMethod[] = [
  'Cheque',
  'UPI / Mobile',
  'Corporate Card',
  'Bank Transfer',
  'Direct Debit',
  'Cash Voucher',
];

export function TransactionsView({
  user,
  transactions,
  budgetHeads,
  sanctions,
  onRefresh,
  onOpenImport,
  preselectedHeadId,
  externalOpenCreate,
  onConsumeExternalCreate,
  externalExportPdf,
  onConsumeExternalExportPdf,
}: TransactionsViewProps) {
  const isAdmin = user.role === 'admin';
  const [search, setSearch] = useState('');
  const [entryFilter, setEntryFilter] = useState<'all' | 'credit' | 'debit' | 'review'>('all');
  const [filterHeadId, setFilterHeadId] = useState<string>('all');
  const [filterFy, setFilterFy] = useState<string>('all');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');

  const [modalOpen, setModalOpen] = useState(false);
  const [editingTx, setEditingTx] = useState<TransactionEnriched | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Form fields
  const [merchant, setMerchant] = useState('');
  const [amount, setAmount] = useState('');
  const [budgetHeadId, setBudgetHeadId] = useState('');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('Cheque');
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState('');

  // Cheque & DDO Sanction fields
  const [chequeNumber, setChequeNumber] = useState('');
  const [chequeIssueDate, setChequeIssueDate] = useState('');
  const [sanctionNumber, setSanctionNumber] = useState('');
  const [sanctionDate, setSanctionDate] = useState('');
  const [paymentSanctionedByHod, setPaymentSanctionedByHod] = useState('');
  const [chequePdf, setChequePdf] = useState<PendingPdfDraft | null>(null);
  const [sanctionPdf, setSanctionPdf] = useState<PendingPdfDraft | null>(null);
  const [removeChequePdf, setRemoveChequePdf] = useState(false);
  const [removeSanctionPdf, setRemoveSanctionPdf] = useState(false);

  // Admin multi-select bulk delete & inline single delete confirm
  const [selectedTxIds, setSelectedTxIds] = useState<string[]>([]);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  // Inline PDF Preview Modal
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewTitle, setPreviewTitle] = useState('');
  const [previewFileName, setPreviewFileName] = useState('attachment.pdf');
  const [previewBlobUrl, setPreviewBlobUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  useEffect(() => {
    const valid = new Set(transactions.map((t) => t.id));
    setSelectedTxIds((prev) => prev.filter((id) => valid.has(id)));
  }, [transactions]);

  useEffect(() => {
    return () => {
      if (previewBlobUrl) URL.revokeObjectURL(previewBlobUrl);
    };
  }, [previewBlobUrl]);

  useEffect(() => {
    if (externalOpenCreate && isAdmin) {
      openCreate(preselectedHeadId || undefined);
      onConsumeExternalCreate?.();
    } else if (externalOpenCreate && !isAdmin) {
      onConsumeExternalCreate?.();
    }
  }, [externalOpenCreate, isAdmin, preselectedHeadId]);

  const approvedSanctions = useMemo(
    () => sanctions.filter((s) => s.approvalStatus === 'approved'),
    [sanctions]
  );

  const headSanctions = useMemo(
    () => approvedSanctions.filter((s) => s.budgetHeadId === budgetHeadId),
    [approvedSanctions, budgetHeadId]
  );

  const availableFys = useMemo(() => {
    const set = new Set<string>();
    approvedSanctions.forEach((s) => set.add(s.financialYear));
    transactions.forEach((t) => set.add(t.financialYear));
    return Array.from(set).sort().reverse();
  }, [approvedSanctions, transactions]);

  const openCreate = (headOverride?: string) => {
    if (!isAdmin) return;
    setEditingTx(null);
    setMerchant('');
    setAmount('');
    setBudgetHeadId(headOverride || budgetHeads[0]?.id || '');
    setPaymentMethod('Cheque');
    setDate(new Date().toISOString().slice(0, 10));
    setNotes('');
    setChequeNumber('');
    setChequeIssueDate('');
    setSanctionNumber('');
    setSanctionDate('');
    setPaymentSanctionedByHod('');
    setChequePdf(null);
    setSanctionPdf(null);
    setRemoveChequePdf(false);
    setRemoveSanctionPdf(false);
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (tx: TransactionEnriched) => {
    if (!isAdmin) return;
    setEditingTx(tx);
    setMerchant(tx.merchant);
    setAmount(String(tx.amount));
    setBudgetHeadId(tx.budgetHeadId);
    setPaymentMethod(tx.paymentMethod);
    setDate(tx.date);
    setNotes(tx.notes || '');
    setChequeNumber(tx.chequeNumber || '');
    setChequeIssueDate(tx.chequeIssueDate || '');
    setSanctionNumber(tx.sanctionNumber || '');
    setSanctionDate(tx.sanctionDate || '');
    setPaymentSanctionedByHod(tx.paymentSanctionedByHod || '');
    setChequePdf(null);
    setSanctionPdf(null);
    setRemoveChequePdf(false);
    setRemoveSanctionPdf(false);
    setFormError(null);
    setModalOpen(true);
  };

  const handleQuickSelectSanction = (sanctionId: string) => {
    const found = headSanctions.find((s) => s.id === sanctionId);
    if (!found) return;
    setSanctionNumber(found.sanctionOrderNo);
    setSanctionDate(found.sanctionDate);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!isAdmin) return;
    setFormError(null);
    const amountNum = Number(amount);
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      setFormError('Enter an amount greater than ₹0.');
      return;
    }
    if (!budgetHeadId) {
      setFormError('Select a budget head before recording this transaction.');
      return;
    }
    const selectedHead = budgetHeads.find((h) => h.id === budgetHeadId);
    const resolvedTitle = selectedHead?.name || '';
    if (!resolvedTitle) {
      setFormError('Select a budget head for this expense.');
      return;
    }

    setSubmitting(true);
    try {
      if (editingTx) {
        await api.updateTransaction(editingTx.id, {
          budgetHeadId,
          title: resolvedTitle,
          merchant: merchant.trim(),
          amount: amountNum,
          paymentMethod,
          date,
          notes: notes.trim(),
          chequeNumber: chequeNumber.trim(),
          chequeIssueDate: chequeIssueDate || '',
          sanctionNumber: sanctionNumber.trim(),
          sanctionDate: sanctionDate || '',
          paymentSanctionedByHod: paymentSanctionedByHod.trim(),
          removeChequeAttachment: removeChequePdf && !chequePdf,
          removeSanctionAttachment: removeSanctionPdf && !sanctionPdf,
          ...(chequePdf
            ? {
                chequeAttachmentBase64: chequePdf.base64,
                chequeAttachmentName: chequePdf.fileName,
                chequeAttachmentSource: chequePdf.source,
              }
            : {}),
          ...(sanctionPdf
            ? {
                sanctionAttachmentBase64: sanctionPdf.base64,
                sanctionAttachmentName: sanctionPdf.fileName,
                sanctionAttachmentSource: sanctionPdf.source,
              }
            : {}),
        });
        setFeedback(`Updated transaction for ${merchant.trim()}.`);
      } else {
        const res = await api.createTransaction({
          budgetHeadId,
          title: resolvedTitle,
          merchant: merchant.trim(),
          amount: amountNum,
          type: 'expense',
          paymentMethod,
          date,
          reference: '',
          notes: notes.trim(),
          chequeNumber: chequeNumber.trim() || undefined,
          chequeIssueDate: chequeIssueDate || undefined,
          sanctionNumber: sanctionNumber.trim() || undefined,
          sanctionDate: sanctionDate || undefined,
          paymentSanctionedByHod: paymentSanctionedByHod.trim() || undefined,
          ...(chequePdf
            ? {
                chequeAttachmentBase64: chequePdf.base64,
                chequeAttachmentName: chequePdf.fileName,
                chequeAttachmentSource: chequePdf.source,
              }
            : {}),
          ...(sanctionPdf
            ? {
                sanctionAttachmentBase64: sanctionPdf.base64,
                sanctionAttachmentName: sanctionPdf.fileName,
                sanctionAttachmentSource: sanctionPdf.source,
              }
            : {}),
        });
        const statusMsg =
          res.transaction.status === 'flagged'
            ? 'Recorded and flagged for admin review (exceeds sanctioned budget).'
            : res.transaction.status === 'pending'
              ? 'Recorded and queued for admin approval.'
              : 'Debit entry recorded to passbook ledger.';
        setFeedback(statusMsg);
      }
      await onRefresh();
      setModalOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : editingTx
            ? 'Unable to update transaction.'
            : 'Unable to record transaction.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const handleStatusChange = async (tx: TransactionEnriched, status: TransactionStatus) => {
    try {
      await api.updateTransaction(tx.id, { status });
      setFeedback(`Marked "${tx.title}" as ${status}.`);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to update status.');
    }
  };

  const handleDelete = async (tx: TransactionEnriched) => {
    try {
      await api.deleteTransaction(tx.id);
      setConfirmDeleteId(null);
      setSelectedTxIds((prev) => prev.filter((id) => id !== tx.id));
      setFeedback(`Deleted "${tx.title}" from passbook ledger.`);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to delete transaction.');
    }
  };

  const toggleSelectTx = (txId: string) => {
    setConfirmBulkDelete(false);
    setSelectedTxIds((prev) =>
      prev.includes(txId) ? prev.filter((id) => id !== txId) : [...prev, txId]
    );
  };

  const handleBulkDelete = async () => {
    if (selectedTxIds.length === 0) return;
    setBulkDeleting(true);
    try {
      const res = await api.bulkDeleteTransactions(selectedTxIds);
      setFeedback(
        `Deleted ${res.deletedCount} passbook ${res.deletedCount === 1 ? 'transaction' : 'transactions'}.`
      );
      setSelectedTxIds([]);
      setConfirmBulkDelete(false);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Bulk delete failed.');
    } finally {
      setBulkDeleting(false);
    }
  };

  const handleOpenTransactionPdf = async (
    tx: TransactionEnriched,
    kind: 'cheque' | 'sanction'
  ) => {
    const attachment = kind === 'cheque' ? tx.chequeAttachment : tx.sanctionAttachment;
    if (!attachment) return;
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(null);
    }
    setPreviewTitle(
      kind === 'cheque'
        ? `Cheque Copy — ${tx.chequeNumber || tx.merchant}`
        : `DDO Sanction Copy — ${tx.sanctionNumber || tx.budgetHeadName}`
    );
    setPreviewFileName(attachment.fileName);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);

    try {
      const blob = await api.fetchTransactionAttachmentBlob(tx.id, kind);
      const url = URL.createObjectURL(blob);
      setPreviewBlobUrl(url);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load PDF document.');
    } finally {
      setPreviewLoading(false);
    }
  };

  const handleOpenSanctionCreditPdf = async (s: BudgetSanctionEnriched) => {
    if (!s.attachment) return;
    if (previewBlobUrl) {
      URL.revokeObjectURL(previewBlobUrl);
      setPreviewBlobUrl(null);
    }
    setPreviewTitle(`Budget Sanction Order — ${s.sanctionOrderNo}`);
    setPreviewFileName(s.attachment.fileName);
    setPreviewError(null);
    setPreviewLoading(true);
    setPreviewOpen(true);

    try {
      const blob = await api.fetchSanctionPdfBlob(s.id);
      const url = URL.createObjectURL(blob);
      setPreviewBlobUrl(url);
    } catch (err) {
      setPreviewError(err instanceof Error ? err.message : 'Failed to load sanction PDF.');
    } finally {
      setPreviewLoading(false);
    }
  };

  // Build unified Bank Passbook statement (Datewise Credit + Debit + Running Balance)
  const { passbookRows, totalCredit, totalDebit, closingBalance } = useMemo(() => {
    const rawEntries: Omit<PassbookEntry, 'runningBalance'>[] = [];

    // 1. Approved Budget Sanctions as Credit entries (pending/rejected sanctions are excluded)
    for (const s of approvedSanctions) {
      if (filterHeadId !== 'all' && s.budgetHeadId !== filterHeadId) continue;
      if (filterFy !== 'all' && s.financialYear !== filterFy) continue;
      rawEntries.push({
        id: `cr-${s.id}`,
        kind: 'sanction-credit',
        date: s.sanctionDate,
        createdAt: s.createdAt,
        financialYear: s.financialYear,
        budgetHeadId: s.budgetHeadId,
        budgetHeadName: s.budgetHeadName,
        budgetHeadColor: s.budgetHeadColor,
        particulars: `Budget Sanction · ${s.budgetHeadName}`,
        subDetails: `Sanctioned by ${s.sanctionedBy}${s.notes ? ` · ${s.notes}` : ''}`,
        refNo: s.sanctionOrderNo,
        creditAmount: s.sanctionAmount,
        debitAmount: 0,
        sanction: s,
      });
    }

    // 2. Transactions as Debit (or Credit if income) entries
    for (const tx of transactions) {
      if (filterHeadId !== 'all' && tx.budgetHeadId !== filterHeadId) continue;
      if (filterFy !== 'all' && tx.financialYear !== filterFy) continue;
      const isCreditTx = tx.type === 'income';
      const refParts: string[] = [];
      if (tx.chequeNumber) refParts.push(`Chq ${tx.chequeNumber}`);
      if (tx.sanctionNumber) refParts.push(`DDO ${tx.sanctionNumber}`);
      if (refParts.length === 0 && tx.reference) refParts.push(tx.reference);

      rawEntries.push({
        id: `tx-${tx.id}`,
        kind: isCreditTx ? 'tx-credit' : 'tx-debit',
        date: tx.date,
        createdAt: tx.createdAt,
        financialYear: tx.financialYear,
        budgetHeadId: tx.budgetHeadId,
        budgetHeadName: tx.budgetHeadName,
        budgetHeadColor: tx.budgetHeadColor,
        particulars: tx.budgetHeadName,
        subDetails: `${tx.merchant} · ${tx.paymentMethod}`,
        refNo: refParts.join(' / ') || '—',
        creditAmount: isCreditTx ? tx.amount : 0,
        debitAmount: isCreditTx ? 0 : tx.amount,
        tx,
      });
    }

    // Always sort chronologically first to calculate exact Bank Passbook running balance
    rawEntries.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      // Credits on the same date post before debits, just like bank passbooks
      const aRank = a.creditAmount > 0 ? 0 : 1;
      const bRank = b.creditAmount > 0 ? 0 : 1;
      if (aRank !== bRank) return aRank - bRank;
      return a.createdAt.localeCompare(b.createdAt);
    });

    let running = 0;
    let sumCredit = 0;
    let sumDebit = 0;
    const withBalance: PassbookEntry[] = rawEntries.map((item) => {
      running = Math.round((running + item.creditAmount - item.debitAmount) * 100) / 100;
      sumCredit = Math.round((sumCredit + item.creditAmount) * 100) / 100;
      sumDebit = Math.round((sumDebit + item.debitAmount) * 100) / 100;
      return {
        ...item,
        runningBalance: running,
      };
    });

    // Apply search & entry-type filter AFTER running balance calculation so passbook balances stay accurate
    const q = search.trim().toLowerCase();
    const filtered = withBalance.filter((entry) => {
      if (entryFilter === 'credit' && entry.creditAmount <= 0) return false;
      if (entryFilter === 'debit' && entry.debitAmount <= 0) return false;
      if (entryFilter === 'review') {
        if (!entry.tx || entry.tx.status === 'approved') return false;
      }
      if (!q) return true;
      return (
        entry.particulars.toLowerCase().includes(q) ||
        entry.subDetails.toLowerCase().includes(q) ||
        entry.refNo.toLowerCase().includes(q) ||
        entry.budgetHeadName.toLowerCase().includes(q) ||
        entry.financialYear.toLowerCase().includes(q) ||
        (entry.tx?.merchant || '').toLowerCase().includes(q) ||
        (entry.tx?.chequeNumber || '').toLowerCase().includes(q) ||
        (entry.tx?.sanctionNumber || '').toLowerCase().includes(q) ||
        (entry.tx?.paymentSanctionedByHod || '').toLowerCase().includes(q) ||
        (entry.sanction?.sanctionOrderNo || '').toLowerCase().includes(q) ||
        (entry.sanction?.sanctionedBy || '').toLowerCase().includes(q)
      );
    });

    const ordered = sortOrder === 'asc' ? filtered : [...filtered].reverse();

    return {
      passbookRows: ordered,
      totalCredit: sumCredit,
      totalDebit: sumDebit,
      closingBalance: running,
    };
  }, [approvedSanctions, transactions, filterHeadId, filterFy, search, entryFilter, sortOrder]);

  const visibleTxIds = useMemo(
    () => passbookRows.filter((r) => Boolean(r.tx)).map((r) => r.tx!.id),
    [passbookRows]
  );

  const allVisibleTxSelected =
    visibleTxIds.length > 0 && visibleTxIds.every((id) => selectedTxIds.includes(id));

  const toggleSelectAllVisibleTx = () => {
    setConfirmBulkDelete(false);
    if (allVisibleTxSelected) {
      const visibleSet = new Set(visibleTxIds);
      setSelectedTxIds((prev) => prev.filter((id) => !visibleSet.has(id)));
    } else {
      const merged = new Set([...selectedTxIds, ...visibleTxIds]);
      setSelectedTxIds(Array.from(merged));
    }
  };

  const buildPassbookExportPayload = (): PassbookExportPayload => {
    const filterHeadName =
      filterHeadId === 'all'
        ? 'All Budget Heads'
        : budgetHeads.find((h) => h.id === filterHeadId)?.name || 'Selected Budget Head';
    const entryFilterLabel =
      entryFilter === 'credit'
        ? 'Credit Only'
        : entryFilter === 'debit'
          ? 'Debit Only'
          : entryFilter === 'review'
            ? 'Needs Review'
            : 'All Passbook Entries';

    return {
      user,
      rows: passbookRows.map((row) => ({
        date: row.date,
        financialYear: row.financialYear,
        entryType:
          row.kind === 'sanction-credit'
            ? 'Credit (Sanction)'
            : row.kind === 'tx-credit'
              ? 'Credit (Refund)'
              : 'Debit (Expense)',
        budgetHeadName: row.budgetHeadName,
        particulars: row.particulars,
        subDetails: row.subDetails,
        refNo: row.refNo,
        chequeIssueDate: row.tx?.chequeIssueDate || '',
        sanctionNumber: row.tx?.sanctionNumber || row.sanction?.sanctionOrderNo || '',
        sanctionDate: row.tx?.sanctionDate || row.sanction?.sanctionDate || '',
        paymentSanctionedByHod: row.tx?.paymentSanctionedByHod || row.sanction?.sanctionedBy || '',
        creditAmount: row.creditAmount,
        debitAmount: row.debitAmount,
        runningBalance: row.runningBalance,
        status: row.tx ? row.tx.status : 'credited',
      })),
      totalCredit,
      totalDebit,
      closingBalance,
      filterHeadName,
      filterFy,
      entryFilterLabel,
      searchQuery: search,
    };
  };

  const handleExportPdf = () => {
    if (passbookRows.length === 0) {
      setFeedback('No ledger entries available to export.');
      return;
    }
    const fileName = downloadPassbookPdf(buildPassbookExportPayload());
    setFeedback(`Downloaded passbook PDF: ${fileName}`);
  };

  useEffect(() => {
    if (externalExportPdf) {
      handleExportPdf();
      onConsumeExternalExportPdf?.();
    }
  }, [externalExportPdf]);

  const handleExportExcel = () => {
    if (passbookRows.length === 0) {
      setFeedback('No ledger entries available to export.');
      return;
    }
    const fileName = downloadPassbookExcel(buildPassbookExportPayload());
    setFeedback(`Downloaded passbook Excel: ${fileName}`);
  };

  return (
    <div className="space-y-5">
      {feedback && (
        <div className="px-4 py-3 rounded-xl bg-slate-900 text-white text-xs sm:text-sm flex items-center justify-between gap-3">
          <span>{feedback}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            className="text-slate-300 hover:text-white text-xs font-medium px-2 py-1 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Passbook Summary Header Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Credit (Sanctions)</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-emerald-700">
            +{formatCurrency(totalCredit)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Budget sanctions credited datewise
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Debit (Expenses)</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-red-700">
            -{formatCurrency(totalDebit)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Payments &amp; cheques debited datewise
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Closing Passbook Balance</p>
          <p
            className={`mt-1.5 font-mono tabular-nums text-2xl font-semibold ${
              closingBalance < 0 ? 'text-red-700' : 'text-teal-800'
            }`}
          >
            {formatCurrency(closingBalance)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {filterHeadId === 'all'
              ? 'Net available across all heads'
              : `Balance for ${budgetHeads.find((h) => h.id === filterHeadId)?.name || 'selected head'}`}
          </p>
        </div>
      </div>

      {/* Search, Segmented Passbook Filters, Budget Head & FY Selectors */}
      <div className="bg-white border border-slate-200 rounded-2xl p-4 space-y-3">
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1">
            <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search budget head, vendor, cheque no., sanction order no., or HOD..."
              className="w-full h-11 pl-10 pr-4 rounded-xl border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <select
              aria-label="Filter by budget head"
              value={filterHeadId}
              onChange={(e) => setFilterHeadId(e.target.value)}
              className="h-11 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-700"
            >
              <option value="all">All Budget Heads</option>
              {budgetHeads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>

            {availableFys.length > 0 && (
              <select
                aria-label="Filter by financial year"
                value={filterFy}
                onChange={(e) => setFilterFy(e.target.value)}
                className="h-11 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-700 focus:outline-none focus:border-teal-700"
              >
                <option value="all">All FY</option>
                {availableFys.map((fy) => (
                  <option key={fy} value={fy}>
                    {fy}
                  </option>
                ))}
              </select>
            )}

            {isAdmin && (
              <button
                type="button"
                onClick={onOpenImport}
                className="min-h-[44px] px-3.5 rounded-xl border border-slate-200 hover:bg-slate-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <FileSpreadsheet className="w-4 h-4 text-teal-700" />
                <span>Import Excel</span>
              </button>
            )}

            <div
              className="inline-flex items-center rounded-xl border border-slate-200 bg-white overflow-hidden"
              role="group"
              aria-label="Export Passbook Ledger"
            >
              <button
                type="button"
                onClick={handleExportPdf}
                disabled={passbookRows.length === 0}
                title="Download Passbook Ledger as PDF"
                className={`min-h-[44px] px-3.5 disabled:opacity-50 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors ${
                  isAdmin
                    ? 'hover:bg-slate-50 text-slate-800'
                    : 'bg-teal-700 hover:bg-teal-800 text-white'
                }`}
              >
                <FileText className={`w-4 h-4 ${isAdmin ? 'text-teal-700' : 'text-white'}`} />
                <span>Export Ledger PDF</span>
              </button>
              <button
                type="button"
                onClick={handleExportExcel}
                disabled={passbookRows.length === 0}
                title="Download Passbook Statement as Excel (.xlsx)"
                className="min-h-[44px] px-3.5 border-l border-slate-200 hover:bg-slate-50 disabled:opacity-50 text-xs font-semibold text-slate-800 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-colors"
              >
                <FileSpreadsheet className="w-4 h-4 text-emerald-700" />
                <span>Export Excel</span>
              </button>
            </div>

            {isAdmin && (
              <button
                type="button"
                onClick={() => openCreate()}
                disabled={budgetHeads.length === 0}
                className="min-h-[44px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Log Transaction</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-slate-100">
          <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-xl overflow-x-auto">
            {(
              [
                ['all', 'All Passbook Entries'],
                ['credit', 'Credit Only'],
                ['debit', 'Debit Only'],
                ['review', 'Needs Review'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setEntryFilter(key)}
                className={`px-3 min-h-[34px] text-xs font-medium rounded-lg whitespace-nowrap shrink-0 cursor-pointer transition-colors ${
                  entryFilter === key
                    ? 'bg-white text-slate-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={() => setSortOrder((prev) => (prev === 'asc' ? 'desc' : 'asc'))}
              className="min-h-[34px] px-3 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 cursor-pointer"
            >
              <ArrowDownUp className="w-3.5 h-3.5 text-teal-700" />
              <span>{sortOrder === 'asc' ? 'Date: Oldest → Newest' : 'Date: Newest → Oldest'}</span>
            </button>
            <span className="text-xs font-mono tabular-nums text-slate-500">
              {passbookRows.length} {passbookRows.length === 1 ? 'entry' : 'entries'}
            </span>
          </div>
        </div>
      </div>

      {/* Admin Bulk Delete Bar or Standard User Read-Only Banner */}
      {isAdmin && visibleTxIds.length > 0 && selectedTxIds.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-slate-900 text-white">
          <span className="text-xs font-medium">
            {selectedTxIds.length} ledger {selectedTxIds.length === 1 ? 'transaction' : 'transactions'} selected
          </span>
          <div className="flex items-center gap-2">
            {confirmBulkDelete ? (
              <>
                <button
                  type="button"
                  disabled={bulkDeleting}
                  onClick={handleBulkDelete}
                  className="min-h-[34px] px-3 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
                >
                  {bulkDeleting ? 'Deleting...' : `Confirm Delete (${selectedTxIds.length})`}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(false)}
                  className="min-h-[34px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-white cursor-pointer"
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="button"
                  onClick={() => setSelectedTxIds([])}
                  className="min-h-[34px] px-2.5 rounded-lg bg-white/10 hover:bg-white/20 text-xs font-medium text-slate-200 cursor-pointer"
                >
                  Clear
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(true)}
                  className="min-h-[34px] px-3 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Selected ({selectedTxIds.length})</span>
                </button>
              </>
            )}
          </div>
        </div>
      )}

      {!isAdmin && (
        <div className="px-4 py-3 rounded-xl bg-slate-100 border border-slate-200 text-xs text-slate-700 flex flex-wrap items-center justify-between gap-3">
          <span>
            View-only passbook ledger showing all credited sanctions and debited expenses. Filter by budget head or financial year and download your statement as PDF or Excel.
          </span>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={handleExportPdf}
              disabled={passbookRows.length === 0}
              className="min-h-[36px] px-3 rounded-lg bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <FileText className="w-3.5 h-3.5" />
              <span>Download Ledger PDF</span>
            </button>
            <button
              type="button"
              onClick={handleExportExcel}
              disabled={passbookRows.length === 0}
              className="min-h-[36px] px-3 rounded-lg bg-white border border-slate-300 hover:bg-slate-50 disabled:opacity-50 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer whitespace-nowrap"
            >
              <FileSpreadsheet className="w-3.5 h-3.5 text-emerald-700" />
              <span>Excel</span>
            </button>
          </div>
        </div>
      )}

      {/* Bank Passbook Table (Desktop) + Passbook Cards (Mobile) */}
      {passbookRows.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
          <p className="text-sm font-semibold text-slate-800">No passbook entries yet</p>
          <p className="text-xs text-slate-500 mt-1">
            {isAdmin
              ? 'Add budget sanctions (Credit) or log expenses (Debit) to populate the datewise passbook statement.'
              : 'Approved sanctions and recorded expenses will appear here in datewise passbook order.'}
          </p>
          {isAdmin && budgetHeads.length > 0 && (
            <button
              type="button"
              onClick={() => openCreate()}
              className="mt-4 px-4 py-2.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-xl cursor-pointer"
            >
              Log First Debit Entry
            </button>
          )}
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50/90 text-xs font-semibold text-slate-600">
                  {isAdmin && (
                    <th className="py-3.5 pl-4 pr-2 w-10">
                      <input
                        type="checkbox"
                        checked={allVisibleTxSelected}
                        disabled={visibleTxIds.length === 0}
                        onChange={toggleSelectAllVisibleTx}
                        aria-label="Select all transactions"
                        className="w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
                      />
                    </th>
                  )}
                  <th className="py-3.5 px-5 whitespace-nowrap">Date</th>
                  <th className="py-3.5 px-4">Particulars &amp; Details</th>
                  <th className="py-3.5 px-4 whitespace-nowrap">Ref / Cheque / Order No.</th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap text-emerald-800">
                    Credit (₹)
                  </th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap text-red-800">
                    Debit (₹)
                  </th>
                  <th className="py-3.5 px-4 text-right whitespace-nowrap">Balance (₹)</th>
                  {isAdmin && (
                    <th className="py-3.5 px-5 text-right whitespace-nowrap">Actions</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {passbookRows.map((entry) => {
                  const isCredit = entry.creditAmount > 0;
                  const tx = entry.tx;
                  const sanction = entry.sanction;
                  const isTxSelected = tx ? selectedTxIds.includes(tx.id) : false;

                  return (
                    <tr
                      key={entry.id}
                      className={`hover:bg-slate-50/90 transition-colors ${
                        isTxSelected
                          ? 'bg-teal-50/40'
                          : isCredit
                            ? 'bg-emerald-50/20'
                            : ''
                      }`}
                    >
                      {isAdmin && (
                        <td className="py-3.5 pl-4 pr-2 align-top">
                          {tx ? (
                            <input
                              type="checkbox"
                              checked={isTxSelected}
                              onChange={() => toggleSelectTx(tx.id)}
                              aria-label={`Select transaction ${tx.merchant}`}
                              className="mt-0.5 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
                            />
                          ) : (
                            <span className="text-slate-200">—</span>
                          )}
                        </td>
                      )}
                      {/* Date */}
                      <td className="py-3.5 px-5 whitespace-nowrap align-top">
                        <p className="font-mono tabular-nums text-xs font-medium text-slate-900">
                          {formatShortDate(entry.date)}
                        </p>
                        <p className="font-mono text-[11px] text-slate-400 mt-0.5">
                          {entry.financialYear}
                        </p>
                      </td>

                      {/* Particulars */}
                      <td className="py-3.5 px-4 max-w-sm align-top">
                        <p className="font-medium text-slate-900 flex items-center gap-1.5">
                          <span
                            className="w-2 h-2 rounded-xs shrink-0"
                            style={{ backgroundColor: entry.budgetHeadColor }}
                            aria-hidden="true"
                          />
                          <span className="truncate">{entry.particulars}</span>
                        </p>
                        <p className="text-xs text-slate-500 mt-0.5">{entry.subDetails}</p>

                        {tx && (
                          <div className="mt-1.5 space-y-0.5 text-[11px] text-slate-600">
                            {(tx.chequeNumber || tx.chequeIssueDate || tx.chequeAttachment) && (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono">
                                  Cheque: {tx.chequeNumber || '—'}
                                  {tx.chequeIssueDate ? ` (${formatShortDate(tx.chequeIssueDate)})` : ''}
                                </span>
                                {tx.chequeAttachment && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenTransactionPdf(tx, 'cheque')}
                                    className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline cursor-pointer"
                                  >
                                    <Eye className="w-3 h-3" />
                                    <span>Cheque PDF</span>
                                  </button>
                                )}
                              </div>
                            )}

                            {(tx.sanctionNumber ||
                              tx.sanctionDate ||
                              tx.paymentSanctionedByHod ||
                              tx.sanctionAttachment) && (
                              <div className="flex flex-wrap items-center gap-2">
                                <span className="font-mono">
                                  DDO Sanction: {tx.sanctionNumber || '—'}
                                  {tx.sanctionDate ? ` (${formatShortDate(tx.sanctionDate)})` : ''}
                                </span>
                                {tx.paymentSanctionedByHod && (
                                  <span className="text-slate-500">
                                    · HOD: {tx.paymentSanctionedByHod}
                                  </span>
                                )}
                                {tx.sanctionAttachment && (
                                  <button
                                    type="button"
                                    onClick={() => handleOpenTransactionPdf(tx, 'sanction')}
                                    className="inline-flex items-center gap-1 font-medium text-teal-700 hover:underline cursor-pointer"
                                  >
                                    <Eye className="w-3 h-3" />
                                    <span>Sanction PDF</span>
                                  </button>
                                )}
                              </div>
                            )}

                            <div className="flex items-center gap-1.5 pt-0.5">
                              {tx.status === 'approved' && (
                                <span className="inline-flex items-center gap-1 text-emerald-700 font-medium">
                                  <CheckCircle2 className="w-3 h-3" />
                                  Approved
                                </span>
                              )}
                              {tx.status === 'pending' && (
                                <span className="inline-flex items-center gap-1 text-amber-700 font-medium">
                                  <Clock className="w-3 h-3" />
                                  Pending Approval
                                </span>
                              )}
                              {tx.status === 'flagged' && (
                                <span className="inline-flex items-center gap-1 text-red-700 font-medium">
                                  <AlertTriangle className="w-3 h-3" />
                                  Flagged
                                </span>
                              )}
                            </div>
                          </div>
                        )}

                        {sanction?.attachment && (
                          <div className="mt-1.5">
                            <button
                              type="button"
                              onClick={() => handleOpenSanctionCreditPdf(sanction)}
                              className="inline-flex items-center gap-1 text-[11px] font-medium text-teal-700 hover:underline cursor-pointer"
                            >
                              <Eye className="w-3 h-3" />
                              <span>View Sanction Order PDF</span>
                            </button>
                          </div>
                        )}
                      </td>

                      {/* Ref / Cheque / Order No. */}
                      <td className="py-3.5 px-4 whitespace-nowrap align-top">
                        <span className="font-mono text-xs text-slate-700">{entry.refNo}</span>
                      </td>

                      {/* Credit (₹) */}
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap align-top">
                        {entry.creditAmount > 0 ? (
                          <span className="font-semibold text-emerald-700">
                            {formatCurrency(entry.creditAmount)}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Debit (₹) */}
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap align-top">
                        {entry.debitAmount > 0 ? (
                          <span className="font-semibold text-red-700">
                            {formatCurrency(entry.debitAmount)}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>

                      {/* Running Balance (₹) */}
                      <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap align-top">
                        <span
                          className={`font-semibold ${
                            entry.runningBalance < 0 ? 'text-red-700' : 'text-slate-900'
                          }`}
                        >
                          {formatCurrency(entry.runningBalance)}
                        </span>
                      </td>

                      {/* Actions (Admin Only) */}
                      {isAdmin && (
                        <td className="py-3.5 px-5 text-right whitespace-nowrap align-top">
                          {tx ? (
                            <div className="inline-flex items-center gap-1">
                              <button
                                type="button"
                                onClick={() => openEdit(tx)}
                                title="Edit entry"
                                className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                              >
                                <Pencil className="w-3.5 h-3.5" />
                              </button>
                              {tx.status !== 'approved' && (
                                <button
                                  type="button"
                                  onClick={() => handleStatusChange(tx, 'approved')}
                                  title="Approve entry"
                                  className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-emerald-700 hover:bg-emerald-50 cursor-pointer"
                                >
                                  <Check className="w-4 h-4" />
                                </button>
                              )}
                              {tx.status !== 'flagged' && (
                                <button
                                  type="button"
                                  onClick={() => handleStatusChange(tx, 'flagged')}
                                  title="Flag for audit"
                                  className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-amber-700 hover:bg-amber-50 cursor-pointer"
                                >
                                  <Flag className="w-3.5 h-3.5" />
                                </button>
                              )}
                              {confirmDeleteId === tx.id ? (
                                <div className="inline-flex items-center gap-1 bg-red-50 border border-red-200 rounded-lg px-1.5 py-0.5">
                                  <button
                                    type="button"
                                    onClick={() => handleDelete(tx)}
                                    className="px-2 py-1 rounded bg-red-700 text-white text-[11px] font-semibold cursor-pointer"
                                  >
                                    Delete
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => setConfirmDeleteId(null)}
                                    className="px-1.5 py-1 text-[11px] text-slate-600 cursor-pointer"
                                  >
                                    Cancel
                                  </button>
                                </div>
                              ) : (
                                <button
                                  type="button"
                                  onClick={() => setConfirmDeleteId(tx.id)}
                                  title="Delete entry"
                                  className="min-w-[34px] min-h-[34px] flex items-center justify-center rounded-lg text-slate-400 hover:text-red-700 hover:bg-red-50 cursor-pointer"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          ) : (
                            <span className="text-[11px] font-medium text-emerald-700">Sanction CR</span>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {/* Mobile Touch-First Passbook Statement Rows */}
          <div className="md:hidden divide-y divide-slate-100">
            {passbookRows.map((entry) => {
              const isCredit = entry.creditAmount > 0;
              const tx = entry.tx;
              const sanction = entry.sanction;
              const isTxSelected = tx ? selectedTxIds.includes(tx.id) : false;

              return (
                <div
                  key={entry.id}
                  className={`p-4 space-y-3 ${
                    isTxSelected ? 'bg-teal-50/40' : isCredit ? 'bg-emerald-50/20' : ''
                  }`}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      {isAdmin && tx && (
                        <input
                          type="checkbox"
                          checked={isTxSelected}
                          onChange={() => toggleSelectTx(tx.id)}
                          aria-label={`Select transaction ${tx.merchant}`}
                          className="mt-1 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer shrink-0"
                        />
                      )}
                      <div className="min-w-0">
                        <div className="flex items-center gap-2">
                          <span
                            className="w-2.5 h-2.5 rounded-xs shrink-0"
                            style={{ backgroundColor: entry.budgetHeadColor }}
                            aria-hidden="true"
                          />
                          <p className="text-sm font-semibold text-slate-900 truncate">
                            {entry.particulars}
                          </p>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">{entry.subDetails}</p>
                        <p className="text-xs font-mono text-slate-400 mt-0.5">
                          {formatShortDate(entry.date)} · {entry.financialYear} · {entry.refNo}
                        </p>

                      {tx && (tx.chequeNumber || tx.chequeIssueDate) && (
                        <p className="text-[11px] font-mono text-slate-600 mt-1">
                          Cheque: {tx.chequeNumber || '—'}
                          {tx.chequeIssueDate ? ` · ${formatShortDate(tx.chequeIssueDate)}` : ''}
                        </p>
                      )}
                      {tx && (tx.sanctionNumber || tx.sanctionDate || tx.paymentSanctionedByHod) && (
                        <p className="text-[11px] font-mono text-slate-600 mt-0.5">
                          DDO Sanction: {tx.sanctionNumber || '—'}
                          {tx.sanctionDate ? ` · ${formatShortDate(tx.sanctionDate)}` : ''}
                          {tx.paymentSanctionedByHod ? ` · HOD: ${tx.paymentSanctionedByHod}` : ''}
                        </p>
                      )}
                      </div>
                    </div>

                    <span
                      className={`font-mono text-xs font-semibold shrink-0 ${
                        isCredit ? 'text-emerald-700' : 'text-red-700'
                      }`}
                    >
                      {isCredit ? 'CR' : 'DR'}
                    </span>
                  </div>

                  {/* Mobile 3-Column Bank Passbook Amounts Strip */}
                  <div className="grid grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-xs">
                    <div>
                      <p className="text-[11px] text-slate-400">Credit (₹)</p>
                      <p className="font-mono tabular-nums font-semibold text-emerald-700 mt-0.5">
                        {entry.creditAmount > 0 ? formatCurrency(entry.creditAmount) : '—'}
                      </p>
                    </div>
                    <div>
                      <p className="text-[11px] text-slate-400">Debit (₹)</p>
                      <p className="font-mono tabular-nums font-semibold text-red-700 mt-0.5">
                        {entry.debitAmount > 0 ? formatCurrency(entry.debitAmount) : '—'}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-[11px] text-slate-400">Balance (₹)</p>
                      <p
                        className={`font-mono tabular-nums font-semibold mt-0.5 ${
                          entry.runningBalance < 0 ? 'text-red-700' : 'text-slate-900'
                        }`}
                      >
                        {formatCurrency(entry.runningBalance)}
                      </p>
                    </div>
                  </div>

                  {/* Mobile Attachments & Actions */}
                  <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      {sanction?.attachment && (
                        <button
                          type="button"
                          onClick={() => handleOpenSanctionCreditPdf(sanction)}
                          className="min-h-[36px] px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-teal-800 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>Sanction PDF</span>
                        </button>
                      )}
                      {tx?.chequeAttachment && (
                        <button
                          type="button"
                          onClick={() => handleOpenTransactionPdf(tx, 'cheque')}
                          className="min-h-[36px] px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-teal-800 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>Cheque PDF</span>
                        </button>
                      )}
                      {tx?.sanctionAttachment && (
                        <button
                          type="button"
                          onClick={() => handleOpenTransactionPdf(tx, 'sanction')}
                          className="min-h-[36px] px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-teal-800 inline-flex items-center gap-1 cursor-pointer"
                        >
                          <FileText className="w-3.5 h-3.5" />
                          <span>DDO PDF</span>
                        </button>
                      )}
                    </div>

                    {isAdmin && tx && (
                      <div className="flex flex-wrap items-center gap-2 ml-auto">
                        <button
                          type="button"
                          onClick={() => openEdit(tx)}
                          className="min-h-[38px] px-3 rounded-lg border border-slate-200 bg-white text-slate-700 text-xs font-medium cursor-pointer"
                        >
                          Edit
                        </button>
                        {tx.status !== 'approved' && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(tx, 'approved')}
                            className="min-h-[38px] px-3 rounded-lg bg-emerald-50 text-emerald-800 text-xs font-medium cursor-pointer"
                          >
                            Approve
                          </button>
                        )}
                        {tx.status !== 'flagged' && (
                          <button
                            type="button"
                            onClick={() => handleStatusChange(tx, 'flagged')}
                            className="min-h-[38px] px-3 rounded-lg bg-amber-50 text-amber-800 text-xs font-medium cursor-pointer"
                          >
                            Flag
                          </button>
                        )}
                        {confirmDeleteId === tx.id ? (
                          <div className="inline-flex items-center gap-1 bg-red-50 border border-red-200 rounded-lg px-2 py-1">
                            <button
                              type="button"
                              onClick={() => handleDelete(tx)}
                              className="px-2.5 py-1 rounded bg-red-700 text-white text-xs font-semibold cursor-pointer"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 text-xs text-slate-600 cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(tx.id)}
                            className="min-h-[38px] px-3 rounded-lg bg-slate-100 text-slate-600 hover:text-red-700 text-xs font-medium cursor-pointer"
                          >
                            Remove
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Log / Edit Transaction Modal (Admin Only) */}
      {isAdmin && (
        <BottomSheetModal
          open={modalOpen}
          onClose={() => setModalOpen(false)}
          title={editingTx ? 'Edit Ledger Transaction' : 'Log Ledger Transaction'}
          subtitle={
            editingTx
              ? 'Update budget head, vendor, amount, cheque & DDO sanction details, or replace PDF attachments.'
              : 'Select a budget head, enter vendor, amount, cheque & DDO sanction details, and attach camera/PDF copies.'
          }
        >
          <form onSubmit={handleSave} className="space-y-4">
            {formError && (
              <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
                {formError}
              </div>
            )}

          {/* Row 1: Budget Head + Merchant / Vendor */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Budget Head
              </label>
              <select
                required
                value={budgetHeadId}
                onChange={(e) => setBudgetHeadId(e.target.value)}
                className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              >
                {budgetHeads.map((h) => (
                  <option key={h.id} value={h.id}>
                    {h.name} ({formatCurrency(h.remainingBalance, true)} left)
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Merchant / Vendor
              </label>
              <input
                type="text"
                required
                value={merchant}
                onChange={(e) => setMerchant(e.target.value)}
                placeholder="Enter Vendor Name Here"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          {/* Row 2: Amount & Transaction Date */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Amount (₹ INR)
              </label>
              <input
                type="number"
                step="0.01"
                min="0.01"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="14500"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono tabular-nums text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Date</label>
              <input
                type="date"
                required
                value={date}
                onChange={(e) => setDate(e.target.value)}
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          {/* Cheque Details & Attachment */}
          <div className="p-3.5 rounded-xl border border-slate-200 bg-slate-50/60 space-y-3">
            <p className="text-xs font-semibold text-slate-800">Cheque Details &amp; Attachment</p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Cheque Number
                </label>
                <input
                  type="text"
                  value={chequeNumber}
                  onChange={(e) => setChequeNumber(e.target.value)}
                  placeholder="CHQ-458210"
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 bg-white font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  Cheque Issue Date
                </label>
                <input
                  type="date"
                  value={chequeIssueDate}
                  onChange={(e) => setChequeIssueDate(e.target.value)}
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 bg-white font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>

            {!chequePdf && editingTx?.chequeAttachment && !removeChequePdf && (
              <div className="p-2.5 rounded-xl bg-white border border-slate-200 flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 text-slate-700 truncate">
                  <FileText className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                  <span className="truncate">{editingTx.chequeAttachment.fileName}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setRemoveChequePdf(true)}
                  className="text-red-700 hover:underline font-medium shrink-0 cursor-pointer"
                >
                  Remove
                </button>
              </div>
            )}

            <PdfCameraField
              label={
                editingTx?.chequeAttachment && !removeChequePdf
                  ? 'Replace Cheque Copy (PDF / Camera)'
                  : 'Attach Cheque Copy (PDF / Camera)'
              }
              defaultFilePrefix={chequeNumber || `cheque-${date}`}
              value={chequePdf}
              onChange={(draft) => {
                setChequePdf(draft);
                if (draft) setRemoveChequePdf(false);
              }}
              onError={setFormError}
            />
          </div>

          {/* DDO Sanction No., DDO Sanction Date, HOD Sanction & Attachment */}
          <div className="space-y-3">
            {headSanctions.length > 0 && (
              <div className="flex justify-end">
                <select
                  aria-label="Fill from existing sanction"
                  defaultValue=""
                  onChange={(e) => {
                    if (e.target.value) handleQuickSelectSanction(e.target.value);
                  }}
                  className="h-8 px-2.5 rounded-lg border border-slate-200 bg-white text-[11px] font-medium text-teal-800 focus:outline-none focus:border-teal-700"
                >
                  <option value="">Fill from head sanction...</option>
                  {headSanctions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.sanctionOrderNo} ({formatShortDate(s.sanctionDate)})
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  DDO Sanction No.
                </label>
                <input
                  type="text"
                  value={sanctionNumber}
                  onChange={(e) => setSanctionNumber(e.target.value)}
                  placeholder="Enter DDO Sanction No."
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 bg-white font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">
                  DDO Sanction Date
                </label>
                <input
                  type="date"
                  value={sanctionDate}
                  onChange={(e) => setSanctionDate(e.target.value)}
                  className="w-full h-11 px-3.5 rounded-xl border border-slate-200 bg-white font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Payment Sanctioned by HOD
              </label>
              <input
                type="text"
                value={paymentSanctionedByHod}
                onChange={(e) => setPaymentSanctionedByHod(e.target.value)}
                placeholder="HOD Name / Designation / Approval Reference"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>

            {!sanctionPdf && editingTx?.sanctionAttachment && !removeSanctionPdf && (
              <div className="p-2.5 rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-between gap-2 text-xs">
                <span className="inline-flex items-center gap-1.5 text-slate-700 truncate">
                  <FileText className="w-3.5 h-3.5 text-teal-700 shrink-0" />
                  <span className="truncate">{editingTx.sanctionAttachment.fileName}</span>
                </span>
                <button
                  type="button"
                  onClick={() => setRemoveSanctionPdf(true)}
                  className="text-red-700 hover:underline font-medium shrink-0 cursor-pointer"
                >
                  Remove
                </button>
              </div>
            )}

            <PdfCameraField
              label={
                editingTx?.sanctionAttachment && !removeSanctionPdf
                  ? 'Replace Sanction Copy (PDF / Camera)'
                  : 'Attach Sanction Copy (PDF / Camera)'
              }
              defaultFilePrefix={sanctionNumber || `ddo-sanction-${date}`}
              value={sanctionPdf}
              onChange={(draft) => {
                setSanctionPdf(draft);
                if (draft) setRemoveSanctionPdf(false);
              }}
              onError={setFormError}
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Payment Method
            </label>
            <select
              value={paymentMethod}
              onChange={(e) => setPaymentMethod(e.target.value as PaymentMethod)}
              className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:border-teal-700"
            >
              {PAYMENT_METHODS.map((pm) => (
                <option key={pm} value={pm}>
                  {pm}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">Notes</label>
            <textarea
              rows={2}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="Optional business purpose or itemized breakdown..."
              className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700 resize-none"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={() => setModalOpen(false)}
              className="min-h-[44px] px-4 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="min-h-[44px] px-5 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white text-sm font-semibold cursor-pointer"
            >
              {submitting
                ? editingTx
                  ? 'Saving...'
                  : 'Recording...'
                : editingTx
                  ? 'Save Changes'
                  : 'Record Transaction'}
            </button>
          </div>
        </form>
      </BottomSheetModal>
      )}

      {/* Inline PDF Viewer Modal for Cheque & Sanction Attachments */}
      <BottomSheetModal
        open={previewOpen}
        onClose={() => setPreviewOpen(false)}
        title={previewTitle || 'Attached Document'}
        subtitle={previewFileName}
      >
        <div className="space-y-3">
          {previewLoading && (
            <div className="h-[420px] rounded-xl bg-slate-50 border border-slate-200 flex items-center justify-center text-xs text-slate-500">
              Loading PDF document...
            </div>
          )}
          {previewError && (
            <div className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {previewError}
            </div>
          )}
          {!previewLoading && !previewError && previewBlobUrl && (
            <>
              <div className="h-[440px] rounded-xl overflow-hidden border border-slate-200 bg-slate-100">
                <iframe
                  src={previewBlobUrl}
                  title={previewTitle}
                  className="w-full h-full border-0"
                />
              </div>
              <div className="flex items-center justify-end gap-2">
                <a
                  href={previewBlobUrl}
                  download={previewFileName}
                  className="min-h-[42px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold inline-flex items-center gap-1.5"
                >
                  <Download className="w-4 h-4" />
                  <span>Download PDF</span>
                </a>
              </div>
            </>
          )}
        </div>
      </BottomSheetModal>
    </div>
  );
}
