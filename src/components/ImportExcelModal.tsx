import React, { useEffect, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Download,
  FileSpreadsheet,
  Upload,
} from 'lucide-react';
import { api } from '../lib/api';
import {
  downloadBudgetHeadsTemplate,
  downloadFullWorkbookTemplate,
  downloadSanctionsTemplate,
  downloadTransactionsTemplate,
  parseExcelFile,
  type ImportMode,
  type ParsedExcelPayload,
} from '../lib/excel';
import { computeFinancialYear, formatCurrency } from '../lib/format';
import type {
  BudgetHeadEnriched,
  ImportResultSummary,
  SafeUser,
  UserWithStats,
  WorkbookImportResult,
} from '../types/finance';
import { BottomSheetModal } from './BottomSheetModal';

interface ImportExcelModalProps {
  open: boolean;
  onClose: () => void;
  defaultMode: ImportMode;
  user: SafeUser;
  budgetHeads: BudgetHeadEnriched[];
  users: UserWithStats[];
  onImported: () => Promise<void>;
}

const ADMIN_MODES: Array<{ key: ImportMode; label: string }> = [
  { key: 'transactions', label: 'Expenses / Ledger' },
  { key: 'sanctions', label: 'Budget Sanctions' },
  { key: 'budget-heads', label: 'Budget Heads' },
  { key: 'workbook', label: 'Complete Workbook' },
];

export function ImportExcelModal({
  open,
  onClose,
  defaultMode,
  user,
  budgetHeads,
  users,
  onImported,
}: ImportExcelModalProps) {
  const isAdmin = user.role === 'admin';
  const [mode, setMode] = useState<ImportMode>(isAdmin ? defaultMode : 'transactions');
  const [fileName, setFileName] = useState<string>('');
  const [parsed, setParsed] = useState<ParsedExcelPayload | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [singleResult, setSingleResult] = useState<ImportResultSummary | null>(null);
  const [workbookResult, setWorkbookResult] = useState<WorkbookImportResult | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importingRef = useRef(false);

  useEffect(() => {
    if (open) {
      setMode(isAdmin ? defaultMode : 'transactions');
      resetFileState();
    }
  }, [open, defaultMode, isAdmin]);

  const resetFileState = () => {
    setFileName('');
    setParsed(null);
    setParseError(null);
    setSingleResult(null);
    setWorkbookResult(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleModeChange = (nextMode: ImportMode) => {
    setMode(nextMode);
    resetFileState();
  };

  const handleDownloadTemplate = () => {
    if (mode === 'transactions') {
      downloadTransactionsTemplate(budgetHeads, user);
    } else if (mode === 'sanctions') {
      downloadSanctionsTemplate(budgetHeads);
    } else if (mode === 'budget-heads') {
      downloadBudgetHeadsTemplate();
    } else {
      downloadFullWorkbookTemplate(budgetHeads, users);
    }
  };

  const handleFile = async (file: File) => {
    setParseError(null);
    setSingleResult(null);
    setWorkbookResult(null);
    setFileName(file.name);
    try {
      const result = await parseExcelFile(file, mode);
      setParsed(result);
    } catch (err) {
      setParsed(null);
      setParseError(
        err instanceof Error
          ? err.message
          : 'Could not read Excel file. Please verify it is a valid .xlsx, .xls, or .csv file.'
      );
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      void handleFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      void handleFile(file);
    }
  };

  const totalParsedRows = parsed
    ? parsed.budgetHeads.length + parsed.sanctions.length + parsed.transactions.length
    : 0;

  const handleCommitImport = async () => {
    if (!parsed || totalParsedRows === 0 || importingRef.current) return;
    importingRef.current = true;
    setImporting(true);
    setParseError(null);
    try {
      if (mode === 'budget-heads') {
        const res = await api.importBudgetHeads(parsed.budgetHeads);
        setSingleResult(res.summary);
      } else if (mode === 'sanctions') {
        const res = await api.importSanctions(parsed.sanctions);
        setSingleResult(res.summary);
      } else if (mode === 'transactions') {
        const res = await api.importTransactions(parsed.transactions);
        setSingleResult(res.summary);
      } else {
        const res = await api.importWorkbook({
          budgetHeads: parsed.budgetHeads,
          sanctions: parsed.sanctions,
          transactions: parsed.transactions,
        });
        setWorkbookResult(res.result);
      }
      await onImported();
    } catch (err) {
      setParseError(err instanceof Error ? err.message : 'Failed to import Excel data.');
    } finally {
      importingRef.current = false;
      setImporting(false);
    }
  };

  const templateLabel =
    mode === 'transactions'
      ? 'Expenses Template (.xlsx)'
      : mode === 'sanctions'
        ? 'Budget Sanctions Template (.xlsx)'
        : mode === 'budget-heads'
          ? 'Budget Heads Template (.xlsx)'
          : 'Complete Multi-Sheet Template (.xlsx)';

  return (
    <BottomSheetModal
      open={open}
      onClose={onClose}
      title="Upload Existing Data (Excel)"
      subtitle="Download a structured .xlsx template or upload your existing spreadsheet (.xlsx, .xls, .csv)."
    >
      <div className="space-y-5">
        {isAdmin && (
          <div>
            <p className="text-xs font-medium text-slate-700 mb-2">1. Select Data Type</p>
            <div className="grid grid-cols-2 gap-1.5 p-1 bg-slate-100 rounded-xl">
              {ADMIN_MODES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => handleModeChange(m.key)}
                  className={`min-h-[38px] px-2.5 text-xs font-medium rounded-lg transition-colors whitespace-nowrap cursor-pointer ${
                    mode === m.key
                      ? 'bg-white text-slate-900 shadow-xs font-semibold'
                      : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  {m.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Download Excel Template */}
        <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-start gap-3 min-w-0">
            <FileSpreadsheet className="w-5 h-5 text-teal-700 shrink-0 mt-0.5" />
            <div className="min-w-0">
              <p className="text-xs font-semibold text-slate-900">
                Download Ready-to-Fill Excel Template
              </p>
              <p className="text-xs text-slate-500 mt-0.5">
                Includes sample rows in ₹ (INR) and a reference tab with your active budget head names.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={handleDownloadTemplate}
            className="min-h-[40px] px-3.5 rounded-xl bg-white border border-slate-200 hover:border-teal-700 hover:text-teal-800 text-xs font-semibold text-slate-800 inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Download className="w-3.5 h-3.5" />
            <span>{templateLabel}</span>
          </button>
        </div>

        {/* File Dropzone */}
        <div>
          <p className="text-xs font-medium text-slate-700 mb-2">
            {isAdmin ? '2. Upload Filled Excel File' : 'Upload Filled Excel File'}
          </p>
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => fileInputRef.current?.click()}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                fileInputRef.current?.click();
              }
            }}
            className={`rounded-xl border-2 border-dashed p-5 text-center transition-colors cursor-pointer ${
              dragOver
                ? 'border-teal-700 bg-teal-50/40'
                : 'border-slate-300 hover:border-teal-600 bg-white'
            }`}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              onChange={handleFileChange}
              className="hidden"
            />
            <Upload className="w-6 h-6 text-teal-700 mx-auto" />
            <p className="mt-2 text-sm font-medium text-slate-900">
              {fileName ? fileName : 'Tap to choose an Excel file or drop it here'}
            </p>
            <p className="text-xs text-slate-500 mt-0.5">
              Supports .xlsx, .xls, and .csv · Amounts parsed in INR (₹)
            </p>
          </div>
        </div>

        {parseError && (
          <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
            {parseError}
          </div>
        )}

        {/* Parsed Preview Section */}
        {parsed && !singleResult && !workbookResult && (
          <div className="space-y-3 pt-1">
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <p className="font-semibold text-slate-900">
                Ready to import:{' '}
                <span className="font-mono text-teal-800">{totalParsedRows}</span>{' '}
                {totalParsedRows === 1 ? 'row' : 'rows'}
              </p>
              {parsed.detectedSheets.length > 0 && (
                <p className="text-slate-500">Sheets: {parsed.detectedSheets.join(', ')}</p>
              )}
            </div>

            {mode === 'workbook' && (
              <div className="grid grid-cols-3 gap-2 text-center bg-slate-50 rounded-xl p-3 border border-slate-200">
                <div>
                  <p className="text-[11px] text-slate-500">Budget Heads</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 mt-0.5">
                    {parsed.budgetHeads.length}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Sanctions</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 mt-0.5">
                    {parsed.sanctions.length}
                  </p>
                </div>
                <div>
                  <p className="text-[11px] text-slate-500">Transactions</p>
                  <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 mt-0.5">
                    {parsed.transactions.length}
                  </p>
                </div>
              </div>
            )}

            {mode === 'transactions' && parsed.transactions.length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
                {parsed.transactions.slice(0, 4).map((row) => (
                  <div
                    key={row.rowNumber}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 truncate">{row.title}</p>
                      <p className="text-slate-500 truncate">
                        {row.date} · {row.merchant} · {row.budgetHeadName}
                      </p>
                    </div>
                    <span className="font-mono tabular-nums font-semibold text-slate-900 shrink-0">
                      {row.type === 'income' ? '+' : '-'}
                      {formatCurrency(row.amount)}
                    </span>
                  </div>
                ))}
                {parsed.transactions.length > 4 && (
                  <p className="px-3.5 py-2 text-[11px] text-slate-500 bg-slate-50">
                    + {parsed.transactions.length - 4} more rows ready to import
                  </p>
                )}
              </div>
            )}

            {mode === 'sanctions' && parsed.sanctions.length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
                {parsed.sanctions.slice(0, 4).map((row) => (
                  <div
                    key={row.rowNumber}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 truncate">{row.budgetHeadName}</p>
                      <p className="text-slate-500 truncate">
                        {row.sanctionDate} · {computeFinancialYear(row.sanctionDate)}
                        {row.sanctionOrderNo ? ` · ${row.sanctionOrderNo}` : ''}
                      </p>
                    </div>
                    <span className="font-mono tabular-nums font-semibold text-teal-800 shrink-0">
                      {formatCurrency(row.sanctionAmount)}
                    </span>
                  </div>
                ))}
                {parsed.sanctions.length > 4 && (
                  <p className="px-3.5 py-2 text-[11px] text-slate-500 bg-slate-50">
                    + {parsed.sanctions.length - 4} more sanction rows
                  </p>
                )}
              </div>
            )}

            {mode === 'budget-heads' && parsed.budgetHeads.length > 0 && (
              <div className="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">
                {parsed.budgetHeads.slice(0, 4).map((row) => (
                  <div
                    key={row.rowNumber}
                    className="px-3.5 py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="min-w-0">
                      <p className="font-medium text-slate-900 truncate">{row.name}</p>
                      {row.description && (
                        <p className="text-slate-500 truncate">{row.description}</p>
                      )}
                    </div>
                    <span
                      className="w-3.5 h-3.5 rounded-full shrink-0 border border-slate-200"
                      style={{ backgroundColor: row.color || '#0F766E' }}
                    />
                  </div>
                ))}
              </div>
            )}

            {parsed.warnings.length > 0 && (
              <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 space-y-1">
                <p className="text-xs font-semibold text-amber-800 inline-flex items-center gap-1.5">
                  <AlertTriangle className="w-3.5 h-3.5" />
                  <span>{parsed.warnings.length} skipped during file parsing</span>
                </p>
                <ul className="text-[11px] text-amber-800 space-y-0.5 max-h-24 overflow-y-auto">
                  {parsed.warnings.slice(0, 5).map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}

        {/* Import Result Confirmation */}
        {singleResult && (
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2">
            <p className="text-xs font-semibold text-emerald-900 inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-700" />
              <span>Import Completed</span>
            </p>
            <p className="text-xs text-emerald-800 font-mono tabular-nums">
              Created: {singleResult.created} · Duplicates Skipped:{' '}
              {singleResult.duplicates ?? 0} · Total Skipped: {singleResult.skipped}
            </p>
            {singleResult.errors.length > 0 && (
              <ul className="pt-1.5 border-t border-emerald-200 text-[11px] text-amber-900 space-y-1 max-h-28 overflow-y-auto">
                {singleResult.errors.map((err, i) => (
                  <li key={i}>
                    Row {err.row}: {err.message}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {workbookResult && (
          <div className="p-4 rounded-xl bg-emerald-50 border border-emerald-200 space-y-2">
            <p className="text-xs font-semibold text-emerald-900 inline-flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-700" />
              <span>Workbook Import Completed</span>
            </p>
            <div className="text-xs text-emerald-900 font-mono tabular-nums space-y-1">
              <p>
                Budget Heads — {workbookResult.budgetHeads.created} created,{' '}
                {workbookResult.budgetHeads.duplicates ?? 0} duplicates skipped
              </p>
              <p>
                Budget Sanctions — {workbookResult.sanctions.created} created,{' '}
                {workbookResult.sanctions.duplicates ?? 0} duplicates skipped
              </p>
              <p>
                Transactions — {workbookResult.transactions.created} created,{' '}
                {workbookResult.transactions.duplicates ?? 0} duplicates skipped
              </p>
            </div>
            {[
              ...workbookResult.budgetHeads.errors.map((e) => `Heads Row ${e.row}: ${e.message}`),
              ...workbookResult.sanctions.errors.map((e) => `Sanctions Row ${e.row}: ${e.message}`),
              ...workbookResult.transactions.errors.map((e) => `Transactions Row ${e.row}: ${e.message}`),
            ].length > 0 && (
              <ul className="pt-1.5 border-t border-emerald-200 text-[11px] text-amber-900 space-y-1 max-h-28 overflow-y-auto">
                {[
                  ...workbookResult.budgetHeads.errors.map((e) => `Heads Row ${e.row}: ${e.message}`),
                  ...workbookResult.sanctions.errors.map((e) => `Sanctions Row ${e.row}: ${e.message}`),
                  ...workbookResult.transactions.errors.map((e) => `Transactions Row ${e.row}: ${e.message}`),
                ].map((msg, i) => (
                  <li key={i}>{msg}</li>
                ))}
              </ul>
            )}
          </div>
        )}

        {/* Footer Action Buttons */}
        <div className="pt-1 flex items-center justify-end gap-2.5">
          <button
            type="button"
            onClick={onClose}
            className="min-h-[44px] px-4 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
          >
            {singleResult || workbookResult ? 'Done' : 'Cancel'}
          </button>
          {!singleResult && !workbookResult && (
            <button
              type="button"
              disabled={importing || totalParsedRows === 0}
              onClick={handleCommitImport}
              className="min-h-[44px] px-5 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-50 text-white text-sm font-semibold cursor-pointer"
            >
              {importing
                ? 'Importing...'
                : totalParsedRows > 0
                  ? `Import ${totalParsedRows} ${totalParsedRows === 1 ? 'Row' : 'Rows'}`
                  : 'Import Data'}
            </button>
          )}
        </div>
      </div>
    </BottomSheetModal>
  );
}
