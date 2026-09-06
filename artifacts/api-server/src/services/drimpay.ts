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
  order_id: string;
  status: string;
  amount: number;
  fee: number;
  total_debited: number;
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
  "Moov Money": "moov",
  "MTN MoMo": "mtn",
  "Orange Money": "orange",
  Wave: "wave",
  "Airtel Money": "airtel",
  Wizall: "wizall",
  Vodacom: "vodacom",
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
  return OPERATOR_SLUGS[operator];
}

export function drimPayWebhookUrl() {
  const url = process.env.DRIMPAY_WEBHOOK_URL;
  if (!url) {
    throw new DrimPayConfigurationError("DRIMPAY_WEBHOOK_URL n’est pas configurée.");
  }
  if (!url.startsWith("https://")) {
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
    apiKey();
    drimPayWebhookUrl();
    return true;
  } catch {
    return false;
  }
}

async function request<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${DRIMPAY_BASE_URL}${path}`, {
    ...init,
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
  return request<DrimPayPayinResponse>("/payin/initiate", {
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
}

export async function initiatePayout(input: DrimPayPayoutInput) {
  const operator = normalizeDrimPayOperator(input.operator);
  return request<DrimPayPayoutResponse>("/payout/send", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      country_code: input.countryCode,
      operator,
      phone: input.phone,
      order_id: input.orderId,
      webhook_url: input.webhookUrl,
      ...(input.description ? { description: input.description } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }),
  });
}

export async function getPayin(reference: string) {
  return request<DrimPayPayinResponse>(`/payin/${encodeURIComponent(reference)}`);
}

export function providerStatusToTransactionStatus(status: string) {
  return ({
    queued: "Pending",
    pending: "Pending",
    processing: "Processing",
    success: "Completed",
    failed: "Failed",
    expired: "Expired",
    cancelled: "Cancelled",
    reversed: "Reversed",
  } as Record<string, string>)[status] ?? "Pending";
}