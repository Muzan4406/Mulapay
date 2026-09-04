import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DecideExchangeBody,
  DecideExchangeParams,
  DecideKycBody,
  DecideKycParams,
  CreateExchangeBody,
  CreateManualDepositBody,
  CreateManualWithdrawalBody,
  CreatePaymentLinkBody,
  CreateTransferBody,
  GetBootstrapResponse,
  GetAdminSummaryResponse,
  MarkNotificationReadParams,
  SubmitKycBody,
  CreateTransferResponse,
  CreateExchangeResponse,
  DecideExchangeResponse,
  CreateManualDepositResponse,
  CreateManualWithdrawalResponse,
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

const router: IRouter = Router();

const COUNTRY_WALLETS = [
  { country: "Togo", code: "TG", currency: "XOF", balance: 482500, pending: 12500 },
  { country: "Bénin", code: "BJ", currency: "XOF", balance: 218000, pending: 0 },
  { country: "Côte d’Ivoire", code: "CI", currency: "XOF", balance: 175250, pending: 48000 },
  { country: "Burkina Faso", code: "BF", currency: "XOF", balance: 0, pending: 0 },
  { country: "Sénégal", code: "SN", currency: "XOF", balance: 94000, pending: 0 },
  { country: "Mali", code: "ML", currency: "XOF", balance: 0, pending: 0 },
  { country: "Niger", code: "NE", currency: "XOF", balance: 0, pending: 0 },
];

const DEMO_USER_ID = "demo-admin";

function nowLabel() {
  return new Date().toISOString();
}

function reference(prefix: string) {
  return `${prefix}-${crypto.randomUUID().slice(0, 5).toUpperCase()}`;
}

function currentUserId(req: Request) {
  try {
    return getAuth(req).userId ?? DEMO_USER_ID;
  } catch {
    return DEMO_USER_ID;
  }
}

async function ensureUser(req: Request) {
  const id = currentUserId(req);
  const isDemo = id === DEMO_USER_ID;
  const role = isDemo || process.env.NODE_ENV !== "production" ? "ADMIN" : "USER";
  await db
    .insert(users)
    .values({
      id,
      firstName: isDemo ? "Afi" : "Mulapay",
      lastName: isDemo ? "Kossi" : "User",
      email: isDemo ? "admin@mulapay.demo" : `${id}@clerk.user`,
      role,
      country: "Togo",
      kycStatus: "VERIFIE",
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
    const togoWalletId = `${id}-tg`;
    const txId = crypto.randomUUID();
    await db.insert(transactions).values([
      { id: txId, userId: id, walletId: togoWalletId, type: "Received", status: "Completed", amount: 17500, currency: "XOF", country: "Togo", counterparty: "Afi Kossi", reference: "MP-8K4D2" },
      { id: crypto.randomUUID(), userId: id, walletId: `${id}-bj`, type: "Exchange", status: "Completed", amount: 75000, currency: "XOF", country: "Bénin", counterparty: "Togo wallet", reference: "MP-8K2A9" },
      { id: crypto.randomUUID(), userId: id, walletId: `${id}-ci`, type: "Sent", status: "Completed", amount: 32000, currency: "XOF", country: "Côte d’Ivoire", counterparty: "Koffi Mensah", reference: "MP-8J91Q" },
      { id: crypto.randomUUID(), userId: id, walletId: togoWalletId, type: "Deposit", status: "Pending", amount: 50000, currency: "XOF", country: "Togo", counterparty: "Manual deposit", reference: "MP-8G21B" },
      { id: crypto.randomUUID(), userId: id, walletId: `${id}-sn`, type: "Payment", status: "Completed", amount: 8900, currency: "XOF", country: "Sénégal", counterparty: "Nia Atelier", reference: "MP-8E75N" },
    ]);
    await db.insert(ledgerEntries).values({
      id: crypto.randomUUID(),
      userId: id,
      walletId: togoWalletId,
      transactionId: txId,
      entryType: "CREDIT",
      amount: 17500,
      currency: "XOF",
      description: "Received from Afi Kossi",
    });
    await db.insert(exchanges).values([
      { id: crypto.randomUUID(), userId: id, source: "Togo · XOF", destination: "Bénin · XOF", amount: 75000, rate: "1", receivedAmount: 75000, status: "COMPLETED" },
      { id: `${id}-ex-demo-pending`, userId: id, source: "Côte d’Ivoire · XOF", destination: "Togo · XOF", amount: 48000, rate: "1", receivedAmount: 48000, status: "PENDING_ADMIN" },
    ]);
    await db.insert(paymentLinks).values([
      { id: crypto.randomUUID(), userId: id, slug: "mulapay.me/afi-atelier", amount: 12500, currency: "XOF", description: "Afi Atelier order #184", status: "Active", expiresAt: "2026-06-18", payments: 3 },
      { id: crypto.randomUUID(), userId: id, slug: "mulapay.me/afi-consult", amount: 30000, currency: "XOF", description: "Consultation deposit", status: "Active", expiresAt: "2026-06-30", payments: 0 },
    ]);
    await db.insert(notifications).values([
      { id: crypto.randomUUID(), userId: id, title: "Exchange request received", body: "Your Côte d’Ivoire to Togo exchange is queued for review.", read: false },
      { id: crypto.randomUUID(), userId: id, title: "Transfer completed", body: "17,500 XOF was received from Afi Kossi.", read: false },
      { id: crypto.randomUUID(), userId: id, title: "KYC approved", body: "Your identity check is complete. Your account is verified.", read: true },
    ]);
    await db.insert(kycVerifications).values({
      id: crypto.randomUUID(),
      userId: id,
      name: `${isDemo ? "Afi Kossi" : "Mulapay User"}`,
      country: "Togo",
      status: "VERIFIE",
      documents: ["National ID", "Selfie"],
    });
  }
  if (isDemo) {
    const reviewCases = [
      { id: "review-mariam", name: "Mariam Traoré", country: "Mali", documents: ["National ID", "Selfie"] },
      { id: "review-youssouf", name: "Youssouf Diallo", country: "Sénégal", documents: ["Passport", "Proof of address"] },
      { id: "review-nana", name: "Nana Abena", country: "Burkina Faso", documents: ["National ID", "Selfie"] },
    ];
    for (const item of reviewCases) {
      await db.insert(users).values({ id: item.id, firstName: item.name.split(" ")[0], lastName: item.name.split(" ").slice(1).join(" "), email: `${item.id}@mulapay.demo`, role: "USER", country: item.country, kycStatus: "EN_ATTENTE" }).onConflictDoNothing();
      const existingCase = await db.query.kycVerifications.findFirst({ where: eq(kycVerifications.userId, item.id) });
      if (!existingCase) {
        await db.insert(kycVerifications).values({ id: crypto.randomUUID(), userId: item.id, name: item.name, country: item.country, status: "EN_ATTENTE", documents: item.documents });
      }
    }
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

router.post("/v1/deposits/manual", async (req, res) => {
  const input = CreateManualDepositBody.parse(req.body);
  const user = await ensureUser(req);
  const wallet = await db.query.wallets.findFirst({ where: and(eq(wallets.id, input.walletId), eq(wallets.userId, user.id)) });
  if (!wallet) {
    res.status(400).json({ error: "Wallet introuvable." });
    return;
  }
  const ref = reference("DEP");
  await db.insert(transactions).values({ id: crypto.randomUUID(), userId: user.id, walletId: wallet.id, type: "Deposit", status: "Pending", amount: input.amount, currency: wallet.currency, country: wallet.country, counterparty: "Manual deposit", reference: ref });
  await db.update(wallets).set({ pending: sql`${wallets.pending} + ${input.amount}` }).where(eq(wallets.id, wallet.id));
  res.status(201).json(CreateManualDepositResponse.parse({ ok: true, message: "Dépôt enregistré en attente de revue manuelle.", reference: ref }));
});

router.post("/v1/withdrawals/manual", async (req, res) => {
  const input = CreateManualWithdrawalBody.parse(req.body);
  const user = await ensureUser(req);
  const wallet = await db.query.wallets.findFirst({ where: and(eq(wallets.id, input.walletId), eq(wallets.userId, user.id)) });
  if (!wallet || wallet.balance < input.amount) {
    res.status(400).json({ error: "Wallet introuvable ou solde insuffisant." });
    return;
  }
  const ref = reference("WDR");
  await db.insert(transactions).values({ id: crypto.randomUUID(), userId: user.id, walletId: wallet.id, type: "Withdrawal", status: "Pending", amount: input.amount, currency: wallet.currency, country: wallet.country, counterparty: "Manual withdrawal", reference: ref });
  await db.update(wallets).set({ balance: sql`${wallets.balance} - ${input.amount}`, pending: sql`${wallets.pending} + ${input.amount}` }).where(eq(wallets.id, wallet.id));
  res.status(201).json(CreateManualWithdrawalResponse.parse({ ok: true, message: "Retrait enregistré en attente de revue manuelle.", reference: ref }));
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