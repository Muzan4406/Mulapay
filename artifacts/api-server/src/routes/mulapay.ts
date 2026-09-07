import { Router, type IRouter, type Request, type Response, type NextFunction } from "express";
import { getAuth } from "@clerk/express";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
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
  RequestKycUploadUrlBody,
  RequestKycUploadUrlResponse,
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
  type KycDocument,
  type KycDocumentKind,
} from "@workspace/db";
import { ObjectNotFoundError, ObjectStorageService } from "../lib/objectStorage";
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
const objectStorageService = new ObjectStorageService();
const KYC_DOCUMENT_KINDS = ["document_front", "document_back", "face_capture"] as const;

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
  if (!route) return null;
  const provider = route.provider as PaymentProvider;
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
  const eventId = req.header("X-DrimPay-Event-Id")?.trim() || createHash("sha256").update(rawBody).digest("hex");

  const result = await db.transaction(async (tx) => {
    const [event] = await tx.insert(paymentProviderWebhookEvents).values({
      id: crypto.randomUUID(),
      provider: "DRIMPAY",
      eventId,
    }).onConflictDoNothing({
      target: [paymentProviderWebhookEvents.provider, paymentProviderWebhookEvents.eventId],
    }).returning();
    if (!event) return { found: true, duplicate: true };
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
     return { found: true, duplicate: false };
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
      if (["Failed", "Expired", "Cancelled"].includes(nextStatus)) {
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: transaction.userId,
          title: transaction.type === "Transfer" ? "Transfert non abouti" : "Retrait non abouti",
          body: `Le ${transaction.type === "Transfer" ? "transfert" : "retrait"} de ${transaction.amount.toLocaleString("fr-FR")} ${transaction.currency} vers ${transaction.counterparty} est ${nextStatus === "Expired" ? "expiré" : nextStatus === "Cancelled" ? "annulé" : "échoué"}.`,
          read: false,
        });
      }
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

    await tx.update(transactions).set({ status: nextStatus }).where(eq(transactions.id, transaction.id));
    if (["Failed", "Expired", "Cancelled"].includes(nextStatus)) {
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: transaction.type === "Payment" ? "Paiement non abouti" : "Dépôt non abouti",
        body: `Le ${transaction.type === "Payment" ? "paiement" : "dépôt"} de ${transaction.amount.toLocaleString("fr-FR")} ${transaction.currency} n’a pas été confirmé.`,
        read: false,
      });
    }
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
  res.status(200).json({ received: true, duplicate: "duplicate" in result ? result.duplicate : false, event: payload.event ?? null });
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
      error: `Le montant minimum accepté par le service de paiement est de ${minimumAmountMatch[1]} ${minimumAmountMatch[2]}.`,
      code: "PAYMENT_AMOUNT_TOO_LOW",
    });
    return;
  }
  const isConfigurationError = error.code === "DRIMPAY_NOT_CONFIGURED" || error.code === "ASHTECHPAY_NOT_CONFIGURED";
  res.status(error.statusCode).json({
    error: isConfigurationError ? "Le service de paiement n’est pas encore configuré." : error.statusCode >= 500 ? "Le service de paiement est temporairement indisponible." : error.message,
    code: isConfigurationError ? "PAYMENT_SERVICE_NOT_CONFIGURED" : "PAYMENT_SERVICE_ERROR",
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
    };
  } catch (error) {
    if (localTransaction && (error instanceof DrimPayError ? error.statusCode < 500 : false)) {
      await db.transaction(async (tx) => {
        await tx.update(wallets)
          .set({ pending: sql`GREATEST(${wallets.pending} - ${estimatedTotal}, 0)` })
          .where(eq(wallets.id, input.wallet.id));
        await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, localTransaction!.id));
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: input.userId,
          title: input.kind === "Transfer" ? "Transfert échoué" : "Retrait échoué",
          body: `Votre ${input.kind === "Transfer" ? "transfert" : "retrait"} de ${input.amount.toLocaleString("fr-FR")} ${input.wallet.currency} n’a pas pu être lancé.`,
          read: false,
        });
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

    await tx.update(transactions).set({ status: nextStatus }).where(eq(transactions.id, transaction.id));
    if (["Failed", "Expired", "Cancelled"].includes(nextStatus)) {
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: transaction.userId,
        title: transaction.type === "Payment" ? "Paiement non abouti" : "Dépôt non abouti",
        body: `Le ${transaction.type === "Payment" ? "paiement" : "dépôt"} de ${transaction.amount.toLocaleString("fr-FR")} ${transaction.currency} n’a pas été confirmé.`,
        read: false,
      });
    }
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

async function reconcileAshtechTransaction(transaction: typeof transactions.$inferSelect) {
  if (
    transaction.paymentProvider !== "ASHTECHPAY" ||
    !transaction.providerTransactionId ||
    !["Pending", "Processing"].includes(transaction.status)
  ) {
    return transaction;
  }

  let provider: Awaited<ReturnType<typeof getAshtechTransaction>>;
  try {
    provider = await getAshtechTransaction(transaction.providerTransactionId);
  } catch (error) {
    console.warn("AshtechPay status check unavailable", {
      reference: transaction.reference,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return transaction;
  }

  const nextStatus = ashtechStatusToTransactionStatus(provider.status);
  if (nextStatus === "Pending" || provider.reference !== transaction.reference) return transaction;

  try {
    return await db.transaction(async (tx) => {
      const current = await tx.query.transactions.findFirst({ where: eq(transactions.id, transaction.id) });
      if (!current || !["Pending", "Processing"].includes(current.status)) return current ?? transaction;
      const wallet = await tx.query.wallets.findFirst({ where: eq(wallets.id, current.walletId ?? "") });
      if (!wallet) throw new Error("WALLET_NOT_FOUND");

      if (nextStatus === "Completed") {
        const merchantAmount = current.merchantAmount ?? provider.credited_amount;
        if (
          provider.amount !== current.amount ||
          provider.currency !== ashtechPayCurrencyForCountry(wallet.code) ||
          provider.credited_amount <= 0 ||
          provider.credited_amount > provider.amount ||
          merchantAmount <= 0 ||
          merchantAmount > provider.credited_amount
        ) {
          throw new Error("INVALID_ASHTECH_STATUS_RESPONSE");
        }
        await tx.update(wallets).set({ balance: sql`${wallets.balance} + ${merchantAmount}` }).where(eq(wallets.id, wallet.id));
        await tx.update(transactions).set({
          status: "Completed",
          netAmount: provider.credited_amount,
        }).where(eq(transactions.id, current.id));
        await tx.insert(ledgerEntries).values({
          id: crypto.randomUUID(),
          userId: current.userId,
          walletId: wallet.id,
          transactionId: current.id,
          entryType: "CREDIT",
          amount: merchantAmount,
          currency: current.currency,
          description: `${current.type === "Payment" ? "Paiement par lien" : "Dépôt AshtechPay"} confirmé par vérification sécurisée · ${current.reference}`,
        });
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: current.userId,
          title: current.type === "Payment" ? "Paiement reçu" : "Dépôt confirmé",
          body: `${merchantAmount.toLocaleString("fr-FR")} ${current.currency} ont été crédités sur le wallet ${wallet.country}.`,
          read: false,
        });
        return { ...current, status: "Completed", netAmount: provider.credited_amount };
      }

      await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, current.id));
      return { ...current, status: "Failed" };
    });
  } catch (error) {
    console.error("AshtechPay status reconciliation rejected", {
      reference: transaction.reference,
      message: error instanceof Error ? error.message : "unknown error",
    });
    return transaction;
  }
}

type MulapayRequest = Request & { mulapayUserId?: string; mulapayAuthMode?: "clerk" | "api_key"; mulapayScopes?: string[] };

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
   return { userId: stored.userId, scopes: stored.scopes };
}

function requiredApiScope(req: Request) {
  if (req.method === "GET" && req.path === "/v1/bootstrap") return "wallets:read";
  if (req.method === "GET" && (req.path.startsWith("/v1/deposits/") || req.path.startsWith("/v1/payments/") || req.path.startsWith("/v1/withdrawals/"))) return "transactions:read";
  if (req.method === "GET" && req.path === "/v1/payment-links") return "payment_links:read";
  if (req.method === "POST" && req.path === "/v1/deposits") return "deposits:write";
  if (req.method === "POST" && req.path === "/v1/withdrawals") return "withdrawals:write";
  if (req.method === "POST" && req.path === "/v1/transfers") return "transfers:write";
  if (req.method === "POST" && req.path === "/v1/exchanges") return "exchanges:write";
  if (req.method === "POST" && req.path === "/v1/payment-links") return "payment_links:write";
  if (req.method === "PATCH" && req.path.startsWith("/v1/payment-links/")) return "payment_links:write";
  if (req.method === "DELETE" && req.path.startsWith("/v1/payment-links/")) return "payment_links:write";
  if (req.method === "PATCH" && req.path.startsWith("/v1/notifications/")) return "wallets:write";
  if (req.method === "POST" && req.path === "/v1/kyc") return "kyc:write";
  return null;
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
   const apiKey = await resolveApiKeyUserId(req);
   if (apiKey) {
     const apiUser = await db.query.users.findFirst({ where: eq(users.id, apiKey.userId) });
     if (isPartnerApiPath(req) && (!apiUser || !isKycVerified(apiUser))) {
       res.status(403).json({
         error: "La vérification KYC est requise pour utiliser l’API partenaire.",
         code: "KYC_REQUIRED",
       });
       return;
     }
     const requiredScope = requiredApiScope(req);
     if (requiredScope && !apiKey.scopes.includes(requiredScope)) {
       res.status(403).json({ error: `Cette clé API n’a pas le scope requis : ${requiredScope}.`, code: "INSUFFICIENT_SCOPE" });
       return;
     }
     (req as MulapayRequest).mulapayUserId = apiKey.userId;
     (req as MulapayRequest).mulapayScopes = apiKey.scopes;
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

function isKycVerified(user: { kycStatus?: string | null }) {
  return user.kycStatus === "VERIFIE" || user.kycStatus === "VERIFIED";
}

function requireVerifiedKyc(user: { kycStatus?: string | null }, res: Response, feature: string) {
  if (isKycVerified(user)) return true;
  res.status(403).json({
    error: `La vérification KYC est requise pour accéder à ${feature}.`,
    code: "KYC_REQUIRED",
  });
  return false;
}

function isPartnerApiPath(req: Request) {
  return req.path.startsWith("/v1/")
    && req.path !== "/v1/bootstrap"
    && !req.path.startsWith("/v1/kyc")
    && !req.path.startsWith("/v1/notifications");
}

function normalizeKycDocuments(raw: unknown): KycDocument[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (typeof item === "object" && item !== null) {
      const value = item as Partial<KycDocument>;
      if (
        KYC_DOCUMENT_KINDS.includes(value.kind as KycDocumentKind)
        && typeof value.objectPath === "string"
        && /^\/objects\/uploads\/[a-zA-Z0-9-]+$/.test(value.objectPath)
        && typeof value.fileName === "string"
        && typeof value.contentType === "string"
        && typeof value.size === "number"
        && Number.isInteger(value.size)
        && value.size > 0
        && value.size <= 10 * 1024 * 1024
      ) {
        return [{ ...value, kind: value.kind as KycDocumentKind } as KycDocument];
      }
    }
    return [];
  });
}

function formatKyc(item: { id: string; userId: string; name: string; country: string; status: string; documents: unknown; details: Record<string, string>; submittedAt: Date }) {
  return {
    id: item.id,
    userId: item.userId,
    name: item.name,
    country: item.country,
    status: item.status,
    documents: normalizeKycDocuments(item.documents),
    details: item.details,
    submittedAt: item.submittedAt.toISOString(),
  };
}

function validateKycSubmission(details: Record<string, string>, documents: KycDocument[]) {
  const required = [
    "firstName",
    "lastName",
    "birthDate",
    "nationality",
    "documentType",
    "documentNumber",
    "documentExpiry",
  ];
  if (required.some((field) => typeof details[field] !== "string" || !details[field].trim())) return false;
  const expiry = new Date(`${details.documentExpiry}T23:59:59.999Z`);
  if (Number.isNaN(expiry.getTime()) || expiry <= new Date()) return false;
  const uploadedKinds = new Set(documents.map((item) => item.kind));
  const documentFilesComplete = KYC_DOCUMENT_KINDS.every((kind) => uploadedKinds.has(kind));
  return documentFilesComplete && details.faceCapture?.trim() === "manual_review";
}

async function ensureClerkUser(req: Request) {
  if (!getAuth(req).userId) throw new Error("AUTHENTICATION_REQUIRED");
  return ensureUser(req);
}

const DEFAULT_API_KEY_SCOPES = [
  "wallets:read",
  "wallets:write",
  "transactions:read",
  "deposits:write",
  "withdrawals:write",
  "transfers:write",
  "exchanges:write",
  "payment_links:read",
  "payment_links:write",
  "kyc:write",
];

router.get("/v1/api-keys", async (req, res) => {
  const user = await ensureClerkUser(req);
  if (!requireVerifiedKyc(user, res, "l’API partenaire")) return;
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
  if (!requireVerifiedKyc(user, res, "l’API partenaire")) return;
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
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: user.id,
    title: "Clé API créée",
    body: `La clé serveur « ${created.name} » a été créée. Conservez-la dans vos secrets d’environnement.`,
    read: false,
  });
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
  if (!requireVerifiedKyc(user, res, "l’API partenaire")) return;
  const [deleted] = await db.delete(apiKeys)
    .where(and(eq(apiKeys.id, req.params.id), eq(apiKeys.userId, user.id)))
    .returning({ id: apiKeys.id });
  if (!deleted) {
    res.status(404).json({ error: "Clé API introuvable." });
    return;
  }
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: user.id,
    title: "Clé API révoquée",
    body: "Une clé API de votre compte a été révoquée et ne peut plus authentifier de requêtes.",
    read: false,
  });
  res.json({ ok: true, message: "Clé API supprimée définitivement." });
});

function formatWallet(wallet: typeof wallets.$inferSelect) {
  return { id: wallet.id, country: wallet.country, code: wallet.code, currency: wallet.currency, balance: wallet.balance, pending: wallet.pending, status: wallet.status };
}

function formatTransaction(transaction: typeof transactions.$inferSelect) {
  return { ...transaction, createdAt: transaction.createdAt.toISOString() };
}

function formatExchange(exchange: typeof exchanges.$inferSelect) {
  return { ...exchange, fee: exchange.platformFee, rate: Number(exchange.rate), requestedAt: exchange.requestedAt.toISOString(), status: exchange.status === "PENDING_ADMIN" ? "Pending review" : exchange.status === "COMPLETED" ? "Completed" : exchange.status === "REJECTED" ? "Rejected" : exchange.status };
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
      await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, current.id));
    });
  }

  // Rebuild reservations from live transactions so a timed-out browser cannot
  // leave an orphaned pending amount on the wallet.
  const [userWallets, liveTransactions, pendingExchanges] = await Promise.all([
    db.select().from(wallets).where(eq(wallets.userId, userId)),
    db.select({ walletId: transactions.walletId, type: transactions.type, amount: transactions.amount, fee: transactions.fee })
      .from(transactions)
      .where(and(
        eq(transactions.userId, userId),
        inArray(transactions.status, activeStatuses),
      )),
    db.select({ source: exchanges.source, sourceWalletId: exchanges.sourceWalletId, amount: exchanges.amount })
      .from(exchanges)
      .where(and(
        eq(exchanges.userId, userId),
        eq(exchanges.status, "PENDING_ADMIN"),
      )),
  ]);
  const pendingByWallet = new Map<string, number>();
  for (const transaction of liveTransactions) {
    if (!transaction.walletId || (transaction.type !== "Withdrawal" && transaction.type !== "Transfer")) continue;
    const reservation = transaction.amount + (transaction.fee ?? 0);
    pendingByWallet.set(transaction.walletId, (pendingByWallet.get(transaction.walletId) ?? 0) + reservation);
  }
  for (const exchange of pendingExchanges) {
    const wallet = userWallets.find((item) => item.id === exchange.sourceWalletId) ?? userWallets.find((item) => item.country === exchange.source);
    if (!wallet) continue;
    pendingByWallet.set(wallet.id, (pendingByWallet.get(wallet.id) ?? 0) + exchange.amount);
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
    user.role === "ADMIN"
      ? db.select().from(exchanges).orderBy(desc(exchanges.requestedAt))
      : db.select().from(exchanges).where(eq(exchanges.userId, user.id)).orderBy(desc(exchanges.requestedAt)),
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
    notifications: userNotifications.map((notification) => ({ id: notification.id, title: notification.title, body: notification.body, read: notification.read, createdAt: notification.createdAt.toISOString() })),
    kyc: userKyc ? formatKyc(userKyc) : { id: "none", userId: user.id, name: `${user.firstName} ${user.lastName}`, country: user.country, status: user.kycStatus, documents: [], details: {}, submittedAt: nowLabel() },
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
  const providerSelection = await resolvePaymentProvider(countryCode, operator);
  if (!providerSelection) {
    res.status(503).json({ error: "Aucun routage de transfert actif n’est configuré pour ce pays et cet opérateur." });
    return;
  }
  if (providerSelection.provider !== "DRIMPAY") {
    res.status(503).json({ error: "Le fournisseur configuré ne prend pas encore en charge les transferts sortants." });
    return;
  }
  try {
    const result = await submitDrimPayOutgoing({
      userId: user.id,
      wallet,
      amount: input.amount,
      countryCode,
      operator: providerSelection.operator,
      phone: recipientMatch[1],
      idempotencyKey: req.header("Idempotency-Key"),
      kind: "Transfer",
      counterparty: `Transfert Mobile Money · ${recipientMatch[1]} · ${operator}`,
    });
    if (!result.existing) {
      await db.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: user.id,
        title: "Transfert initié",
        body: `${result.amount.toLocaleString("fr-FR")} ${result.currency} sont en cours d’envoi vers ${input.counterparty}.`,
        read: false,
      });
    }
    res.status(result.existing ? 200 : 201).json({
      ok: true,
      message: result.existing
        ? "Cette demande de transfert existe déjà."
        : "Transfert en cours de traitement. Le wallet sera débité après confirmation Mulapay.",
      reference: result.reference,
      status: result.status,
      amount: result.amount,
      currency: result.currency,
      fee: result.fee,
      totalDebited: result.totalDebited,
      netAmount: result.amount,
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
  const input = CreateExchangeBody.parse(req.body);
  if (!Number.isInteger(input.amount) || input.amount <= 0) {
    res.status(400).json({ error: "Le montant de l’échange doit être un entier positif." });
    return;
  }
  if (input.source === input.destination) {
    res.status(400).json({ error: "Les wallets source et destination doivent être différents." });
    return;
  }

  const user = await ensureUser(req);
  const [sourceWallet, destinationWallet, settings] = await Promise.all([
    db.query.wallets.findFirst({
      where: and(eq(wallets.userId, user.id), eq(wallets.country, input.source), eq(wallets.status, "Active")),
    }),
    db.query.wallets.findFirst({
      where: and(eq(wallets.userId, user.id), eq(wallets.country, input.destination), eq(wallets.status, "Active")),
    }),
    getPlatformSettings(),
  ]);
  if (!sourceWallet || !destinationWallet) {
    res.status(400).json({ error: "Les deux wallets sélectionnés doivent être actifs." });
    return;
  }
  if (sourceWallet.currency !== destinationWallet.currency) {
    res.status(400).json({ error: "Les échanges entre devises différentes ne sont pas encore disponibles." });
    return;
  }

  const exchangeAmount = calculateMulapayNetAmount(input.amount, Number(settings.feePercentage));
  try {
    const created = await db.transaction(async (tx) => {
      const reserved = await tx
        .update(wallets)
        .set({ pending: sql`${wallets.pending} + ${input.amount}` })
        .where(and(
          eq(wallets.id, sourceWallet.id),
          eq(wallets.status, "Active"),
          sql`${wallets.balance} - ${wallets.pending} >= ${input.amount}`,
        ))
        .returning({ id: wallets.id });
      if (!reserved.length) {
        throw new Error("EXCHANGE_INSUFFICIENT_FUNDS");
      }

      const [exchange] = await tx.insert(exchanges).values({
        id: crypto.randomUUID(),
        userId: user.id,
        sourceWalletId: sourceWallet.id,
        destinationWalletId: destinationWallet.id,
        source: sourceWallet.country,
        destination: destinationWallet.country,
        amount: input.amount,
        rate: "1.0000",
        receivedAmount: exchangeAmount.merchantAmount,
        platformFee: exchangeAmount.platformFee,
        status: "PENDING_ADMIN",
      }).returning();
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: user.id,
        title: "Demande d’échange envoyée",
        body: `${exchangeAmount.merchantAmount.toLocaleString("fr-FR")} ${sourceWallet.currency} seront disponibles sur le wallet ${destinationWallet.country} après approbation. Frais : ${exchangeAmount.platformFee.toLocaleString("fr-FR")} ${sourceWallet.currency}.`,
        read: false,
      });
      return exchange;
    });

    res.status(201).json(CreateExchangeResponse.parse({
      ok: true,
      message: `Demande d’échange envoyée. Le montant net après frais est de ${created.receivedAmount.toLocaleString("fr-FR")} ${sourceWallet.currency}.`,
      reference: created.id,
      status: "Pending review",
      fee: exchangeAmount.platformFee,
      netAmount: created.receivedAmount,
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "EXCHANGE_INSUFFICIENT_FUNDS") {
      res.status(400).json({ error: "Le solde disponible du wallet source est insuffisant pour cet échange." });
      return;
    }
    throw error;
  }
});

router.patch("/v1/exchanges/:id/decision", requireAdmin, async (req, res) => {
  const params = DecideExchangeParams.parse(req.params);
  const input = DecideExchangeBody.parse(req.body);
  if (input.decision !== "APPROVED" && input.decision !== "REJECTED") {
    res.status(400).json({ error: "La décision doit être APPROVED ou REJECTED." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(exchanges)
        .set({ status: "PROCESSING" })
        .where(and(eq(exchanges.id, params.id), eq(exchanges.status, "PENDING_ADMIN")))
        .returning();
      if (!claimed) {
        const existing = await tx.query.exchanges.findFirst({ where: eq(exchanges.id, params.id) });
        return existing ? { kind: "already_decided" as const } : { kind: "not_found" as const };
      }

      const sourceWallet = await tx.query.wallets.findFirst({
        where: and(
          eq(wallets.userId, claimed.userId),
          claimed.sourceWalletId ? eq(wallets.id, claimed.sourceWalletId) : eq(wallets.country, claimed.source),
          eq(wallets.status, "Active"),
        ),
      });
      const destinationWallet = await tx.query.wallets.findFirst({
        where: and(
          eq(wallets.userId, claimed.userId),
          claimed.destinationWalletId ? eq(wallets.id, claimed.destinationWalletId) : eq(wallets.country, claimed.destination),
          eq(wallets.status, "Active"),
        ),
      });
      if (!sourceWallet || !destinationWallet || sourceWallet.currency !== destinationWallet.currency) {
        throw new Error("EXCHANGE_WALLET_UNAVAILABLE");
      }

      if (input.decision === "REJECTED") {
        await tx.update(wallets)
          .set({ pending: sql`GREATEST(${wallets.pending} - ${claimed.amount}, 0)` })
          .where(eq(wallets.id, sourceWallet.id));
        await tx.update(exchanges).set({ status: "REJECTED" }).where(eq(exchanges.id, claimed.id));
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: claimed.userId,
          title: "Échange rejeté",
          body: `Votre demande d’échange de ${claimed.amount.toLocaleString("fr-FR")} ${sourceWallet.currency} vers ${claimed.destination} a été rejetée${input.reason ? ` : ${input.reason}` : "."}`,
          read: false,
        });
        return { kind: "rejected" as const, exchange: claimed };
      }

      const debited = await tx
        .update(wallets)
        .set({
          balance: sql`${wallets.balance} - ${claimed.amount}`,
          pending: sql`GREATEST(${wallets.pending} - ${claimed.amount}, 0)`,
        })
        .where(and(
          eq(wallets.id, sourceWallet.id),
          gte(wallets.balance, claimed.amount),
          gte(wallets.pending, claimed.amount),
        ))
        .returning({ id: wallets.id });
      if (!debited.length) {
        throw new Error("EXCHANGE_SOURCE_BALANCE_UNAVAILABLE");
      }
      await tx.update(wallets)
        .set({ balance: sql`${wallets.balance} + ${claimed.receivedAmount}` })
        .where(eq(wallets.id, destinationWallet.id));
      await tx.update(exchanges).set({ status: "COMPLETED" }).where(eq(exchanges.id, claimed.id));
      await tx.insert(ledgerEntries).values([
        {
          id: crypto.randomUUID(),
          userId: claimed.userId,
          walletId: sourceWallet.id,
          transactionId: null,
          entryType: "DEBIT",
          amount: claimed.amount,
          currency: sourceWallet.currency,
          description: `Échange vers ${destinationWallet.country} approuvé · frais ${claimed.platformFee} ${sourceWallet.currency}`,
        },
        {
          id: crypto.randomUUID(),
          userId: claimed.userId,
          walletId: destinationWallet.id,
          transactionId: null,
          entryType: "CREDIT",
          amount: claimed.receivedAmount,
          currency: destinationWallet.currency,
          description: `Échange depuis ${sourceWallet.country} approuvé`,
        },
      ]);
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: claimed.userId,
        title: "Échange approuvé",
        body: `${claimed.receivedAmount.toLocaleString("fr-FR")} ${destinationWallet.currency} ont été crédités sur votre wallet ${destinationWallet.country}.`,
        read: false,
      });
      return { kind: "approved" as const, exchange: claimed };
    });

    if (result.kind === "not_found") {
      res.status(404).json({ error: "Demande d’échange introuvable." });
      return;
    }
    if (result.kind === "already_decided") {
      res.status(409).json({ error: "Cette demande d’échange a déjà été traitée." });
      return;
    }
    const approved = result.kind === "approved";
    res.json(DecideExchangeResponse.parse({
      ok: true,
      message: approved ? "Échange approuvé et wallets mis à jour." : "Échange rejeté et réservation libérée.",
      reference: result.exchange.id,
      status: approved ? "Completed" : "Rejected",
      netAmount: result.exchange.receivedAmount,
    }));
  } catch (error) {
    if (error instanceof Error && error.message === "EXCHANGE_WALLET_UNAVAILABLE") {
      res.status(409).json({ error: "Les wallets de cet échange ne sont plus disponibles." });
      return;
    }
    if (error instanceof Error && error.message === "EXCHANGE_SOURCE_BALANCE_UNAVAILABLE") {
      res.status(409).json({ error: "Le solde réservé n’est plus disponible pour approuver cet échange." });
      return;
    }
    throw error;
  }
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
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: user.id,
    title: "Lien de paiement créé",
    body: `Le lien « ${created.productName} » est actif et prêt à recevoir des paiements.`,
    read: false,
  });
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
  if (!providerSelection) {
    res.status(503).json({ error: "Aucun routage de paiement actif n’est configuré pour ce pays et cet opérateur." });
    return;
  }
  if (input.operator === "Orange Money" && ORANGE_OTP_COUNTRIES.has(countryCode) && !input.operatorOtp) {
    res.status(400).json({ error: "Le code OTP Orange Money est requis pour ce pays." });
    return;
  }
  const orderIdHeader = req.header("Idempotency-Key");
   const paymentLinkIdempotencyKey = orderIdHeader && orderIdHeader.length <= 128 ? orderIdHeader : crypto.randomUUID();
  const orderId = `paylink_${link.id}_${paymentLinkIdempotencyKey}`;
  const existing = await db.query.transactions.findFirst({ where: eq(transactions.providerOrderId, orderId) });
  if (existing) {
    res.status(200).json({ ok: true, message: "Cette demande de paiement existe déjà.", reference: existing.reference, status: existing.status, paymentUrl: existing.paymentUrl, expiresAt: existing.expiresAt?.toISOString() ?? null, fee: existing.fee, netAmount: existing.netAmount, platformFee: existing.platformFee, merchantAmount: existing.merchantAmount });
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
        reference: orderId,
        notifyUrl: ashtechPayWebhookUrl(),
        otp: input.operatorOtp,
      });
      normalizedProvider = {
        reference: provider.reference,
        status: ashtechStatusToTransactionStatus(provider.status),
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
        fee: provider.fee,
        netAmount: provider.net_amount,
        paymentUrl: provider.payment_url ?? null,
        expiresAt: provider.expires_at ? new Date(provider.expires_at) : null,
        transactionId: null,
      };
    }
    await db.transaction(async (tx) => {
      await tx.insert(transactions).values({
        id: crypto.randomUUID(),
        userId: link.userId,
        walletId: ownerWallet.id,
        type: "Payment",
        paymentProvider: providerSelection.provider,
        // Le crédit du ledger intervient après confirmation fournisseur vérifiée.
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
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: link.userId,
        title: "Paiement initié",
        body: `${input.amount.toLocaleString("fr-FR")} ${ownerWallet.currency} sont en attente de confirmation pour le lien « ${link.productName} ».`,
        read: false,
      });
    });
    res.status(201).json({ ok: true, message: normalizedProvider.paymentUrl ? "Ouvrez le lien de paiement pour confirmer." : "Confirmez le paiement sur votre téléphone.", reference: normalizedProvider.reference, status: "Pending", paymentUrl: normalizedProvider.paymentUrl, expiresAt: normalizedProvider.expiresAt?.toISOString() ?? null, fee: normalizedProvider.fee, netAmount: normalizedProvider.netAmount, platformFee: mulapayAmount.platformFee, merchantAmount: mulapayAmount.merchantAmount });
  } catch (error) {
    if (error instanceof AshtechPayOtpRequiredError) {
      res.status(400).json({ error: "Le code OTP opérateur est requis pour continuer.", code: "OTP_REQUIRED", otpRequired: true });
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
  const reconciledTransaction = await reconcileAshtechTransaction(transaction);
  res.json({
    ok: true,
    reference: reconciledTransaction.reference,
    status: reconciledTransaction.status,
    amount: reconciledTransaction.amount,
    currency: reconciledTransaction.currency,
    fee: reconciledTransaction.fee,
    netAmount: reconciledTransaction.netAmount,
    platformFee: reconciledTransaction.platformFee,
    merchantAmount: reconciledTransaction.merchantAmount,
    paymentUrl: reconciledTransaction.paymentUrl,
    expiresAt: reconciledTransaction.expiresAt?.toISOString() ?? null,
    createdAt: reconciledTransaction.createdAt.toISOString(),
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
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: user.id,
    title: "Lien de paiement modifié",
    body: `Le lien « ${updated.productName} » a été mis à jour.`,
    read: false,
  });
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
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: user.id,
    title: "Lien de paiement supprimé",
    body: "Un lien de paiement de votre compte a été supprimé et ne peut plus recevoir de paiements.",
    read: false,
  });
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
  if (!providerSelection) {
    res.status(503).json({ error: "Aucun routage de dépôt actif n’est configuré pour ce pays et cet opérateur." });
    return;
  }
  const orderIdHeader = req.header("Idempotency-Key");
  const orderId = orderIdHeader && orderIdHeader.length <= 128 ? orderIdHeader : `order_${crypto.randomUUID()}`;
    const existing = await db.query.transactions.findFirst({
      where: and(
        eq(transactions.providerOrderId, orderId),
        eq(transactions.userId, user.id),
        eq(transactions.type, "Deposit"),
      ),
    });
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
         reference: orderId,
        notifyUrl: ashtechPayWebhookUrl(),
        otp: input.operatorOtp,
      });
      normalizedProvider = {
        reference: provider.reference,
        status: ashtechStatusToTransactionStatus(provider.status),
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
        fee: Math.round(provider.fee),
        netAmount: provider.net_amount,
        paymentUrl: provider.payment_url ?? null,
        expiresAt: provider.expires_at ? new Date(provider.expires_at) : null,
        transactionId: null,
      };
    }
    await db.transaction(async (tx) => {
      await tx.insert(transactions).values({
        id: crypto.randomUUID(),
        userId: user.id,
        walletId: wallet.id,
        type: "Deposit",
        paymentProvider: providerSelection.provider,
        // Le crédit du ledger intervient uniquement après le webhook signé.
        status: "Pending",
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
      await tx.insert(notifications).values({
        id: crypto.randomUUID(),
        userId: user.id,
        title: "Dépôt initié",
        body: `${validatedAmount.toLocaleString("fr-FR")} ${wallet.currency} sont en attente de confirmation sur votre wallet ${wallet.country}.`,
        read: false,
      });
    });
    res.status(201).json({
      ok: true,
      message: normalizedProvider.paymentUrl ? "Ouvrez le lien Wave pour confirmer le paiement." : "Confirmez le paiement sur votre téléphone.",
      reference: normalizedProvider.reference,
      status: "Pending",
      paymentUrl: normalizedProvider.paymentUrl,
      expiresAt: normalizedProvider.expiresAt?.toISOString() ?? null,
      fee: normalizedProvider.fee,
      netAmount: normalizedProvider.netAmount,
      platformFee: mulapayAmount.platformFee,
      merchantAmount: mulapayAmount.merchantAmount,
    });
  } catch (error) {
    if (error instanceof AshtechPayOtpRequiredError) {
      res.status(400).json({
        error: "Le code OTP opérateur est requis pour continuer.",
        code: "OTP_REQUIRED",
        otpRequired: true,
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
  const reconciledTransaction = await reconcileAshtechTransaction(transaction);
  res.json({
    ok: true,
    reference: reconciledTransaction.reference,
    status: reconciledTransaction.status,
    amount: reconciledTransaction.amount,
    currency: reconciledTransaction.currency,
    fee: reconciledTransaction.fee,
    netAmount: reconciledTransaction.netAmount,
    platformFee: reconciledTransaction.platformFee,
    merchantAmount: reconciledTransaction.merchantAmount,
    paymentUrl: reconciledTransaction.paymentUrl,
    expiresAt: reconciledTransaction.expiresAt?.toISOString() ?? null,
    createdAt: reconciledTransaction.createdAt.toISOString(),
  });
});

router.get("/v1/withdrawals/:reference", async (req, res) => {
  const user = await ensureUser(req);
  if (!requireVerifiedKyc(user, res, "les retraits")) return;
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
  const reconciledTransaction = await reconcileAshtechTransaction(transaction);
  res.json({
    ok: true,
    reference: reconciledTransaction.reference,
    status: reconciledTransaction.status,
    amount: reconciledTransaction.amount,
    currency: reconciledTransaction.currency,
    fee: reconciledTransaction.fee,
    netAmount: reconciledTransaction.netAmount,
    paymentUrl: reconciledTransaction.paymentUrl,
    expiresAt: reconciledTransaction.expiresAt?.toISOString() ?? null,
    createdAt: reconciledTransaction.createdAt.toISOString(),
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
  if (!requireVerifiedKyc(user, res, "les retraits")) return;
  const wallet = await db.query.wallets.findFirst({
    where: and(eq(wallets.id, requestedWalletId), eq(wallets.userId, user.id), eq(wallets.code, countryCode)),
  });
  if (!wallet) {
    res.status(400).json({ error: "Le wallet sélectionné ne correspond pas au pays du retrait." });
    return;
  }
  const providerSelection = await resolvePaymentProvider(countryCode, input.operator);
  if (!providerSelection) {
    res.status(503).json({ error: "Aucun routage de retrait actif n’est configuré pour ce pays et cet opérateur." });
    return;
  }
  if (providerSelection.provider !== "DRIMPAY") {
    res.status(503).json({ error: "Le fournisseur configuré ne prend pas encore en charge les retraits sortants." });
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
    await db.insert(notifications).values({
      id: crypto.randomUUID(),
      userId: user.id,
      title: "Retrait initié",
      body: `${requestedAmount.toLocaleString("fr-FR")} ${wallet.currency} sont en cours d’envoi vers ${requestedOperator}.`,
      read: false,
    });

    const provider = await initiatePayout({
      amount: requestedAmount,
      currency: wallet.currency,
      countryCode,
      operator: providerSelection.operator,
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
      message: "Retrait en cours de traitement. Le wallet sera débité après confirmation Mulapay.",
      reference: provider.reference,
      status: "Pending",
      amount: provider.amount,
      currency: provider.currency,
      fee: provider.fee,
      totalDebited: providerTotal,
    });
  } catch (error) {
    if (localTransaction && (error instanceof DrimPayError ? error.statusCode < 500 : false)) {
      await db.transaction(async (tx) => {
        await tx.update(wallets)
          .set({ pending: sql`GREATEST(${wallets.pending} - ${estimatedTotal}, 0)` })
          .where(eq(wallets.id, wallet.id));
        await tx.update(transactions).set({ status: "Failed" }).where(eq(transactions.id, localTransaction!.id));
        await tx.insert(notifications).values({
          id: crypto.randomUUID(),
          userId: user.id,
          title: "Retrait échoué",
          body: `Votre retrait de ${requestedAmount.toLocaleString("fr-FR")} ${wallet.currency} n’a pas pu être confirmé.`,
          read: false,
        });
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

router.patch("/v1/notifications/read-all", async (req, res) => {
  const user = await ensureUser(req);
  await db.update(notifications).set({ read: true }).where(eq(notifications.userId, user.id));
  res.json(MarkNotificationReadResponse.parse({ ok: true, message: "Toutes les notifications sont marquées comme lues.", reference: null }));
});

router.post("/v1/kyc/uploads/request-url", async (req, res) => {
  const user = await ensureUser(req);
  const input = RequestKycUploadUrlBody.parse(req.body);
  if (!Number.isInteger(input.size)) {
    res.status(400).json({ error: "La taille du fichier doit être un entier." });
    return;
  }
  try {
    const { uploadURL, objectPath } = await objectStorageService.createUploadSession(user.id, {
      contentType: input.contentType,
      size: input.size,
    });
    res.json(RequestKycUploadUrlResponse.parse({
      uploadURL,
      objectPath,
      metadata: input,
    }));
  } catch {
    res.status(503).json({
      error: "Le stockage privé des documents est momentanément indisponible. Votre dossier n’a pas été envoyé.",
      code: "OBJECT_STORAGE_UNAVAILABLE",
    });
  }
});

router.put("/v1/kyc/uploads/:token", async (req, res) => {
  const user = await ensureUser(req);
  const token = Array.isArray(req.params.token) ? req.params.token[0] : req.params.token;
  const contentType = (req.headers["content-type"] ?? "").split(";")[0].trim();
  if (!Buffer.isBuffer(req.body) || !["image/jpeg", "image/png", "image/webp"].includes(contentType)) {
    res.status(400).json({ error: "Le fichier KYC doit être une image JPEG, PNG ou WebP." });
    return;
  }
  try {
    await objectStorageService.uploadPendingObject(token, user.id, req.body, contentType);
    res.json({ ok: true });
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Session d’upload KYC expirée ou invalide." });
      return;
    }
    res.status(503).json({ error: error instanceof Error ? error.message : "Le document KYC n’a pas pu être enregistré." });
  }
});

router.post("/v1/kyc", async (req, res) => {
  const input = SubmitKycBody.parse(req.body);
  const user = await ensureUser(req);
  const documents = normalizeKycDocuments(input.documents);
  if (documents.length !== 3 || !validateKycSubmission(input.details ?? {}, documents)) {
    res.status(400).json({
      error: "Le dossier KYC est incomplet ou contient un document expiré.",
      code: "INCOMPLETE_KYC",
    });
    return;
  }
  try {
    await Promise.all(documents.map((document) => objectStorageService.getObjectEntityFile(document.objectPath)));
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(422).json({
        error: "Au moins un document KYC n’a pas été enregistré dans le stockage privé. Réimportez les images concernées.",
        code: "KYC_DOCUMENT_NOT_FOUND",
      });
      return;
    }
    res.status(503).json({
      error: "Le stockage privé des documents est momentanément indisponible. Le dossier n’a pas été enregistré.",
      code: "OBJECT_STORAGE_UNAVAILABLE",
    });
    return;
  }
  const [kyc] = await db.insert(kycVerifications).values({ id: crypto.randomUUID(), userId: user.id, name: `${user.firstName} ${user.lastName}`, country: input.country, status: "EN_ATTENTE", documents, details: input.details ?? {} }).returning();
  await db.update(users).set({ kycStatus: "EN_ATTENTE" }).where(eq(users.id, user.id));
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: user.id,
    title: "Dossier KYC envoyé",
    body: "Votre dossier de vérification a été transmis à l’équipe conformité.",
    read: false,
  });
  res.status(201).json(formatKyc(kyc));
});

router.get("/v1/admin/summary", requireAdmin, async (_req, res) => {
  const [kyc, pendingExchanges, allTransactions] = await Promise.all([
    db.select().from(kycVerifications).where(or(eq(kycVerifications.status, "EN_ATTENTE"), eq(kycVerifications.status, "A_REVOIR"))),
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
  res.json(result.map(formatKyc));
});

router.get("/v1/admin/kyc/:id/documents/:kind", requireAdmin, async (req, res) => {
  const kycId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  const documentKind = Array.isArray(req.params.kind) ? req.params.kind[0] : req.params.kind;
  if (!KYC_DOCUMENT_KINDS.includes(documentKind as KycDocumentKind)) {
    res.status(404).json({ error: "Document KYC introuvable." });
    return;
  }
  const kyc = await db.query.kycVerifications.findFirst({ where: eq(kycVerifications.id, kycId) });
  const document = normalizeKycDocuments(kyc?.documents).find((item) => item.kind === documentKind);
  if (!document) {
    res.status(404).json({ error: "Document KYC introuvable." });
    return;
  }
  try {
    const file = await objectStorageService.getObjectEntityFile(document.objectPath);
    const downloaded = await objectStorageService.downloadObject(file);
    res.setHeader("Content-Type", downloaded.contentType);
    if (downloaded.contentLength) res.setHeader("Content-Length", String(downloaded.contentLength));
    res.setHeader("Cache-Control", "private, no-store");
    res.setHeader("Content-Disposition", `inline; filename="${document.fileName.replace(/["\\\r\n]/g, "_")}"`);
    Readable.fromWeb(downloaded.stream as ReadableStream<Uint8Array>).pipe(res);
  } catch (error) {
    if (error instanceof ObjectNotFoundError) {
      res.status(404).json({ error: "Document KYC introuvable." });
      return;
    }
    throw error;
  }
});

router.patch("/v1/admin/kyc/:id/decision", requireAdmin, async (req, res) => {
  const params = DecideKycParams.parse(req.params);
  const input = DecideKycBody.parse(req.body);
  const status = input.decision === "REVIEW" ? "A_REVOIR" : input.decision === "VERIFIED" || input.decision === "APPROVED" ? "VERIFIE" : "REFUSE";
  const existing = await db.query.kycVerifications.findFirst({ where: eq(kycVerifications.id, params.id) });
  if (!existing) {
    res.status(404).json({ error: "Dossier KYC introuvable." });
    return;
  }
  await db.update(kycVerifications).set({ status }).where(eq(kycVerifications.id, params.id));
  await db.update(users).set({ kycStatus: status }).where(eq(users.id, existing.userId));
  await db.insert(notifications).values({
    id: crypto.randomUUID(),
    userId: existing.userId,
    title: status === "VERIFIE" ? "KYC approuvé" : status === "A_REVOIR" ? "Informations KYC requises" : "KYC refusé",
    body: input.reason || (status === "A_REVOIR" ? "Des informations supplémentaires sont nécessaires pour terminer votre vérification." : "Votre dossier a été traité par l’équipe conformité."),
    read: false,
  });
  res.json(DecideKycResponse.parse({ ok: true, message: "Décision KYC enregistrée.", reference: null }));
});

router.get("/v1/admin/transactions", requireAdmin, async (_req, res) => {
  const result = await db.select().from(transactions).orderBy(desc(transactions.createdAt));
  res.json(result.map(formatTransaction));
});

export default router;