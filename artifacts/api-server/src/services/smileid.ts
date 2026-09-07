import { createHmac, timingSafeEqual } from "node:crypto";

const SMILE_PRODUCTION_URL = "https://api.smileidentity.com";

export type SmileIdTokenInput = {
  kycId: string;
  userId: string;
  country: string;
  idType: string;
  idNumber: string;
  givenNames: string;
  lastName: string;
  email: string;
  callbackUrl: string;
};

export type SmileIdConfig = {
  token: string;
  environment: "production";
  product: "doc_verification";
  callbackUrl: string;
  partnerDetails: {
    partner_id: string;
    name: string;
    logo_url: string;
    policy_url: string;
    theme_color: string;
  };
};

function partnerId() {
  return process.env.SMILE_IDENTITY_PARTNER_ID?.trim() ?? "";
}

function apiKey() {
  return process.env.SMILE_IDENTITY_API_KEY?.trim() ?? "";
}

function apiBaseUrl() {
  return process.env.SMILE_IDENTITY_API_URL?.trim() || SMILE_PRODUCTION_URL;
}

export function isSmileIdConfigured() {
  return Boolean(partnerId() && apiKey() && /^[1-9]\d*$/.test(partnerId()));
}

async function parseSmileResponse(response: Response) {
  const text = await response.text();
  let body: Record<string, unknown> = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const message = typeof body.message === "string" ? body.message : "Smile ID a refusé la demande.";
    throw new Error(`SMILE_ID_${response.status}: ${message}`);
  }
  return body;
}

export async function createSmileIdSession(input: SmileIdTokenInput): Promise<SmileIdConfig> {
  if (!isSmileIdConfigured()) throw new Error("SMILE_ID_NOT_CONFIGURED");

  const form = new FormData();
  form.set("product", "document_verification");
  form.set("user_id", input.userId);
  form.set("partner_params", JSON.stringify({
    mulapay_kyc_id: input.kycId,
    mulapay_user_id: input.userId,
  }));
  form.set("payload", JSON.stringify({
    country: input.country,
    id_type: input.idType,
    id_number: input.idNumber,
    given_names: input.givenNames,
    last_name: input.lastName,
    email: input.email,
    callback_url: input.callbackUrl,
  }));

  const response = await fetch(`${apiBaseUrl()}/v3/token`, {
    method: "POST",
    headers: {
      "smileid-partner-id": partnerId(),
      "smileid-api-key": apiKey(),
    },
    body: form,
  });
  const body = await parseSmileResponse(response);
  if (typeof body.token !== "string" || !body.token) throw new Error("SMILE_ID_TOKEN_MISSING");

  const origin = new URL(input.callbackUrl).origin;
  const logoUrl = process.env.SMILE_IDENTITY_LOGO_URL?.trim() || `${origin}/logo.png`;
  const policyUrl = process.env.SMILE_IDENTITY_PRIVACY_URL?.trim() || `${origin}/privacy`;

  return {
    token: body.token,
    environment: "production",
    product: "doc_verification",
    callbackUrl: input.callbackUrl,
    partnerDetails: {
      partner_id: partnerId(),
      name: "Mulapay",
      logo_url: logoUrl,
      policy_url: policyUrl,
      theme_color: "#0f766e",
    },
  };
}

export function verifySmileIdWebhookSignature(signature: string | undefined, timestamp: string | undefined, rawBody: Buffer) {
  if (!signature || !timestamp || !partnerId() || !apiKey()) return false;
  const expected = createHmac("sha256", apiKey())
    .update(`${timestamp}${partnerId()}sid_request`)
    .digest("base64");
  const provided = Buffer.from(signature, "utf8");
  const calculated = Buffer.from(expected, "utf8");
  return provided.length === calculated.length && timingSafeEqual(provided, calculated);
}

export function smileIdStatus(body: Record<string, unknown>) {
  const rawStatus = String(body.status ?? body.Status ?? body.result ?? body.Result ?? "").toLowerCase();
  const rawCode = String(body.result_code ?? body.ResultCode ?? body.resultCode ?? "").toLowerCase();
  if (["clear", "verified", "success", "approved"].includes(rawStatus) || ["0000", "0"].includes(rawCode)) return "VERIFIED" as const;
  if (["attention", "review", "pending", "manual_review"].includes(rawStatus)) return "REVIEW" as const;
  if (["block", "failed", "failure", "error", "rejected", "refused"].includes(rawStatus) || rawCode) return "FAILED" as const;
  return null;
}

export function smileIdJobId(body: Record<string, unknown>, headerValue?: string) {
  return String(headerValue ?? body.job_id ?? body.JobID ?? body.jobId ?? "").trim();
}

export function smileIdUserId(body: Record<string, unknown>, headerValue?: string) {
  return String(headerValue ?? body.user_id ?? body.UserID ?? body.userId ?? "").trim();
}

export function smileIdPartnerParams(body: Record<string, unknown>) {
  const value = body.partner_params ?? body.partnerParams ?? body.PartnerParams;
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}