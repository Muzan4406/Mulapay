import {
  boolean,
  integer,
  jsonb,
  numeric,
  index,
  unique,
  pgTable,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

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

export const platformSettings = pgTable("mulapay_platform_settings", {
  id: text("id").primaryKey(),
  feePercentage: numeric("fee_percentage", { precision: 5, scale: 2 }).notNull().default("1.00"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

export const apiKeys = pgTable(
  "mulapay_api_keys",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    name: text("name").notNull(),
    keyPrefix: text("key_prefix").notNull(),
    keyHash: text("key_hash").notNull().unique(),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_api_keys_user_idx").on(table.userId)],
);

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
    paymentProvider: text("payment_provider").notNull().default("DRIMPAY"),
    counterparty: text("counterparty").notNull(),
    reference: text("reference").notNull().unique(),
    providerOrderId: text("provider_order_id").unique(),
    providerTransactionId: text("provider_transaction_id"),
    netAmount: integer("net_amount"),
    platformFee: integer("platform_fee"),
    merchantAmount: integer("merchant_amount"),
    paymentUrl: text("payment_url"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    fee: integer("fee"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("mulapay_transactions_user_idx").on(table.userId)],
);

export const paymentProviderRoutes = pgTable(
  "mulapay_payment_provider_routes",
  {
    id: text("id").primaryKey(),
    countryCode: text("country_code").notNull(),
    country: text("country").notNull(),
    operator: text("operator").notNull(),
    providerOperator: text("provider_operator").notNull(),
    provider: text("provider").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("mulapay_provider_route_country_operator_idx").on(table.countryCode, table.operator),
  ],
);

export const paymentProviderWebhookEvents = pgTable(
  "mulapay_payment_provider_webhook_events",
  {
    id: text("id").primaryKey(),
    provider: text("provider").notNull(),
    eventId: text("event_id").notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [unique("mulapay_provider_webhook_event_unique").on(table.provider, table.eventId)],
);

export const exchanges = pgTable(
  "mulapay_exchanges",
  {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id),
    sourceWalletId: text("source_wallet_id").references(() => wallets.id),
    destinationWalletId: text("destination_wallet_id").references(() => wallets.id),
    source: text("source").notNull(),
    destination: text("destination").notNull(),
    amount: integer("amount").notNull(),
    rate: numeric("rate").notNull(),
    receivedAmount: integer("received_amount").notNull(),
    platformFee: integer("platform_fee").notNull().default(0),
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
    reference: text("reference"),
    productName: text("product_name").notNull().default("Paiement"),
    amount: integer("amount").notNull(),
    currency: text("currency").notNull(),
    description: text("description").notNull(),
    walletId: text("wallet_id"),
    amountType: text("amount_type").notNull().default("FIXED"),
    amountMin: integer("amount_min").notNull().default(300),
    amountMax: integer("amount_max").notNull().default(500_000),
    customerFields: jsonb("customer_fields").$type<string[]>().notNull().default(sql`'["full_name","phone","email"]'::jsonb`),
    status: text("status").notNull().default("Active"),
    expiresAt: text("expires_at").notNull(),
    maxPayments: integer("max_payments"),
    afterPaymentAction: text("after_payment_action").notNull().default("CONFIRMATION"),
    redirectUrl: text("redirect_url"),
    notifyApp: boolean("notify_app").notNull().default(true),
    notifyEmail: boolean("notify_email").notNull().default(true),
    notifyWebhook: boolean("notify_webhook").notNull().default(false),
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