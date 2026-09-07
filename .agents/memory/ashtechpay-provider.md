---
name: AshtechPay webhook boundary
description: Durable AshtechPay integration decision about webhook authentication and activation prerequisites.
---

AshtechPay webhook confirmation remains HMAC-verified, using the server-side AshtechPay API credential because this integration does not require a separate webhook secret.

AshtechPay collection requests use the national phone number format documented by the provider; Mulapay may accept and validate international input but must strip the country dial code before calling AshtechPay.

AshtechPay can return HTTP 502 for a business validation error such as a country-specific minimum amount; provider error bodies must be inspected and mapped to a client-side 400 rather than shown as a generic outage.

AshtechPay may return fractional fee amounts even though the Mulapay transaction fee column is integer-backed; normalize the provider fee before persistence while preserving the provider credited amount as authoritative.

**Why:** The user confirmed that AshtechPay does not provide or require a distinct webhook secret; disabling signature verification would violate Mulapay’s production-only ledger safety boundary.

**How to apply:** Keep the API credential server-side, convert phone format only at the AshtechPay adapter boundary, translate known provider validation errors into actionable French responses, and require the public HTTPS webhook URL before enabling AshtechPay routing. Never credit a wallet from an unsigned or unverifiable callback.

Provider-tracked AshtechPay transactions must not be locally expired by the browser polling timeout; a provider success can arrive after the UI window. The authenticated provider status endpoint is a safe fallback when the signed webhook is delayed or undelivered.

**Why:** AshtechPay can report `success` while its callback is delayed or absent, so relying only on the browser window leaves a genuinely paid transaction stuck in `Pending`.

**How to apply:** Keep such transactions pending while a provider transaction ID exists, query the authenticated provider status endpoint as a fallback, validate reference/amount/currency/net amount, and settle idempotently. Prefer the signed webhook when delivered.

The authenticated Mulapay bootstrap must also run that reconciliation before returning pending deposits, then refetch wallets so a delayed provider success is reflected in both the transaction list and balance on the next app poll.

**Why:** A status endpoint can confirm settlement correctly while the UI remains stale if reconciliation is only wired into detail routes.

**How to apply:** Reconcile pending incoming transactions during authenticated bootstrap, preserve the stored Mulapay fee/net amount, and read wallets after reconciliation before serializing the response.