import {
  boolean,
  integer,
  jsonb,
  numeric,
  index,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";

export const users = pgTable("mulapay_users", {
  id: text("id").primaryKey(),
  firstName: text("first_name").notNull(),
  lastName: text("last_name").notNull(),
  email: text("email").notNull(),
  role: text("role").notNull().default("USER"),
  country: text("country").notNull().default("Togo"),
  kycStatus: text("kyc_status").notNull().default("NON_VERIFIE"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

export const wallets = pgTable(
  "mulapay_wallets",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    country: text("country").notNull(),
    code: text("code").notNull(),
    currency: text("currency").notNull(),
    balance: integer("balance").notNull().default(0),
    pending: integer("pending").notNull().default(0),
    status: text("status").notNull().default("Active"),
  },
  (table) => [index("mulapay_wallets_user_idx").on(table.userId)],
);

export const transactions = pgTable(
  "mulapay_transactions",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    walletId: text("wallet_id").references(() => wallets.id),
    type: text("type").notNull(),
    status: text("status").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    country: text("country").notNull(),
    counterparty: text("counterparty").notNull(),
    reference: text("reference").notNull().unique(),
    providerOrderId: text("provider_order_id").unique(),
    netAmount: integer("net_amount"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_transactions_user_idx").on(table.userId)],
);

export const exchanges = pgTable(
  "mulapay_exchanges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    source: text("source").notNull(),
    destination: text("destination").notNull(),
    amount: integer("amount").notNull(),
    rate: numeric("rate").notNull(),
    receivedAmount: integer("received_amount").notNull(),
    status: text("status").notNull().default("PENDING_ADMIN"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_exchanges_user_idx").on(table.userId)],
);

export const paymentLinks = pgTable(
  "mulapay_payment_links",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    slug: text("slug").notNull().unique(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    description: text("description").notNull(),
    status: text("status").notNull().default("Active"),
    expiresAt: text("expires_at").notNull(),
    payments: integer("payments").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_payment_links_user_idx").on(table.userId)],
);

export const notifications = pgTable(
  "mulapay_notifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    title: text("title").notNull(),
    body: text("body").notNull(),
    read: boolean("read").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_notifications_user_idx").on(table.userId)],
);

export const kycVerifications = pgTable(
  "mulapay_kyc_verifications",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    country: text("country").notNull(),
    status: text("status").notNull().default("EN_ATTENTE"),
    documents: jsonb("documents").$type<string[]>().notNull(),
    submittedAt: timestamp("submitted_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_kyc_user_idx").on(table.userId)],
);

export const ledgerEntries = pgTable(
  "mulapay_ledger_entries",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    walletId: text("wallet_id").notNull().references(() => wallets.id),
    transactionId: text("transaction_id").references(() => transactions.id),
    entryType: text("entry_type").notNull(),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    description: text("description").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_ledger_user_idx").on(table.userId)],
);

export type MulapayUser = typeof users.$inferSelect;
export type MulapayWallet = typeof wallets.$inferSelect;
export type MulapayTransaction = typeof transactions.$inferSelect;
export type MulapayExchange = typeof exchanges.$inferSelect;
export type MulapayPaymentLink = typeof paymentLinks.$inferSelect;
export type MulapayNotification = typeof notifications.$inferSelect;
export type MulapayKyc = typeof kycVerifications.$inferSelect;