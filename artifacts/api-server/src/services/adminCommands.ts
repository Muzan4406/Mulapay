import { createHash } from "node:crypto";
import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  adminAnnouncements, adminAudit, adminConfiguration, adminProviders, apiKeys, blacklistedPhones, db,
  ledgerEntries, merchantIntegrations, merchantMessages, notifications, paymentLinks, paymentProviderRoutes, platformSettings, transactions, users, wallets,
} from "@workspace/db";
import type { AdminCommandInput } from "@workspace/api-zod";
import type { MulapayUser } from "@workspace/db";
import { clerkClient } from "../lib/clerk";
import { COUNTRIES, encryptAdminSecret, getAdminConfiguration, getTelegramConfiguration, normalizePhone, profilePhone, OperationalError } from "./adminConfiguration";
import { emailIsConfigured, queueMerchantMail } from "./merchantMail";
import { decideExchange, decideKyc } from "./adminDecisions";
import { isDrimPayConfigured, isDrimPayRouteSupported, operatorSlugForName } from "./drimpay";
import { isAshtechPayConfigured, isAshtechPayOperatorSupported } from "./ashtechpay";

const text = (v: string | undefined, label: string, max = 200) => {
  if (!v?.trim() || v.trim().length > max) throw new OperationalError(`${label} est obligatoire (maximum ${max} caractères).`, 400);
  return v.trim();
};
const validFee = (v: number | null | undefined) => v === undefined || v === null || Number.isFinite(v) && v >= 0 && v <= 100;
export async function executeConsoleCommand(actor: MulapayUser, input: AdminCommandInput, origin: string) {
  const a = input.action;
  const target = input.targetId;
  const privileged = new Set(["merchant_update", "merchant_suspend", "merchant_activate", "merchant_delete", "wallet_adjust", "provider_update", "route_update", "settings_update", "stats_reset", "telegram_configure", "telegram_test", "blacklist_add", "blacklist_remove", "key_revoke", "link_revoke"]);
  if (privileged.has(a) && actor.role !== "SUPER_ADMIN") throw new OperationalError("Cette action nécessite le rôle SUPER_ADMIN.");
  let message = "Modification enregistrée.";
  let audited = false;
  if (["merchant_update", "merchant_suspend", "merchant_activate", "merchant_delete", "password_reset"].includes(a)) {
    if (!target) throw new OperationalError("Sélectionnez un marchand.", 400);
    const user = await db.query.users.findFirst({ where: eq(users.id, target) });
    if (!user) throw new OperationalError("Compte introuvable.", 404);
    if (a !== "merchant_update" && target === actor.id) throw new OperationalError("Vous ne pouvez pas exécuter cette action sur votre propre compte.");
    if (user.role !== "USER" && actor.role !== "SUPER_ADMIN") throw new OperationalError("Accès réservé au super administrateur.");
    if (user.status === "DELETED") throw new OperationalError("Ce compte est définitivement fermé.", 409);
    if (a === "merchant_update") {
      if (!validFee(input.payinFee) || !validFee(input.payoutFee)) throw new OperationalError("Les taux doivent être compris entre 0 et 100.", 400);
      if (input.country && !COUNTRIES.some(c => c.country === input.country)) throw new OperationalError("Pays non pris en charge.", 400);
      let verifiedEmail = user.email;
      let pendingEmail = false;
      if (input.email && input.email.toLowerCase() !== user.email.toLowerCase()) {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) throw new OperationalError("Adresse e-mail invalide.", 400);
        const account = await clerkClient.users.getUser(user.id);
        const address = account.emailAddresses.find(e => e.emailAddress.toLowerCase() === input.email?.toLowerCase());
        if (address?.verification?.status === "verified") {
          await clerkClient.users.updateUser(user.id, { primaryEmailAddressID: address.id });
          verifiedEmail = address.emailAddress;
        } else {
          if (!address) await clerkClient.emailAddresses.createEmailAddress({ userId: user.id, emailAddress: input.email.toLowerCase(), verified: false, primary: false });
          pendingEmail = true;
        }
      }
      const firstName = input.firstName === undefined ? user.firstName : text(input.firstName, "Prénom", 80);
      const lastName = input.lastName === undefined ? user.lastName : text(input.lastName, "Nom", 80);
      await db.update(users).set({
        firstName, lastName, email: verifiedEmail.toLowerCase(), country: input.country ?? user.country,
        payinEnabled: input.payinEnabled, payoutEnabled: input.payoutEnabled,
        payinFee: input.payinFee === undefined ? undefined : input.payinFee === null ? null : String(input.payinFee),
        payoutFee: input.payoutFee === undefined ? undefined : input.payoutFee === null ? null : String(input.payoutFee),
      }).where(eq(users.id, target));
      if (pendingEmail) {
        await db.insert(notifications).values({ id: crypto.randomUUID(), userId: user.id, title: "Adresse e-mail à vérifier", body: `L’administration a proposé ${input.email}. Votre adresse actuelle reste active. Ouvrez Sécurité > Gérer mes adresses e-mail, vérifiez la nouvelle adresse, définissez-la comme principale, puis synchronisez-la.` });
        message = "Modifications enregistrées. La nouvelle adresse reste en attente : le marchand doit la vérifier et la choisir comme principale dans Sécurité. L’adresse actuelle est conservée jusque-là.";
      }
    } else if (a === "password_reset") {
      if (!emailIsConfigured()) throw new OperationalError("Connectez le service d’e-mail avant d’envoyer une procédure de récupération.", 503);
      await queueMerchantMail(actor.id, { purpose: a, recipient: user.email, subject: "Récupération de votre compte Mulapay", body: `Une récupération de mot de passe a été demandée par l’administration. Ouvrez ${origin}/forgot-password et confirmez votre adresse pour recevoir votre code. Si vous n’êtes pas à l’origine de cette demande, contactez le support.`, idempotencyKey: text(input.idempotencyKey, "Clé d’idempotence", 128) });
      audited = true;
      message = "La procédure sécurisée de récupération a été mise en file d’envoi. Aucun mot de passe n’a été défini par l’administrateur.";
    } else {
      await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mulapay-admin-lifecycle'))`);
        if (user.role === "SUPER_ADMIN" && a !== "merchant_activate") {
          const supers = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "SUPER_ADMIN"), eq(users.status, "ACTIVE")));
          if (supers.length <= 1) throw new OperationalError("Le dernier super administrateur actif ne peut pas être suspendu ou supprimé.");
        }
        if (a === "merchant_delete") {
          const owned = await tx.select().from(wallets).where(eq(wallets.userId, user.id)).for("update");
          if (owned.some(w => w.balance !== 0 || w.pending !== 0)) throw new OperationalError("Le compte doit avoir des soldes et réservations nuls avant sa fermeture définitive.", 409);
        }
        await tx.update(users).set(a === "merchant_delete"
          ? { status: "DELETED", deletedAt: new Date(), payinEnabled: false, payoutEnabled: false }
          : { status: a === "merchant_suspend" ? "SUSPENDED" : "ACTIVE" }).where(eq(users.id, target));
        if (a !== "merchant_activate") {
          await tx.update(apiKeys).set({ revokedAt: new Date() }).where(and(eq(apiKeys.userId, target), isNull(apiKeys.revokedAt)));
        }
        if (a === "merchant_delete") await tx.update(paymentLinks).set({ status: "Revoked", adminRevokedAt: new Date() }).where(eq(paymentLinks.userId, target));
        await tx.insert(adminAudit).values({ id: crypto.randomUUID(), actorId: actor.id, action: a, targetId: target, reason: input.reason });
        audited = true;
      });
      message = a === "merchant_delete" ? "Compte définitivement fermé. Les historiques financiers sont conservés." : a === "merchant_suspend" ? "Compte suspendu et clés API révoquées." : "Compte réactivé. Les anciennes clés révoquées restent invalides.";
    }
  } else if (a === "wallet_adjust") {
    const amount = input.amount;
    if (!Number.isSafeInteger(amount) || !amount || amount <= 0 || amount > 1_000_000_000 || !["credit", "debit"].includes(input.direction ?? "")) throw new OperationalError("Montant entier positif et sens de l’ajustement requis.", 400);
    const reason = text(input.reason, "Motif", 1000);
    const requestKey = `admin-adjust:${actor.id}:${text(input.idempotencyKey, "Clé d’idempotence", 128)}`;
    const hash = createHash("sha256").update(JSON.stringify({ walletId: input.walletId, direction: input.direction, amount, reason })).digest("hex");
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${requestKey}))`);
      const prior = await tx.query.adminAudit.findFirst({ where: eq(adminAudit.idempotencyKey, requestKey) });
      if (prior) {
        if (prior.details.requestHash !== hash) throw new OperationalError("Cette clé correspond à un autre ajustement.", 409);
        return;
      }
      const [wallet] = await tx.select().from(wallets).where(eq(wallets.id, text(input.walletId, "Wallet"))).for("update");
      if (!wallet) throw new OperationalError("Wallet introuvable.", 404);
      const owner = await tx.query.users.findFirst({ where: eq(users.id, wallet.userId) });
      if (owner?.status !== "ACTIVE") throw new OperationalError("Le marchand doit être actif pour ajuster son wallet.", 409);
      const next = wallet.balance + (input.direction === "credit" ? amount : -amount);
      if (next < wallet.pending || next > 2_147_483_647) throw new OperationalError("L’ajustement dépasse le disponible ou la capacité du wallet.", 409);
      const id = crypto.randomUUID();
      await tx.update(wallets).set({ balance: next }).where(eq(wallets.id, wallet.id));
      await tx.insert(transactions).values({ id, userId: wallet.userId, walletId: wallet.id, type: input.direction === "credit" ? "AdminCredit" : "AdminDebit", status: "Completed", amount, currency: wallet.currency, country: wallet.country, reference: `MP-ADJ-${id}`, paymentProvider: "INTERNAL", counterparty: `Ajustement administratif · ${reason}`, fee: 0, platformFee: 0, settledAt: new Date() });
      await tx.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId: wallet.userId, walletId: wallet.id, transactionId: id, entryType: input.direction === "credit" ? "CREDIT" : "DEBIT", amount, currency: wallet.currency, description: reason });
      await tx.insert(adminAudit).values({ id: crypto.randomUUID(), actorId: actor.id, action: a, targetId: wallet.id, reason, details: { requestHash: hash, amount, direction: input.direction, before: wallet.balance, after: next }, idempotencyKey: requestKey });
      await tx.insert(notifications).values({ id: crypto.randomUUID(), userId: wallet.userId, title: "Ajustement de votre wallet", body: `${input.direction === "credit" ? "Crédit" : "Débit"} de ${amount} ${wallet.currency} : ${reason}` });
    });
    audited = true;
    message = "Ajustement comptabilisé et journalisé.";
  } else if (a === "settings_update" || a === "stats_reset") {
    const previous = await getAdminConfiguration();
    const next = a === "stats_reset" ? { ...previous, statsSince: new Date().toISOString() } : { ...previous, ...input.settings, statsSince: previous.statsSince };
    if (a === "settings_update" && !input.settings) throw new OperationalError("Aucun réglage fourni.", 400);
    if (!validFee(next.payinFee) || !validFee(next.payoutFee)) throw new OperationalError("Taux de frais invalide.", 400);
    for (const key of ["depositMin", "depositMax", "withdrawalMin", "withdrawalMax"] as const) if (!Number.isSafeInteger(next[key]) || next[key] < 1 || next[key] > 1_000_000_000) throw new OperationalError("Les limites doivent être des montants entiers positifs.", 400);
    if (next.depositMin > next.depositMax || next.withdrawalMin > next.withdrawalMax) throw new OperationalError("Le minimum ne peut pas dépasser le maximum.", 400);
    if (next.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(next.supportEmail)) throw new OperationalError("Adresse de support invalide.", 400);
    if (next.supportWhatsapp) normalizePhone(next.supportWhatsapp);
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext('mulapay-admin-config'))`);
      const fresh = await tx.query.adminConfiguration.findFirst({ where: eq(adminConfiguration.id, "global") });
      const effective = { ...previous, ...fresh?.config, ...(a === "settings_update" ? input.settings : {}), statsSince: a === "stats_reset" ? next.statsSince : (fresh?.config.statsSince ?? previous.statsSince) } as typeof next;
      if (effective.depositMin > effective.depositMax || effective.withdrawalMin > effective.withdrawalMax) throw new OperationalError("Les limites ont changé. Rechargez les paramètres puis réessayez.", 409);
      await tx.insert(adminConfiguration).values({ id: "global", config: effective }).onConflictDoUpdate({ target: adminConfiguration.id, set: { config: effective, updatedAt: new Date() } });
      await tx.insert(platformSettings).values({ id: "global", feePercentage: String(effective.payinFee) }).onConflictDoUpdate({ target: platformSettings.id, set: { feePercentage: String(effective.payinFee), updatedAt: new Date() } });
      await tx.insert(adminAudit).values({ id: crypto.randomUUID(), actorId: actor.id, action: a, details: { settings: effective } });
    });
    audited = true;
    message = a === "stats_reset" ? "Période statistique réinitialisée. Aucun solde ni historique n’a été supprimé." : message;
  } else if (a === "provider_update") {
    if (!["DRIMPAY", "ASHTECHPAY"].includes(target ?? "") || typeof input.enabled !== "boolean") throw new OperationalError("Agrégateur et état requis.", 400);
    if (input.enabled && !(target === "DRIMPAY" ? isDrimPayConfigured() : isAshtechPayConfigured())) throw new OperationalError("Configurez d’abord les identifiants serveur de cet agrégateur.", 503);
    await db.insert(adminProviders).values({ id: target!, enabled: input.enabled }).onConflictDoUpdate({ target: adminProviders.id, set: { enabled: input.enabled } });
  } else if (a === "route_update") {
    const countryCode = text(input.countryCode, "Code pays");
    const country = COUNTRIES.find(c => c.code === countryCode);
    const operator = text(input.operator, "Opérateur", 80);
    const providerOperator = text(input.providerOperator, "Opérateur fournisseur", 80);
    if (!country || input.country !== country.country || !input.provider) throw new OperationalError("Association pays/code/agrégateur invalide.", 400);
    if (input.provider === "DRIMPAY" && !isDrimPayRouteSupported(countryCode, providerOperator)) {
      throw new OperationalError("Choisissez un code opérateur DrimPay autorisé pour le pays sélectionné.", 400);
    }
    if (input.dailyLimit != null && (!Number.isSafeInteger(input.dailyLimit) || input.dailyLimit < 1 || input.dailyLimit > 2_000_000_000)) throw new OperationalError("Plafond journalier invalide.", 400);
    if (input.provider === "DRIMPAY" && !operatorSlugForName(providerOperator) || input.provider === "ASHTECHPAY" && !isAshtechPayOperatorSupported(countryCode, providerOperator)) throw new OperationalError("Opérateur non pris en charge par cet agrégateur pour ce pays.", 400);
    const enabled = input.enabled ?? false;
    if (enabled && !(input.provider === "DRIMPAY" ? isDrimPayConfigured() : isAshtechPayConfigured())) throw new OperationalError("Les identifiants de cet agrégateur ne sont pas configurés.", 503);
    const data = { countryCode, country: country.country, operator, providerOperator, provider: input.provider, enabled, dailyLimit: input.dailyLimit ?? null, updatedAt: new Date() };
    if (target) {
      const updated = await db.update(paymentProviderRoutes).set(data).where(eq(paymentProviderRoutes.id, target)).returning({ id: paymentProviderRoutes.id });
      if (!updated.length) throw new OperationalError("Route introuvable.", 404);
    } else await db.insert(paymentProviderRoutes).values({ id: crypto.randomUUID(), ...data }).onConflictDoUpdate({ target: [paymentProviderRoutes.countryCode, paymentProviderRoutes.operator], set: data });
  } else if (a === "key_revoke") {
    const r = await db.update(apiKeys).set({ revokedAt: new Date() }).where(eq(apiKeys.id, text(target, "Clé"))).returning({ id: apiKeys.id });
    if (!r.length) throw new OperationalError("Clé introuvable.", 404);
  } else if (a === "link_revoke") {
    const r = await db.update(paymentLinks).set({ adminRevokedAt: new Date(), status: "Revoked" }).where(eq(paymentLinks.id, text(target, "Lien"))).returning({ id: paymentLinks.id });
    if (!r.length) throw new OperationalError("Lien introuvable.", 404);
  } else if (a === "blacklist_add") {
    const phone = normalizePhone(text(input.recipient, "Numéro international", 30));
    const allSupers = await db.select().from(users).where(and(eq(users.role, "SUPER_ADMIN"), eq(users.status, "ACTIVE")));
    if (allSupers.some(u => u.phone && profilePhone(u.phone, u.country) === phone)) throw new OperationalError("Un numéro de super administrateur actif ne peut pas être bloqué.");
    await db.insert(blacklistedPhones).values({ id: crypto.randomUUID(), phone, name: input.name?.trim().slice(0, 160) ?? "", reason: text(input.reason, "Motif", 1000), actorId: actor.id }).onConflictDoNothing();
  } else if (a === "blacklist_remove") {
    const r = await db.delete(blacklistedPhones).where(eq(blacklistedPhones.id, text(target, "Blocage"))).returning({ id: blacklistedPhones.id });
    if (!r.length) throw new OperationalError("Blocage introuvable.", 404);
  } else if (a === "announcement_create") {
    await db.insert(adminAnnouncements).values({ id: crypto.randomUUID(), actorId: actor.id, title: text(input.title, "Titre", 160), body: text(input.body, "Message", 2000) });
  } else if (a === "announcement_delete") {
    await db.update(adminAnnouncements).set({ deletedAt: new Date() }).where(eq(adminAnnouncements.id, text(target, "Notification")));
  } else if (a === "message_send") {
    if (!emailIsConfigured()) throw new OperationalError("Connectez Resend et une adresse MAIL_FROM vérifiée avant l’envoi.", 503);
    const subject = text(input.subject, "Sujet", 200), body = text(input.body, "Message", 20_000);
    const recipient = text(input.recipient, "Destinataire", 254);
    const count = await queueMerchantMail(actor.id, { purpose: a, recipient, subject, body, idempotencyKey: text(input.idempotencyKey, "Clé d’idempotence", 128) });
    audited = true;
    message = `${count} message(s) mis en file d’envoi. Consultez l’historique pour leur statut réel.`;
  } else if (a === "telegram_configure") {
    const token = text(input.telegramToken, "Bot Token", 200), chatId = text(input.telegramChatId, "Chat ID", 100);
    if (!/^\d+:[A-Za-z0-9_-]+$/.test(token) || !/^-?\d+$/.test(chatId)) throw new OperationalError("Format du Bot Token ou Chat ID invalide.", 400);
    const encrypted = encryptAdminSecret(JSON.stringify({ token, chatId, activatedAt: new Date().toISOString() }));
    await db.insert(adminConfiguration).values({ id: "global", telegramEncrypted: encrypted }).onConflictDoUpdate({ target: adminConfiguration.id, set: { telegramEncrypted: encrypted, updatedAt: new Date() } });
    message = "Configuration Telegram chiffrée et enregistrée.";
  } else if (a === "telegram_test") {
    const config = await getTelegramConfiguration();
    if (!config) throw new OperationalError("Configurez Telegram avant le test.", 503);
    try {
      const response = await fetch(`https://api.telegram.org/bot${config.token}/sendMessage`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ chat_id: config.chatId, text: "Mulapay : la connexion du bot est opérationnelle." }), signal: AbortSignal.timeout(10_000) });
      const result = await response.json() as { ok?: boolean };
      if (!response.ok || !result.ok) throw new Error();
    } catch { throw new OperationalError("Telegram n’a pas confirmé l’envoi. Vérifiez le bot, le Chat ID et son accès au groupe.", 502); }
    message = "Message de test confirmé par Telegram.";
  } else if (a === "integration_create") {
    const user = await db.query.users.findFirst({ where: eq(users.id, text(target, "Marchand")) });
    if (!user) throw new OperationalError("Marchand introuvable.", 404);
    let url: URL;
    try { url = new URL(text(input.url, "URL", 2000)); } catch { throw new OperationalError("URL invalide.", 400); }
    if (url.protocol !== "https:" || url.username || url.password) throw new OperationalError("Utilisez une URL HTTPS publique sans identifiants.", 400);
    await db.insert(merchantIntegrations).values({ id: crypto.randomUUID(), userId: user.id, name: text(input.name, "Nom du site", 100), url: url.href });
  } else if (a === "integration_delete") {
    await db.delete(merchantIntegrations).where(eq(merchantIntegrations.id, text(target, "Intégration")));
  } else if (a === "kyc_approve" || a === "kyc_reject") {
    await decideKyc(actor.id, text(target, "Dossier"), a === "kyc_approve", input.reason); audited = true;
  } else if (a === "exchange_approve" || a === "exchange_reject") {
    await decideExchange(actor.id, text(target, "Échange"), a === "exchange_approve", input.reason); audited = true;
  } else throw new OperationalError("Action inconnue.", 400);
  if (!audited) await db.insert(adminAudit).values({ id: crypto.randomUUID(), actorId: actor.id, action: a, targetId: target, reason: input.reason });
  return { ok: true, message };
}
