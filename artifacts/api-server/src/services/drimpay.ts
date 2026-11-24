import { createHmac, timingSafeEqual } from "node:crypto";

export type DrimPayPayinInput = {
  amount: number;
  currency: string;
  countryCode: string;
  operator: string;
  phone: string;
  orderId: string;
  webhookUrl: string;
  description?: string;
  expiresInMinutes?: 2 | 5 | 10;
  operatorOtp?: string;
  metadata?: Record<string, string>;
};

export type DrimPayPayinResponse = {
  reference: string;
  order_id: string;
  status: string;
  amount: number;
  fee: number;
  net_amount: number;
  currency: string;
  country_code: string;
  operator: string;
  phone: string;
  mode: string;
  payment_url?: string;
  expires_at: string;
  webhook_url?: string;
  message?: string;
  created_at: string;
  idempotent?: boolean;
};

export type DrimPayPayoutInput = {
  amount: number;
  currency: string;
  countryCode: string;
  operator: string;
  phone: string;
  orderId: string;
  webhookUrl: string;
  description?: string;
  metadata?: Record<string, string>;
};

export type DrimPayPayoutResponse = {
  id?: string;
  reference: string;
  external_ref?: string;
  order_id?: string;
  status: string;
  amount: number;
  fee: number;
  total_debit: number;
  net_amount?: number;
  currency: string;
  country_code: string;
  operator: string;
  phone: string;
  wallet_balance_after?: number;
  mode?: string;
  created_at: string;
};

export type DrimPayWebhookPayload = {
  event?: string;
  reference: string;
  order_id?: string;
  status: string;
  amount: number;
  fee?: number;
  net_amount?: number;
  currency: string;
  country_code: string;
  operator: string;
  phone: string;
  mode?: string;
  failure_reason?: string | null;
  metadata?: Record<string, unknown>;
  created_at?: string;
  updated_at?: string;
};

export class DrimPayError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly code = "DRIMPAY_ERROR",
  ) {
    super(message);
    this.name = "DrimPayError";
  }
}

export class DrimPayConfigurationError extends DrimPayError {
  constructor(message: string) {
    super(message, 503, "DRIMPAY_NOT_CONFIGURED");
    this.name = "DrimPayConfigurationError";
  }
}

const DRIMPAY_BASE_URL = "https://drimpay.com/api/v2";

const OPERATOR_SLUGS: Record<string, string> = {
  "Mixx by Yas": "tmoney",
  TMoney: "tmoney",
  "Moov Money": "moov",
  "MTN MoMo": "mtn",
  "MTN Mobile Money": "mtn",
  "MTN Money": "mtn",
  MTN: "mtn",
  "Orange Money": "orange",
  Orange: "orange",
  Wave: "wave",
  "Wave Money": "wave",
  Celtiis: "celtiis",
  Free: "free",
  "Free Money": "free",
  "Airtel Money": "airtel",
  Wizall: "wizall",
  Vodacom: "vodacom",
};

const DRIMPAY_COUNTRY_OPERATORS: Record<string, Set<string>> = {
  TG: new Set(["tmoney", "moov"]),
  BJ: new Set(["mtn", "moov", "celtiis"]),
  BF: new Set(["orange", "moov", "wave"]),
  ML: new Set(["orange", "moov"]),
  SN: new Set(["orange", "wave", "free"]),
  CI: new Set(["mtn", "orange", "wave", "moov"]),
};

export const COUNTRY_CODES: Record<string, string> = {
  Togo: "TG",
  Bénin: "BJ",
  Benin: "BJ",
  "Côte d’Ivoire": "CI",
  "Côte d'Ivoire": "CI",
  "Burkina Faso": "BF",
  Sénégal: "SN",
  Senegal: "SN",
  Mali: "ML",
  Niger: "NE",
};

export function countryCodeForName(country: string) {
  return COUNTRY_CODES[country];
}

export function operatorSlugForName(operator: string) {
  const trimmed = operator.trim();
  return OPERATOR_SLUGS[trimmed] ?? (Object.values(OPERATOR_SLUGS).includes(trimmed.toLowerCase()) ? trimmed.toLowerCase() : undefined);
}

export function isDrimPayRouteSupported(countryCode: string, operator: string) {
  const slug = operatorSlugForName(operator);
  return Boolean(slug && DRIMPAY_COUNTRY_OPERATORS[countryCode]?.has(slug));
}

export function drimPayWebhookUrl() {
  const url = process.env.DRIMPAY_WEBHOOK_URL;
  if (!url) {
    throw new DrimPayConfigurationError("DRIMPAY_WEBHOOK_URL n’est pas configurée.");
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new DrimPayConfigurationError("DRIMPAY_WEBHOOK_URL doit être une URL HTTPS publique.");
  }
  if (parsed.protocol !== "https:" || !parsed.hostname || parsed.username || parsed.password) {
    throw new DrimPayConfigurationError("DRIMPAY_WEBHOOK_URL doit être une URL HTTPS publique.");
  }
  return url;
}

function apiKey() {
  const value = process.env.DRIMPAY_API_KEY;
  if (!value) {
    throw new DrimPayConfigurationError("La clé API DrimPay n’est pas configurée.");
  }
  if (!value.startsWith("dp_live_sk_")) {
    throw new DrimPayConfigurationError("La clé DrimPay doit être une clé de production dp_live_sk_.");
  }
  return value;
}

export function isDrimPayConfigured() {
  try {
    if (process.env.NODE_ENV !== "production") return false;
    apiKey();
    drimPayWebhookUrl();
    if (!process.env.DRIMPAY_WEBHOOK_SECRET?.trim()) {
      throw new DrimPayConfigurationError("Le secret webhook DrimPay correspondant à la clé API n’est pas configuré.");
    }
    return true;
  } catch {
    return false;
  }
}

export function verifyDrimPayWebhookSignature(
  header: string | undefined,
  rawBody: Buffer,
  secret = process.env.DRIMPAY_WEBHOOK_SECRET,
  timestampHeader?: string,
) {
  if (!secret || !header) return false;
  const values = new Map<string, string>();
  for (const part of header.split(",")) {
    const [key, value] = part.trim().split("=", 2);
    if (!key || !value || values.has(key)) return false;
    values.set(key, value);
  }
  const timestamp = values.get("t");
  const signature = values.get("v1");
  if (!timestamp || !/^\d{10}$/.test(timestamp) || !signature || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  if (timestampHeader !== undefined && timestampHeader !== timestamp) return false;
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody.toString("utf8")}`).digest();
  const provided = Buffer.from(signature, "hex");
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

function assertLiveRuntime() {
  if (process.env.NODE_ENV !== "production") {
    throw new DrimPayConfigurationError("Les appels à DrimPay Production sont désactivés hors de l’environnement de production.");
  }
}

async function request<T>(path: string, init: RequestInit = {}) {
  assertLiveRuntime();
  const response = await fetch(`${DRIMPAY_BASE_URL}${path}`, {
    ...init,
    signal: init.signal ?? AbortSignal.timeout(20_000),
    headers: {
      Authorization: `Bearer ${apiKey()}`,
      "Content-Type": "application/json",
      ...(init.headers ?? {}),
    },
  });

  const raw = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    body = {};
  }

  if (!response.ok) {
    const code = typeof body.error === "string" ? body.error : "DRIMPAY_ERROR";
    const message = typeof body.message === "string" ? body.message : `DrimPay a répondu avec HTTP ${response.status}.`;
    throw new DrimPayError(message, response.status, code);
  }

  return body as T;
}

export function normalizeDrimPayOperator(operator: string) {
  const slug = operatorSlugForName(operator);
  if (!slug) {
    throw new DrimPayError(`Opérateur Mobile Money non pris en charge : ${operator}.`, 400, "INVALID_OPERATOR");
  }
  return slug;
}

export async function initiatePayin(input: DrimPayPayinInput) {
  const operator = normalizeDrimPayOperator(input.operator);
  const response = await request<DrimPayPayinResponse>("/payin/initiate", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      country_code: input.countryCode,
      operator,
      phone: input.phone,
      order_id: input.orderId,
      webhook_url: input.webhookUrl,
      description: input.description,
      expires_in_minutes: input.expiresInMinutes ?? 5,
      ...(input.operatorOtp ? { operator_otp: input.operatorOtp } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }),
  });
  if (
    response.mode !== "live" ||
    !response.reference ||
    response.order_id !== input.orderId ||
    response.amount !== input.amount ||
    response.currency !== input.currency ||
    response.country_code !== input.countryCode ||
    operatorSlugForName(response.operator) !== operator ||
    !Number.isSafeInteger(response.fee) ||
    response.fee < 0 ||
    !Number.isSafeInteger(response.net_amount) ||
    response.net_amount <= 0 ||
    response.net_amount > response.amount ||
    !Number.isFinite(Date.parse(response.expires_at))
  ) {
    throw new DrimPayError("La réponse Pay-in DrimPay ne correspond pas à la demande de production.", 502, "INVALID_PAYIN_RESPONSE");
  }
  return response;
}

export async function initiatePayout(input: DrimPayPayoutInput) {
  const operator = normalizeDrimPayOperator(input.operator);
  const response = await request<DrimPayPayoutResponse>("/payout/initiate", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      country_code: input.countryCode,
      operator,
      phone: input.phone,
      external_ref: input.orderId,
      webhook_url: input.webhookUrl,
      ...(input.description ? { description: input.description } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }),
  });
  if (
    response.mode !== "live" ||
    !response.reference ||
    (response.external_ref ?? response.order_id) !== input.orderId ||
    response.amount !== input.amount ||
    response.currency !== input.currency ||
    response.country_code !== input.countryCode ||
    operatorSlugForName(response.operator) !== operator ||
    !Number.isSafeInteger(response.fee) ||
    response.fee < 0 ||
    !Number.isSafeInteger(response.total_debit) ||
    response.total_debit < response.amount
  ) {
    throw new DrimPayError("La réponse Payout DrimPay ne correspond pas à la demande de production.", 502, "INVALID_PAYOUT_RESPONSE");
  }
  return response;
}

export async function getPayin(reference: string) {
  return request<DrimPayPayinResponse>(`/payin/${encodeURIComponent(reference)}`);
}

export async function getPayout(reference: string) {
  return request<DrimPayPayoutResponse>(`/payout/${encodeURIComponent(reference)}`);
}

export function providerStatusToTransactionStatus(status: string) {
  const normalized = status.trim().toLowerCase();
  return ({
    queued: "Pending",
    pending: "Pending",
    processing: "Processing",
    success: "Completed",
    completed: "Completed",
    failed: "Failed",
    expired: "Expired",
    cancelled: "Cancelled",
    reversed: "Reversed",
  } as Record<string, string>)[normalized] ?? "Pending";
}