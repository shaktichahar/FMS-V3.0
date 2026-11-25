import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Calendar, FileDown, RotateCcw } from 'lucide-react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { formatAxisCurrency, formatCurrency, formatPct } from '../lib/format';
import {
  computeUtilizationReportData,
  downloadUtilizationReportPdf,
} from '../lib/utilizationPdf';
import type {
  AnalyticsSummary,
  BudgetHeadEnriched,
  BudgetSanctionEnriched,
  SafeUser,
  TransactionEnriched,
} from '../types/finance';

interface ReportsViewProps {
  user: SafeUser;
  initialAnalytics: AnalyticsSummary | null;
  budgetHeads: BudgetHeadEnriched[];
  sanctions: BudgetSanctionEnriched[];
  transactions: TransactionEnriched[];
}

export function ReportsView({
  user,
  initialAnalytics,
  budgetHeads,
  sanctions,
  transactions,
}: ReportsViewProps) {
  const isAdmin = user.role === 'admin';
  const [selectedFy, setSelectedFy] = useState<string>('all');
  const [dateFrom, setDateFrom] = useState<string>('');
  const [dateTo, setDateTo] = useState<string>('');
  const [selectedHeadId, setSelectedHeadId] = useState<string>('all');
  const [analytics, setAnalytics] = useState<AnalyticsSummary | null>(initialAnalytics);
  const [loading, setLoading] = useState(false);
  const [pdfFeedback, setPdfFeedback] = useState<string | null>(null);

  useEffect(() => {
    setAnalytics(initialAnalytics);
  }, [initialAnalytics]);

  const availableYears = useMemo(() => {
    const set = new Set<string>();
    (analytics?.availableFinancialYears || []).forEach((fy) => set.add(fy));
    sanctions
      .filter((s) => s.approvalStatus === 'approved')
      .forEach((s) => set.add(s.financialYear));
    transactions.forEach((t) => set.add(t.financialYear));
    return Array.from(set).sort().reverse();
  }, [analytics, sanctions, transactions]);

  const handleFyChange = async (fy: string) => {
    setSelectedFy(fy);
    setLoading(true);
    try {
      const res = await api.getAnalytics(0, fy);
      setAnalytics(res.analytics);
    } catch {
      // Keep prior analytics visible
    } finally {
      setLoading(false);
    }
  };

  const handleResetFilters = () => {
    setDateFrom('');
    setDateTo('');
    setSelectedHeadId('all');
    if (selectedFy !== 'all') {
      void handleFyChange('all');
    }
  };

  const reportData = useMemo(
    () =>
      computeUtilizationReportData({
        user,
        budgetHeads,
        sanctions,
        transactions,
        selectedFy,
        dateFrom,
        dateTo,
        selectedHeadId,
      }),
    [user, budgetHeads, sanctions, transactions, selectedFy, dateFrom, dateTo, selectedHeadId]
  );

  const hasCustomFilters =
    selectedFy !== 'all' || Boolean(dateFrom) || Boolean(dateTo) || selectedHeadId !== 'all';

  const handleDownloadPdf = () => {
    const fileName = downloadUtilizationReportPdf(reportData);
    setPdfFeedback(`Downloaded PDF Utilization Report (${fileName}).`);
  };

  // Filtered chart datasets reflecting FY + Date Range + Budget Head selections
  const chartHeadComparison = useMemo(
    () =>
      reportData.headRows.map((row) => {
        const match = budgetHeads.find((h) => h.id === row.id);
        return {
          id: row.id,
          name: row.name,
          color: match?.color || '#1D358F',
          sanctioned: row.sanctioned,
          spent: row.spent,
          remaining: row.remaining,
          utilizationPct: row.utilizationPct,
        };
      }),
    [reportData.headRows, budgetHeads]
  );

  const chartShareBreakdown = useMemo(() => {
    const total = reportData.headRows.reduce((s, r) => s + r.spent, 0);
    return reportData.headRows
      .filter((r) => r.spent > 0)
      .map((r) => {
        const match = budgetHeads.find((h) => h.id === r.id);
        return {
          id: r.id,
          name: r.name,
          color: match?.color || '#1D358F',
          amount: r.spent,
          count: r.txCount,
          sharePct: total > 0 ? Math.round((r.spent / total) * 1000) / 10 : 0,
        };
      })
      .sort((a, b) => b.amount - a.amount);
  }, [reportData.headRows, budgetHeads]);

  if (!analytics) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
        <p className="text-sm text-slate-600">Loading spending analysis...</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {pdfFeedback && (
        <div className="px-4 py-3 rounded-xl bg-slate-900 text-white text-xs sm:text-sm flex items-center justify-between gap-3">
          <span>{pdfFeedback}</span>
          <button
            type="button"
            onClick={() => setPdfFeedback(null)}
            className="text-slate-300 hover:text-white text-xs font-medium px-2 py-1 cursor-pointer"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Utilization Report Filter & PDF Download Card */}
      <section className="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm sm:text-base font-semibold text-slate-900">
              Budget Utilization Report
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Select Financial Year, custom date range, and/or Budget Head to filter analytics and download a PDF Utilization Report.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {hasCustomFilters && (
              <button
                type="button"
                onClick={handleResetFilters}
                className="min-h-[42px] px-3.5 rounded-xl border border-slate-200 bg-white hover:bg-slate-50 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                <span>Reset Filters</span>
              </button>
            )}
            <button
              type="button"
              onClick={handleDownloadPdf}
              className="min-h-[42px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 active:scale-[0.99] text-white text-xs font-semibold inline-flex items-center gap-2 whitespace-nowrap cursor-pointer transition-all"
            >
              <FileDown className="w-4 h-4" />
              <span>Download Utilization Report (PDF)</span>
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 pt-3 border-t border-slate-100">
          {/* Financial Year */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
              Financial Year
            </label>
            <select
              aria-label="Select financial year"
              value={selectedFy}
              onChange={(e) => void handleFyChange(e.target.value)}
              className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:outline-none focus:border-teal-700"
            >
              <option value="all">All Financial Years</option>
              {availableYears.map((fy) => (
                <option key={fy} value={fy}>
                  {fy}
                </option>
              ))}
            </select>
          </div>

          {/* Budget Head */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
              Budget Head
            </label>
            <select
              aria-label="Select budget head"
              value={selectedHeadId}
              onChange={(e) => setSelectedHeadId(e.target.value)}
              className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-xs font-medium text-slate-800 focus:outline-none focus:border-teal-700"
            >
              <option value="all">All Budget Heads ({budgetHeads.length})</option>
              {budgetHeads.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name}
                </option>
              ))}
            </select>
          </div>

          {/* Date From */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
              From Date (Optional)
            </label>
            <div className="relative">
              <Calendar className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="date"
                aria-label="From date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="w-full h-11 pl-9 pr-3 rounded-xl border border-slate-200 bg-white font-mono text-xs text-slate-800 focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          {/* Date To */}
          <div>
            <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">
              To Date (Optional)
            </label>
            <div className="relative">
              <Calendar className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                type="date"
                aria-label="To date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                className="w-full h-11 pl-9 pr-3 rounded-xl border border-slate-200 bg-white font-mono text-xs text-slate-800 focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>
        </div>
      </section>

      {/* Summary Metrics (Reflects Active FY / Date / Budget Head Selection) */}
      <div
        className={`grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 transition-opacity ${
          loading ? 'opacity-60' : 'opacity-100'
        }`}
      >
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Approved Sanctioned</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {formatCurrency(reportData.totalSanctioned)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {reportData.headRows.length}{' '}
            {reportData.headRows.length === 1 ? 'budget head' : 'budget heads'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Period Net Spend</p>
          <p className="mt-1.5 font-mono tabular-nums text-2xl font-semibold text-red-700">
            {formatCurrency(reportData.totalSpent)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {reportData.ledgerRows.filter((r) => r.debit > 0).length} debit entries
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Remaining Balance</p>
          <p
            className={`mt-1.5 font-mono tabular-nums text-2xl font-semibold ${
              reportData.totalRemaining < 0 ? 'text-red-700' : 'text-teal-800'
            }`}
          >
            {formatCurrency(reportData.totalRemaining)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {selectedFy === 'all' ? 'Across all years' : selectedFy}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Sanction Utilization</p>
          <p
            className={`mt-1.5 font-mono tabular-nums text-2xl font-semibold ${
              reportData.utilizationPct >= 95
                ? 'text-red-700'
                : reportData.utilizationPct >= 80
                  ? 'text-amber-700'
                  : 'text-teal-800'
            }`}
          >
            {formatPct(reportData.utilizationPct)}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            {reportData.ledgerRows.length} total statement entries
          </p>
        </div>
      </div>

      {/* Budget Head Utilization Table (Preview of PDF Section 1) */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="p-5 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">
              Budget Head Utilization Breakdown
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Exact summary included in your downloaded PDF Utilization Report
            </p>
          </div>
          <span className="text-xs font-mono text-slate-500">
            {selectedFy === 'all' ? 'All FY' : selectedFy}
            {dateFrom || dateTo ? ` · ${dateFrom || 'Start'} → ${dateTo || 'Today'}` : ''}
          </span>
        </div>

        {reportData.headRows.length === 0 ? (
          <div className="p-8 text-center text-sm text-slate-500">
            No budget heads match your current selection.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-slate-50/90 border-b border-slate-200 text-xs font-semibold text-slate-600">
                  <th className="py-3 px-5">Budget Head</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Sanctioned (₹)</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Net Spent (₹)</th>
                  <th className="py-3 px-4 text-right whitespace-nowrap">Remaining (₹)</th>
                  <th className="py-3 px-5 text-right whitespace-nowrap">Utilization %</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {reportData.headRows.map((row) => (
                  <tr key={row.id} className="hover:bg-slate-50/60">
                    <td className="py-3 px-5 font-medium text-slate-900">{row.name}</td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-slate-800 whitespace-nowrap">
                      {formatCurrency(row.sanctioned)}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-red-700 whitespace-nowrap">
                      {formatCurrency(row.spent)}
                    </td>
                    <td
                      className={`py-3 px-4 text-right font-mono tabular-nums font-semibold whitespace-nowrap ${
                        row.remaining < 0 ? 'text-red-700' : 'text-teal-800'
                      }`}
                    >
                      {formatCurrency(row.remaining)}
                    </td>
                    <td className="py-3 px-5 text-right font-mono tabular-nums font-semibold whitespace-nowrap">
                      <span
                        className={
                          row.utilizationPct >= 95
                            ? 'text-red-700'
                            : row.utilizationPct >= 80
                              ? 'text-amber-700'
                              : 'text-slate-800'
                        }
                      >
                        {formatPct(row.utilizationPct)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-teal-50/60 border-t border-teal-200 text-sm font-semibold text-slate-900">
                  <td className="py-3.5 px-5">Total</td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                    {formatCurrency(reportData.totalSanctioned)}
                  </td>
                  <td className="py-3.5 px-4 text-right font-mono tabular-nums text-red-700 whitespace-nowrap">
                    {formatCurrency(reportData.totalSpent)}
                  </td>
                  <td
                    className={`py-3.5 px-4 text-right font-mono tabular-nums whitespace-nowrap ${
                      reportData.totalRemaining < 0 ? 'text-red-700' : 'text-teal-800'
                    }`}
                  >
                    {formatCurrency(reportData.totalRemaining)}
                  </td>
                  <td className="py-3.5 px-5 text-right font-mono tabular-nums whitespace-nowrap">
                    {formatPct(reportData.utilizationPct)}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </section>

      {/* Primary Charts Row: Sanctioned vs Actual Spend + Head Share Donut */}
      <div className="grid grid-cols-1 xl:grid-cols-5 gap-6">
        <section className="xl:col-span-3 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6">
          <div className="mb-5">
            <h2 className="text-base font-semibold text-slate-900">
              Budget Sanctioned vs. Actual Spend
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Variance comparison across selected budget heads and period
            </p>
          </div>

          {chartHeadComparison.length === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-slate-500">
              No budget head data available for this selection.
            </div>
          ) : (
            <div className="h-72 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart
                  data={chartHeadComparison}
                  margin={{ top: 8, right: 8, left: -10, bottom: 8 }}
                  barGap={6}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                  <XAxis
                    dataKey="name"
                    tick={{ fontSize: 11, fill: '#475569' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(label: string) =>
                      label.length > 13 ? `${label.slice(0, 12)}…` : label
                    }
                  />
                  <YAxis
                    tick={{ fontSize: 12, fill: '#64748B' }}
                    axisLine={false}
                    tickLine={false}
                    tickFormatter={(v: number) => formatAxisCurrency(v)}
                  />
                  <Tooltip
                    formatter={(value, name) => [
                      formatCurrency(Number(value ?? 0)),
                      name === 'sanctioned' ? 'Sanctioned' : 'Net Spent',
                    ]}
                    contentStyle={{
                      borderRadius: '12px',
                      border: '1px solid #E2E8F0',
                      boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)',
                      fontSize: '12px',
                    }}
                  />
                  <Bar dataKey="sanctioned" fill="#CBD5E1" radius={[6, 6, 0, 0]} maxBarSize={28} />
                  <Bar dataKey="spent" fill="#1D358F" radius={[6, 6, 0, 0]} maxBarSize={28} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          <div className="mt-4 pt-3 border-t border-slate-100 flex items-center gap-5 text-xs text-slate-600">
            <span className="inline-flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-xs bg-slate-300 inline-block" aria-hidden="true" />
              Sanctioned Amount
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-xs bg-teal-700 inline-block" aria-hidden="true" />
              Actual Spend
            </span>
          </div>
        </section>

        {/* Spending Mix by Budget Head */}
        <section className="xl:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 flex flex-col">
          <div className="mb-4">
            <h2 className="text-base font-semibold text-slate-900">Spending Share by Head</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Distribution of expenses across selected budget heads
            </p>
          </div>

          {chartShareBreakdown.length === 0 ? (
            <div className="flex-1 flex items-center justify-center text-sm text-slate-500 py-10">
              No expense entries in this selection.
            </div>
          ) : (
            <>
              <div className="h-48 w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={chartShareBreakdown}
                      dataKey="amount"
                      nameKey="name"
                      cx="50%"
                      cy="50%"
                      innerRadius={52}
                      outerRadius={78}
                      paddingAngle={2}
                    >
                      {chartShareBreakdown.map((entry) => (
                        <Cell key={entry.id} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(value) => formatCurrency(Number(value ?? 0))}
                      contentStyle={{
                        borderRadius: '12px',
                        border: '1px solid #E2E8F0',
                        fontSize: '12px',
                      }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-4 divide-y divide-slate-100">
                {chartShareBreakdown.map((item) => (
                  <div
                    key={item.id}
                    className="py-2.5 flex items-center justify-between gap-3 text-xs"
                  >
                    <div className="flex items-center gap-2 min-w-0">
                      <span
                        className="w-2.5 h-2.5 rounded-xs shrink-0"
                        style={{ backgroundColor: item.color }}
                        aria-hidden="true"
                      />
                      <span className="font-medium text-slate-800 truncate">{item.name}</span>
                      <span className="text-slate-400 shrink-0">({item.count})</span>
                    </div>
                    <div className="font-mono tabular-nums text-right shrink-0">
                      <span className="font-semibold text-slate-900">
                        {formatCurrency(item.amount)}
                      </span>
                      <span className="text-slate-400 ml-2">{formatPct(item.sharePct)}</span>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </section>
      </div>

      {/* Financial Year Summary & Watchlist */}
      <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 flex flex-col justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-900">
            {isAdmin ? 'Financial Year Sanctions Summary' : 'Payment Channel Breakdown'}
          </h2>
          <p className="text-xs text-slate-500 mt-0.5">
            {isAdmin
              ? 'Sanctioned pools and spend aggregated by Indian Financial Year (Apr – Mar)'
              : 'Where expenses are settled across payment rails'}
          </p>

          {isAdmin ? (
            <div className="mt-4 divide-y divide-slate-100">
              {analytics.financialYearBreakdown.map((fyRow) => (
                <div key={fyRow.financialYear} className="py-3 first:pt-1">
                  <div className="flex items-baseline justify-between gap-2">
                    <p className="text-sm font-medium text-slate-900">
                      <span className="font-mono font-semibold text-teal-800">
                        {fyRow.financialYear}
                      </span>{' '}
                      <span className="text-xs font-normal text-slate-500">
                        · {fyRow.sanctionCount}{' '}
                        {fyRow.sanctionCount === 1 ? 'sanction' : 'sanctions'}
                      </span>
                    </p>
                    <span className="font-mono tabular-nums text-xs font-semibold text-slate-800">
                      {formatPct(fyRow.utilizationPct)}
                    </span>
                  </div>
                  <div className="mt-1.5 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full"
                      style={{
                        width: `${Math.min(100, fyRow.utilizationPct)}%`,
                        backgroundColor:
                          fyRow.utilizationPct >= 95
                            ? '#DC2626'
                            : fyRow.utilizationPct >= 80
                              ? '#D97706'
                              : '#1D358F',
                      }}
                    />
                  </div>
                  <div className="mt-1 flex justify-between text-xs font-mono tabular-nums text-slate-500">
                    <span>{formatCurrency(fyRow.spent)} spent</span>
                    <span>{formatCurrency(fyRow.sanctioned)} sanctioned</span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-4 divide-y divide-slate-100">
              {analytics.paymentMethodBreakdown.length === 0 ? (
                <p className="py-8 text-xs text-slate-500 text-center">
                  No expenses recorded for this period.
                </p>
              ) : (
                analytics.paymentMethodBreakdown.map((pm) => (
                  <div
                    key={pm.method}
                    className="py-3 flex items-center justify-between text-sm"
                  >
                    <div>
                      <p className="font-medium text-slate-900">{pm.method}</p>
                      <p className="text-xs text-slate-500">
                        {pm.count} {pm.count === 1 ? 'transaction' : 'transactions'}
                      </p>
                    </div>
                    <p className="font-mono tabular-nums font-semibold text-slate-900">
                      {formatCurrency(pm.amount)}
                    </p>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        {analytics.alerts.length > 0 && (
          <div className="mt-5 pt-4 border-t border-slate-100">
            <p className="text-xs font-semibold text-slate-800 flex items-center gap-1.5 mb-2">
              <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
              <span>High-Utilization Watchlist ({analytics.alerts.length})</span>
            </p>
            <div className="space-y-1.5">
              {analytics.alerts.slice(0, 3).map((al) => (
                <div
                  key={al.id}
                  className="flex items-center justify-between gap-2 text-xs text-slate-600"
                >
                  <span className="truncate">
                    <strong className="font-medium text-slate-800">{al.label}</strong> ·{' '}
                    {al.context}
                  </span>
                  <span
                    className={`font-mono tabular-nums font-semibold shrink-0 ${
                      al.severity === 'critical' ? 'text-red-700' : 'text-amber-700'
                    }`}
                  >
                    {formatPct(al.utilizationPct)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
