import {
  AlertTriangle,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  CheckCircle2,
  Clock,
  FileText,
  Plus,
} from 'lucide-react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { formatAxisCurrency, formatCurrency, formatPct, formatShortDate } from '../lib/format';
import type {
  AnalyticsSummary,
  BudgetHeadEnriched,
  SafeUser,
  TransactionEnriched,
} from '../types/finance';

interface OverviewViewProps {
  user: SafeUser;
  analytics: AnalyticsSummary | null;
  budgetHeads: BudgetHeadEnriched[];
  transactions: TransactionEnriched[];
  loading: boolean;
  onNavigate: (tab: 'overview' | 'heads' | 'sanctions' | 'transactions' | 'reports' | 'users' | 'backup') => void;
  onQuickLogTransaction: (budgetHeadId?: string) => void;
  onExportLedgerPdf?: () => void;
}

export function OverviewView({
  user,
  analytics,
  budgetHeads,
  transactions,
  loading,
  onNavigate,
  onQuickLogTransaction,
  onExportLedgerPdf,
}: OverviewViewProps) {
  const isAdmin = user.role === 'admin';

  if (loading && !analytics) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-28 rounded-2xl bg-white border border-slate-200 animate-pulse" />
          ))}
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-2 h-80 rounded-2xl bg-white border border-slate-200 animate-pulse" />
          <div className="h-80 rounded-2xl bg-white border border-slate-200 animate-pulse" />
        </div>
      </div>
    );
  }

  if (!analytics) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center">
        <p className="text-sm text-slate-600">Unable to load financial summary right now.</p>
      </div>
    );
  }

  const recentTxs = transactions.slice(0, 6);
  const topHeads = [...budgetHeads]
    .sort((a, b) => b.utilizationPct - a.utilizationPct)
    .slice(0, 5);

  const healthColor =
    analytics.utilizationPct >= 95
      ? 'text-red-700'
      : analytics.utilizationPct >= 80
        ? 'text-amber-700'
        : 'text-emerald-700';

  return (
    <div className="space-y-6">
      {/* KPI Strip — 4-Column Full-Width Row */}
      <section aria-label="Key financial metrics" className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Total Sanctioned Budget</p>
          <p className="mt-2 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {formatCurrency(analytics.totalSanctioned)}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {analytics.sanctionCount} sanction {analytics.sanctionCount === 1 ? 'order' : 'orders'} ·{' '}
            {budgetHeads.length} {budgetHeads.length === 1 ? 'head' : 'heads'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Net Spend Recorded</p>
          <p className="mt-2 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {formatCurrency(analytics.totalSpent)}
          </p>
          <p className={`mt-2 text-xs font-medium ${healthColor}`}>
            {formatPct(analytics.utilizationPct)} of sanctioned budget utilized
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Remaining Sanctioned</p>
          <p
            className={`mt-2 font-mono tabular-nums text-2xl font-semibold ${
              analytics.remainingBalance < 0 ? 'text-red-700' : 'text-teal-800'
            }`}
          >
            {formatCurrency(analytics.remainingBalance)}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {analytics.totalIncome > 0
              ? `Includes ${formatCurrency(analytics.totalIncome, true)} credits`
              : 'Available across active budget heads'}
          </p>
        </div>

        <div className="bg-white border border-slate-200 rounded-2xl p-5">
          <p className="text-xs font-medium text-slate-500">Ledger Activity</p>
          <p className="mt-2 font-mono tabular-nums text-2xl font-semibold text-slate-900">
            {analytics.transactionCount}
          </p>
          <p className="mt-2 text-xs text-slate-500">
            {analytics.pendingCount} pending · {analytics.flaggedCount} flagged
          </p>
        </div>
      </section>

      {/* Primary Visual Anchor: Spending Velocity Chart + Budget Head Utilization */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <section className="lg:col-span-2 bg-white border border-slate-200 rounded-2xl p-5 sm:p-6">
          <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
            <div>
              <h2 className="text-base font-semibold text-slate-900">
                Monthly Spending Trajectory
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Actual monthly outlay compared against even monthly sanction pace
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('reports')}
              className="text-xs font-medium text-teal-700 hover:text-teal-900 inline-flex items-center gap-1 min-h-[36px] px-2 cursor-pointer whitespace-nowrap"
            >
              <span>Full Analysis</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>

          <div className="h-64 sm:h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart
                data={analytics.monthlySeries}
                margin={{ top: 8, right: 8, left: -12, bottom: 0 }}
              >
                <defs>
                  <linearGradient id="spendGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#1D358F" stopOpacity={0.22} />
                    <stop offset="95%" stopColor="#1D358F" stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#E2E8F0" vertical={false} />
                <XAxis
                  dataKey="month"
                  tick={{ fontSize: 12, fill: '#64748B' }}
                  axisLine={false}
                  tickLine={false}
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
                    name === 'expense' ? 'Expenses' : 'Monthly Sanction Pace',
                  ]}
                  contentStyle={{
                    borderRadius: '12px',
                    border: '1px solid #E2E8F0',
                    boxShadow: '0 8px 24px rgba(15, 23, 42, 0.08)',
                    fontSize: '12px',
                  }}
                />
                <Area
                  type="monotone"
                  dataKey="sanctionPace"
                  stroke="#94A3B8"
                  strokeWidth={1.5}
                  strokeDasharray="4 4"
                  fill="none"
                />
                <Area
                  type="monotone"
                  dataKey="expense"
                  stroke="#1D358F"
                  strokeWidth={2.5}
                  fill="url(#spendGradient)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>

          <div className="mt-4 pt-3 border-t border-slate-100 flex flex-wrap items-center gap-5 text-xs text-slate-600">
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-0.5 bg-teal-700 inline-block" aria-hidden="true" />
              Actual Expenses
            </span>
            <span className="inline-flex items-center gap-2">
              <span className="w-3 h-0.5 border-t border-dashed border-slate-400 inline-block" aria-hidden="true" />
              Target Monthly Sanction Pace
            </span>
          </div>
        </section>

        {/* Budget Head Sanction Utilization */}
        <section className="bg-white border border-slate-200 rounded-2xl p-5 sm:p-6 flex flex-col">
          <div className="flex items-center justify-between gap-2 mb-4">
            <div>
              <h2 className="text-base font-semibold text-slate-900">Sanction Utilization</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                Spend against sanctioned funds per budget head
              </p>
            </div>
            <button
              type="button"
              onClick={() => onNavigate('sanctions')}
              className="text-xs font-medium text-teal-700 hover:text-teal-900 min-h-[36px] px-1 cursor-pointer whitespace-nowrap"
            >
              Sanctions
            </button>
          </div>

          {topHeads.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-8">
              <p className="text-sm font-medium text-slate-700">No budget heads added yet</p>
              <p className="text-xs text-slate-500 mt-1 max-w-xs">
                Add budget heads and enter sanction amounts to monitor utilization.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100 flex-1">
              {topHeads.map((head) => {
                const isOver = head.utilizationPct >= 100;
                const isWarn = head.utilizationPct >= 80 && !isOver;
                const barWidth = Math.min(100, Math.max(2, head.utilizationPct));
                const barColor = isOver
                  ? '#DC2626'
                  : isWarn
                    ? '#D97706'
                    : head.color || '#1D358F';

                return (
                  <div key={head.id} className="py-3.5 first:pt-1 last:pb-0">
                    <div className="flex items-baseline justify-between gap-2">
                      <p className="text-sm font-medium text-slate-900 truncate">{head.name}</p>
                      <span
                        className={`font-mono tabular-nums text-xs font-semibold shrink-0 ${
                          isOver
                            ? 'text-red-700'
                            : isWarn
                              ? 'text-amber-700'
                              : 'text-slate-700'
                        }`}
                      >
                        {formatPct(head.utilizationPct)}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-0.5 truncate">
                      {head.sanctionCount} {head.sanctionCount === 1 ? 'sanction' : 'sanctions'}
                      {head.latestFinancialYear ? ` · ${head.latestFinancialYear}` : ''}
                    </p>
                    <div className="mt-2 h-1.5 w-full bg-slate-100 rounded-full overflow-hidden">
                      <div
                        className="h-full rounded-full transition-all duration-300"
                        style={{ width: `${barWidth}%`, backgroundColor: barColor }}
                      />
                    </div>
                    <div className="mt-1.5 flex items-center justify-between text-xs font-mono tabular-nums text-slate-500">
                      <span>{formatCurrency(head.spentTotal, true)} spent</span>
                      <span>{formatCurrency(head.sanctionedTotal, true)} sanctioned</span>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      {/* Recent Transactions Ledger Preview */}
      <section className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
        <div className="px-5 sm:px-6 py-4 border-b border-slate-100 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-slate-900">Recent Transactions</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              Latest recorded ledger activity across all budget heads
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {onExportLedgerPdf && (
              <button
                type="button"
                onClick={onExportLedgerPdf}
                className="min-h-[40px] px-3.5 text-xs font-semibold text-teal-800 bg-teal-50 hover:bg-teal-100 rounded-xl inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
              >
                <FileText className="w-3.5 h-3.5" />
                <span>Export Ledger PDF</span>
              </button>
            )}
            {isAdmin && (
              <button
                type="button"
                onClick={() => onQuickLogTransaction()}
                className="min-h-[40px] px-3.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-xl inline-flex items-center gap-1.5 transition-colors cursor-pointer whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                <span>Log Entry</span>
              </button>
            )}
            <button
              type="button"
              onClick={() => onNavigate('transactions')}
              className="min-h-[40px] px-3 text-xs font-medium text-slate-600 hover:text-slate-900 inline-flex items-center gap-1 cursor-pointer whitespace-nowrap"
            >
              <span>All Ledger</span>
              <ArrowRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {recentTxs.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-slate-700">No transactions recorded yet</p>
            <p className="text-xs text-slate-500 mt-1">
              {isAdmin
                ? 'Record an expense or rebate to see live budget tracking and spending charts.'
                : 'Ledger entries recorded by administrators will appear here.'}
            </p>
            {isAdmin && (
              <button
                type="button"
                onClick={() => onQuickLogTransaction()}
                className="mt-4 px-4 py-2.5 text-xs font-semibold text-white bg-teal-700 hover:bg-teal-800 rounded-xl cursor-pointer"
              >
                Log First Transaction
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {recentTxs.map((tx) => {
              const isIncome = tx.type === 'income';
              return (
                <div
                  key={tx.id}
                  onClick={() => onNavigate('transactions')}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      onNavigate('transactions');
                    }
                  }}
                  className="px-5 sm:px-6 py-3.5 hover:bg-slate-50/80 transition-colors flex items-center justify-between gap-4 cursor-pointer"
                >
                  <div className="flex items-center gap-3.5 min-w-0">
                    <div
                      className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 ${
                        isIncome ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {isIncome ? (
                        <ArrowDownLeft className="w-4 h-4" />
                      ) : (
                        <ArrowUpRight className="w-4 h-4" />
                      )}
                    </div>
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-slate-900 truncate">{tx.title}</p>
                      <p className="text-xs text-slate-500 truncate mt-0.5">
                        {tx.merchant} · {tx.budgetHeadName} · {formatShortDate(tx.date)}
                        {isAdmin ? ` · ${tx.userName}` : ''}
                      </p>
                    </div>
                  </div>

                  <div className="text-right shrink-0">
                    <p
                      className={`font-mono tabular-nums text-sm font-semibold ${
                        isIncome ? 'text-emerald-700' : 'text-slate-900'
                      }`}
                    >
                      {isIncome ? '+' : '-'}
                      {formatCurrency(tx.amount)}
                    </p>
                    <p className="mt-0.5 text-xs inline-flex items-center justify-end gap-1">
                      {tx.status === 'approved' && (
                        <>
                          <CheckCircle2 className="w-3 h-3 text-emerald-600" />
                          <span className="text-emerald-700">Approved</span>
                        </>
                      )}
                      {tx.status === 'pending' && (
                        <>
                          <Clock className="w-3 h-3 text-amber-600" />
                          <span className="text-amber-700">Pending</span>
                        </>
                      )}
                      {tx.status === 'flagged' && (
                        <>
                          <AlertTriangle className="w-3 h-3 text-red-600" />
                          <span className="text-red-700">Flagged</span>
                        </>
                      )}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
