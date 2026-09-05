import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { createHmac, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DecideExchangeBody,
  DecideExchangeParams,
  DecideKycBody,
  DecideKycParams,
  CreateExchangeBody,
  CreatePaymentLinkBody,
  CreateTransferBody,
  GetBootstrapResponse,
  GetAdminSummaryResponse,
  MarkNotificationReadParams,
  SubmitKycBody,
  CreateTransferResponse,
  CreateExchangeResponse,
  DecideExchangeResponse,
  MarkNotificationReadResponse,
  DecideKycResponse,
} from "@workspace/api-zod";
import {
  exchanges,
  kycVerifications,
  ledgerEntries,
  notifications,
  paymentLinks,
  transactions,
  users,
  wallets,
} from "@workspace/db";
import {
  countryCodeForName,
  DrimPayError,
  drimPayWebhookUrl,
  initiatePayin,
  providerStatusToTransactionStatus,
} from "../services/drimpay";

const router: IRouter = Router();

const ORANGE_OTP_COUNTRIES = new Set(["CI", "SN", "BF", "ML"]);
const TERMINAL_PROVIDER_STATUSES = new Set(["success", "failed", "expired", "cancelled", "reversed"]);

function parseDrimPayWebhookSignature(header: string | undefined, rawBody: Buffer) {
  const secret = process.env.DRIMPAY_WEBHOOK_SECRET;
  if (!secret || !header) return false;
  const values = Object.fromEntries(
    header.split(",").map((part) => {
      const [key, value] = part.trim().split("=", 2);
      return [key, value];
    }),
  );
  const timestamp = Number(values.t);
  const signature = values.v1;
  if (!Number.isInteger(timestamp) || !signature || Math.abs(Date.now() / 1000 - timestamp) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest("hex");
  const provided = Buffer.from(signature, "hex");
  const calculated = Buffer.from(expected, "hex");
  return provided.length === calculated.length && timingSafeEqual(provided, calculated);
}

async function handleDrimPayWebhook(req: Request, res: Response) {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !parseDrimPayWebhookSignature(req.header("X-DrimPay-Signature"), rawBody)) {
    res.status(401).json({ error: "Signature DrimPay invalide ou expirée." });
    return;
  }

  const payload = req.body as {
    reference?: string;
    status?: string;
    amount?: number;
    net_amount?: number;
    currency?: string;
    country_code?: string;
    operator?: string;
  };
  if (!payload.reference || !payload.status || !payload.amount || !payload.currency || !payload.country_code || !payload.operator) {
    res.status(400).json({ error: "Payload DrimPay incomplet." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const transaction = await tx.query.transactions.findFirst({ where: eq(transactions.reference, payload.reference!) });
    if (!transaction) return { found: false };
    const nextStatus = providerStatusToTransactionStatus(payload.status!);
    const currentIsTerminal = ["Completed", "Failed", "Expired", "Cancelled", "Reversed"].includes(transaction.status);
    if (currentIsTerminal && transaction.status !== "Completed" && nextStatus !== "Reversed") {
      return { found: true };
    }

    if (payload.status === "success" && transaction.status !== "Completed") {
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, transaction.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");
      const netAmount = payload.net_amount ?? transaction.netAmount ?? Math.round(transaction.amount * 0.965);
      await tx
        .update(wallets)
        .set({
          balance: sql`${wallets.balance} + ${netAmount}`,
          pending: sql`GREATEST(${wallets.pending} - ${transaction.amount}, 0)`,
        })
        .where(eq(wallets.id, wallet.id));
      await tx.update(transactions).set({ status: "Completed", netAmount }).where(eq(transactions.id, transaction.id));
      await tx.insert(ledgerEntries).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        walletId: wallet.id,
        transactionId: transaction.id,
        entryType: "CREDIT",
        amount: netAmount,
        currency: transaction.currency,
        description: `Pay-in DrimPay confirmé · ${payload.reference}`,
      });
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: "Dépôt confirmé",
        body: `${netAmount.toLocaleString("fr-FR")} ${transaction.currency} ont été crédités sur le wallet ${wallet.country}.`,
        read: false,
      });
      return { found: true };
    }

    if (payload.status === "reversed" && transaction.status === "Completed") {
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, transaction.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");
      const netAmount = transaction.netAmount ?? Math.round(transaction.amount * 0.965);
      await tx.update(wallets).set({ balance: sql`${wallets.balance} - ${netAmount}` }).where(eq(wallets.id, wallet.id));
      await tx.update(transactions).set({ status: "Reversed" }).where(eq(transactions.id, transaction.id));
      await tx.insert(ledgerEntries).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        walletId: wallet.id,
        transactionId: transaction.id,
        entryType: "DEBIT",
        amount: netAmount,
        currency: transaction.currency,
        description: `Pay-in DrimPay remboursé · ${payload.reference}`,
      });
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: "Dépôt remboursé",
        body: `Le dépôt DrimPay ${payload.reference} a été remboursé.`,
        read: false,
      });
      return { found: true };
    }

    if (TERMINAL_PROVIDER_STATUSES.has(payload.status!)) {
      await tx
        .update(wallets)
        .set({ pending: sql`GREATEST(${wallets.pending} - ${transaction.amount}, 0)` })
        .where(eq(wallets.id, transaction.walletId ?? ""));
    }
    await tx.update(transactions).set({ status: nextStatus }).where(eq(transactions.id, transaction.id));
    return { found: true };
  });

  if (!result.found) {
    res.status(404).json({ error: "Transaction DrimPay introuvable." });
    return;
  }
  res.status(200).json({ received: true });
}

router.post("/v1/webhooks/drimpay", handleDrimPayWebhook);

router.use((req, res, next) => {
  if (!getAuth(req).userId) {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }
  next();
});

const COUNTRY_WALLETS = [
  { country: "Togo", code: "TG", currency: "XOF", balance: 482500, pending: 12500 },
  { country: "Bénin", code: "BJ", currency: "XOF", balance: 218000, pending: 0 },
  { country: "Côte d’Ivoire", code: "CI", currency: "XOF", balance: 175250, pending: 48000 },
  { country: "Burkina Faso", code: "BF", currency: "XOF", balance: 0, pending: 0 },
  { country: "Sénégal", code: "SN", currency: "XOF", balance: 94000, pending: 0 },
  { country: "Mali", code: "ML", currency: "XOF", balance: 0, pending: 0 },
  { country: "Niger", code: "NE", currency: "XOF", balance: 0, pending: 0 },
];

function nowLabel() {
  return new Date().toISOString();
}

function reference(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
}

function currentUserId(req: Request) {
  return getAuth(req).userId;
}

async function ensureUser(req: Request) {
  const id = currentUserId(req);
  if (!id) throw new Error("AUTHENTICATION_REQUIRED");
  await db
    .insert(users)
    .values({
      id,
      firstName: "Utilisateur",
      lastName: "Mulapay",
      email: `${id}@clerk.user`,
      role: "USER",
      country: "Togo",
      kycStatus: "NON_VERIFIE",
    })
    .onConflictDoNothing();

  const existingWallet = await db.query.wallets.findFirst({ where: eq(wallets.userId, id) });
  if (!existingWallet) {
    await db.insert(wallets).values(
      COUNTRY_WALLETS.map((wallet) => ({
        id: `${id}-${wallet.code.toLowerCase()}`,
        userId: id,
        ...wallet,
        status: wallet.balance > 0 || wallet.country === "Togo" ? "Active" : "Active",
      })),
    );
  }
  return (await db.query.users.findFirst({ where: eq(users.id, id) }))!;
}

function formatWallet(wallet: typeof wallets.$inferSelect) {
  return { id: wallet.id, country: wallet.country, code: wallet.code, currency: wallet.currency, balance: wallet.balance, pending: wallet.pending, status: wallet.status };
}

function formatTransaction(transaction: typeof transactions.$inferSelect) {
  return { ...transaction, createdAt: transaction.createdAt.toISOString() };
}

function formatExchange(exchange: typeof exchanges.$inferSelect) {
  return { ...exchange, rate: Number(exchange.rate), requestedAt: exchange.requestedAt.toISOString(), status: exchange.status === "PENDING_ADMIN" ? "Pending review" : exchange.status === "COMPLETED" ? "Completed" : exchange.status === "REJECTED" ? "Rejected" : exchange.status };
}

async function bootstrap(req: Request) {
  const user = await ensureUser(req);
  const [userWallets, userTransactions, userExchanges, userLinks, userNotifications, userKyc] = await Promise.all([
    db.select().from(wallets).where(eq(wallets.userId, user.id)),
    db.select().from(transactions).where(eq(transactions.userId, user.id)).orderBy(desc(transactions.createdAt)),
    db.select().from(exchanges).where(eq(exchanges.userId, user.id)).orderBy(desc(exchanges.requestedAt)),
    db.select().from(paymentLinks).where(eq(paymentLinks.userId, user.id)).orderBy(desc(paymentLinks.createdAt)),
    db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.createdAt)),
    db.query.kycVerifications.findFirst({ where: eq(kycVerifications.userId, user.id), orderBy: desc(kycVerifications.submittedAt) }),
  ]);
  return GetBootstrapResponse.parse({
    profile: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, country: user.country, kycStatus: user.kycStatus },
    wallets: userWallets.map(formatWallet),
    transactions: userTransactions.map(formatTransaction),
    exchanges: userExchanges.map(formatExchange),
    links: userLinks.map((link) => ({ ...link })),
    notifications: userNotifications.map((notification) => ({ id: notification.id, title: notification.title, body: notification.body, read: notification.read })),
    kyc: userKyc ? { id: userKyc.id, userId: userKyc.userId, name: userKyc.name, country: userKyc.country, status: userKyc.status, documents: userKyc.documents, submittedAt: userKyc.submittedAt.toISOString() } : { id: "none", userId: user.id, name: `${user.firstName} ${user.lastName}`, country: user.country, status: user.kycStatus, documents: [], submittedAt: nowLabel() },
  });
}

async function requireAdmin(req: Request, res: Response, next: NextFunction) {
  const user = await ensureUser(req);
  if (user.role !== "ADMIN" && user.role !== "SUPER_ADMIN") {
    res.status(403).json({ error: "Admin access required" });
    return;
  }
  next();
}

router.get("/v1/bootstrap", async (req, res) => {
  res.json(await bootstrap(req));
});

router.post("/v1/transfers", async (req, res) => {
  const input = CreateTransferBody.parse(req.body);
  const user = await ensureUser(req);
  const source = await db.query.wallets.findFirst({ where: and(eq(wallets.userId, user.id), eq(wallets.currency, input.currency), eq(wallets.status, "Active")) });
  if (!source || source.balance < input.amount) {
    res.status(400).json({ error: "Solde disponible insuffisant pour ce transfert." });
    return;
  }
  const id = crypto.randomUUID();
  const ref = reference("MP");
  await db.transaction(async (tx) => {
    await tx.update(wallets).set({ balance: sql`${wallets.balance} - ${input.amount}` }).where(eq(wallets.id, source.id));
    await tx.insert(transactions).values({ id, userId: user.id, walletId: source.id, type: "Sent", status: "Completed", amount: input.amount, currency: input.currency, country: source.country, counterparty: input.counterparty, reference: ref });
    await tx.insert(ledgerEntries).values({ id: crypto.randomUUID(), userId: user.id, walletId: source.id, transactionId: id, entryType: "DEBIT", amount: input.amount, currency: input.currency, description: `Transfer to ${input.counterparty}` });
  });
  res.status(201).json(CreateTransferResponse.parse({ ok: true, message: "Transfert exécuté.", reference: ref }));
});

router.post("/v1/exchanges", async (req, res) => {
  const input = CreateExchangeBody.parse(req.body);
  const user = await ensureUser(req);
  const source = await db.query.wallets.findFirst({ where: and(eq(wallets.userId, user.id), eq(wallets.country, input.source), eq(wallets.status, "Active")) });
  const destination = await db.query.wallets.findFirst({ where: and(eq(wallets.userId, user.id), eq(wallets.country, input.destination), eq(wallets.status, "Active")) });
  if (!source || !destination || source.balance < input.amount) {
    res.status(400).json({ error: "Wallet source introuvable ou solde insuffisant." });
    return;
  }
  await db.insert(exchanges).values({ id: crypto.randomUUID(), userId: user.id, source: `${source.country} · ${source.currency}`, destination: `${destination.country} · ${destination.currency}`, amount: input.amount, rate: "1", receivedAmount: input.amount, status: "PENDING_ADMIN" });
  await db.insert(notifications).values({ id: crypto.randomUUID(), userId: user.id, title: "Demande d’échange envoyée", body: `${source.country} vers ${destination.country} est en attente de validation opérations.`, read: false });
  res.status(201).json(CreateExchangeResponse.parse({ ok: true, message: "Demande d’échange envoyée pour validation.", reference: null }));
});

router.patch("/v1/exchanges/:id/decision", requireAdmin, async (req, res) => {
  const params = DecideExchangeParams.parse(req.params);
  const input = DecideExchangeBody.parse(req.body);
  const exchange = await db.query.exchanges.findFirst({ where: eq(exchanges.id, params.id) });
  if (!exchange) {
    res.status(404).json({ error: "Demande d’échange introuvable." });
    return;
  }
  const accepted = input.decision === "APPROVED";
  await db.transaction(async (tx) => {
    await tx.update(exchanges).set({ status: accepted ? "COMPLETED" : "REJECTED" }).where(eq(exchanges.id, exchange.id));
    if (accepted) {
      const userId = exchange.userId;
      const sourceCountry = exchange.source.split(" · ")[0];
      const destinationCountry = exchange.destination.split(" · ")[0];
      const sourceWallet = await tx.query.wallets.findFirst({ where: and(eq(wallets.userId, userId), eq(wallets.country, sourceCountry)) });
      const destinationWallet = await tx.query.wallets.findFirst({ where: and(eq(wallets.userId, userId), eq(wallets.country, destinationCountry)) });
      if (!sourceWallet || !destinationWallet || sourceWallet.balance < exchange.amount) throw new Error("Solde insuffisant au moment de la validation.");
      await tx.update(wallets).set({ balance: sql`${wallets.balance} - ${exchange.amount}` }).where(eq(wallets.id, sourceWallet.id));
      await tx.update(wallets).set({ balance: sql`${wallets.balance} + ${exchange.receivedAmount}` }).where(eq(wallets.id, destinationWallet.id));
      const ref = reference("EX");
      const txId = crypto.randomUUID();
      await tx.insert(transactions).values({ id: txId, userId, walletId: destinationWallet.id, type: "Exchange", status: "Completed", amount: exchange.receivedAmount, currency: destinationWallet.currency, country: destinationWallet.country, counterparty: exchange.source, reference: ref });
      await tx.insert(ledgerEntries).values([
        { id: crypto.randomUUID(), userId, walletId: sourceWallet.id, transactionId: txId, entryType: "DEBIT", amount: exchange.amount, currency: sourceWallet.currency, description: `Exchange to ${destinationWallet.country}` },
        { id: crypto.randomUUID(), userId, walletId: destinationWallet.id, transactionId: txId, entryType: "CREDIT", amount: exchange.receivedAmount, currency: destinationWallet.currency, description: `Exchange from ${sourceWallet.country}` },
      ]);
    }
    await tx.insert(notifications).values({ id: crypto.randomUUID(), userId: exchange.userId, title: accepted ? "Échange approuvé" : "Échange refusé", body: accepted ? "Votre échange a été finalisé." : input.reason || "Votre demande d’échange a été refusée.", read: false });
  });
  res.json(DecideExchangeResponse.parse({ ok: true, message: accepted ? "Échange approuvé et finalisé." : "Échange rejeté.", reference: null }));
});

router.post("/v1/payment-links", async (req, res) => {
  const input = CreatePaymentLinkBody.parse(req.body);
  const user = await ensureUser(req);
  const link = { id: crypto.randomUUID(), userId: user.id, slug: `mulapay.me/${user.firstName.toLowerCase()}-${crypto.randomUUID().slice(0, 6)}`, amount: input.amount, currency: input.currency, description: input.description, status: "Active", expiresAt: input.expiresAt, payments: 0 };
  const [created] = await db.insert(paymentLinks).values(link).returning();
  res.status(201).json(created);
});

router.get("/v1/payment-links", async (req, res) => {
  const user = await ensureUser(req);
  res.json(await db.select().from(paymentLinks).where(eq(paymentLinks.userId, user.id)).orderBy(desc(paymentLinks.createdAt)));
});

router.post("/v1/deposits", async (req, res) => {
  const input = req.body as {
    walletId?: string;
    amount?: number;
    method?: string;
    country?: string;
    operator?: string;
    phone?: string;
    operatorOtp?: string;
  };
  const amount = input.amount;
  if (!input.walletId || typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || input.method !== "mobile_money" || !input.country || !input.operator || !input.phone) {
    res.status(400).json({ error: "Pays, opérateur, téléphone et montant sont obligatoires." });
    return;
  }
  const validatedAmount = amount as number;
  const countryCode = countryCodeForName(input.country);
  if (!countryCode || countryCode === "NE") {
    res.status(400).json({ error: "DrimPay ne prend pas encore en charge les dépôts dans ce pays." });
    return;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(input.phone)) {
    res.status(400).json({ error: "Le téléphone doit être au format international, par exemple +22890000000." });
    return;
  }
  if (input.operator === "Orange Money" && ORANGE_OTP_COUNTRIES.has(countryCode) && !input.operatorOtp) {
    res.status(400).json({ error: "Le code OTP Orange Money est obligatoire pour ce pays." });
    return;
  }

  const user = await ensureUser(req);
  const wallet = await db.query.wallets.findFirst({ where: and(eq(wallets.id, input.walletId), eq(wallets.userId, user.id)) });
  if (!wallet || wallet.code !== countryCode) {
    res.status(400).json({ error: "Le wallet sélectionné ne correspond pas au pays du dépôt." });
    return;
  }
  const orderIdHeader = req.header("Idempotency-Key");
  const orderId = orderIdHeader && orderIdHeader.length <= 128 ? orderIdHeader : `order_${crypto.randomUUID()}`;
  const existing = await db.query.transactions.findFirst({ where: eq(transactions.providerOrderId, orderId) });
  if (existing) {
    res.status(200).json({ ok: true, message: "Cette demande de dépôt existe déjà.", reference: existing.reference, status: existing.status });
    return;
  }

  try {
    const provider = await initiatePayin({
      amount: validatedAmount,
      currency: wallet.currency,
      countryCode,
      operator: input.operator,
      phone: input.phone,
      orderId,
      webhookUrl: drimPayWebhookUrl(),
      description: `Dépôt Mulapay · ${wallet.country}`,
      operatorOtp: input.operatorOtp,
      metadata: { mulapay_user_id: user.id, mulapay_wallet_id: wallet.id },
    });
    await db.transaction(async (tx) => {
      await tx
        .update(wallets)
        .set({ pending: sql`${wallets.pending} + ${validatedAmount}` })
        .where(eq(wallets.id, wallet.id));
      await tx.insert(transactions).values({
        id: crypto.randomUUID(),
        userId: user.id,
        walletId: wallet.id,
        type: "Deposit",
        status: providerStatusToTransactionStatus(provider.status),
        amount: validatedAmount,
        netAmount: provider.net_amount,
        currency: wallet.currency,
        country: wallet.country,
        counterparty: `DrimPay · ${input.operator}`,
        reference: provider.reference,
        providerOrderId: orderId,
      });
    });
    res.status(201).json({
      ok: true,
      message: provider.payment_url ? "Ouvrez le lien Wave pour confirmer le paiement." : "Confirmez le paiement sur votre téléphone.",
      reference: provider.reference,
      status: provider.status,
      paymentUrl: provider.payment_url ?? null,
      expiresAt: provider.expires_at,
      fee: provider.fee,
      netAmount: provider.net_amount,
    });
  } catch (error) {
    if (error instanceof DrimPayError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    throw error;
  }
});

router.post("/v1/withdrawals", async (_req, res) => {
  res.status(501).json({ error: "L’API Payin DrimPay ne couvre pas encore les retraits. Aucun wallet n’a été débité." });
});

router.patch("/v1/notifications/:id/read", async (req, res) => {
  const { id } = MarkNotificationReadParams.parse(req.params);
  const user = await ensureUser(req);
  await db.update(notifications).set({ read: true }).where(and(eq(notifications.id, id), eq(notifications.userId, user.id)));
  res.json(MarkNotificationReadResponse.parse({ ok: true, message: "Notification marquée comme lue.", reference: null }));
});

router.post("/v1/kyc", async (req, res) => {
  const input = SubmitKycBody.parse(req.body);
  const user = await ensureUser(req);
  const [kyc] = await db.insert(kycVerifications).values({ id: crypto.randomUUID(), userId: user.id, name: `${user.firstName} ${user.lastName}`, country: input.country, status: "EN_ATTENTE", documents: input.documents }).returning();
  await db.update(users).set({ kycStatus: "EN_ATTENTE" }).where(eq(users.id, user.id));
  res.status(201).json({ id: kyc.id, userId: kyc.userId, name: kyc.name, country: kyc.country, status: kyc.status, documents: kyc.documents, submittedAt: kyc.submittedAt.toISOString() });
});

router.get("/v1/admin/summary", requireAdmin, async (_req, res) => {
  const [kyc, pendingExchanges, allTransactions] = await Promise.all([
    db.select().from(kycVerifications).where(eq(kycVerifications.status, "EN_ATTENTE")),
    db.select().from(exchanges).where(eq(exchanges.status, "PENDING_ADMIN")),
    db.select().from(transactions),
  ]);
  res.json(GetAdminSummaryResponse.parse({ kycAwaiting: kyc.length, exchangeQueue: pendingExchanges.length, volume: allTransactions.reduce((sum, item) => sum + item.amount, 0), successRate: 98.6 }));
});

router.get("/v1/admin/kyc", requireAdmin, async (_req, res) => {
  const result = await db.select().from(kycVerifications).orderBy(desc(kycVerifications.submittedAt));
  res.json(result.map((item) => ({ id: item.id, userId: item.userId, name: item.name, country: item.country, status: item.status, documents: item.documents, submittedAt: item.submittedAt.toISOString() })));
});

router.patch("/v1/admin/kyc/:id/decision", requireAdmin, async (req, res) => {
  const params = DecideKycParams.parse(req.params);
  const input = DecideKycBody.parse(req.body);
  const status = input.decision === "VERIFIED" || input.decision === "APPROVED" ? "VERIFIE" : "REFUSE";
  const existing = await db.query.kycVerifications.findFirst({ where: eq(kycVerifications.id, params.id) });
  if (!existing) {
    res.status(404).json({ error: "Dossier KYC introuvable." });
    return;
  }
  await db.update(kycVerifications).set({ status }).where(eq(kycVerifications.id, params.id));
  await db.update(users).set({ kycStatus: status }).where(eq(users.id, existing.userId));
  await db.insert(notifications).values({ id: crypto.randomUUID(), userId: existing.userId, title: status === "VERIFIE" ? "KYC approuvé" : "KYC refusé", body: input.reason || "Votre dossier a été traité par l’équipe conformité.", read: false });
  res.json(DecideKycResponse.parse({ ok: true, message: "Décision KYC enregistrée.", reference: null }));
});

router.get("/v1/admin/transactions", requireAdmin, async (_req, res) => {
  const result = await db.select().from(transactions).orderBy(desc(transactions.createdAt));
  res.json(result.map(formatTransaction));
});

export default router;