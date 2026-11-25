import React, { useState } from 'react';
import { CalendarClock, Mail, Pencil, Phone, Plus, Shield, Trash2, UserCheck, UserX } from 'lucide-react';
import { api } from '../lib/api';
import { formatCurrency } from '../lib/format';
import type { SafeUser, UserRole, UserWithStats } from '../types/finance';
import { Avatar } from './Avatar';
import { BottomSheetModal } from './BottomSheetModal';

function toLocalDateTimeInput(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fromLocalDateTimeInput(val: string): string | null {
  const trimmed = val.trim();
  if (!trimmed) return null;
  const d = new Date(trimmed);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function formatDateTimeShort(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: true,
  });
}

function describeAccessWindow(u: UserWithStats): {
  statusLabel: string;
  statusClass: string;
  scheduleSummary: string | null;
} {
  const now = Date.now();
  const activeFromMs = u.activeFrom ? new Date(u.activeFrom).getTime() : null;
  const activeUntilMs = u.activeUntil ? new Date(u.activeUntil).getTime() : null;
  const deactFromMs = u.deactivatedFrom ? new Date(u.deactivatedFrom).getTime() : null;
  const deactUntilMs = u.deactivatedUntil ? new Date(u.deactivatedUntil).getTime() : null;

  const parts: string[] = [];
  if (u.activeFrom || u.activeUntil) {
    parts.push(
      `Active window: ${u.activeFrom ? formatDateTimeShort(u.activeFrom) : 'Now'} → ${
        u.activeUntil ? formatDateTimeShort(u.activeUntil) : 'Indefinite'
      }`
    );
  }
  if (u.deactivatedFrom || u.deactivatedUntil) {
    parts.push(
      `Deactivated window: ${u.deactivatedFrom ? formatDateTimeShort(u.deactivatedFrom) : 'Now'} → ${
        u.deactivatedUntil ? formatDateTimeShort(u.deactivatedUntil) : 'Indefinite'
      }`
    );
  }
  const scheduleSummary = parts.length > 0 ? parts.join(' · ') : null;

  if (!u.active) {
    return {
      statusLabel: 'Pending / Suspended',
      statusClass: 'text-amber-700 font-semibold',
      scheduleSummary,
    };
  }
  const inDeactWindow =
    (deactFromMs !== null || deactUntilMs !== null) &&
    (deactFromMs === null || now >= deactFromMs) &&
    (deactUntilMs === null || now <= deactUntilMs);
  if (inDeactWindow) {
    return {
      statusLabel: u.deactivatedUntil
        ? `Temporarily Deactivated until ${formatDateTimeShort(u.deactivatedUntil)}`
        : 'Temporarily Deactivated',
      statusClass: 'text-red-700 font-semibold',
      scheduleSummary,
    };
  }
  if (activeFromMs !== null && now < activeFromMs) {
    return {
      statusLabel: `Scheduled to activate ${formatDateTimeShort(u.activeFrom)}`,
      statusClass: 'text-amber-700 font-semibold',
      scheduleSummary,
    };
  }
  if (activeUntilMs !== null && now > activeUntilMs) {
    return {
      statusLabel: `Access expired ${formatDateTimeShort(u.activeUntil)}`,
      statusClass: 'text-red-700 font-semibold',
      scheduleSummary,
    };
  }
  if (activeUntilMs !== null) {
    return {
      statusLabel: `Active until ${formatDateTimeShort(u.activeUntil)}`,
      statusClass: 'text-emerald-700 font-medium',
      scheduleSummary,
    };
  }
  return {
    statusLabel: 'Approved / Active',
    statusClass: 'text-emerald-700 font-medium',
    scheduleSummary,
  };
}

interface UsersViewProps {
  currentUser: SafeUser;
  users: UserWithStats[];
  onRefresh: () => Promise<void>;
  externalOpenCreate?: boolean;
  onConsumeExternalCreate?: () => void;
}

export function UsersView({
  currentUser,
  users,
  onRefresh,
  externalOpenCreate,
  onConsumeExternalCreate,
}: UsersViewProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<UserWithStats | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [department, setDepartment] = useState('');
  const [email, setEmail] = useState('');
  const [mobile, setMobile] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [password, setPassword] = useState('');

  // Delete inline confirmation
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  // Schedule active / deactivation period modal
  const [scheduleUser, setScheduleUser] = useState<UserWithStats | null>(null);
  const [schedActiveFrom, setSchedActiveFrom] = useState('');
  const [schedActiveUntil, setSchedActiveUntil] = useState('');
  const [schedDeactFrom, setSchedDeactFrom] = useState('');
  const [schedDeactUntil, setSchedDeactUntil] = useState('');
  const [schedError, setSchedError] = useState<string | null>(null);
  const [schedSaving, setSchedSaving] = useState(false);

  React.useEffect(() => {
    if (externalOpenCreate) {
      openCreate();
      onConsumeExternalCreate?.();
    }
  }, [externalOpenCreate]);

  const openCreate = () => {
    setEditingUser(null);
    setFullName('');
    setUsername('');
    setDepartment('');
    setEmail('');
    setMobile('');
    setRole('user');
    setPassword('');
    setFormError(null);
    setModalOpen(true);
  };

  const openEdit = (target: UserWithStats) => {
    setEditingUser(target);
    setFullName(target.fullName);
    setUsername(target.username);
    setDepartment(target.department);
    setEmail(target.email || '');
    setMobile(target.mobile || '');
    setRole(target.role);
    setPassword('');
    setFormError(null);
    setModalOpen(true);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);
    setSubmitting(true);
    try {
      if (editingUser) {
        await api.updateUser(editingUser.id, {
          fullName: fullName.trim(),
          department: department.trim() || 'Operations',
          email: email.trim(),
          mobile: mobile.trim(),
          ...(password.trim().length >= 6 ? { password: password.trim() } : {}),
        });
        setFeedback(`Updated OTP contact and profile details for ${fullName.trim()}.`);
      } else {
        await api.createUser({
          fullName: fullName.trim(),
          username: username.trim().toLowerCase(),
          department: department.trim() || 'Operations',
          email: email.trim(),
          mobile: mobile.trim(),
          role,
          password,
        });
        setFeedback(`Created ${role} account @${username.trim().toLowerCase()}.`);
      }
      await onRefresh();
      setModalOpen(false);
    } catch (err) {
      setFormError(
        err instanceof Error
          ? err.message
          : editingUser
            ? 'Unable to update user.'
            : 'Unable to create user.'
      );
    } finally {
      setSubmitting(false);
    }
  };

  const toggleActive = async (target: UserWithStats) => {
    try {
      const nextActive = !target.active;
      await api.updateUser(target.id, { active: nextActive });
      setFeedback(
        nextActive
          ? `Approved ${target.fullName}'s account. They can now sign in.`
          : `${target.fullName}'s account has been suspended.`
      );
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to update user status.');
    }
  };

  const toggleRole = async (target: UserWithStats) => {
    const nextRole: UserRole = target.role === 'admin' ? 'user' : 'admin';
    try {
      await api.updateUser(target.id, { role: nextRole });
      setFeedback(`Updated ${target.fullName}'s access level to ${nextRole}.`);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to update user role.');
    }
  };

  const handleDeleteUser = async (target: UserWithStats) => {
    setDeletingId(target.id);
    try {
      await api.deleteUser(target.id);
      setConfirmDeleteId(null);
      setFeedback(`Deleted account for ${target.fullName} (@${target.username}).`);
      await onRefresh();
    } catch (err) {
      setFeedback(err instanceof Error ? err.message : 'Unable to delete user account.');
    } finally {
      setDeletingId(null);
    }
  };

  const openScheduleModal = (target: UserWithStats) => {
    setScheduleUser(target);
    setSchedActiveFrom(toLocalDateTimeInput(target.activeFrom));
    setSchedActiveUntil(toLocalDateTimeInput(target.activeUntil));
    setSchedDeactFrom(toLocalDateTimeInput(target.deactivatedFrom));
    setSchedDeactUntil(toLocalDateTimeInput(target.deactivatedUntil));
    setSchedError(null);
  };

  const applyActivePreset = (hours: number) => {
    const now = new Date();
    const until = new Date(now.getTime() + hours * 3600 * 1000);
    setSchedActiveFrom(toLocalDateTimeInput(now.toISOString()));
    setSchedActiveUntil(toLocalDateTimeInput(until.toISOString()));
    setSchedDeactFrom('');
    setSchedDeactUntil('');
    setSchedError(null);
  };

  const applyDeactivatePreset = (hours: number) => {
    const now = new Date();
    const until = new Date(now.getTime() + hours * 3600 * 1000);
    setSchedDeactFrom(toLocalDateTimeInput(now.toISOString()));
    setSchedDeactUntil(toLocalDateTimeInput(until.toISOString()));
    setSchedError(null);
  };

  const handleSaveSchedule = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!scheduleUser) return;
    setSchedError(null);
    const activeFromIso = fromLocalDateTimeInput(schedActiveFrom);
    const activeUntilIso = fromLocalDateTimeInput(schedActiveUntil);
    const deactFromIso = fromLocalDateTimeInput(schedDeactFrom);
    const deactUntilIso = fromLocalDateTimeInput(schedDeactUntil);

    if (activeFromIso && activeUntilIso && new Date(activeUntilIso) <= new Date(activeFromIso)) {
      setSchedError('Active "Until" time must be after the "From" time.');
      return;
    }
    if (deactFromIso && deactUntilIso && new Date(deactUntilIso) <= new Date(deactFromIso)) {
      setSchedError('Deactivation "Until" time must be after the "From" time.');
      return;
    }

    setSchedSaving(true);
    try {
      await api.updateUser(scheduleUser.id, {
        active: true,
        activeFrom: activeFromIso,
        activeUntil: activeUntilIso,
        deactivatedFrom: deactFromIso,
        deactivatedUntil: deactUntilIso,
      });
      setFeedback(`Updated access schedule for ${scheduleUser.fullName}.`);
      setScheduleUser(null);
      await onRefresh();
    } catch (err) {
      setSchedError(err instanceof Error ? err.message : 'Unable to save access schedule.');
    } finally {
      setSchedSaving(false);
    }
  };

  const handleClearSchedules = async () => {
    if (!scheduleUser) return;
    setSchedSaving(true);
    setSchedError(null);
    try {
      await api.updateUser(scheduleUser.id, {
        active: true,
        activeFrom: null,
        activeUntil: null,
        deactivatedFrom: null,
        deactivatedUntil: null,
      });
      setFeedback(`Cleared time-bound schedules for ${scheduleUser.fullName}. Account is active.`);
      setScheduleUser(null);
      await onRefresh();
    } catch (err) {
      setSchedError(err instanceof Error ? err.message : 'Unable to clear schedule.');
    } finally {
      setSchedSaving(false);
    }
  };

  const pendingCount = users.filter((u) => !u.active).length;
  const sortedUsers = [...users].sort((a, b) => Number(a.active) - Number(b.active));

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

      {pendingCount > 0 && (
        <div className="px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900">
          <span className="font-semibold">
            {pendingCount} {pendingCount === 1 ? 'account is' : 'accounts are'} awaiting approval.
          </span>{' '}
          New user accounts cannot sign in until you click <span className="font-semibold">Approve Account</span> below.
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-sm text-slate-600">
            Approve new user accounts, manage registered OTP mobile/email contacts, and set panel permissions.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="min-h-[42px] px-4 rounded-xl bg-teal-700 hover:bg-teal-800 text-white text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>Add Account</span>
        </button>
      </div>

      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden divide-y divide-slate-100">
        {sortedUsers.map((u) => {
          const isSelf = u.id === currentUser.id;
          const accessInfo = describeAccessWindow(u);
          const isConfirmingDelete = confirmDeleteId === u.id;
          return (
            <div
              key={u.id}
              className={`p-5 flex flex-col lg:flex-row lg:items-center justify-between gap-4 transition-colors ${
                u.active ? 'hover:bg-slate-50/60' : 'bg-amber-50/40 hover:bg-amber-50/70'
              }`}
            >
              <div className="flex items-start gap-3.5 min-w-0">
                <Avatar name={u.fullName} src={u.avatarUrl} size="lg" />
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {u.fullName}
                    {isSelf && (
                      <span className="ml-2 text-xs font-normal text-slate-400">(You)</span>
                    )}
                  </p>
                  <p className="text-xs text-slate-500 mt-0.5 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="font-mono">@{u.username}</span>
                    <span aria-hidden="true">·</span>
                    <span className={u.role === 'admin' ? 'text-teal-800 font-medium' : ''}>
                      {u.role === 'admin' ? 'Administrator' : 'Standard User'}
                    </span>
                    <span aria-hidden="true">·</span>
                    <span className={accessInfo.statusClass}>{accessInfo.statusLabel}</span>
                  </p>
                  {accessInfo.scheduleSummary && (
                    <p className="text-[11px] font-mono text-slate-500 mt-1">
                      {accessInfo.scheduleSummary}
                    </p>
                  )}
                  <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-1.5 text-xs text-slate-500">
                    <span className="inline-flex items-center gap-1.5 min-w-0">
                      <Mail className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="truncate">{u.email || 'No email set'}</span>
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Phone className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                      <span className="font-mono">{u.mobile || 'No mobile set'}</span>
                    </span>
                  </div>
                </div>
              </div>

              <div className="flex flex-wrap items-center justify-between lg:justify-end gap-4 shrink-0">
                <div className="grid grid-cols-2 gap-5 text-left sm:text-right">
                  <div>
                    <p className="text-xs text-slate-400">Net Spent</p>
                    <p className="font-mono tabular-nums text-sm font-semibold text-slate-900 mt-0.5">
                      {formatCurrency(u.spentTotal, true)}
                    </p>
                  </div>
                  <div>
                    <p className="text-xs text-slate-400">Entries</p>
                    <p className="font-mono tabular-nums text-sm font-medium text-slate-700 mt-0.5">
                      {u.transactionCount}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={() => openEdit(u)}
                    className="min-h-[38px] px-3 rounded-xl border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                    <span>Edit OTP Info</span>
                  </button>

                  {!isSelf && (
                    <>
                      <button
                        type="button"
                        onClick={() => openScheduleModal(u)}
                        className="min-h-[38px] px-3 rounded-xl border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <CalendarClock className="w-3.5 h-3.5 text-teal-700" />
                        <span>Schedule Access</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleRole(u)}
                        className="min-h-[38px] px-3 rounded-xl border border-slate-200 hover:bg-slate-100 text-xs font-medium text-slate-700 inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer"
                      >
                        <Shield className="w-3.5 h-3.5" />
                        <span>{u.role === 'admin' ? 'Set User' : 'Make Admin'}</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => toggleActive(u)}
                        className={`min-h-[38px] px-3 rounded-xl border text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap cursor-pointer ${
                          u.active
                            ? 'border-slate-200 text-slate-700 hover:text-red-700 hover:bg-red-50'
                            : 'border-emerald-700 text-white bg-emerald-700 hover:bg-emerald-800'
                        }`}
                      >
                        {u.active ? (
                          <>
                            <UserX className="w-3.5 h-3.5" />
                            <span>Deactivate</span>
                          </>
                        ) : (
                          <>
                            <UserCheck className="w-3.5 h-3.5" />
                            <span>Approve / Activate</span>
                          </>
                        )}
                      </button>

                      {isConfirmingDelete ? (
                        <div className="inline-flex items-center gap-1.5 bg-red-50 border border-red-200 rounded-xl px-2 py-1">
                          <button
                            type="button"
                            disabled={deletingId === u.id}
                            onClick={() => handleDeleteUser(u)}
                            className="min-h-[30px] px-2.5 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-60 text-white text-xs font-semibold cursor-pointer whitespace-nowrap"
                          >
                            {deletingId === u.id ? 'Deleting...' : 'Confirm Delete'}
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="min-h-[30px] px-2 rounded-lg text-xs font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDeleteId(u.id)}
                          aria-label={`Delete ${u.fullName}`}
                          title="Delete user account"
                          className="min-w-[38px] min-h-[38px] px-2.5 rounded-xl border border-slate-200 text-slate-500 hover:text-red-700 hover:border-red-200 hover:bg-red-50 inline-flex items-center justify-center gap-1 text-xs font-medium cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                          <span>Delete</span>
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Add / Edit User Modal */}
      <BottomSheetModal
        open={modalOpen}
        onClose={() => setModalOpen(false)}
        title={editingUser ? `Edit Account · @${editingUser.username}` : 'Provision User Account'}
        subtitle={
          editingUser
            ? 'Update registered mobile number, email address, and profile details used for login OTP.'
            : 'Set username, password, registered mobile/email for OTP, and role for a new portal member.'
        }
      >
        <form onSubmit={handleSubmit} className="space-y-4">
          {formError && (
            <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {formError}
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Full Name</label>
              <input
                type="text"
                required
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="Rajesh Sharma"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Username</label>
              <input
                type="text"
                required
                disabled={Boolean(editingUser)}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="rajesh.sharma"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono text-sm text-slate-900 disabled:bg-slate-50 disabled:text-slate-500 focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Registered Email (OTP)
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="user@department.gov.in"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">
                Registered Mobile (OTP)
              </label>
              <input
                type="tel"
                required
                value={mobile}
                onChange={(e) => setMobile(e.target.value)}
                placeholder="+91 98765 43210"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 font-mono text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-slate-700 mb-1.5">Department</label>
              <input
                type="text"
                value={department}
                onChange={(e) => setDepartment(e.target.value)}
                placeholder="Procurement"
                className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
              />
            </div>
            {!editingUser && (
              <div>
                <label className="block text-xs font-medium text-slate-700 mb-1.5">Access Role</label>
                <select
                  value={role}
                  onChange={(e) => setRole(e.target.value as UserRole)}
                  className="w-full h-11 px-3 rounded-xl border border-slate-200 bg-white text-sm text-slate-900 focus:outline-none focus:border-teal-700"
                >
                  <option value="user">Standard User (User Panel)</option>
                  <option value="admin">Administrator (Admin Panel)</option>
                </select>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-slate-700 mb-1.5">
              {editingUser ? 'Reset Password (optional)' : 'Initial Password'}
            </label>
            <input
              type="password"
              required={!editingUser}
              minLength={editingUser ? undefined : 6}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={editingUser ? 'Leave blank to keep existing password' : 'Minimum 6 characters'}
              className="w-full h-11 px-3.5 rounded-xl border border-slate-200 text-sm text-slate-900 focus:outline-none focus:border-teal-700"
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
                ? editingUser
                  ? 'Saving...'
                  : 'Creating...'
                : editingUser
                  ? 'Save Changes'
                  : 'Create Account'}
            </button>
          </div>
        </form>
      </BottomSheetModal>

      {/* Time-Bound Active / Deactivation Schedule Modal */}
      <BottomSheetModal
        open={Boolean(scheduleUser)}
        onClose={() => setScheduleUser(null)}
        title={scheduleUser ? `Schedule Access · ${scheduleUser.fullName}` : 'Schedule Access'}
        subtitle="Activate or temporarily deactivate this account for a specific date & time period."
      >
        <form onSubmit={handleSaveSchedule} className="space-y-5">
          {schedError && (
            <div className="px-3.5 py-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700">
              {schedError}
            </div>
          )}

          {/* Active Window */}
          <div className="p-4 rounded-xl border border-emerald-200 bg-emerald-50/40 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-emerald-950">
                Active Time Period (Optional)
              </p>
              {(schedActiveFrom || schedActiveUntil) && (
                <button
                  type="button"
                  onClick={() => {
                    setSchedActiveFrom('');
                    setSchedActiveUntil('');
                  }}
                  className="text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-600">
              When set, the user can sign in only during this time window.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'Active 1 hr', hrs: 1 },
                { label: 'Active 24 hrs', hrs: 24 },
                { label: 'Active 7 days', hrs: 24 * 7 },
                { label: 'Active 30 days', hrs: 24 * 30 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyActivePreset(p.hrs)}
                  className="px-2.5 py-1.5 rounded-lg bg-white border border-emerald-200 hover:border-emerald-500 text-[11px] font-medium text-emerald-900 cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Active From
                </label>
                <input
                  type="datetime-local"
                  value={schedActiveFrom}
                  onChange={(e) => setSchedActiveFrom(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white font-mono text-xs text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Active Until
                </label>
                <input
                  type="datetime-local"
                  value={schedActiveUntil}
                  onChange={(e) => setSchedActiveUntil(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white font-mono text-xs text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>
          </div>

          {/* Temporary Deactivation Window */}
          <div className="p-4 rounded-xl border border-red-200 bg-red-50/40 space-y-3">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-semibold text-red-950">
                Temporary Deactivation Period (Optional)
              </p>
              {(schedDeactFrom || schedDeactUntil) && (
                <button
                  type="button"
                  onClick={() => {
                    setSchedDeactFrom('');
                    setSchedDeactUntil('');
                  }}
                  className="text-[11px] font-medium text-slate-600 hover:text-slate-900 cursor-pointer"
                >
                  Clear
                </button>
              )}
            </div>
            <p className="text-[11px] text-slate-600">
              Account will be automatically blocked during this period and restored afterward.
            </p>
            <div className="flex flex-wrap gap-1.5">
              {[
                { label: 'Deactivate 1 hr', hrs: 1 },
                { label: 'Deactivate 24 hrs', hrs: 24 },
                { label: 'Deactivate 7 days', hrs: 24 * 7 },
              ].map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => applyDeactivatePreset(p.hrs)}
                  className="px-2.5 py-1.5 rounded-lg bg-white border border-red-200 hover:border-red-500 text-[11px] font-medium text-red-900 cursor-pointer"
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Deactivate From
                </label>
                <input
                  type="datetime-local"
                  value={schedDeactFrom}
                  onChange={(e) => setSchedDeactFrom(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white font-mono text-xs text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
              <div>
                <label className="block text-[11px] font-medium text-slate-700 mb-1">
                  Deactivate Until
                </label>
                <input
                  type="datetime-local"
                  value={schedDeactUntil}
                  onChange={(e) => setSchedDeactUntil(e.target.value)}
                  className="w-full h-10 px-3 rounded-xl border border-slate-200 bg-white font-mono text-xs text-slate-900 focus:outline-none focus:border-teal-700"
                />
              </div>
            </div>
          </div>

          <div className="pt-2 flex flex-wrap items-center justify-between gap-2.5">
            <button
              type="button"
              disabled={schedSaving}
              onClick={handleClearSchedules}
              className="min-h-[42px] px-3.5 rounded-xl border border-slate-200 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Clear All Schedules
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setScheduleUser(null)}
                className="min-h-[42px] px-4 rounded-xl border border-slate-200 text-sm font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={schedSaving}
                className="min-h-[42px] px-5 rounded-xl bg-teal-700 hover:bg-teal-800 disabled:opacity-60 text-white text-sm font-semibold cursor-pointer"
              >
                {schedSaving ? 'Saving...' : 'Save Schedule'}
              </button>
            </div>
          </div>
        </form>
      </BottomSheetModal>
    </div>
  );
}
