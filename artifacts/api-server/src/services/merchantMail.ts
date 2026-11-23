import { and, eq, sql } from "drizzle-orm";
import { adminAudit, db, merchantMessages, users } from "@workspace/db";
import { createHash } from "node:crypto";
import { OperationalError } from "./adminConfiguration";
import { logger } from "../lib/logger";

export function emailIsConfigured() { return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM); }
export async function queueMerchantMail(actorId: string, input: { purpose: string; recipient: string; subject: string; body: string; idempotencyKey: string }) {
  if (!emailIsConfigured()) throw new OperationalError("Connectez Resend et une adresse MAIL_FROM vérifiée avant l’envoi.", 503);
  const requestKey = `mail:${actorId}:${input.purpose}:${input.idempotencyKey}`;
  const requestHash = createHash("sha256").update(JSON.stringify({ recipient: input.recipient, subject: input.subject, body: input.body })).digest("hex");
  return db.transaction(async tx => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestKey}))`);
    const prior = await tx.query.adminAudit.findFirst({ where: eq(adminAudit.idempotencyKey, requestKey) });
    if (prior) {
      if (prior.details.requestHash !== requestHash) throw new OperationalError("Cette clé correspond à un autre envoi.", 409);
      return Number(prior.details.count);
    }
    const recipients = input.recipient === "ALL"
      ? (await tx.select({ email: users.email }).from(users).where(and(eq(users.status, "ACTIVE"), eq(users.role, "USER")))).map(u => u.email)
      : /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.recipient) ? [input.recipient] : [];
    const unique = [...new Set(recipients)];
    if (!unique.length) throw new OperationalError("Aucun destinataire valide.", 400);
    for (let start = 0; start < unique.length; start += 100) await tx.insert(merchantMessages).values(unique.slice(start, start + 100).map(recipient => ({
      id: crypto.randomUUID(), actorId, recipient, subject: input.subject, body: input.body, status: "QUEUED",
    })));
    await tx.insert(adminAudit).values({ id: crypto.randomUUID(), actorId, action: input.purpose, idempotencyKey: requestKey, details: { requestHash, count: unique.length } });
    return unique.length;
  });
}
export async function sendMerchantMail(message: typeof merchantMessages.$inferSelect) {
  if (!emailIsConfigured()) throw new OperationalError("L’envoi d’e-mails nécessite la connexion de Resend et une adresse MAIL_FROM vérifiée.", 503);
  const claimed = await db.update(merchantMessages).set({ status: "SENDING" })
    .where(and(eq(merchantMessages.id, message.id), eq(merchantMessages.status, "QUEUED"))).returning({ id: merchantMessages.id });
  if (!claimed.length) return;
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST", headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json", "Idempotency-Key": message.id },
      body: JSON.stringify({ from: process.env.MAIL_FROM, to: [message.recipient], subject: message.subject, text: message.body }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Le fournisseur a refusé le message (${response.status}).`);
    const result = await response.json() as { id?: string };
    await db.update(merchantMessages).set({ status: "SENT", providerId: result.id ?? null, sentAt: new Date(), error: null }).where(eq(merchantMessages.id, message.id));
  } catch {
    await db.update(merchantMessages).set({ status: "FAILED", error: "Envoi non confirmé par le fournisseur. Aucune relance automatique." }).where(eq(merchantMessages.id, message.id));
    logger.warn({ messageId: message.id }, "Merchant email not confirmed");
  }
}
let running = false;
export function startMerchantMailWorker() {
  const tick = async () => {
    if (running || !emailIsConfigured()) return;
    running = true;
    try {
      const pending = await db.select().from(merchantMessages).where(eq(merchantMessages.status, "QUEUED")).limit(10);
      for (const message of pending) await sendMerchantMail(message);
    } catch { logger.warn("Merchant email queue unavailable"); } finally { running = false; }
  };
  setInterval(() => void tick(), 5000).unref();
}
