import { relations } from 'drizzle-orm';
import {
  boolean,
  doublePrecision,
  integer,
  pgTable,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';

export const users = pgTable('users', {
  id: text('id').primaryKey(),
  firebaseUid: text('firebase_uid').unique(),
  username: text('username').notNull().unique(),
  fullName: text('full_name').notNull(),
  department: text('department').notNull().default('Operations'),
  email: text('email').notNull().default(''),
  mobile: text('mobile').notNull().default(''),
  role: text('role').notNull().default('user'), // 'admin' | 'user'
  avatarUrl: text('avatar_url'),
  active: boolean('active').notNull().default(true),
  activeFrom: timestamp('active_from'),
  activeUntil: timestamp('active_until'),
  deactivatedFrom: timestamp('deactivated_from'),
  deactivatedUntil: timestamp('deactivated_until'),
  passwordHash: text('password_hash'),
  passwordSalt: text('password_salt'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const otpChallenges = pgTable('otp_challenges', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .references(() => users.id, { onDelete: 'cascade' })
    .notNull(),
  purpose: text('purpose').notNull().default('login'), // 'login' | 'direct-otp'
  codeHash: text('code_hash').notNull(),
  channels: text('channels').notNull().default('email,mobile'),
  maskedEmail: text('masked_email'),
  maskedMobile: text('masked_mobile'),
  deliverySummary: text('delivery_summary'),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  expiresAt: timestamp('expires_at').notNull(),
  consumedAt: timestamp('consumed_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const budgetHeads = pgTable('budget_heads', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  color: text('color').notNull().default('#0F766E'),
  description: text('description').notNull().default(''),
  createdBy: text('created_by')
    .references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

export const budgetSanctions = pgTable('budget_sanctions', {
  id: text('id').primaryKey(),
  budgetHeadId: text('budget_head_id')
    .references(() => budgetHeads.id, { onDelete: 'cascade' })
    .notNull(),
  sanctionAmount: doublePrecision('sanction_amount').notNull(),
  sanctionDate: text('sanction_date').notNull(), // YYYY-MM-DD
  financialYear: text('financial_year').notNull(), // e.g. FY 2026-27
  sanctionOrderNo: text('sanction_order_no').notNull(),
  sanctionedBy: text('sanctioned_by').notNull().default('Technical Director RISL'),
  notes: text('notes').notNull().default(''),
  attachmentJson: text('attachment_json'),
  approvalStatus: text('approval_status').notNull().default('approved'), // 'approved' | 'pending' | 'rejected'
  approvedBy: text('approved_by').references(() => users.id, { onDelete: 'set null' }),
  approvedAt: timestamp('approved_at'),
  createdBy: text('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

export const transactions = pgTable('transactions', {
  id: text('id').primaryKey(),
  budgetHeadId: text('budget_head_id')
    .references(() => budgetHeads.id, { onDelete: 'restrict' })
    .notNull(),
  userId: text('user_id')
    .references(() => users.id, { onDelete: 'set null' }),
  title: text('title').notNull(),
  merchant: text('merchant').notNull(),
  amount: doublePrecision('amount').notNull(),
  type: text('type').notNull().default('expense'), // 'expense' | 'income'
  status: text('status').notNull().default('approved'), // 'approved' | 'pending' | 'flagged'
  paymentMethod: text('payment_method').notNull().default('Cheque'),
  date: text('date').notNull(), // YYYY-MM-DD
  financialYear: text('financial_year').notNull(),
  reference: text('reference').notNull().default(''),
  notes: text('notes').notNull().default(''),
  chequeNumber: text('cheque_number'),
  chequeIssueDate: text('cheque_issue_date'),
  sanctionNumber: text('sanction_number'),
  sanctionDate: text('sanction_date'),
  paymentSanctionedByHod: text('payment_sanctioned_by_hod'),
  chequeAttachmentJson: text('cheque_attachment_json'),
  sanctionAttachmentJson: text('sanction_attachment_json'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// Relations
export const usersRelations = relations(users, ({ many }) => ({
  transactions: many(transactions),
  otpChallenges: many(otpChallenges),
}));

export const budgetHeadsRelations = relations(budgetHeads, ({ many }) => ({
  sanctions: many(budgetSanctions),
  transactions: many(transactions),
}));

export const budgetSanctionsRelations = relations(budgetSanctions, ({ one }) => ({
  budgetHead: one(budgetHeads, {
    fields: [budgetSanctions.budgetHeadId],
    references: [budgetHeads.id],
  }),
}));

export const transactionsRelations = relations(transactions, ({ one }) => ({
  budgetHead: one(budgetHeads, {
    fields: [transactions.budgetHeadId],
    references: [budgetHeads.id],
  }),
  user: one(users, {
    fields: [transactions.userId],
    references: [users.id],
  }),
}));
