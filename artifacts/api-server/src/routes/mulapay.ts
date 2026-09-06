import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, like, lte, ne, or, sql } from "drizzle-orm";
import { db } from "@workspace/db";
import {
  DecideExchangeBody,
  DecideExchangeParams,
  DecideKycBody,
  DecideKycParams,
  CreateExchangeBody,
  CreatePaymentLinkBody,
  CreatePublicPaymentBody,
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
  GetAdminSettingsResponse,
  UpdateAdminSettingsBody,
  UpdateAdminSettingsResponse,
} from "@workspace/api-zod";
import {
  apiKeys,
  exchanges,
  kycVerifications,
  ledgerEntries,
  notifications,
  paymentProviderRoutes,
  paymentProviderWebhookEvents,
  platformSettings,
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
  initiatePayout,
  isDrimPayConfigured,
  operatorSlugForName,
  providerStatusToTransactionStatus,
} from "../services/drimpay";
import {
  AshtechPayError,
  AshtechPayOtpRequiredError,
  ashtechPayCurrencyForCountry,
  ashtechPayPhoneForCountry,
  ashtechPayWebhookUrl,
  getAshtechTransaction,
  initiateAshtechPayin,
  isAshtechPayOperatorSupported,
  isAshtechPayConfigured,
} from "../services/ashtechpay";

const router: IRouter = Router();

const ORANGE_OTP_COUNTRIES = new Set(["CI", "SN", "BF", "ML"]);
const TERMINAL_PROVIDER_STATUSES = new Set(["success", "completed", "failed", "expired", "cancelled", "reversed"]);
const PUBLIC_PAYMENT_MIN_AMOUNT = 300;
const PUBLIC_PAYMENT_MAX_AMOUNT = 500_000;
const PLATFORM_SETTINGS_ID = "global";
const DEFAULT_FEE_PERCENTAGE = 1;
const DRIMPAY_PAYOUT_FEE_RATE = 0.035;
type PaymentProvider = "DRIMPAY" | "ASHTECHPAY";

function firstHeaderValue(value: string | string[] | undefined) {
  const header = Array.isArray(value) ? value[0] : value;
  return header?.split(",")[0]?.trim();
}

function requestOrigin(req: Request) {
  const forwardedHost = firstHeaderValue(req.headers["x-forwarded-host"]);
  const host = forwardedHost || req.headers.host;
  if (!host) throw new Error("Impossible de déterminer le domaine courant.");
  const forwardedProtocol = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const protocol = forwardedProtocol || (req.secure ? "https" : "http");
  return `${protocol}://${host}`;
}

function presentPaymentLink(req: Request, link: typeof paymentLinks.$inferSelect) {
  const currentOrigin = requestOrigin(req);
  let linkUrl: URL;
  try {
    linkUrl = new URL(link.slug);
  } catch {
    return link;
  }
  if (linkUrl.origin === currentOrigin) return link;
  const token = linkUrl.pathname.split("/").filter(Boolean).pop();
  return token ? { ...link, slug: `${requestOrigin(req)}/pay/${token}` } : link;
}

async function getPlatformSettings() {
  const existing = await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, PLATFORM_SETTINGS_ID) });
  if (existing) return existing;
  const [created] = await db.insert(platformSettings).values({ id: PLATFORM_SETTINGS_ID, feePercentage: DEFAULT_FEE_PERCENTAGE.toFixed(2) }).onConflictDoNothing().returning();
  return created ?? (await db.query.platformSettings.findFirst({ where: eq(platformSettings.id, PLATFORM_SETTINGS_ID) }))!;
}

function calculateMulapayNetAmount(amount: number, feePercentage: number) {
  const platformFee = Math.round(amount * feePercentage / 100);
  return { platformFee, merchantAmount: Math.max(0, amount - platformFee) };
}

function estimateDrimPayPayoutFee(amount: number) {
  return Math.ceil(amount * DRIMPAY_PAYOUT_FEE_RATE);
}

function withdrawalReservationAmount(transaction: typeof transactions.$inferSelect) {
  return transaction.type === "Withdrawal" || transaction.type === "Transfer"
    ? transaction.amount + (transaction.fee ?? 0)
    : transaction.amount;
}

function withdrawalPayloadMatchesWallet(
  transaction: typeof transactions.$inferSelect,
  wallet: typeof wallets.$inferSelect,
  payload: { country_code: string; currency: string; operator: string },
) {
  if (transaction.type !== "Withdrawal" && transaction.type !== "Transfer") return true;
  const expectedOperator = transaction.counterparty.split("·").at(-1)?.trim();
  return (
    wallet.code === payload.country_code &&
    transaction.currency === payload.currency &&
    Boolean(expectedOperator && operatorSlugForName(expectedOperator) === payload.operator)
  );
}

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

function parseAshtechPayWebhookSignature(headers: { signature?: string; timestamp?: string }, rawBody: Buffer) {
  // AshtechPay uses the configured API credential for webhook signing; no
  // separate webhook secret is required by this integration.
  const secret = process.env.ASHTECHPAY_API_KEY;
  if (!secret || !headers.signature || !headers.timestamp) return false;
  const numericTimestamp = Number(headers.timestamp);
  if (!Number.isFinite(numericTimestamp)) return false;
  const timestampMs = numericTimestamp > 1_000_000_000_000 ? numericTimestamp : numericTimestamp * 1000;
  if (Math.abs(Date.now() - timestampMs) > 5 * 60 * 1000) return false;
  const expected = `sha256=${createHmac("sha256", secret).update(`${headers.timestamp}.${rawBody.toString("utf8")}`).digest("hex")}`;
  const provided = Buffer.from(headers.signature);
  const calculated = Buffer.from(expected);
  return provided.length === calculated.length && timingSafeEqual(provided, calculated);
}

async function resolvePaymentProvider(countryCode: string, operator: string) {
  const route = await db.query.paymentProviderRoutes.findFirst({
    where: and(
      eq(paymentProviderRoutes.countryCode, countryCode),
      eq(paymentProviderRoutes.operator, operator),
      eq(paymentProviderRoutes.enabled, true),
    ),
  });
  const provider = (route?.provider ?? "DRIMPAY") as PaymentProvider;
  if (provider !== "DRIMPAY" && provider !== "ASHTECHPAY") throw new Error("PAYMENT_PROVIDER_INVALID");
  return { provider, operator: route?.providerOperator ?? operator };
}

async function handleDrimPayWebhook(req: Request, res: Response) {
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !parseDrimPayWebhookSignature(req.header("X-DrimPay-Signature"), rawBody)) {
    res.status(401).json({ error: "Signature de confirmation invalide ou expirée." });
    return;
  }

  const payload = req.body as {
    event?: string;
    reference?: string;
    order_id?: string;
    status?: string;
    amount?: number;
    fee?: number;
    total_debited?: number;
    net_amount?: number;
    currency?: string;
    country_code?: string;
    operator?: string;
    failure_reason?: string | null;
  };
  if (
    !payload.reference ||
    !payload.status ||
    typeof payload.amount !== "number" ||
    !payload.currency ||
    !payload.country_code ||
    !payload.operator
  ) {
    res.status(400).json({ error: "Notification de confirmation incomplète." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const transaction = await tx.query.transactions.findFirst({
      where: and(
        eq(transactions.paymentProvider, "DRIMPAY"),
        or(
          eq(transactions.reference, payload.reference!),
          ...(payload.order_id ? [eq(transactions.providerOrderId, payload.order_id)] : []),
        ),
      ),
    });
    if (!transaction) return { found: false };
    const nextStatus = providerStatusToTransactionStatus(payload.status!);
    const currentIsTerminal = ["Completed", "Failed", "Expired", "Cancelled", "Reversed"].includes(transaction.status);
    if (currentIsTerminal && transaction.status !== "Completed" && nextStatus !== "Reversed") {
      return { found: true };
    }

    if (transaction.type === "Withdrawal" || transaction.type === "Transfer") {
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, transaction.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");
      if (
        !withdrawalPayloadMatchesWallet(transaction, wallet, {
          country_code: payload.country_code!,
          currency: payload.currency!,
          operator: payload.operator!,
        }) ||
        payload.amount !== transaction.amount
      ) {
        return { found: true, walletMismatch: true };
      }

      if (nextStatus === "Completed" && transaction.status !== "Completed") {
        if (
          typeof payload.fee !== "number" ||
          typeof payload.total_debited !== "number" ||
          payload.fee < 0 ||
          payload.total_debited !== payload.amount + payload.fee
        ) {
          throw new Error("INVALID_PROVIDER_PAYOUT_TOTAL");
        }
        const debitAmount = payload.total_debited;
        const reservedAmount = withdrawalReservationAmount(transaction);
        const updatedWallets = await tx
          .update(wallets)
          .set({
            balance: sql`${wallets.balance} - ${debitAmount}`,
            pending: sql`GREATEST(${wallets.pending} - ${reservedAmount}, 0)`,
          })
          .where(and(eq(wallets.id, wallet.id), gte(wallets.balance, debitAmount)))
          .returning({ id: wallets.id });
        if (!updatedWallets.length) throw new Error("WITHDRAWAL_BALANCE_UNAVAILABLE");
        await tx.update(transactions).set({
          status: "Completed",
          fee: payload.fee,
          netAmount: payload.amount,
          merchantAmount: payload.amount,
        }).where(eq(transactions.id, transaction.id));
        await tx.insert(ledgerEntries).values({
          id: crypto.randomUUID(),
          userId: transaction.userId,
          walletId: wallet.id,
          transactionId: transaction.id,
          entryType: "DEBIT",
          amount: debitAmount,
          currency: transaction.currency,
          description: `${transaction.type === "Transfer" ? "Transfert" : "Retrait"} DrimPay confirmé · ${payload.reference}`,
        });
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: transaction.userId,
          title: transaction.type === "Transfer" ? "Transfert confirmé" : "Retrait confirmé",
          body: `${payload.amount.toLocaleString("fr-FR")} ${transaction.currency} ont été envoyés vers ${transaction.counterparty}.`,
          read: false,
        });
        return { found: true };
      }

      if (nextStatus === "Reversed" && transaction.status === "Completed") {
        const debitAmount = transaction.amount + (transaction.fee ?? 0);
        await tx.update(wallets).set({ balance: sql`${wallets.balance} + ${debitAmount}` }).where(eq(wallets.id, wallet.id));
        await tx.update(transactions).set({ status: "Reversed" }).where(eq(transactions.id, transaction.id));
        await tx.insert(ledgerEntries).values({
          id: crypto.randomUUID(),
          userId: transaction.userId,
          walletId: wallet.id,
          transactionId: transaction.id,
          entryType: "CREDIT",
          amount: debitAmount,
          currency: transaction.currency,
          description: `${transaction.type === "Transfer" ? "Transfert" : "Retrait"} DrimPay remboursé · ${payload.reference}`,
        });
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: transaction.userId,
          title: transaction.type === "Transfer" ? "Transfert remboursé" : "Retrait remboursé",
          body: `Le ${transaction.type === "Transfer" ? "transfert" : "retrait"} DrimPay ${payload.reference} a été remboursé.`,
          read: false,
        });
        return { found: true };
      }

      if (TERMINAL_PROVIDER_STATUSES.has(payload.status!)) {
        await tx.update(wallets)
          .set({ pending: sql`GREATEST(${wallets.pending} - ${withdrawalReservationAmount(transaction)}, 0)` })
          .where(eq(wallets.id, wallet.id));
      }
      await tx.update(transactions).set({ status: nextStatus }).where(eq(transactions.id, transaction.id));
      return { found: true };
    }

    if (nextStatus === "Completed" && transaction.status !== "Completed") {
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, transaction.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");
      if (
        !depositPayloadMatchesWallet(transaction, wallet, payload.country_code!, payload.currency!, "DRIMPAY") ||
        payload.amount !== transaction.amount
      ) {
        return { found: true, walletMismatch: true };
      }
      const providerNetAmount = payload.net_amount ?? transaction.netAmount;
      const merchantAmount = transaction.merchantAmount ?? providerNetAmount;
      if (providerNetAmount == null || providerNetAmount <= 0 || providerNetAmount > payload.amount) throw new Error("INVALID_PROVIDER_NET_AMOUNT");
      if (merchantAmount == null || merchantAmount <= 0 || merchantAmount > payload.amount) throw new Error("INVALID_MULAPAY_NET_AMOUNT");
      await tx
        .update(wallets)
        .set({
          balance: sql`${wallets.balance} + ${merchantAmount}`,
          pending: sql`GREATEST(${wallets.pending} - ${transaction.amount}, 0)`,
        })
        .where(eq(wallets.id, wallet.id));
      await tx.update(transactions).set({ status: "Completed", netAmount: providerNetAmount }).where(eq(transactions.id, transaction.id));
      await tx.insert(ledgerEntries).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        walletId: wallet.id,
        transactionId: transaction.id,
        entryType: "CREDIT",
        amount: merchantAmount,
        currency: transaction.currency,
        description: `${transaction.type === "Payment" ? "Paiement par lien" : "Dépôt Mulapay"} confirmé · ${payload.reference}`,
      });
      const paymentLinkId = transaction.providerOrderId?.match(/^paylink_(.+)_[0-9a-f-]{36}$/i)?.[1];
      if (transaction.type === "Payment" && paymentLinkId) {
        await tx.update(paymentLinks).set({ payments: sql`${paymentLinks.payments} + 1` }).where(eq(paymentLinks.id, paymentLinkId));
      }
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: transaction.type === "Payment" ? "Paiement reçu" : "Dépôt confirmé",
        body: `${merchantAmount.toLocaleString("fr-FR")} ${transaction.currency} ont été crédités sur le wallet ${wallet.country}.`,
        read: false,
      });
      return { found: true };
    }

    if (nextStatus === "Reversed" && transaction.status === "Completed") {
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, transaction.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");
      const merchantAmount = transaction.merchantAmount ?? transaction.netAmount;
      if (merchantAmount == null) throw new Error("MISSING_MULAPAY_NET_AMOUNT");
      await tx.update(wallets).set({ balance: sql`${wallets.balance} - ${merchantAmount}` }).where(eq(wallets.id, wallet.id));
      await tx.update(transactions).set({ status: "Reversed" }).where(eq(transactions.id, transaction.id));
      await tx.insert(ledgerEntries).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        walletId: wallet.id,
        transactionId: transaction.id,
        entryType: "DEBIT",
        amount: merchantAmount,
        currency: transaction.currency,
        description: `Dépôt Mulapay remboursé · ${payload.reference}`,
      });
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: "Dépôt remboursé",
        body: `Le dépôt Mulapay ${payload.reference} a été remboursé.`,
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
    res.status(404).json({ error: "Transaction de paiement introuvable." });
    return;
  }
  if ("walletMismatch" in result && result.walletMismatch) {
    res.status(422).json({ error: "Le webhook DrimPay ne correspond pas au wallet, à l’opérateur ou au montant de la transaction." });
    return;
  }
  res.status(200).json({ received: true, event: payload.event ?? null });
}

function ashtechStatusToTransactionStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  if (normalized === "completed" || normalized === "success" || normalized === "successful") return "Completed";
  if (normalized === "failed" || normalized === "failure" || normalized === "cancelled" || normalized === "canceled" || normalized === "expired") return "Failed";
  return "Pending";
}

function depositPayloadMatchesWallet(
  transaction: typeof transactions.$inferSelect,
  wallet: typeof wallets.$inferSelect,
  countryCode: string,
  currency: string,
  provider: PaymentProvider,
) {
  if (transaction.type !== "Deposit") return true;
  if (wallet.code !== countryCode) return false;
  if (provider === "ASHTECHPAY") return ashtechPayCurrencyForCountry(wallet.code) === currency;
  return transaction.currency === currency;
}

function respondWithPaymentProviderError(res: Response, error: DrimPayError | AshtechPayError, provider: PaymentProvider) {
  const minimumAmountMatch = error.message.match(/minimum allowed.*?\bis\s+(\d+)\s+([A-Z]+)/i);
  if (minimumAmountMatch) {
    res.status(400).json({
      error: `Le montant minimum accepté par ${provider === "ASHTECHPAY" ? "AshtechPay" : "le fournisseur"} est de ${minimumAmountMatch[1]} ${minimumAmountMatch[2]}.`,
      code: "PAYMENT_AMOUNT_TOO_LOW",
      provider,
    });
    return;
  }
  const isConfigurationError = error.code === "DRIMPAY_NOT_CONFIGURED" || error.code === "ASHTECHPAY_NOT_CONFIGURED";
  res.status(error.statusCode).json({
    error: isConfigurationError ? "Le service de paiement n’est pas encore configuré." : error.statusCode >= 500 ? "Le service de paiement est temporairement indisponible." : error.message,
    code: isConfigurationError ? "PAYMENT_SERVICE_NOT_CONFIGURED" : "PAYMENT_SERVICE_ERROR",
    provider,
  });
}

type DrimPayOutgoingKind = "Withdrawal" | "Transfer";

async function submitDrimPayOutgoing(input: {
  userId: string;
  wallet: typeof wallets.$inferSelect;
  amount: number;
  countryCode: string;
  operator: string;
  phone: string;
  idempotencyKey: string | undefined;
  kind: DrimPayOutgoingKind;
  counterparty: string;
}) {
  const prefix = input.kind === "Withdrawal" ? "mp_wd_" : "mp_tf_";
  const orderId = input.idempotencyKey && input.idempotencyKey.length <= 128
    ? `${prefix}${createHash("sha256").update(`${input.userId}:${input.idempotencyKey}`).digest("hex").slice(0, 56)}`
    : `${prefix}${crypto.randomUUID()}`;
  const existing = await db.query.transactions.findFirst({
    where: and(
      eq(transactions.providerOrderId, orderId),
      eq(transactions.userId, input.userId),
      eq(transactions.type, input.kind),
    ),
  });
  if (existing) {
    return {
      existing: true,
      reference: existing.reference,
      status: existing.status,
      amount: existing.amount,
      currency: existing.currency,
      fee: existing.fee ?? 0,
      totalDebited: existing.amount + (existing.fee ?? 0),
      providerStatus: existing.status,
    };
  }

  const estimatedFee = estimateDrimPayPayoutFee(input.amount);
  const estimatedTotal = input.amount + estimatedFee;
  let localTransaction: typeof transactions.$inferSelect | undefined;
  try {
    if (!isDrimPayConfigured()) {
      throw new DrimPayError("Le service payout DrimPay n’est pas encore configuré.", 503, "DRIMPAY_NOT_CONFIGURED");
    }
    const webhookUrl = drimPayWebhookUrl();
    [localTransaction] = await db.transaction(async (tx) => {
      const reserved = await tx
        .update(wallets)
        .set({ pending: sql`${wallets.pending} + ${estimatedTotal}` })
        .where(and(
          eq(wallets.id, input.wallet.id),
          sql`${wallets.balance} - ${wallets.pending} >= ${estimatedTotal}`,
        ))
        .returning({ id: wallets.id });
      if (!reserved.length) {
        throw new DrimPayError("Solde disponible insuffisant pour couvrir le montant et les frais du transfert.", 400, "INSUFFICIENT_FUNDS");
      }

      return tx.insert(transactions).values({
        id: crypto.randomUUID(),
        userId: input.userId,
        walletId: input.wallet.id,
        type: input.kind,
        paymentProvider: "DRIMPAY",
        status: "Pending",
        amount: input.amount,
        currency: input.wallet.currency,
        country: input.wallet.country,
        counterparty: input.counterparty,
        reference: orderId,
        providerOrderId: orderId,
        fee: estimatedFee,
        netAmount: input.amount,
        merchantAmount: input.amount,
      }).returning();
    });

    const provider = await initiatePayout({
      amount: input.amount,
      currency: input.wallet.currency,
      countryCode: input.countryCode,
      operator: input.operator,
      phone: input.phone,
      orderId,
      webhookUrl,
      description: `${input.kind === "Withdrawal" ? "Retrait" : "Transfert"} Mulapay · ${input.wallet.country}`,
      metadata: { mulapay_user_id: input.userId, mulapay_wallet_id: input.wallet.id },
    });
    const providerTotal = provider.total_debited;
    if (
      provider.amount !== input.amount ||
      providerTotal !== provider.amount + provider.fee ||
      providerTotal <= 0
    ) {
      throw new DrimPayError("La réponse payout DrimPay est incohérente. L’opération reste en attente de vérification.", 502, "INVALID_PAYOUT_RESPONSE");
    }

    await db.transaction(async (tx) => {
      await tx.update(wallets)
        .set({ pending: sql`${wallets.pending} + ${providerTotal - estimatedTotal}` })
        .where(eq(wallets.id, input.wallet.id));
      await tx.update(transactions).set({
        reference: provider.reference,
        fee: provider.fee,
        netAmount: provider.amount,
        merchantAmount: provider.amount,
      }).where(eq(transactions.id, localTransaction!.id));
    });
    return {
      existing: false,
      reference: provider.reference,
      status: "Pending",
      amount: provider.amount,
      currency: provider.currency,
      fee: provider.fee,
      totalDebited: providerTotal,
      providerStatus: provider.status,
    };
  } catch (error) {
    if (localTransaction && (error instanceof DrimPayError ? error.statusCode < 500 : false)) {
      await db.transaction(async (tx) => {
        await tx.update(wallets)
          .set({ pending: sql`GREATEST(${wallets.pending} - ${estimatedTotal}, 0)` })
          .where(eq(wallets.id, input.wallet.id));
        await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, localTransaction!.id));
      });
    }
    throw error;
  }
}

async function handleAshtechPayWebhook(req: Request, res: Response) {
  const eventId = req.header("X-Ashtech-Event-Id");
  if (!eventId || eventId.length > 200) {
    res.status(400).json({ error: "Identifiant d’événement AshtechPay manquant." });
    return;
  }
  const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
  if (!rawBody || !parseAshtechPayWebhookSignature({
    signature: req.header("X-Ashtech-Signature") ?? undefined,
    timestamp: req.header("X-Ashtech-Timestamp") ?? undefined,
  }, rawBody)) {
    res.status(401).json({ error: "Signature de confirmation AshtechPay invalide." });
    return;
  }

  const payload = req.body as {
    event?: string;
    transaction_id?: string;
    reference?: string;
    status?: string;
    amount?: number;
    total_amount?: number;
    currency?: string;
    country_code?: string;
  };
  if (!payload.reference || !payload.status || typeof payload.amount !== "number" || !payload.currency) {
    res.status(400).json({ error: "Notification AshtechPay incomplète." });
    return;
  }

  const result = await db.transaction(async (tx) => {
    const [event] = await tx.insert(paymentProviderWebhookEvents).values({
      id: crypto.randomUUID(),
      provider: "ASHTECHPAY",
      eventId,
    }).onConflictDoNothing({
      target: [paymentProviderWebhookEvents.provider, paymentProviderWebhookEvents.eventId],
    }).returning();
    if (!event) return { found: true, duplicate: true };
    const transaction = await tx.query.transactions.findFirst({
      where: and(eq(transactions.reference, payload.reference!), eq(transactions.paymentProvider, "ASHTECHPAY")),
    });
    if (!transaction) return { found: false, duplicate: false };
    const nextStatus = ashtechStatusToTransactionStatus(payload.status!);
    const currentIsTerminal = ["Completed", "Failed", "Expired", "Cancelled", "Reversed"].includes(transaction.status);
    if (currentIsTerminal && !(nextStatus === "Completed" && transaction.status !== "Completed")) return { found: true, duplicate: false };

    if (nextStatus === "Completed") {
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, transaction.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");
      const providerNetAmount = payload.amount;
      if (typeof providerNetAmount !== "number") throw new Error("ASH TECHPAY_NET_AMOUNT_MISSING");
      const merchantAmount = transaction.merchantAmount ?? providerNetAmount;
      if (
        !depositPayloadMatchesWallet(transaction, wallet, payload.country_code ?? wallet.code, payload.currency!, "ASHTECHPAY") ||
        (typeof payload.total_amount === "number" && payload.total_amount !== transaction.amount) ||
        providerNetAmount <= 0 ||
        providerNetAmount > (payload.total_amount ?? transaction.amount) ||
        merchantAmount <= 0 ||
        merchantAmount > providerNetAmount
      ) {
        return { found: true, duplicate: false, walletMismatch: true };
      }
      await tx.update(wallets).set({
        balance: sql`${wallets.balance} + ${merchantAmount}`,
        pending: sql`GREATEST(${wallets.pending} - ${transaction.amount}, 0)`,
      }).where(eq(wallets.id, wallet.id));
      await tx.update(transactions).set({ status: "Completed", netAmount: providerNetAmount }).where(eq(transactions.id, transaction.id));
      await tx.insert(ledgerEntries).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        walletId: wallet.id,
        transactionId: transaction.id,
        entryType: "CREDIT",
        amount: merchantAmount,
        currency: transaction.currency,
        description: `${transaction.type === "Payment" ? "Paiement par lien" : "Dépôt AshtechPay"} confirmé · ${payload.reference}`,
      });
      const paymentLinkId = transaction.providerOrderId?.match(/^paylink_(.+)_[0-9a-f-]{36}$/i)?.[1];
      if (transaction.type === "Payment" && paymentLinkId) {
        await tx.update(paymentLinks).set({ payments: sql`${paymentLinks.payments} + 1` }).where(eq(paymentLinks.id, paymentLinkId));
      }
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: transaction.type === "Payment" ? "Paiement reçu" : "Dépôt confirmé",
        body: `${merchantAmount.toLocaleString("fr-FR")} ${transaction.currency} ont été crédités sur le wallet ${wallet.country}.`,
        read: false,
      });
      return { found: true, duplicate: false };
    }

    if (nextStatus === "Failed") {
      await tx.update(wallets)
        .set({ pending: sql`GREATEST(${wallets.pending} - ${transaction.amount}, 0)` })
        .where(eq(wallets.id, transaction.walletId ?? ""));
    }
    await tx.update(transactions).set({ status: nextStatus }).where(eq(transactions.id, transaction.id));
    return { found: true, duplicate: false };
  });

  if (!result.found) {
    res.status(404).json({ error: "Transaction AshtechPay introuvable." });
    return;
  }
  if ("walletMismatch" in result && result.walletMismatch) {
    res.status(422).json({ error: "Le webhook AshtechPay ne correspond pas au wallet et au montant de la transaction." });
    return;
  }
  res.status(200).json({ received: true, duplicate: result.duplicate, event: payload.event ?? null });
}

router.post("/v1/webhooks/drimpay", handleDrimPayWebhook);
router.post("/v1/webhooks/ashtechpay", handleAshtechPayWebhook);

type MulapayRequest = Request & { mulapayUserId?: string; mulapayAuthMode?: "clerk" | "api_key" };

function apiKeyFromRequest(req: Request) {
  const bearer = req.header("Authorization");
  if (bearer?.startsWith("Bearer ")) return bearer.slice(7).trim();
  return req.header("X-Mulapay-Key")?.trim();
}

function hashApiKey(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

async function resolveApiKeyUserId(req: Request) {
  const rawKey = apiKeyFromRequest(req);
  if (!rawKey) return null;
  const stored = await db.query.apiKeys.findFirst({
    where: and(eq(apiKeys.keyHash, hashApiKey(rawKey)), isNull(apiKeys.revokedAt)),
  });
  if (!stored) return null;
  await db.update(apiKeys).set({ lastUsedAt: new Date() }).where(eq(apiKeys.id, stored.id));
  return stored.userId;
}

router.use(async (req, res, next) => {
  if (
    req.path.startsWith("/v1/public/payment-links/") ||
    req.path === "/v1/webhooks/drimpay" ||
    req.path === "/v1/webhooks/ashtechpay"
  ) {
    next();
    return;
  }
  const clerkUserId = getAuth(req).userId;
  if (clerkUserId) {
    (req as MulapayRequest).mulapayAuthMode = "clerk";
    next();
    return;
  }
  const apiUserId = await resolveApiKeyUserId(req);
  if (apiUserId) {
    (req as MulapayRequest).mulapayUserId = apiUserId;
    (req as MulapayRequest).mulapayAuthMode = "api_key";
    next();
    return;
  }
  if (!clerkUserId) {
    res.status(401).json({ error: "Authentification requise." });
    return;
  }
});

const COUNTRY_WALLETS = [
  { country: "Togo", code: "TG", currency: "XOF", balance: 0, pending: 0 },
  { country: "Bénin", code: "BJ", currency: "XOF", balance: 0, pending: 0 },
  { country: "Côte d’Ivoire", code: "CI", currency: "XOF", balance: 0, pending: 0 },
  { country: "Burkina Faso", code: "BF", currency: "XOF", balance: 0, pending: 0 },
  { country: "Sénégal", code: "SN", currency: "XOF", balance: 0, pending: 0 },
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
  return getAuth(req).userId ?? (req as MulapayRequest).mulapayUserId;
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

async function ensureClerkUser(req: Request) {
  if (!getAuth(req).userId) throw new Error("AUTHENTICATION_REQUIRED");
  return ensureUser(req);
}

const DEFAULT_API_KEY_SCOPES = ["wallets:read", "transactions:read", "deposits:write"];

router.get("/v1/api-keys", async (req, res) => {
  const user = await ensureClerkUser(req);
  const keys = await db.select().from(apiKeys).where(and(eq(apiKeys.userId, user.id), isNull(apiKeys.revokedAt))).orderBy(desc(apiKeys.createdAt));
  res.json(keys.map((key) => ({
    id: key.id,
    name: key.name,
    keyPrefix: key.keyPrefix,
    scopes: key.scopes,
    lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
    revokedAt: key.revokedAt?.toISOString() ?? null,
    createdAt: key.createdAt.toISOString(),
  })));
});

router.post("/v1/api-keys", async (req, res) => {
  const user = await ensureClerkUser(req);
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  if (name.length < 2 || name.length > 80) {
    res.status(400).json({ error: "Le nom de la clé doit contenir entre 2 et 80 caractères." });
    return;
  }
  const rawKey = `mp_live_${randomBytes(32).toString("base64url")}`;
  const [created] = await db.insert(apiKeys).values({
    id: crypto.randomUUID(),
    userId: user.id,
    name,
    keyPrefix: rawKey.slice(0, 16),
    keyHash: hashApiKey(rawKey),
    scopes: DEFAULT_API_KEY_SCOPES,
  }).returning();
  res.status(201).json({
    id: created.id,
    name: created.name,
    key: rawKey,
    keyPrefix: created.keyPrefix,
    scopes: created.scopes,
    createdAt: created.createdAt.toISOString(),
    warning: "Cette clé ne sera plus affichée après cette fermeture.",
  });
});

router.delete("/v1/api-keys/:id", async (req, res) => {
  const user = await ensureClerkUser(req);
  const [deleted] = await db.delete(apiKeys)
    .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, user.id)))
    .returning({ id: apiKeys.id });
  if (!deleted) {
    res.status(404).json({ error: "Clé API introuvable." });
    return;
  }
  res.json({ ok: true, message: "Clé API supprimée définitivement." });
});

function formatWallet(wallet: typeof wallets.$inferSelect) {
  return { id: wallet.id, country: wallet.country, code: wallet.code, currency: wallet.currency, balance: wallet.balance, pending: wallet.pending, status: wallet.status };
}

function formatTransaction(transaction: typeof transactions.$inferSelect) {
  return { ...transaction, createdAt: transaction.createdAt.toISOString() };
}

function formatExchange(exchange: typeof exchanges.$inferSelect) {
  return { ...exchange, rate: Number(exchange.rate), requestedAt: exchange.requestedAt.toISOString(), status: exchange.status === "PENDING_ADMIN" ? "Pending review" : exchange.status === "COMPLETED" ? "Completed" : exchange.status === "REJECTED" ? "Rejected" : exchange.status };
}

async function expireAndReconcilePending(userId: string) {
  const cutoff = new Date(Date.now() - 60_000);
  const activeStatuses = ["Pending", "Processing"];
  const stale = await db.query.transactions.findMany({
    where: and(
      eq(transactions.userId, userId),
      inArray(transactions.status, activeStatuses),
      lte(transactions.createdAt, cutoff),
      ne(transactions.type, "Withdrawal"),
      ne(transactions.type, "Transfer"),
      or(ne(transactions.paymentProvider, "ASHTECHPAY"), isNull(transactions.providerTransactionId)),
    ),
  });

  for (const transaction of stale) {
    await db.transaction(async (tx) => {
      const current = await tx.query.transactions.findFirst({ where: eq(transactions.id, transaction.id) });
      if (!current || !activeStatuses.includes(current.status) || current.createdAt > cutoff) return;
      await tx.update(wallets)
        .set({ pending: sql`GREATEST(${wallets.pending} - ${current.amount}, 0)` })
        .where(eq(wallets.id, current.walletId ?? ""));
      await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, current.id));
    });
  }

  // Rebuild reservations from live transactions so a timed-out browser cannot
  // leave an orphaned pending amount on the wallet.
  const [userWallets, liveTransactions] = await Promise.all([
    db.select().from(wallets).where(eq(wallets.userId, userId)),
    db.select({ walletId: transactions.walletId, amount: transactions.amount })
      .from(transactions)
      .where(and(
        eq(transactions.userId, userId),
        inArray(transactions.status, activeStatuses),
        ne(transactions.type, "Withdrawal"),
        ne(transactions.type, "Transfer"),
      )),
  ]);
  const pendingByWallet = new Map<string, number>();
  for (const transaction of liveTransactions) {
    if (!transaction.walletId) continue;
    pendingByWallet.set(transaction.walletId, (pendingByWallet.get(transaction.walletId) ?? 0) + transaction.amount);
  }
  for (const wallet of userWallets) {
    const pending = pendingByWallet.get(wallet.id) ?? 0;
    if (wallet.pending !== pending) {
      await db.update(wallets).set({ pending }).where(eq(wallets.id, wallet.id));
    }
  }
}

async function bootstrap(req: Request) {
  const user = await ensureUser(req);
  await expireAndReconcilePending(user.id);
  const [userWallets, userTransactions, userExchanges, userLinks, userNotifications, userKyc, settings] = await Promise.all([
    db.select().from(wallets).where(eq(wallets.userId, user.id)),
    db.select().from(transactions).where(eq(transactions.userId, user.id)).orderBy(desc(transactions.createdAt)),
    db.select().from(exchanges).where(eq(exchanges.userId, user.id)).orderBy(desc(exchanges.requestedAt)),
    db.select().from(paymentLinks).where(eq(paymentLinks.userId, user.id)).orderBy(desc(paymentLinks.createdAt)),
    db.select().from(notifications).where(eq(notifications.userId, user.id)).orderBy(desc(notifications.createdAt)),
    db.query.kycVerifications.findFirst({ where: eq(kycVerifications.userId, user.id), orderBy: desc(kycVerifications.submittedAt) }),
    getPlatformSettings(),
  ]);
  return GetBootstrapResponse.parse({
    profile: { id: user.id, firstName: user.firstName, lastName: user.lastName, email: user.email, role: user.role, country: user.country, kycStatus: user.kycStatus },
    wallets: userWallets.map(formatWallet),
    transactions: userTransactions.map(formatTransaction),
    exchanges: userExchanges.map(formatExchange),
    links: userLinks.map((link) => presentPaymentLink(req, link)),
    notifications: userNotifications.map((notification) => ({ id: notification.id, title: notification.title, body: notification.body, read: notification.read })),
    kyc: userKyc ? { id: userKyc.id, userId: userKyc.userId, name: userKyc.name, country: userKyc.country, status: userKyc.status, documents: userKyc.documents, submittedAt: userKyc.submittedAt.toISOString() } : { id: "none", userId: user.id, name: `${user.firstName} ${user.lastName}`, country: user.country, status: user.kycStatus, documents: [], submittedAt: nowLabel() },
    feePercentage: Number(settings.feePercentage),
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
  const input = req.body as {
    amount?: number;
    currency?: string;
    country?: string;
    counterparty?: string;
    note?: string;
    feePayer?: string;
  };
  if (
    typeof input.amount !== "number" ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0 ||
    !input.currency ||
    !input.country ||
    !input.counterparty ||
    input.feePayer !== "sender"
  ) {
    res.status(400).json({ error: "Montant, devise, pays, destinataire et prise en charge des frais par l’expéditeur sont obligatoires." });
    return;
  }
  if (input.amount > 10_000_000) {
    res.status(400).json({ error: "Le montant maximum d’un transfert DrimPay est de 10 000 000 FCFA." });
    return;
  }
  const recipientMatch = /^(\+[1-9]\d{7,14})\s*·\s*(.+)$/.exec(input.counterparty.trim());
  if (!recipientMatch) {
    res.status(400).json({ error: "Le destinataire doit contenir un téléphone international et un opérateur Mobile Money." });
    return;
  }
  const countryCode = countryCodeForName(input.country);
  const operator = recipientMatch[2].trim();
  const operatorSlug = operatorSlugForName(operator);
  if (!countryCode || countryCode === "NE" || !operatorSlug) {
    res.status(400).json({ error: "Le pays ou l’opérateur Mobile Money sélectionné n’est pas pris en charge par DrimPay pour les transferts." });
    return;
  }
  const user = await ensureUser(req);
  const wallet = await db.query.wallets.findFirst({
    where: and(
      eq(wallets.userId, user.id),
      eq(wallets.code, countryCode),
      eq(wallets.currency, input.currency),
    ),
  });
  if (!wallet) {
    res.status(400).json({ error: "Le wallet source ne correspond pas au pays ou à la devise du transfert." });
    return;
  }
  try {
    const result = await submitDrimPayOutgoing({
      userId: user.id,
      wallet,
      amount: input.amount,
      countryCode,
      operator: operatorSlug,
      phone: recipientMatch[1],
      idempotencyKey: req.header("Idempotency-Key"),
      kind: "Transfer",
      counterparty: `Transfert Mobile Money · ${recipientMatch[1]} · ${operator}`,
    });
    res.status(result.existing ? 200 : 201).json({
      ok: true,
      message: result.existing
        ? "Cette demande de transfert existe déjà."
        : "Transfert en cours de traitement. Le wallet sera débité après confirmation DrimPay.",
      reference: result.reference,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      fee: result.fee,
      totalDebited: result.totalDebited,
      netAmount: result.amount,
      provider: "DRIMPAY",
    });
  } catch (error) {
    if (error instanceof DrimPayError) {
      respondWithPaymentProviderError(res, error, "DRIMPAY");
      return;
    }
    throw error;
  }
});

router.post("/v1/exchanges", async (req, res) => {
  res.status(501).json({ error: "Les échanges ne sont pas encore connectés à un service de paiement réel. Aucun wallet n’a été débité ni crédité." });
});

router.patch("/v1/exchanges/:id/decision", requireAdmin, async (req, res) => {
  res.status(501).json({ error: "Les décisions d’échange restent désactivées tant qu’un service de règlement réel n’est pas connecté." });
});

router.post("/v1/payment-links", async (req, res) => {
  const input = CreatePaymentLinkBody.parse(req.body);
  const user = await ensureUser(req);
  if (input.amountType === "FIXED" && (!input.amount || input.amount <= 0)) {
    res.status(400).json({ error: "Un montant fixe supérieur à zéro est requis." });
    return;
  }
  if (input.amountType === "CUSTOMER_CHOOSES" && input.amount != null && input.amount < 0) {
    res.status(400).json({ error: "Le montant minimum ne peut pas être négatif." });
    return;
  }
  if (input.amountType === "CUSTOMER_CHOOSES" && (!Number.isInteger(input.amountMin) || !Number.isInteger(input.amountMax) || input.amountMin < PUBLIC_PAYMENT_MIN_AMOUNT || input.amountMax > PUBLIC_PAYMENT_MAX_AMOUNT || input.amountMin > input.amountMax)) {
    res.status(400).json({ error: `Le montant libre doit être compris entre ${PUBLIC_PAYMENT_MIN_AMOUNT.toLocaleString("fr-FR")} et ${PUBLIC_PAYMENT_MAX_AMOUNT.toLocaleString("fr-FR")}, avec un minimum inférieur ou égal au maximum.` });
    return;
  }
  if (input.maxPayments !== null && (!Number.isInteger(input.maxPayments) || input.maxPayments < 1)) {
    res.status(400).json({ error: "La limite de paiements doit être un entier positif." });
    return;
  }
  if (input.afterPaymentAction === "REDIRECT") {
    if (!input.redirectUrl) {
      res.status(400).json({ error: "Une URL de redirection est requise." });
      return;
    }
    try {
      const redirectUrl = new URL(input.redirectUrl);
      if (!["http:", "https:"].includes(redirectUrl.protocol)) throw new Error("unsupported protocol");
    } catch {
      res.status(400).json({ error: "L’URL de redirection est invalide." });
      return;
    }
  }
  if (input.walletId) {
    const wallet = await db.query.wallets.findFirst({ where: and(eq(wallets.id, input.walletId), eq(wallets.userId, user.id)) });
    if (!wallet) {
      res.status(400).json({ error: "Le wallet de réception est invalide." });
      return;
    }
  }
  const reference = `MP-LINK-${randomBytes(4).toString("hex").toUpperCase()}`;
  const link = {
    id: crypto.randomUUID(),
    userId: user.id,
    slug: `${requestOrigin(req)}/pay/${randomBytes(8).toString("hex")}`,
    reference,
    productName: input.productName,
    amount: input.amount ?? 0,
    currency: input.currency,
    description: input.description,
    walletId: input.walletId,
    amountType: input.amountType,
    amountMin: input.amountType === "CUSTOMER_CHOOSES" ? input.amountMin : PUBLIC_PAYMENT_MIN_AMOUNT,
    amountMax: input.amountType === "CUSTOMER_CHOOSES" ? input.amountMax : PUBLIC_PAYMENT_MAX_AMOUNT,
    customerFields: input.customerFields,
    status: "Active",
    expiresAt: input.expiresAt,
    maxPayments: input.maxPayments,
    afterPaymentAction: input.afterPaymentAction,
    redirectUrl: input.redirectUrl,
    notifyApp: input.notifyApp,
    notifyEmail: input.notifyEmail,
    notifyWebhook: input.notifyWebhook,
    payments: 0,
  };
  const [created] = await db.insert(paymentLinks).values(link).returning();
  res.status(201).json(created);
});

router.get("/v1/public/payment-links/:token", async (req, res) => {
  const token = req.params.token;
  if (!/^[a-f0-9]{16}$/i.test(token)) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  const link = await db.query.paymentLinks.findFirst({ where: like(paymentLinks.slug, `%/${token}`) });
  if (!link) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  const expired = Boolean(link.expiresAt) && new Date(link.expiresAt).getTime() <= Date.now();
  const exhausted = link.maxPayments !== null && link.payments >= link.maxPayments;
  if (link.status !== "Active" || expired || exhausted) {
    res.status(410).json({ error: "Ce lien de paiement n’est plus disponible." });
    return;
  }
  res.json({
    slug: `${requestOrigin(req)}/pay/${token}`,
    reference: link.reference,
    productName: link.productName,
    amount: link.amount,
    currency: link.currency,
    description: link.description,
    amountType: link.amountType,
    amountMin: link.amountMin,
    amountMax: link.amountMax,
    customerFields: link.customerFields,
    status: link.status,
    expiresAt: link.expiresAt,
    maxPayments: link.maxPayments,
    afterPaymentAction: link.afterPaymentAction,
    redirectUrl: link.redirectUrl,
    payments: link.payments,
  });
});

router.post("/v1/public/payment-links/:token/payments", async (req, res) => {
  const input = CreatePublicPaymentBody.parse(req.body);
  const token = req.params.token;
  if (!/^[a-f0-9]{16}$/i.test(token)) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  const link = await db.query.paymentLinks.findFirst({ where: like(paymentLinks.slug, `%/${token}`) });
  if (!link) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  const expired = Boolean(link.expiresAt) && new Date(link.expiresAt).getTime() <= Date.now();
  const exhausted = link.maxPayments !== null && link.payments >= link.maxPayments;
  if (link.status !== "Active" || expired || exhausted) {
    res.status(410).json({ error: "Ce lien de paiement n’est plus disponible." });
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email)) {
    res.status(400).json({ error: "L’adresse e-mail est invalide." });
    return;
  }
  if (!input.fullName.trim() || !input.country.trim() || !input.operator.trim() || !input.phone.trim()) {
    res.status(400).json({ error: "Nom complet, pays, opérateur et téléphone sont obligatoires." });
    return;
  }
  if (link.amountType === "FIXED" && input.amount !== link.amount) {
    res.status(400).json({ error: "Le montant ne correspond pas à celui demandé par ce lien." });
    return;
  }
  if (input.amount <= 0 || !Number.isInteger(input.amount)) {
    res.status(400).json({ error: "Le montant doit être un entier positif." });
    return;
  }
  if (link.amountType === "CUSTOMER_CHOOSES" && (input.amount < link.amountMin || input.amount > link.amountMax)) {
    res.status(400).json({
      error: `Le montant doit être compris entre ${link.amountMin.toLocaleString("fr-FR")} et ${link.amountMax.toLocaleString("fr-FR")} ${link.currency}.`,
      code: "PAYMENT_AMOUNT_OUT_OF_RANGE",
    });
    return;
  }
  const countryCode = countryCodeForName(input.country);
  if (!countryCode || countryCode === "NE") {
    res.status(400).json({ error: "Les paiements ne sont pas encore disponibles dans ce pays." });
    return;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(input.phone)) {
    res.status(400).json({ error: "Le téléphone doit être au format international." });
    return;
  }
  const ownerWallet = link.walletId
    ? await db.query.wallets.findFirst({ where: and(eq(wallets.id, link.walletId), eq(wallets.userId, link.userId), eq(wallets.currency, link.currency), eq(wallets.status, "Active")) })
    : await db.query.wallets.findFirst({ where: and(eq(wallets.userId, link.userId), eq(wallets.code, countryCode), eq(wallets.currency, link.currency), eq(wallets.status, "Active")) });
  if (!ownerWallet) {
    res.status(400).json({ error: "Aucun wallet de réception actif ne correspond au pays choisi." });
    return;
  }
  const settings = await getPlatformSettings();
  const mulapayAmount = calculateMulapayNetAmount(input.amount, Number(settings.feePercentage));
  const providerSelection = await resolvePaymentProvider(countryCode, input.operator);
  if (input.operator === "Orange Money" && ORANGE_OTP_COUNTRIES.has(countryCode) && !input.operatorOtp) {
    res.status(400).json({ error: "Le code OTP Orange Money est requis pour ce pays." });
    return;
  }
  const orderIdHeader = req.header("Idempotency-Key");
  const paymentLinkIdempotencyKey = orderIdHeader && orderIdHeader.length <= 64 ? orderIdHeader : crypto.randomUUID();
  const orderId = `paylink_${link.id}_${paymentLinkIdempotencyKey}`;
  const existing = await db.query.transactions.findFirst({ where: eq(transactions.providerOrderId, orderId) });
  if (existing) {
    const existingMulapayAmount = calculateMulapayNetAmount(existing.amount, Number(settings.feePercentage));
    res.status(200).json({ ok: true, message: "Cette demande de paiement existe déjà.", reference: existing.reference, status: existing.status, paymentUrl: existing.paymentUrl, expiresAt: existing.expiresAt?.toISOString() ?? null, fee: existing.fee, netAmount: existing.netAmount, platformFee: existingMulapayAmount.platformFee, merchantAmount: existingMulapayAmount.merchantAmount });
    return;
  }
  try {
    let normalizedProvider: {
      reference: string;
      status: string;
      fee: number;
      netAmount: number;
      paymentUrl: string | null;
      expiresAt: Date | null;
      providerStatus: string;
      transactionId: string | null;
    };
    if (providerSelection.provider === "ASHTECHPAY") {
      const ashtechCurrency = ashtechPayCurrencyForCountry(countryCode);
      if (!ashtechCurrency) throw new AshtechPayError("AshtechPay ne prend pas en charge la devise de ce pays.", 400, "COUNTRY_NOT_SUPPORTED");
      const provider = await initiateAshtechPayin({
        amount: input.amount,
        currency: ashtechCurrency,
        countryCode,
        operator: providerSelection.operator,
        phone: ashtechPayPhoneForCountry(input.phone, countryCode),
        notifyUrl: ashtechPayWebhookUrl(),
        otp: input.operatorOtp,
      });
      normalizedProvider = {
        reference: provider.reference,
        status: ashtechStatusToTransactionStatus(provider.status),
        providerStatus: provider.status,
        fee: Math.round(provider.fee_amount),
        netAmount: provider.credited_amount,
        paymentUrl: provider.flow === "wave" ? provider.wave_url ?? null : null,
        expiresAt: null,
        transactionId: provider.transaction_id,
      };
    } else {
      const provider = await initiatePayin({
        amount: input.amount,
        currency: ownerWallet.currency,
        countryCode,
        operator: providerSelection.operator,
        phone: input.phone,
        orderId,
        webhookUrl: drimPayWebhookUrl(),
        description: `Paiement par lien · ${link.productName}`,
        operatorOtp: input.operatorOtp,
        metadata: { mulapay_payment_link_id: link.id, customer_name: input.fullName, customer_email: input.email },
      });
      normalizedProvider = {
        reference: provider.reference,
        status: providerStatusToTransactionStatus(provider.status),
        providerStatus: provider.status,
        fee: provider.fee,
        netAmount: provider.net_amount,
        paymentUrl: provider.payment_url ?? null,
        expiresAt: provider.expires_at ? new Date(provider.expires_at) : null,
        transactionId: null,
      };
    }
    await db.transaction(async (tx) => {
      await tx.update(wallets).set({ pending: sql`${wallets.pending} + ${input.amount}` }).where(eq(wallets.id, ownerWallet.id));
      await tx.insert(transactions).values({
        id: crypto.randomUUID(),
        userId: link.userId,
        walletId: ownerWallet.id,
        type: "Payment",
        paymentProvider: providerSelection.provider,
        // Le crédit du ledger intervient uniquement après le webhook signé.
        status: "Pending",
        amount: input.amount,
        netAmount: normalizedProvider.netAmount,
        paymentUrl: normalizedProvider.paymentUrl,
        expiresAt: normalizedProvider.expiresAt,
        fee: normalizedProvider.fee,
        platformFee: mulapayAmount.platformFee,
        merchantAmount: mulapayAmount.merchantAmount,
        currency: ownerWallet.currency,
        country: ownerWallet.country,
        counterparty: `Paiement par lien · ${link.productName}`,
        reference: normalizedProvider.reference,
        providerOrderId: orderId,
        providerTransactionId: normalizedProvider.transactionId,
      });
    });
    res.status(201).json({ ok: true, message: normalizedProvider.paymentUrl ? "Ouvrez le lien de paiement pour confirmer." : "Confirmez le paiement sur votre téléphone.", reference: normalizedProvider.reference, status: "Pending", paymentUrl: normalizedProvider.paymentUrl, expiresAt: normalizedProvider.expiresAt?.toISOString() ?? null, fee: normalizedProvider.fee, netAmount: normalizedProvider.netAmount, platformFee: mulapayAmount.platformFee, merchantAmount: mulapayAmount.merchantAmount, provider: providerSelection.provider });
  } catch (error) {
    if (error instanceof AshtechPayOtpRequiredError) {
      res.status(400).json({ error: error.message, code: error.code, otpRequired: true, reference: error.reference, ussdCode: error.ussdCode, provider: "ASHTECHPAY" });
      return;
    }
    if (error instanceof DrimPayError || error instanceof AshtechPayError) {
      respondWithPaymentProviderError(res, error, providerSelection.provider);
      return;
    }
    throw error;
  }
});

router.get("/v1/public/payment-links/:token/payments/:reference", async (req, res) => {
  const token = req.params.token;
  if (!/^[a-f0-9]{16}$/i.test(token)) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  const link = await db.query.paymentLinks.findFirst({ where: like(paymentLinks.slug, `%/${token}`) });
  if (!link) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  await expireAndReconcilePending(link.userId);
  const transaction = await db.query.transactions.findFirst({
    where: and(
      eq(transactions.reference, req.params.reference),
      eq(transactions.userId, link.userId),
      eq(transactions.type, "Payment"),
      like(transactions.providerOrderId, `paylink_${link.id}_%`),
    ),
  });
  if (!transaction) {
    res.status(404).json({ error: "Paiement introuvable." });
    return;
  }
  let providerStatus: string | null = null;
  if (transaction.paymentProvider === "ASHTECHPAY" && transaction.status !== "Completed" && transaction.providerTransactionId) {
    try {
      const provider = await getAshtechTransaction(transaction.providerTransactionId);
      providerStatus = ashtechStatusToTransactionStatus(provider.status);
    } catch {
      providerStatus = null;
    }
  }
  res.json({
    ok: true,
    reference: transaction.reference,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    fee: transaction.fee,
    netAmount: transaction.netAmount,
    platformFee: transaction.platformFee,
    merchantAmount: transaction.merchantAmount,
    paymentUrl: transaction.paymentUrl,
    expiresAt: transaction.expiresAt?.toISOString() ?? null,
    providerStatus,
    createdAt: transaction.createdAt.toISOString(),
  });
});

router.get("/v1/payment-links", async (req, res) => {
  const user = await ensureUser(req);
  const links = await db.select().from(paymentLinks).where(eq(paymentLinks.userId, user.id)).orderBy(desc(paymentLinks.createdAt));
  res.json(links.map((link) => presentPaymentLink(req, link)));
});

router.patch("/v1/payment-links/:id", async (req, res) => {
  const input = CreatePaymentLinkBody.parse(req.body);
  const user = await ensureUser(req);
  const existing = await db.query.paymentLinks.findFirst({ where: and(eq(paymentLinks.id, req.params.id), eq(paymentLinks.userId, user.id)) });
  if (!existing) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  if (input.amountType === "FIXED" && (!input.amount || input.amount <= 0)) {
    res.status(400).json({ error: "Un montant fixe supérieur à zéro est requis." });
    return;
  }
  if (input.amountType === "CUSTOMER_CHOOSES" && input.amount != null && input.amount < 0) {
    res.status(400).json({ error: "Le montant minimum ne peut pas être négatif." });
    return;
  }
  if (input.amountType === "CUSTOMER_CHOOSES" && (!Number.isInteger(input.amountMin) || !Number.isInteger(input.amountMax) || input.amountMin < PUBLIC_PAYMENT_MIN_AMOUNT || input.amountMax > PUBLIC_PAYMENT_MAX_AMOUNT || input.amountMin > input.amountMax)) {
    res.status(400).json({ error: `Le montant libre doit être compris entre ${PUBLIC_PAYMENT_MIN_AMOUNT.toLocaleString("fr-FR")} et ${PUBLIC_PAYMENT_MAX_AMOUNT.toLocaleString("fr-FR")}, avec un minimum inférieur ou égal au maximum.` });
    return;
  }
  if (input.maxPayments !== null && (!Number.isInteger(input.maxPayments) || input.maxPayments < 1)) {
    res.status(400).json({ error: "La limite de paiements doit être un entier positif." });
    return;
  }
  if (input.afterPaymentAction === "REDIRECT") {
    if (!input.redirectUrl) {
      res.status(400).json({ error: "Une URL de redirection est requise." });
      return;
    }
    try {
      const redirectUrl = new URL(input.redirectUrl);
      if (!["http:", "https:"].includes(redirectUrl.protocol)) throw new Error("unsupported protocol");
    } catch {
      res.status(400).json({ error: "L’URL de redirection est invalide." });
      return;
    }
  }
  if (input.walletId) {
    const wallet = await db.query.wallets.findFirst({ where: and(eq(wallets.id, input.walletId), eq(wallets.userId, user.id)) });
    if (!wallet) {
      res.status(400).json({ error: "Le wallet de réception est invalide." });
      return;
    }
  }
  const [updated] = await db.update(paymentLinks).set({
    productName: input.productName,
    description: input.description,
    amount: input.amount ?? 0,
    currency: input.currency,
    walletId: input.walletId,
    amountType: input.amountType,
    amountMin: input.amountType === "CUSTOMER_CHOOSES" ? input.amountMin : PUBLIC_PAYMENT_MIN_AMOUNT,
    amountMax: input.amountType === "CUSTOMER_CHOOSES" ? input.amountMax : PUBLIC_PAYMENT_MAX_AMOUNT,
    customerFields: input.customerFields,
    expiresAt: input.expiresAt,
    maxPayments: input.maxPayments,
    afterPaymentAction: input.afterPaymentAction,
    redirectUrl: input.redirectUrl,
    notifyApp: input.notifyApp,
    notifyEmail: input.notifyEmail,
    notifyWebhook: input.notifyWebhook,
  }).where(and(eq(paymentLinks.id, existing.id), eq(paymentLinks.userId, user.id))).returning();
  res.json(presentPaymentLink(req, updated));
});

router.delete("/v1/payment-links/:id", async (req, res) => {
  const user = await ensureUser(req);
  const [deleted] = await db.delete(paymentLinks)
    .where(and(eq(paymentLinks.id, req.params.id), eq(paymentLinks.userId, user.id)))
    .returning({ id: paymentLinks.id });
  if (!deleted) {
    res.status(404).json({ error: "Lien de paiement introuvable." });
    return;
  }
  res.json({ ok: true, message: "Lien de paiement supprimé définitivement.", reference: null });
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
    providerReference?: string;
  };
  const amount = input.amount;
  if (!input.walletId || typeof amount !== "number" || !Number.isInteger(amount) || amount <= 0 || input.method !== "mobile_money" || !input.country || !input.operator || !input.phone) {
    res.status(400).json({ error: "Pays, opérateur, téléphone et montant sont obligatoires." });
    return;
  }
  const validatedAmount = amount as number;
  const countryCode = countryCodeForName(input.country);
  if (!countryCode || countryCode === "NE") {
    res.status(400).json({ error: "Les dépôts ne sont pas encore disponibles dans ce pays." });
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
  const settings = await getPlatformSettings();
  const mulapayAmount = calculateMulapayNetAmount(validatedAmount, Number(settings.feePercentage));
  const providerSelection = await resolvePaymentProvider(countryCode, input.operator);
  const orderIdHeader = req.header("Idempotency-Key");
  const orderId = orderIdHeader && orderIdHeader.length <= 128 ? orderIdHeader : `order_${crypto.randomUUID()}`;
  const existing = await db.query.transactions.findFirst({ where: eq(transactions.providerOrderId, orderId) });
  if (existing) {
    res.status(200).json({
      ok: true,
      message: "Cette demande de dépôt existe déjà.",
      reference: existing.reference,
      status: existing.status,
      amount: existing.amount,
      currency: existing.currency,
      paymentUrl: existing.paymentUrl,
      expiresAt: existing.expiresAt?.toISOString() ?? null,
      fee: existing.fee,
      netAmount: existing.netAmount,
      platformFee: existing.platformFee,
      merchantAmount: existing.merchantAmount,
    });
    return;
  }

  try {
    let normalizedProvider: {
      reference: string;
      status: string;
      providerStatus: string;
      fee: number;
      netAmount: number;
      paymentUrl: string | null;
      expiresAt: Date | null;
      transactionId: string | null;
    };
    if (providerSelection.provider === "ASHTECHPAY") {
      const ashtechCurrency = ashtechPayCurrencyForCountry(countryCode);
      if (!ashtechCurrency) throw new AshtechPayError("AshtechPay ne prend pas en charge la devise de ce pays.", 400, "COUNTRY_NOT_SUPPORTED");
      const provider = await initiateAshtechPayin({
        amount: validatedAmount,
        currency: ashtechCurrency,
        countryCode,
        operator: providerSelection.operator,
        phone: ashtechPayPhoneForCountry(input.phone, countryCode),
        reference: input.providerReference,
        notifyUrl: ashtechPayWebhookUrl(),
        otp: input.operatorOtp,
      });
      normalizedProvider = {
        reference: provider.reference,
        status: ashtechStatusToTransactionStatus(provider.status),
        providerStatus: provider.status,
          fee: Math.round(provider.fee_amount),
        netAmount: provider.credited_amount,
        paymentUrl: provider.flow === "wave" ? provider.wave_url ?? null : null,
        expiresAt: null,
        transactionId: provider.transaction_id,
      };
    } else {
      const provider = await initiatePayin({
        amount: validatedAmount,
        currency: wallet.currency,
        countryCode,
        operator: providerSelection.operator,
        phone: input.phone,
        orderId,
        webhookUrl: drimPayWebhookUrl(),
        description: `Dépôt Mulapay · ${wallet.country}`,
        operatorOtp: input.operatorOtp,
        metadata: { mulapay_user_id: user.id, mulapay_wallet_id: wallet.id },
      });
      normalizedProvider = {
        reference: provider.reference,
        status: providerStatusToTransactionStatus(provider.status),
        providerStatus: provider.status,
        fee: Math.round(provider.fee),
        netAmount: provider.net_amount,
        paymentUrl: provider.payment_url ?? null,
        expiresAt: provider.expires_at ? new Date(provider.expires_at) : null,
        transactionId: null,
      };
    }
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
          paymentProvider: providerSelection.provider,
          status: normalizedProvider.status,
        amount: validatedAmount,
          netAmount: normalizedProvider.netAmount ?? null,
          platformFee: mulapayAmount.platformFee,
          merchantAmount: mulapayAmount.merchantAmount,
          paymentUrl: normalizedProvider.paymentUrl,
          expiresAt: normalizedProvider.expiresAt,
          fee: normalizedProvider.fee == null ? null : Math.round(normalizedProvider.fee),
        currency: wallet.currency,
        country: wallet.country,
        counterparty: `Dépôt Mobile Money · ${input.operator}`,
          reference: normalizedProvider.reference,
        providerOrderId: orderId,
        providerTransactionId: normalizedProvider.transactionId,
      });
    });
    res.status(201).json({
      ok: true,
      message: normalizedProvider.paymentUrl ? "Ouvrez le lien Wave pour confirmer le paiement." : "Confirmez le paiement sur votre téléphone.",
      reference: normalizedProvider.reference,
      status: normalizedProvider.providerStatus,
      paymentUrl: normalizedProvider.paymentUrl,
      expiresAt: normalizedProvider.expiresAt?.toISOString() ?? null,
      fee: normalizedProvider.fee,
      netAmount: normalizedProvider.netAmount,
      platformFee: mulapayAmount.platformFee,
      merchantAmount: mulapayAmount.merchantAmount,
      provider: providerSelection.provider,
    });
  } catch (error) {
    if (error instanceof AshtechPayOtpRequiredError) {
      res.status(400).json({
        error: error.message,
        code: error.code,
        otpRequired: true,
        reference: error.reference,
        ussdCode: error.ussdCode,
        provider: "ASHTECHPAY",
      });
      return;
    }
    if (error instanceof DrimPayError || error instanceof AshtechPayError) {
      respondWithPaymentProviderError(res, error, providerSelection.provider);
      return;
    }
    throw error;
  }
});

router.get("/v1/deposits/:reference", async (req, res) => {
  const user = await ensureUser(req);
  await expireAndReconcilePending(user.id);
  const transaction = await db.query.transactions.findFirst({
    where: and(eq(transactions.reference, req.params.reference), eq(transactions.userId, user.id), eq(transactions.type, "Deposit")),
  });
  if (!transaction) {
    res.status(404).json({ error: "Dépôt introuvable." });
    return;
  }
  res.json({
    ok: true,
    reference: transaction.reference,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    fee: transaction.fee,
    netAmount: transaction.netAmount,
    platformFee: transaction.platformFee,
    merchantAmount: transaction.merchantAmount,
    paymentUrl: transaction.paymentUrl,
    expiresAt: transaction.expiresAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
  });
});

router.get("/v1/withdrawals/:reference", async (req, res) => {
  const user = await ensureUser(req);
  const transaction = await db.query.transactions.findFirst({
    where: and(
      eq(transactions.reference, req.params.reference),
      eq(transactions.userId, user.id),
      eq(transactions.type, "Withdrawal"),
    ),
  });
  if (!transaction) {
    res.status(404).json({ error: "Retrait introuvable." });
    return;
  }
  res.json({
    ok: true,
    reference: transaction.reference,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    fee: transaction.fee,
    totalDebited: transaction.amount + (transaction.fee ?? 0),
    createdAt: transaction.createdAt.toISOString(),
  });
});

router.get("/v1/payments/:reference", async (req, res) => {
  const user = await ensureUser(req);
  await expireAndReconcilePending(user.id);
  const transaction = await db.query.transactions.findFirst({
    where: and(eq(transactions.reference, req.params.reference), eq(transactions.userId, user.id), eq(transactions.type, "Payment")),
  });
  if (!transaction) {
    res.status(404).json({ error: "Paiement introuvable." });
    return;
  }
  res.json({
    ok: true,
    reference: transaction.reference,
    status: transaction.status,
    amount: transaction.amount,
    currency: transaction.currency,
    fee: transaction.fee,
    netAmount: transaction.netAmount,
    paymentUrl: transaction.paymentUrl,
    expiresAt: transaction.expiresAt?.toISOString() ?? null,
    createdAt: transaction.createdAt.toISOString(),
  });
});

router.post("/v1/withdrawals", async (req, res) => {
  const input = req.body as {
    walletId?: string;
    amount?: number;
    country?: string;
    operator?: string;
    phone?: string;
    method?: string;
  };
  if (
    !input.walletId ||
    typeof input.amount !== "number" ||
    !Number.isInteger(input.amount) ||
    input.amount <= 0 ||
    !input.country ||
    !input.operator ||
    !input.phone ||
    input.method !== "mobile_money"
  ) {
    res.status(400).json({ error: "Wallet, montant, pays, opérateur, téléphone et méthode Mobile Money sont obligatoires." });
    return;
  }
  if (input.amount > 10_000_000) {
    res.status(400).json({ error: "Le montant maximum d’un retrait DrimPay est de 10 000 000 FCFA." });
    return;
  }
  const countryCode = countryCodeForName(input.country);
  if (!countryCode || countryCode === "NE") {
    res.status(400).json({ error: "Les retraits ne sont pas encore disponibles dans ce pays." });
    return;
  }
  if (!operatorSlugForName(input.operator)) {
    res.status(400).json({ error: "L’opérateur Mobile Money sélectionné n’est pas pris en charge." });
    return;
  }
  if (!/^\+[1-9]\d{7,14}$/.test(input.phone)) {
    res.status(400).json({ error: "Le téléphone doit être au format international, par exemple +22890000000." });
    return;
  }
  const requestedAmount = input.amount;
  const requestedCountry = input.country;
  const requestedOperator = input.operator;
  const requestedPhone = input.phone;
  const requestedWalletId = input.walletId;

  const user = await ensureUser(req);
  const wallet = await db.query.wallets.findFirst({
    where: and(eq(wallets.id, requestedWalletId), eq(wallets.userId, user.id), eq(wallets.code, countryCode)),
  });
  if (!wallet) {
    res.status(400).json({ error: "Le wallet sélectionné ne correspond pas au pays du retrait." });
    return;
  }

  const rawIdempotencyKey = req.header("Idempotency-Key");
  const orderId = rawIdempotencyKey && rawIdempotencyKey.length <= 128
    ? `mp_wd_${createHash("sha256").update(`${user.id}:${rawIdempotencyKey}`).digest("hex").slice(0, 56)}`
    : `mp_wd_${crypto.randomUUID()}`;
  const existing = await db.query.transactions.findFirst({
    where: and(eq(transactions.providerOrderId, orderId), eq(transactions.userId, user.id), eq(transactions.type, "Withdrawal")),
  });
  if (existing) {
    res.status(200).json({
      ok: true,
      message: "Cette demande de retrait existe déjà.",
      reference: existing.reference,
      status: existing.status,
      amount: existing.amount,
      currency: existing.currency,
      fee: existing.fee,
      totalDebited: existing.amount + (existing.fee ?? 0),
    });
    return;
  }

  const estimatedFee = estimateDrimPayPayoutFee(requestedAmount);
  const estimatedTotal = requestedAmount + estimatedFee;
  let localTransaction: typeof transactions.$inferSelect | undefined;
  try {
    if (!isDrimPayConfigured()) {
      throw new DrimPayError("Le service payout DrimPay n’est pas encore configuré.", 503, "DRIMPAY_NOT_CONFIGURED");
    }
    const webhookUrl = drimPayWebhookUrl();
    [localTransaction] = await db.transaction(async (tx) => {
      const reserved = await tx
        .update(wallets)
        .set({ pending: sql`${wallets.pending} + ${estimatedTotal}` })
        .where(and(
          eq(wallets.id, wallet.id),
          sql`${wallets.balance} - ${wallets.pending} >= ${estimatedTotal}`,
        ))
        .returning({ id: wallets.id });
      if (!reserved.length) throw new DrimPayError("Solde disponible insuffisant pour couvrir le montant et les frais du retrait.", 400, "INSUFFICIENT_FUNDS");

      return tx.insert(transactions).values({
        id: crypto.randomUUID(),
        userId: user.id,
        walletId: wallet.id,
        type: "Withdrawal",
        paymentProvider: "DRIMPAY",
        status: "Pending",
        amount: requestedAmount,
        currency: wallet.currency,
        country: wallet.country,
        counterparty: `Retrait Mobile Money · ${requestedOperator}`,
        reference: orderId,
        providerOrderId: orderId,
        fee: estimatedFee,
        netAmount: requestedAmount,
        merchantAmount: requestedAmount,
      }).returning();
    });

    const provider = await initiatePayout({
      amount: requestedAmount,
      currency: wallet.currency,
      countryCode,
      operator: requestedOperator,
      phone: requestedPhone,
      orderId,
      webhookUrl,
      description: `Retrait Mulapay · ${wallet.country}`,
      metadata: { mulapay_user_id: user.id, mulapay_wallet_id: wallet.id },
    });
    const providerTotal = provider.total_debited;
    if (
      provider.amount !== requestedAmount ||
      providerTotal !== provider.amount + provider.fee ||
      providerTotal <= 0
    ) {
      throw new DrimPayError("La réponse payout DrimPay est incohérente. Le retrait reste en attente de vérification.", 502, "INVALID_PAYOUT_RESPONSE");
    }

    await db.transaction(async (tx) => {
      await tx.update(wallets)
        .set({ pending: sql`${wallets.pending} + ${providerTotal - estimatedTotal}` })
        .where(eq(wallets.id, wallet.id));
      await tx.update(transactions).set({
        reference: provider.reference,
        fee: provider.fee,
        netAmount: provider.amount,
        merchantAmount: provider.amount,
      }).where(eq(transactions.id, localTransaction!.id));
    });
    res.status(201).json({
      ok: true,
      message: "Retrait en cours de traitement. Le wallet sera débité après confirmation DrimPay.",
      reference: provider.reference,
      status: provider.status,
      amount: provider.amount,
      currency: provider.currency,
      fee: provider.fee,
      totalDebited: providerTotal,
      provider: "DRIMPAY",
    });
  } catch (error) {
    if (localTransaction && (error instanceof DrimPayError ? error.statusCode < 500 : false)) {
      await db.transaction(async (tx) => {
        await tx.update(wallets)
          .set({ pending: sql`GREATEST(${wallets.pending} - ${estimatedTotal}, 0)` })
          .where(eq(wallets.id, wallet.id));
        await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, localTransaction!.id));
      });
    }
    if (error instanceof DrimPayError) {
      respondWithPaymentProviderError(res, error, "DRIMPAY");
      return;
    }
    throw error;
  }
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
  const settledTransactions = allTransactions.filter(item => ["Completed", "Failed", "Expired", "Cancelled", "Reversed"].includes(item.status));
  const completedTransactions = allTransactions.filter(item => item.status === "Completed");
  const successRate = settledTransactions.length ? Number(((completedTransactions.length / settledTransactions.length) * 100).toFixed(1)) : 0;
  res.json(GetAdminSummaryResponse.parse({ kycAwaiting: kyc.length, exchangeQueue: pendingExchanges.length, volume: allTransactions.reduce((sum, item) => sum + item.amount, 0), successRate }));
});

router.get("/v1/admin/settings", requireAdmin, async (_req, res) => {
  const settings = await getPlatformSettings();
  res.json(GetAdminSettingsResponse.parse({ feePercentage: Number(settings.feePercentage) }));
});

router.get("/v1/admin/payment-providers", requireAdmin, async (_req, res) => {
  res.json({
    providers: [
      { id: "DRIMPAY", label: "DrimPay", configured: isDrimPayConfigured() },
      { id: "ASHTECHPAY", label: "AshtechPay", configured: isAshtechPayConfigured() },
    ],
  });
});

router.get("/v1/admin/payment-provider-routes", requireAdmin, async (_req, res) => {
  const routes = await db.select().from(paymentProviderRoutes).orderBy(paymentProviderRoutes.country, paymentProviderRoutes.operator);
  res.json(routes);
});

router.put("/v1/admin/payment-provider-routes", requireAdmin, async (req, res) => {
  const input = req.body as {
    countryCode?: string;
    country?: string;
    operator?: string;
    providerOperator?: string;
    provider?: string;
    enabled?: boolean;
  };
  if (!input.countryCode || !input.country || !input.operator || !input.providerOperator || !input.provider) {
    res.status(400).json({ error: "Pays, opérateur, fournisseur et opérateur fournisseur sont requis." });
    return;
  }
  if (input.provider !== "DRIMPAY" && input.provider !== "ASHTECHPAY") {
    res.status(400).json({ error: "Fournisseur de paiement inconnu." });
    return;
  }
  if (input.provider === "DRIMPAY" && !isDrimPayConfigured()) {
    res.status(503).json({ error: "DrimPay ne peut pas être sélectionné tant que ses secrets serveur ne sont pas configurés." });
    return;
  }
  if (input.provider === "DRIMPAY" && !operatorSlugForName(input.providerOperator.trim())) {
    res.status(400).json({ error: "Cet opérateur n’est pas reconnu par DrimPay." });
    return;
  }
  if (input.provider === "ASHTECHPAY" && !isAshtechPayConfigured()) {
    res.status(503).json({ error: "AshtechPay ne peut pas être sélectionné tant que ses secrets serveur ne sont pas configurés." });
    return;
  }
  if (input.provider === "ASHTECHPAY" && !isAshtechPayOperatorSupported(input.countryCode, input.providerOperator)) {
    res.status(400).json({ error: "Cet opérateur n’est pas disponible chez AshtechPay pour le pays sélectionné." });
    return;
  }
  const [route] = await db.insert(paymentProviderRoutes).values({
    id: crypto.randomUUID(),
    countryCode: input.countryCode,
    country: input.country,
    operator: input.operator,
    providerOperator: input.providerOperator,
    provider: input.provider,
    enabled: input.enabled ?? true,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [paymentProviderRoutes.countryCode, paymentProviderRoutes.operator],
    set: {
      country: input.country,
      providerOperator: input.providerOperator,
      provider: input.provider,
      enabled: input.enabled ?? true,
      updatedAt: new Date(),
    },
  }).returning();
  res.json(route);
});

router.patch("/v1/admin/settings", requireAdmin, async (req, res) => {
  const input = UpdateAdminSettingsBody.parse(req.body);
  const settings = await getPlatformSettings();
  const [updated] = await db.update(platformSettings).set({ feePercentage: input.feePercentage.toFixed(2), updatedAt: new Date() }).where(eq(platformSettings.id, settings.id)).returning();
  res.json(UpdateAdminSettingsResponse.parse({ feePercentage: Number(updated.feePercentage) }));
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