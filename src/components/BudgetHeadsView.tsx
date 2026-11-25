import React, { useMemo, useState } from 'react';
import { FileSpreadsheet, Landmark, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { formatCurrency, formatPct } from '../lib/format';
import type { BudgetHeadEnriched } from '../types/finance';
import { BottomSheetModal } from './BottomSheetModal';

interface BudgetHeadsViewProps {
  budgetHeads: BudgetHeadEnriched[];
  onRefresh: () => Promise<void>;
  onOpenImport: () => void;
  onAddSanctionForHead: (headId: string) => void;
  externalOpenCreate?: boolean;
  onConsumeExternalCreate?: () => void;
}

const COLOR_OPTIONS = [
  { label: 'Teal', value: '#0F766E' },
  { label: 'Cobalt', value: '#2563EB' },
  { label: 'Violet', value: '#7C3AED' },
  { label: 'Amber', value: '#D97706' },
  { label: 'Cyan', value: '#0891B2' },
  { label: 'Slate', value: '#475569' },
  { label: 'Rose', value: '#BE123C' },
];

export function BudgetHeadsView({
  budgetHeads,
  onRefresh,
  onOpenImport,
  onAddSanctionForHead,
  externalOpenCreate,
  onConsumeExternalCreate,
}: BudgetHeadsViewProps) {
  const [search, setSearch] = useState('');
  const [modalOpen, setModalOpen] = useState(false);
  const [editing, setEditing] = useState<BudgetHeadEnriched | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [actionFeedback, setActionFeedback] = useState<string | null>(null);

  // Streamlined Budget Head fields (Code, Category, Fiscal Ceiling removed)
  const [name, setName] = useState('');
  const [color, setColor] = useState('#0F766E');
  const [description, setDescription] = useState('');

  // Multi-select bulk delete & inline single delete confirm
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  React.useEffect(() => {
    const valid = new Set(budgetHeads.map((h) => h.id));
    setSelectedIds((prev) => prev.filter((id) => valid.has(id)));
  }, [budgetHeads]);

  React.useEffect(() => {
    if (externalOpenCreate) {
      openCreate();
      onConsumeExternalCreate?.();
    }
  }, [externalOpenCreate]);

  const openCreate = () => {
    setEditing(null);
    setName('');
    setColor('#0F766E');
    setDescription('');
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (head: BudgetHeadEnriched) => {
    setEditing(head);
    setName(head.name);
    setColor(head.color);
    setDescription(head.description);
    setFormError(null);
    setModalOpen(true);
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    if (!name.trim()) {
      setFormError('Budget head name is required.');
      return;
    }

    setSubmitting(true);
    try {
      if (editing) {
        await api.updateBudgetHead(editing.id, {
          name: name.trim(),
          color,
          description: description.trim(),
        });
        setActionFeedback(`Updated budget head "${name.trim()}".`);
      } else {
        await api.createBudgetHead({
          name: name.trim(),
          color,
          description: description.trim(),
        });
        setActionFeedback(
          `Created budget head "${name.trim()}". Enter its sanction amount in the Budget Sanctions tab.`
        );
      }
      await onRefresh();
      setModalOpen(false);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Unable to save budget head.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (head: BudgetHeadEnriched) => {
    setActionFeedback(null);
    try {
      await api.deleteBudgetHead(head.id);
      setConfirmDeleteId(null);
      setSelectedIds((prev) => prev.filter((id) => id !== head.id));
      setActionFeedback(`Removed budget head "${head.name}".`);
      await onRefresh();
    } catch (err) {
      setActionFeedback(err instanceof Error ? err.message : 'Could not delete budget head.');
    }
  };

  const toggleSelect = (id: string) => {
    setConfirmBulkDelete(false);
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  };

  const handleBulkDelete = async () => {
    if (selectedIds.length === 0) return;
    setBulkDeleting(true);
    setActionFeedback(null);
    try {
      const res = await api.bulkDeleteBudgetHeads(selectedIds);
      const parts: string[] = [];
      if (res.deletedCount > 0) {
        parts.push(`Deleted ${res.deletedCount} budget ${res.deletedCount === 1 ? 'head' : 'heads'}.`);
      }
      if (res.skippedCount > 0) {
        const detail = res.errors.slice(0, 2).join('; ');
        parts.push(
          `Skipped ${res.skippedCount}${detail ? ` (${detail})` : ''}.`
        );
      }
      setActionFeedback(parts.join(' ') || 'No budget heads were deleted.');
      setSelectedIds([]);
      setConfirmBulkDelete(false);
      await onRefresh();
    } catch (err) {
      setActionFeedback(err instanceof Error ? err.message : 'Bulk delete failed.');
    } finally {
      setBulkDeleting(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return budgetHeads.filter((h) => {
      if (!q) return true;
      return (
        h.name.toLowerCase().includes(q) ||
        h.description.toLowerCase().includes(q) ||
        (h.latestFinancialYear || '').toLowerCase().includes(q)
      );
    });
  }, [budgetHeads, search]);

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((h) => selectedIds.includes(h.id));

  const toggleSelectAllFiltered = () => {
    setConfirmBulkDelete(false);
    if (allFilteredSelected) {
      const filteredSet = new Set(filtered.map((h) => h.id));
      setSelectedIds((prev) => prev.filter((id) => !filteredSet.has(id)));
    } else {
      const merged = new Set([...selectedIds, ...filtered.map((h) => h.id)]);
      setSelectedIds(Array.from(merged));
    }
  };

  const totalSanctioned = budgetHeads.reduce((s, h) => s + h.sanctionedTotal, 0);
  const totalSpent = budgetHeads.reduce((s, h) => s + h.spentTotal, 0);
  const totalRemaining = totalSanctioned - totalSpent;

  return (
    <div className="space-y-6">
      {/* Summary Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Active Budget Heads</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {budgetHeads.length}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Add sanctions per head on the Budget Sanctions tab
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Sanctioned Pool</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {formatCurrency(totalSanctioned)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {totalSanctioned > 0 ? formatPct((totalSpent / totalSanctioned) * 100) : '0%'} utilized across all heads
          </p>
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Remaining Sanctioned Balance</p>
          <p
            className={`mt-1.5 font-mono tabular-nums text-2xl font-semibold ${
              totalRemaining < 0 ? 'text-red-700' : 'text-teal-800'
            }`}
          >
            {formatCurrency(totalRemaining)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            Net spent {formatCurrency(totalSpent, true)}
          </p>
        </div>
      </div>

      {actionFeedback && (
        <div className="px-4 py-3 rounded-xl bg-slate-900 text-white text-xs sm:text-sm flex items-center justify-between gap-3">
          <span>{actionFeedback}</span>
          <button
            type="button"
            onClick={() => setActionFeedback(null)}
            className="text-slate-300 hover:text-white text-xs font-medium px-2 py-1 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Search & Action Toolbar */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search budget heads by name or notes..."
            className="w-full h-11 pl-10 pr-4 rounded-xl bg-white border border-slate-200 text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:border-teal-700"
          />
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onOpenImport}
            className="min-h-[42px] px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-slate-800 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <FileSpreadsheet className="w-4 h-4 text-teal-700" />
            <span>Import Excel</span>
          </button>
          <button
            type="button"
            onClick={openCreate}
            className="min-h-[42px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 cursor-pointer"
          >
            <Plus className="w-4 h-4" />
            <span>Add Budget Head</span>
          </button>
        </div>
      </div>

      {/* Multi-Select & Bulk Delete Bar */}
      {filtered.length > 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5 rounded-xl bg-white border border-slate-200">
          <label className="inline-flex items-center gap-2.5 text-xs font-medium text-slate-700 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={allFilteredSelected}
              onChange={toggleSelectAllFiltered}
              className="w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer"
            />
            <span>
              Select All ({filtered.length})
              {selectedIds.length > 0 ? ` · ${selectedIds.length} selected` : ''}
            </span>
          </label>

          {selectedIds.length > 0 && (
            <div className="flex items-center gap-2">
              {confirmBulkDelete ? (
                <>
                  <button
                    type="button"
                    disabled={bulkDeleting}
                    onClick={handleBulkDelete}
                    className="min-h-[34px] px-3 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer"
                  >
                    {bulkDeleting
                      ? 'Deleting...'
                      : `Confirm Delete (${selectedIds.length})`}
                  </button>
                  <button
                    type="button"
                    onClick={() => setConfirmBulkDelete(false)}
                    className="min-h-[34px] px-2.5 rounded-lg border border-slate-200 text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(true)}
                  className="min-h-[34px] px-3 rounded-lg bg-red-50 border border-red-200 hover:bg-red-100 text-red-700 text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                  <span>Delete Selected ({selectedIds.length})</span>
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Budget Heads Grid */}
      {filtered.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center">
          <p className="text-sm font-semibold text-slate-800">No matching budget heads</p>
          <p className="text-xs text-slate-500 mt-1">
            Create a budget head to begin recording sanction amounts and expenses.
          </p>
          <button
            type="button"
            onClick={openCreate}
            className="mt-4 px-4 py-2.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-xl cursor-pointer"
          >
            Create Budget Head
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filtered.map((head) => {
            const spentPct =
              head.sanctionedTotal > 0
                ? Math.min(100, (head.spentTotal / head.sanctionedTotal) * 100)
                : 0;
            const isSelected = selectedIds.includes(head.id);
            const isConfirmingDelete = confirmDeleteId === head.id;

            return (
              <article
                key={head.id}
                className={`bg-white border rounded-2xl p-5 flex flex-col justify-between transition-colors ${
                  isSelected ? 'border-teal-700 ring-1 ring-teal-700/20' : 'border-slate-200'
                }`}
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex items-start gap-2.5 min-w-0">
                      <input
                        type="checkbox"
                        checked={isSelected}
                        onChange={() => toggleSelect(head.id)}
                        aria-label={`Select ${head.name}`}
                        className="mt-0.5 w-4 h-4 rounded border-slate-300 text-teal-700 focus:ring-teal-700 cursor-pointer shrink-0"
                      />
                      <div className="min-w-0">
                        <p className="text-xs text-slate-500 flex items-center gap-1.5">
                          <span
                            className="w-2.5 h-2.5 rounded-xs inline-block shrink-0"
                            style={{ backgroundColor: head.color }}
                            aria-hidden="true"
                          />
                          <span>
                            {head.sanctionCount}{' '}
                            {head.sanctionCount === 1 ? 'sanction' : 'sanctions'}
                          </span>
                          {head.latestFinancialYear && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-mono text-teal-800 font-medium">
                                {head.latestFinancialYear}
                              </span>
                            </>
                          )}
                        </p>
                        <h3 className="mt-1.5 text-base font-semibold text-slate-900 truncate">
                          {head.name}
                        </h3>
                      </div>
                    </div>

                    <div className="flex items-center gap-1 shrink-0">
                      {isConfirmingDelete ? (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDelete(head)}
                            className="px-2 py-1 rounded-lg bg-red-700 text-white text-[11px] font-semibold cursor-pointer"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1 rounded-lg border border-slate-200 text-[11px] text-slate-600 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() => openEdit(head)}
                            aria-label={`Edit ${head.name}`}
                            className="min-w-[38px] min-h-[38px] flex items-center justify-center rounded-lg text-slate-500 hover:text-slate-900 hover:bg-slate-100 cursor-pointer"
                          >
                            <Pencil className="w-4 h-4" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(head.id)}
                            aria-label={`Delete ${head.name}`}
                            className="min-w-[38px] min-h-[38px] flex items-center justify-center rounded-lg text-slate-500 hover:text-red-700 hover:bg-red-50 cursor-pointer"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </>
                      )}
                    </div>
                  </div>

                  {head.description && (
                    <p className="mt-2 text-xs text-slate-600 line-clamp-2 leading-relaxed">
                      {head.description}
                    </p>
                  )}
                </div>

                <div className="mt-5 pt-4 border-t border-slate-100 space-y-3">
                  <div className="flex items-baseline justify-between">
                    <span className="text-xs text-slate-500">Total Sanctioned</span>
                    <span className="font-mono tabular-nums text-sm font-semibold text-slate-900">
                      {formatCurrency(head.sanctionedTotal)}
                    </span>
                  </div>

                  <div className="relative h-2 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full transition-all duration-300"
                      style={{
                        width: `${spentPct}%`,
                        backgroundColor:
                          head.utilizationPct >= 95
                            ? '#DC2626'
                            : head.utilizationPct >= 80
                              ? '#D97706'
                              : head.color,
                      }}
                    />
                  </div>

                  <div className="grid grid-cols-2 gap-2 pt-1 text-xs">
                    <div>
                      <p className="text-slate-400">Spent</p>
                      <p className="font-mono tabular-nums font-medium text-slate-800 mt-0.5">
                        {formatCurrency(head.spentTotal, true)} ({formatPct(head.utilizationPct)})
                      </p>
                    </div>
                    <div className="text-right">
                      <p className="text-slate-400">Remaining</p>
                      <p
                        className={`font-mono tabular-nums font-semibold mt-0.5 ${
                          head.remainingBalance < 0 ? 'text-red-700' : 'text-teal-800'
                        }`}
                      >
                        {formatCurrency(head.remainingBalance, true)}
                      </p>
                    </div>
                  </div>

                  <button
                    type="button"
                    onClick={() => onAddSanctionForHead(head.id)}
                    className="w-full min-h-[38px] mt-1 rounded-xl border border-slate-200 hover:border-teal-700 hover:text-teal-800 text-xs font-semibold text-slate-700 inline-flex items-center justify-center gap-1.5 transition-colors cursor-pointer"
                  >
                    <Landmark className="w-3.5 h-3.5" />
                    <span>Enter Sanction Amount</span>
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {/* Create / Edit Budget Head Modal (Code, Category, Fiscal Ceiling removed) */}
      <BottomSheetModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editing ? 'Edit Budget Head' : 'Create Budget Head'}
        subtitle="Define the budget head name and scope. Sanction amounts are entered on the Budget Sanctions tab."
      >
        <form onSubmit={handleSave} className="space-y-4">
          {formError && (
            <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {formError}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Budget Head Name
            </label>
            <input
              type="text"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., Infrastructure Maintenance"
              className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Chart Identifier Color
            </label>
            <div className="flex flex-wrap items-center gap-2">
              {COLOR_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setColor(opt.value)}
                  className={`min-h-[38px] px-3 rounded-xl border text-xs font-medium inline-flex items-center gap-2 cursor-pointer transition-colors ${
                    color === opt.value
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : 'border-slate-200 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  <span
                    className="w-3 h-3 rounded-full"
                    style={{ backgroundColor: opt.value }}
                    aria-hidden="true"
                  />
                  <span>{opt.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              Scope &amp; Notes
            </label>
            <textarea
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Outline eligible expenses covered under this budget head."
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
              {submitting ? 'Saving...' : editing ? 'Save Changes' : 'Create Budget Head'}
            </button>
          </div>
        </form>
      </BottomSheetModal>
    </div>
  );
}
