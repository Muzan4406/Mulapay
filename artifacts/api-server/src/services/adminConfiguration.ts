import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, eq, gte, inArray, ne, sql } from "drizzle-orm";
import { adminConfiguration, adminProviders, blacklistedPhones, db, paymentProviderRoutes, platformSettings, routeReservations, users } from "@workspace/db";
import type { AdminConfiguration } from "@workspace/api-zod";

export class OperationalError extends Error {
  constructor(message: string, public status = 403) { super(message); }
}
export const COUNTRIES = [
  { country: "Togo", code: "TG" }, { country: "Bénin", code: "BJ" }, { country: "Côte d’Ivoire", code: "CI" },
  { country: "Burkina Faso", code: "BF" }, { country: "Sénégal", code: "SN" }, { country: "Mali", code: "ML" }, { country: "Niger", code: "NE" },
];
export async function getAdminConfiguration(): Promise<Required<AdminConfiguration>> {
  const [record, fee] = await Promise.all([
    db.query.adminConfiguration.findFirst({ where: eq(adminConfiguration.id, "global") }),
    db.query.platformSettings.findFirst({ where: eq(platformSettings.id, "global") }),
  ]);
  const defaults: Required<AdminConfiguration> = {
    payinFee: Number(fee?.feePercentage ?? 1), payoutFee: Number(fee?.feePercentage ?? 1),
    depositMin: 300, depositMax: 500_000, withdrawalMin: 300, withdrawalMax: 10_000_000,
    maintenance: false, maintenanceMessage: "Les services Mulapay sont temporairement en maintenance.",
    payinMaintenance: false, payoutMaintenance: false, linksMaintenance: false, apiMaintenance: false,
    supportEmail: "", supportWhatsapp: "", statsSince: null,
  };
  const stored = record?.config ?? {};
  return Object.fromEntries(Object.entries(defaults).map(([k, value]) => [k, stored[k] ?? value])) as Required<AdminConfiguration>;
}
export async function saveAdminConfiguration(config: Required<AdminConfiguration>) {
  await db.insert(adminConfiguration).values({ id: "global", config }).onConflictDoUpdate({
    target: adminConfiguration.id, set: { config, updatedAt: new Date() },
  });
}
export function normalizePhone(phone: string) {
  const compact = phone.replace(/[\s().-]/g, "").replace(/^00/, "+");
  if (!/^\+[1-9]\d{7,14}$/.test(compact)) throw new OperationalError("Utilisez un numéro international complet, par exemple +22890000000.", 400);
  return compact;
}
export function profilePhone(phone: string, country: string) {
  const prefixes: Record<string, string> = { Togo: "228", "Bénin": "229", "Côte d’Ivoire": "225", "Côte d'Ivoire": "225", "Burkina Faso": "226", "Sénégal": "221", Mali: "223", Niger: "227" };
  const raw = phone.replace(/[\s().-]/g, "");
  return raw.startsWith("+") || raw.startsWith("00") ? normalizePhone(raw) : normalizePhone(`+${prefixes[country] ?? ""}${raw}`);
}
export async function assertMerchantAccess(userId: string, service?: "payin" | "payout" | "links" | "api" | "exchange", amount?: number) {
  const [user, config] = await Promise.all([
    db.query.users.findFirst({ where: eq(users.id, userId) }), getAdminConfiguration(),
  ]);
  if (user && user.status !== "ACTIVE") throw new OperationalError("Ce compte est suspendu ou fermé.");
  if (user?.phone) {
    // Legacy local profile phone numbers are resolved using their stored country.
    const phone = profilePhone(user.phone, user.country);
    if (await db.query.blacklistedPhones.findFirst({ where: eq(blacklistedPhones.phone, phone) })) throw new OperationalError("Ce numéro est bloqué sur Mulapay.");
  }
  const admin = user?.role === "ADMIN" || user?.role === "SUPER_ADMIN";
  if (config.maintenance && (!admin || service)) throw new OperationalError(config.maintenanceMessage, 503);
  if (service && service !== "exchange" && config[`${service}Maintenance`]) throw new OperationalError(config.maintenanceMessage, 503);
  if (service === "payin" && user?.payinEnabled === false) throw new OperationalError("Les dépôts sont désactivés pour ce compte.");
  if (service === "payout" && user?.payoutEnabled === false) throw new OperationalError("Les retraits sont désactivés pour ce compte.");
  if (amount !== undefined && (service === "payin" || service === "payout")) {
    const min = service === "payin" ? config.depositMin : config.withdrawalMin;
    const max = service === "payin" ? config.depositMax : config.withdrawalMax;
    if (!Number.isSafeInteger(amount) || amount < min || amount > max) throw new OperationalError(`Le montant doit être compris entre ${min} et ${max} FCFA.`, 400);
  }
  return user;
}
export async function merchantFee(userId: string, kind: "payin" | "payout") {
  const [user, config] = await Promise.all([db.query.users.findFirst({ where: eq(users.id, userId) }), getAdminConfiguration()]);
  return Number((kind === "payin" ? user?.payinFee : user?.payoutFee) ?? config[`${kind}Fee`]);
}
function encryptionKey() {
  const value = process.env.ADMIN_ENCRYPTION_KEY;
  if (!value || value.length < 32) throw new OperationalError("Configurez ADMIN_ENCRYPTION_KEY avec au moins 32 caractères avant de sauvegarder Telegram.", 503);
  return createHash("sha256").update(value).digest();
}
export function encryptAdminSecret(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return ["v1", iv.toString("hex"), cipher.getAuthTag().toString("hex"), data.toString("hex")].join(":");
}
export function decryptAdminSecret(value: string) {
  const [version, iv, tag, data] = value.split(":");
  if (version !== "v1" || !iv || !tag || !data) throw new OperationalError("La configuration chiffrée doit être enregistrée à nouveau.", 503);
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(iv, "hex"));
  decipher.setAuthTag(Buffer.from(tag, "hex"));
  return decipher.update(data, "hex", "utf8") + decipher.final("utf8");
}
export async function getTelegramConfiguration(): Promise<{ token: string; chatId: string; activatedAt?: string } | null> {
  const stored = await db.query.adminConfiguration.findFirst({ where: eq(adminConfiguration.id, "global") });
  if (stored?.telegramEncrypted) return JSON.parse(decryptAdminSecret(stored.telegramEncrypted));
  return process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_CHAT_ID
    ? { token: process.env.TELEGRAM_BOT_TOKEN, chatId: process.env.TELEGRAM_CHAT_ID } : null;
}
export async function assertProviderEnabled(id: string) {
  const provider = await db.query.adminProviders.findFirst({ where: eq(adminProviders.id, id) });
  if (provider?.enabled === false) throw new OperationalError("Cet agrégateur est temporairement désactivé.", 503);
}
// A reservation remains counted until the provider has definitively failed.
// Never release an uncertain request: the provider may still settle it.
type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export async function reserveRoute(routeId: string, userId: string, amount: number, requestKey: string, onReserved?: (tx: DbTransaction) => Promise<void>) {
  return db.transaction(async tx => {
    const [route] = await tx.select().from(paymentProviderRoutes).where(eq(paymentProviderRoutes.id, routeId)).for("update");
    if (!route?.enabled) throw new OperationalError("Cet opérateur est désactivé.", 503);
    await assertProviderEnabled(route.provider);
    const existing = await tx.query.routeReservations.findFirst({ where: eq(routeReservations.requestKey, requestKey) });
    if (existing) {
      if (existing.routeId !== routeId || existing.userId !== userId || existing.amount !== amount) throw new OperationalError("Clé d’idempotence déjà utilisée pour une autre opération.", 409);
      if (existing.state !== "RELEASED") throw new OperationalError("Cette opération a déjà été soumise. Consultez son statut avant de réessayer.", 409);
    }
    const day = new Date().toISOString().slice(0, 10); // Africa/Lome = UTC
    const [usage] = await tx.select({ used: sql<number>`coalesce(sum(${routeReservations.amount}),0)::int` }).from(routeReservations)
      .where(and(eq(routeReservations.routeId, routeId), eq(routeReservations.day, day), ne(routeReservations.state, "RELEASED")));
    if (route.dailyLimit !== null && Number(usage.used) + amount > route.dailyLimit) throw new OperationalError("Le plafond journalier de cet opérateur est atteint.", 409);
    if (existing) await tx.update(routeReservations).set({ state: "RESERVED", day }).where(eq(routeReservations.id, existing.id));
    else await tx.insert(routeReservations).values({ id: crypto.randomUUID(), routeId, userId, amount, requestKey, day });
    if (onReserved) await onReserved(tx);
  });
}
export async function finishRouteReservation(requestKey: string, state: "COMMITTED" | "RELEASED") {
  await db.update(routeReservations).set({ state }).where(eq(routeReservations.requestKey, requestKey));
}
