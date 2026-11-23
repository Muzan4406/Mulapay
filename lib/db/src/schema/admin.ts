import { pgTable, text, boolean, integer, jsonb, timestamp, primaryKey, uniqueIndex } from "drizzle-orm/pg-core";

export const adminConfiguration = pgTable("mulapay_admin_configuration", {
  id: text("id").primaryKey(),
  config: jsonb("config").$type<Record<string, unknown>>().notNull().default({}),
  telegramEncrypted: text("telegram_encrypted"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const adminAudit = pgTable("mulapay_admin_audit", {
  id: text("id").primaryKey(),
  actorId: text("actor_id").notNull(),
  action: text("action").notNull(),
  targetId: text("target_id"),
  reason: text("reason"),
  details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
  idempotencyKey: text("idempotency_key"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [uniqueIndex("mulapay_admin_audit_idempotency_key_unique").on(t.idempotencyKey)]);
export const adminProviders = pgTable("mulapay_admin_providers", {
  id: text("id").primaryKey(), enabled: boolean("enabled").notNull().default(true),
});
export const blacklistedPhones = pgTable("mulapay_blacklisted_phones", {
  id: text("id").primaryKey(), phone: text("phone").notNull().unique(),
  name: text("name").notNull().default(""),
  reason: text("reason").notNull(), actorId: text("actor_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const adminAnnouncements = pgTable("mulapay_admin_announcements", {
  id: text("id").primaryKey(), title: text("title").notNull(), body: text("body").notNull(),
  actorId: text("actor_id").notNull(), deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const announcementDismissals = pgTable("mulapay_announcement_dismissals", {
  userId: text("user_id").notNull(), announcementId: text("announcement_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [primaryKey({ columns: [t.userId, t.announcementId] })]);
export const merchantMessages = pgTable("mulapay_merchant_messages", {
  id: text("id").primaryKey(), actorId: text("actor_id").notNull(), recipient: text("recipient").notNull(),
  subject: text("subject").notNull(), body: text("body").notNull(), status: text("status").notNull(),
  error: text("error"), providerId: text("provider_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  sentAt: timestamp("sent_at", { withTimezone: true }),
});
export const apiUsage = pgTable("mulapay_api_usage", {
  id: text("id").primaryKey(), keyId: text("key_id").notNull(), method: text("method").notNull(),
  path: text("path").notNull(), status: integer("status").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const merchantIntegrations = pgTable("mulapay_merchant_integrations", {
  id: text("id").primaryKey(), userId: text("user_id").notNull(), name: text("name").notNull(), url: text("url").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const routeReservations = pgTable("mulapay_route_reservations", {
  id: text("id").primaryKey(), routeId: text("route_id").notNull(), day: text("day").notNull(), userId: text("user_id").notNull(),
  amount: integer("amount").notNull(), requestKey: text("request_key").notNull().unique(),
  state: text("state").notNull().default("RESERVED"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});
export const telegramDeliveries = pgTable("mulapay_telegram_deliveries", {
  notificationId: text("notification_id").primaryKey(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }).notNull().defaultNow(),
});
