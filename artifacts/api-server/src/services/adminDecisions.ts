import { and, eq, gte, sql } from "drizzle-orm";
import { adminAudit, db, exchanges, kycVerifications, ledgerEntries, notifications, users, wallets } from "@workspace/db";
import { OperationalError } from "./adminConfiguration";

export async function decideKyc(actorId: string, id: string, approve: boolean | "review", reason?: string) {
  if (approve !== true && !reason?.trim()) throw new OperationalError("Indiquez le motif de la décision.", 400);
  await db.transaction(async tx => {
    const [kyc] = await tx.select().from(kycVerifications).where(eq(kycVerifications.id, id)).for("update");
    if (!kyc) throw new OperationalError("Dossier KYC introuvable.", 404);
    if (!["EN_ATTENTE", "A_REVOIR"].includes(kyc.status)) throw new OperationalError("Ce dossier a déjà été traité.", 409);
    const [latest] = await tx.select().from(kycVerifications).where(eq(kycVerifications.userId, kyc.userId)).orderBy(sql`${kycVerifications.submittedAt} desc`).limit(1);
    if (latest?.id !== id) throw new OperationalError("Un dossier plus récent existe pour ce marchand.", 409);
    const status = approve === "review" ? "A_REVOIR" : approve ? "VERIFIE" : "REFUSE";
    await tx.update(kycVerifications).set({ status, details: { ...kyc.details, reviewReason: reason?.trim() ?? "", reviewedBy: actorId } }).where(eq(kycVerifications.id, id));
    await tx.update(users).set({ kycStatus: status }).where(eq(users.id, kyc.userId));
    await tx.insert(notifications).values({ id: crypto.randomUUID(), userId: kyc.userId, title: approve === "review" ? "Informations KYC requises" : approve ? "KYC approuvé" : "KYC refusé", body: reason?.trim() || "Votre dossier a été approuvé après examen manuel." });
    await tx.insert(adminAudit).values({ id: crypto.randomUUID(), actorId, action: approve === "review" ? "kyc_review" : approve ? "kyc_approve" : "kyc_reject", targetId: id, reason });
  });
}
export async function decideExchange(actorId: string, id: string, approve: boolean, reason?: string) {
  if (!approve && !reason?.trim()) throw new OperationalError("Indiquez le motif du rejet.", 400);
  await db.transaction(async tx => {
    const [exchange] = await tx.select().from(exchanges).where(eq(exchanges.id, id)).for("update");
    if (!exchange) throw new OperationalError("Échange introuvable.", 404);
    if (exchange.status !== "PENDING_ADMIN") throw new OperationalError("Cette demande a déjà été traitée.", 409);
    // Stable lock order prevents concurrent exchanges from locking wallets in reverse order.
    const owned = await tx.select().from(wallets).where(eq(wallets.userId, exchange.userId)).orderBy(wallets.id).for("update");
    const source = owned.find(w => exchange.sourceWalletId ? w.id === exchange.sourceWalletId : w.country === exchange.source);
    const destination = owned.find(w => exchange.destinationWalletId ? w.id === exchange.destinationWalletId : w.country === exchange.destination);
    if (!source || !destination || source.id === destination.id || source.currency !== destination.currency) throw new OperationalError("Les wallets de cet échange sont indisponibles.", 409);
    if (source.pending < exchange.amount) throw new OperationalError("La réservation de cet échange est incohérente.", 409);
    if (approve && source.balance < exchange.amount) throw new OperationalError("Solde insuffisant pour régler l’échange.", 409);
    await tx.update(wallets).set({
      pending: source.pending - exchange.amount, balance: source.balance - (approve ? exchange.amount : 0),
    }).where(eq(wallets.id, source.id));
    if (approve) {
      if (destination.balance + exchange.receivedAmount > 2_147_483_647) throw new OperationalError("Le plafond comptable du wallet serait dépassé.", 409);
      await tx.update(wallets).set({ balance: destination.balance + exchange.receivedAmount }).where(eq(wallets.id, destination.id));
      await tx.insert(ledgerEntries).values([
        { id: crypto.randomUUID(), userId: exchange.userId, walletId: source.id, entryType: "DEBIT", amount: exchange.amount, currency: source.currency, description: `Échange ${id} vers ${destination.country}; frais ${exchange.platformFee}` },
        { id: crypto.randomUUID(), userId: exchange.userId, walletId: destination.id, entryType: "CREDIT", amount: exchange.receivedAmount, currency: destination.currency, description: `Échange ${id} depuis ${source.country}` },
      ]);
    }
    await tx.update(exchanges).set({ status: approve ? "COMPLETED" : "REJECTED", decidedAt: new Date(), decidedBy: actorId, decisionReason: reason ?? null }).where(eq(exchanges.id, id));
    await tx.insert(notifications).values({ id: crypto.randomUUID(), userId: exchange.userId, title: approve ? "Échange approuvé" : "Échange refusé", body: reason?.trim() || `Votre échange de ${exchange.amount} ${source.currency} a été traité.` });
    await tx.insert(adminAudit).values({ id: crypto.randomUUID(), actorId, action: approve ? "exchange_approve" : "exchange_reject", targetId: id, reason });
  });
}
