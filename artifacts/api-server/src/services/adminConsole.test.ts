import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  adminAnnouncements, adminAudit, adminProviders, announcementDismissals, apiKeys, apiUsage, blacklistedPhones, db, exchanges,
  kycVerifications, ledgerEntries, merchantIntegrations, merchantMessages, notifications, paymentLinks, paymentProviderRoutes,
  pool, routeReservations, transactions, users, wallets,
} from "@workspace/db";
import { GetAdminConsoleResponse, type AdminCommandInput, type GetAdminConsoleParams } from "@workspace/api-zod";
import { executeConsoleCommand } from "./adminCommands";
import { readAdminConsole } from "./adminConsoleRead";
import { assertMerchantAccess, decryptAdminSecret, encryptAdminSecret, merchantFee, normalizePhone, profilePhone, reserveRoute } from "./adminConfiguration";
import { decideExchange, decideKyc } from "./adminDecisions";

// Dedicated synthetic records only; these tests never call a payment or email provider.
const prefix = `admin-test-${crypto.randomUUID()}`;
const actorId = `${prefix}-actor`, userId = `${prefix}-user`, walletId = `${prefix}-tg`, secondWalletId = `${prefix}-bj`;
let actor: typeof users.$inferSelect;
let merchant: typeof users.$inferSelect;
const command = (input: AdminCommandInput) => executeConsoleCommand(actor, input, "https://example.invalid");
before(async () => {
  [actor, merchant] = await db.insert(users).values([
    { id: actorId, firstName: "Test", lastName: "Admin", email: `${actorId}@example.invalid`, role: "SUPER_ADMIN", country: "Togo", status: "ACTIVE" },
    { id: userId, firstName: "Test", lastName: "Marchand", email: `${userId}@example.invalid`, role: "USER", country: "Togo", status: "ACTIVE" },
  ]).returning();
  await db.insert(wallets).values([
    { id: walletId, userId, country: "Togo", code: "TG", currency: "XOF", status: "Active", balance: 0, pending: 0 },
    { id: secondWalletId, userId, country: "Bénin", code: "BJ", currency: "XOF", status: "Active", balance: 0, pending: 0 },
  ]);
});
after(async () => {
  // Explicit ownership filters make it impossible to clean up another user's records.
  await db.delete(announcementDismissals).where(inArray(announcementDismissals.userId, [actorId, userId]));
  await db.delete(adminAnnouncements).where(eq(adminAnnouncements.actorId, actorId));
  await db.delete(adminAudit).where(eq(adminAudit.actorId, actorId));
  await db.delete(blacklistedPhones).where(eq(blacklistedPhones.actorId, actorId));
  await db.delete(merchantMessages).where(eq(merchantMessages.actorId, actorId));
  await db.delete(paymentProviderRoutes).where(eq(paymentProviderRoutes.operator, `${prefix}-route`));
  await db.delete(notifications).where(inArray(notifications.userId, [actorId, userId]));
  await db.delete(ledgerEntries).where(inArray(ledgerEntries.userId, [actorId, userId]));
  await db.delete(transactions).where(inArray(transactions.userId, [actorId, userId]));
  await db.delete(exchanges).where(eq(exchanges.userId, userId));
  await db.delete(kycVerifications).where(eq(kycVerifications.userId, userId));
  await db.delete(routeReservations).where(eq(routeReservations.userId, userId));
  await db.delete(paymentProviderRoutes).where(like(paymentProviderRoutes.id, `${prefix}%`));
  await db.delete(adminProviders).where(eq(adminProviders.id, prefix));
  await db.delete(wallets).where(inArray(wallets.userId, [actorId, userId]));
  await db.delete(users).where(inArray(users.id, [actorId, userId]));
  await pool.end();
});
test("normalisation internationale et correspondance pays", () => {
  assert.equal(normalizePhone("00228 90 00 00 01"), "+22890000001");
  assert.equal(profilePhone("90 00 00 01", "Togo"), "+22890000001");
  assert.equal(profilePhone("01 90 00 00 01", "Bénin"), "+2290190000001");
  assert.throws(() => normalizePhone("90000001"));
});
test("chiffrement authentifié Telegram, sans restituer le secret dans la configuration", () => {
  const encrypted = encryptAdminSecret("synthetic-telegram-config");
  assert.equal(decryptAdminSecret(encrypted), "synthetic-telegram-config");
  assert.ok(!encrypted.includes("synthetic"));
  assert.throws(() => decryptAdminSecret(encrypted.slice(0, -2) + (encrypted.endsWith("00") ? "11" : "00")));
});
test("toutes les sections exposent des réponses conformes, sans identifiants secrets", async () => {
  const sections: GetAdminConsoleParams["section"][] = ["dashboard", "merchants", "kyc", "transactions", "wallets", "exchanges", "providers", "operators", "api-keys", "payment-links", "blacklist", "messages", "notifications", "settings"];
  for (const section of sections) {
    const output = GetAdminConsoleResponse.parse(await readAdminConsole({ section }));
    assert.equal(output.section, section);
    assert.equal(output.page, 1);
    assert.ok(Array.isArray(output.items));
    if (section === "wallets") assert.ok(output.items.every(row => typeof row.active === "number"));
    const json = JSON.stringify(output);
    assert.ok(!json.includes('"keyHash"') && !json.includes('"telegramEncrypted"') && !json.includes('"telegramToken"'));
  }
});
test("un marchand ne peut pas effectuer un ajustement administratif", async () => {
  await assert.rejects(() => executeConsoleCommand(merchant, { action: "wallet_adjust", walletId, amount: 10, direction: "credit", reason: "Test", idempotencyKey: "denied" }, "https://example.invalid"), /SUPER_ADMIN/);
});
test("un opérateur DrimPay valide peut être préparé en aperçu sans activer de paiement live", async () => {
  const routeOperator = `${prefix}-route`;
  await command({ action: "route_update", countryCode: "TG", country: "Togo", operator: routeOperator, providerOperator: "tmoney", provider: "DRIMPAY", dailyLimit: null });
  const saved = await db.query.paymentProviderRoutes.findFirst({ where: eq(paymentProviderRoutes.operator, routeOperator) });
  assert.ok(saved);
  assert.equal(saved.enabled, false);
  await assert.rejects(
    () => command({ action: "route_update", countryCode: "TG", country: "Togo", operator: routeOperator, providerOperator: "tmoney", provider: "DRIMPAY", enabled: true }),
    /identifiants de cet agrégateur ne sont pas configurés/,
  );
});
test("un crédit rejoué simultanément ne crédite et ne journalise qu’une fois", async () => {
  const input: AdminCommandInput = { action: "wallet_adjust", walletId, amount: 1000, direction: "credit", reason: "Test synthétique idempotent", idempotencyKey: "same-request" };
  await Promise.all([command(input), command(input)]);
  const w = await db.query.wallets.findFirst({ where: eq(wallets.id, walletId) });
  assert.equal(w?.balance, 1000);
  const ledger = await db.select().from(ledgerEntries).where(eq(ledgerEntries.userId, userId));
  assert.equal(ledger.length, 1);
  await assert.rejects(() => command({ ...input, amount: 2000 }), /autre ajustement/);
});
test("deux débits concurrents ne dépassent pas le disponible réservé", async () => {
  await db.update(wallets).set({ pending: 100 }).where(eq(wallets.id, walletId));
  const results = await Promise.allSettled([
    command({ action: "wallet_adjust", walletId, amount: 600, direction: "debit", reason: "Test concurrence A", idempotencyKey: "debit-a" }),
    command({ action: "wallet_adjust", walletId, amount: 600, direction: "debit", reason: "Test concurrence B", idempotencyKey: "debit-b" }),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const w = await db.query.wallets.findFirst({ where: eq(wallets.id, walletId) });
  assert.equal(w?.balance, 400); assert.equal(w?.pending, 100);
});
test("les frais Payin et Payout du marchand sont distincts et peuvent hériter des taux globaux", async () => {
  await command({ action: "merchant_update", targetId: userId, payinFee: 2, payoutFee: 3 });
  assert.equal(await merchantFee(userId, "payin"), 2);
  assert.equal(await merchantFee(userId, "payout"), 3);
  await command({ action: "merchant_update", targetId: userId, payinFee: null, payoutFee: null, payinEnabled: false });
  await assert.rejects(() => assertMerchantAccess(userId, "payin", 1000), /désactivés|maintenance/);
  assert.equal((await db.query.users.findFirst({ where: eq(users.id, userId) }))?.payinEnabled, false);
  await command({ action: "merchant_update", targetId: userId, payinEnabled: true });
});
test("le plafond opérateur reste atomique face aux demandes concurrentes", async () => {
  const routeId = `${prefix}-route`;
  await db.insert(paymentProviderRoutes).values({ id: routeId, countryCode: "ZZ", country: "Test", operator: prefix, providerOperator: prefix, provider: prefix, dailyLimit: 100, enabled: true });
  const results = await Promise.allSettled([
    reserveRoute(routeId, userId, 80, `${prefix}-route-a`),
    reserveRoute(routeId, userId, 80, `${prefix}-route-b`),
  ]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  const reservations = await db.select().from(routeReservations).where(eq(routeReservations.routeId, routeId));
  assert.equal(reservations.length, 1); assert.equal(reservations[0].amount, 80);
});
test("la suspension et la fermeture sont effectives sans supprimer le grand livre", async () => {
  await command({ action: "merchant_suspend", targetId: userId, reason: "Test" });
  await assert.rejects(() => assertMerchantAccess(userId), /suspendu/);
  await command({ action: "merchant_activate", targetId: userId });
  await assertMerchantAccess(userId);
  await assert.rejects(() => command({ action: "merchant_delete", targetId: userId }), /soldes et réservations nuls/);
});
test("KYC reste manuel et un ancien dossier ne peut pas écraser le plus récent", async () => {
  await db.insert(kycVerifications).values([
    { id: `${prefix}-kyc-old`, userId, name: "Test", country: "Togo", status: "EN_ATTENTE", documents: [], details: {}, submittedAt: new Date(Date.now() - 2000) },
    { id: `${prefix}-kyc-new`, userId, name: "Test", country: "Togo", status: "EN_ATTENTE", documents: [], details: {}, submittedAt: new Date() },
  ]);
  await assert.rejects(() => decideKyc(actorId, `${prefix}-kyc-old`, true), /plus récent/);
  await assert.rejects(() => decideKyc(actorId, `${prefix}-kyc-new`, false), /motif/);
  await decideKyc(actorId, `${prefix}-kyc-new`, true);
  const u = await db.query.users.findFirst({ where: eq(users.id, userId) });
  assert.equal(u?.kycStatus, "VERIFIE");
  await assert.rejects(() => decideKyc(actorId, `${prefix}-kyc-new`, true), /déjà été traité/);
});
test("une décision d’échange est comptabilisée une seule fois", async () => {
  await db.update(wallets).set({ balance: 1000, pending: 500 }).where(eq(wallets.id, walletId));
  const id = `${prefix}-exchange`;
  await db.insert(exchanges).values({ id, userId, sourceWalletId: walletId, destinationWalletId: secondWalletId, source: "Togo", destination: "Bénin", amount: 500, rate: "1", receivedAmount: 490, platformFee: 10, status: "PENDING_ADMIN" });
  await decideExchange(actorId, id, true);
  await assert.rejects(() => decideExchange(actorId, id, true), /déjà été traitée/);
  const result = await db.select().from(wallets).where(inArray(wallets.id, [walletId, secondWalletId]));
  assert.equal(result.find(w => w.id === walletId)?.balance, 500);
  assert.equal(result.find(w => w.id === walletId)?.pending, 0);
  assert.equal(result.find(w => w.id === secondWalletId)?.balance, 490);
  const audit = await db.select().from(adminAudit).where(and(eq(adminAudit.targetId, id), eq(adminAudit.action, "exchange_approve")));
  assert.equal(audit.length, 1);
});
