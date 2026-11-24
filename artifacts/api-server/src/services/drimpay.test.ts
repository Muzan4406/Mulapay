import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";
import {
  DrimPayConfigurationError,
  initiatePayin,
  initiatePayout,
  isDrimPayConfigured,
  isDrimPayRouteSupported,
  operatorSlugForName,
  verifyDrimPayWebhookSignature,
} from "./drimpay";

const envKeys = ["NODE_ENV", "DRIMPAY_API_KEY", "DRIMPAY_WEBHOOK_SECRET", "DRIMPAY_WEBHOOK_URL"] as const;

function withLiveEnvironment<T>(run: () => Promise<T> | T) {
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  Object.assign(process.env, {
    NODE_ENV: "production",
    DRIMPAY_API_KEY: "dp_live_sk_unit_test",
    DRIMPAY_WEBHOOK_SECRET: "unit-test-webhook-secret",
    DRIMPAY_WEBHOOK_URL: "https://mulaapay.example/api/v1/webhooks/drimpay",
  });
  return Promise.resolve()
    .then(run)
    .finally(() => {
      for (const key of envKeys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    });
}

test("DrimPay configuration requires live API credentials, webhook secret, and public HTTPS URL", async () => {
  await withLiveEnvironment(() => {
    assert.equal(isDrimPayConfigured(), true);
    delete process.env.DRIMPAY_WEBHOOK_SECRET;
    assert.equal(isDrimPayConfigured(), false);
    process.env.DRIMPAY_WEBHOOK_SECRET = "unit-test-webhook-secret";
    process.env.DRIMPAY_WEBHOOK_URL = "http://localhost/webhook";
    assert.equal(isDrimPayConfigured(), false);
    process.env.DRIMPAY_WEBHOOK_URL = "https://mulaapay.example/api/v1/webhooks/drimpay";
    process.env.NODE_ENV = "development";
    assert.equal(isDrimPayConfigured(), false);
  });
});

test("DrimPay webhook signatures validate raw bytes, timestamp, and secret", () => {
  const secret = "unit-test-webhook-secret";
  const body = Buffer.from('{"event":"payin.success","mode":"live"}');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body.toString("utf8")}`).digest("hex");
  const header = `t=${timestamp},v1=${signature}`;

  assert.equal(verifyDrimPayWebhookSignature(header, body, secret, timestamp), true);
  assert.equal(verifyDrimPayWebhookSignature(header, body, secret, String(Number(timestamp) + 1)), false);
  assert.equal(verifyDrimPayWebhookSignature(header, Buffer.from(`${body.toString("utf8")} `), secret), false);
  assert.equal(verifyDrimPayWebhookSignature(`t=${Number(timestamp) - 301},v1=${signature}`, body, secret), false);
  assert.equal(verifyDrimPayWebhookSignature(`t=${timestamp},v1=not-hex`, body, secret), false);
  assert.equal(verifyDrimPayWebhookSignature(header, body, undefined), false);
});

test("DrimPay only accepts documented country/operator combinations", () => {
  assert.equal(isDrimPayRouteSupported("TG", "Mixx by Yas"), true);
  assert.equal(isDrimPayRouteSupported("BJ", "Celtiis"), true);
  assert.equal(isDrimPayRouteSupported("SN", "Free"), true);
  assert.equal(isDrimPayRouteSupported("NE", "Orange Money"), false);
  assert.equal(isDrimPayRouteSupported("TG", "Orange Money"), false);
  assert.equal(operatorSlugForName("TMoney"), "tmoney");
  assert.equal(operatorSlugForName("tmoney"), "tmoney");
});

test("Pay-in uses the documented live endpoint and idempotent order_id", async () => {
  await withLiveEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        reference: "IN-UNIT-1",
        order_id: "payin-unit-1",
        status: "pending",
        amount: 5000,
        fee: 150,
        net_amount: 4850,
        currency: "XOF",
        country_code: "TG",
        operator: "TMoney",
        phone: "+22890123456",
        mode: "live",
        expires_at: new Date(Date.now() + 60_000).toISOString(),
      }), { status: 201 });
    }) as typeof fetch;

    try {
      const response = await initiatePayin({
        amount: 5000,
        currency: "XOF",
        countryCode: "TG",
        operator: "Mixx by Yas",
        phone: "+22890123456",
        orderId: "payin-unit-1",
        webhookUrl: "https://mulaapay.example/api/v1/webhooks/drimpay",
      });
      assert.equal(requestUrl, "https://drimpay.com/api/v2/payin/initiate");
      assert.equal(requestBody.order_id, "payin-unit-1");
      assert.equal(requestBody.operator, "tmoney");
      assert.equal(response.mode, "live");
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("Payout uses the current production endpoint, external_ref, and total_debit response", async () => {
  await withLiveEnvironment(async () => {
    const originalFetch = globalThis.fetch;
    let requestUrl = "";
    let requestBody: Record<string, unknown> = {};
    globalThis.fetch = (async (input, init) => {
      requestUrl = String(input);
      requestBody = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({
        reference: "OUT-UNIT-1",
        external_ref: "payout-unit-1",
        order_id: "payout-unit-1",
        status: "processing",
        amount: 10000,
        fee: 300,
        total_debit: 10300,
        net_amount: 10000,
        currency: "XOF",
        country_code: "TG",
        operator: "tmoney",
        phone: "+22890123456",
        mode: "live",
        created_at: new Date().toISOString(),
      }), { status: 201 });
    }) as typeof fetch;

    try {
      const response = await initiatePayout({
        amount: 10000,
        currency: "XOF",
        countryCode: "TG",
        operator: "Mixx by Yas",
        phone: "+22890123456",
        orderId: "payout-unit-1",
        webhookUrl: "https://mulaapay.example/api/v1/webhooks/drimpay",
      });
      assert.equal(requestUrl, "https://drimpay.com/api/v2/payout/initiate");
      assert.equal(requestBody.external_ref, "payout-unit-1");
      assert.equal(requestBody.order_id, undefined);
      assert.equal(response.total_debit, 10300);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

test("DrimPay live requests fail closed outside production", async () => {
  await withLiveEnvironment(async () => {
    process.env.NODE_ENV = "development";
    await assert.rejects(
      initiatePayin({
        amount: 5000,
        currency: "XOF",
        countryCode: "TG",
        operator: "Mixx by Yas",
        phone: "+22890123456",
        orderId: "payin-dev-blocked",
        webhookUrl: "https://mulaapay.example/api/v1/webhooks/drimpay",
      }),
      (error: unknown) => error instanceof DrimPayConfigurationError,
    );
  });
});
