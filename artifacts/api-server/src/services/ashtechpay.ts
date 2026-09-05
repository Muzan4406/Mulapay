export type AshtechPayinInput = {
  amount: number;
  currency: string;
  phone: string;
  operator: string;
  countryCode: string;
  reference?: string;
  notifyUrl: string;
  otp?: string;
};

export type AshtechPayinResponse = {
  transaction_id: string;
  reference: string;
  status: string;
  amount: number;
  credited_amount: number;
  fee_amount: number;
  currency: string;
  operator: string;
  phone: string;
  country_code: string;
  created_at: string;
  flow?: string;
  wave_url?: string;
  ussd_code?: string | null;
};

export class AshtechPayError extends Error {
  constructor(
    message: string,
    public readonly statusCode = 502,
    public readonly code = "ASHTECHPAY_ERROR",
  ) {
    super(message);
    this.name = "AshtechPayError";
  }
}

export class AshtechPayOtpRequiredError extends AshtechPayError {
  constructor(
    public readonly reference: string,
    public readonly ussdCode: string | null,
    message = "Un OTP AshtechPay est requis pour continuer ce paiement.",
  ) {
    super(message, 400, "OTP_REQUIRED");
    this.name = "AshtechPayOtpRequiredError";
  }
}

const ASHTECHPAY_BASE_URL = "https://ashtechpay.top";

export const ASHTECHPAY_COUNTRY_CURRENCIES: Record<string, string> = {
  BJ: "XOFB",
  BF: "XOFF",
  CI: "XOFC",
  CM: "XAF",
  GA: "XAFG",
  ML: "XOFM",
  NE: "XOFN",
  CD: "CDF",
  SN: "XOFS",
  TG: "XOFT",
};

export const ASHTECHPAY_OPERATORS: Record<string, string[]> = {
  BJ: ["Celtiis Money", "Coris Money", "Moov Money", "MTN Money"],
  BF: ["Moov Money", "Orange Money (OTP)", "Wallet LigdiCash"],
  CM: ["MTN Money", "Orange Money"],
  CI: ["Moov Money", "MTN Money", "Orange (OTP)", "Wave Money"],
  GA: ["Airtel Money", "Moov Money"],
  ML: ["Moov Money", "Orange Money"],
  NE: ["Airtel Money"],
  CD: ["Afri Money", "Airtel", "Mpesa Money", "Orange", "Vodacom"],
  SN: ["E-money", "Free Money", "Orange Money (OTP)", "Wave Money"],
  TG: ["Flooz (Moov)", "T-Money"],
};

export function ashtechPayCurrencyForCountry(countryCode: string) {
  return ASHTECHPAY_COUNTRY_CURRENCIES[countryCode];
}

export function isAshtechPayOperatorSupported(countryCode: string, operator: string) {
  return ASHTECHPAY_OPERATORS[countryCode]?.includes(operator) ?? false;
}

function apiKey() {
  const value = process.env.ASHTECHPAY_API_KEY;
  if (!value) throw new AshtechPayError("La clé API AshtechPay n’est pas configurée.", 503, "ASHTECHPAY_NOT_CONFIGURED");
  return value;
}

export function ashtechPayWebhookUrl() {
  const value = process.env.ASHTECHPAY_WEBHOOK_URL;
  if (!value) throw new AshtechPayError("L’URL webhook AshtechPay n’est pas configurée.", 503, "ASHTECHPAY_NOT_CONFIGURED");
  if (!value.startsWith("https://")) throw new AshtechPayError("L’URL webhook AshtechPay doit être publique et en HTTPS.", 503, "ASHTECHPAY_NOT_CONFIGURED");
  return value;
}

export function isAshtechPayConfigured() {
  try {
    apiKey();
    ashtechPayWebhookUrl();
    return true;
  } catch {
    return false;
  }
}

async function request<T>(path: string, init: RequestInit = {}) {
  const response = await fetch(`${ASHTECHPAY_BASE_URL}${path}`, {
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
    const code = typeof body.error === "string" ? body.error : "ASHTECHPAY_ERROR";
    const message = typeof body.message === "string" ? body.message : `AshtechPay a répondu avec HTTP ${response.status}.`;
    if (code === "otp_required" && typeof body.reference === "string") {
      throw new AshtechPayOtpRequiredError(body.reference, typeof body.ussd_code === "string" ? body.ussd_code : null, message);
    }
    throw new AshtechPayError(message, response.status, code);
  }
  return body as T;
}

export async function initiateAshtechPayin(input: AshtechPayinInput) {
  return request<AshtechPayinResponse>("/v1/collect", {
    method: "POST",
    body: JSON.stringify({
      amount: input.amount,
      currency: input.currency,
      phone: input.phone,
      operator: input.operator,
      country_code: input.countryCode,
      ...(input.reference ? { reference: input.reference } : {}),
      notify_url: input.notifyUrl,
      ...(input.otp ? { otp: input.otp } : {}),
    }),
  });
}