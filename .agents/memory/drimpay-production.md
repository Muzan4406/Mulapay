---
name: DrimPay production boundary
description: Mulapay’s DrimPay integration is intentionally production-only; public documentation must not present a sandbox workflow.
---

Mulapay uses the DrimPay production contract only in the product. Follow the current official docs for endpoint and field names: Pay-in uses `/api/v2/payin/initiate`; Pay-out uses `/api/v2/payout/initiate` with `external_ref` and `total_debit`. Require a `dp_live_sk_` API key, its matching separate webhook signing secret, and a public HTTPS callback. Never fall back to Sandbox.

All Mobile Money outbound flows currently share that payout contract: withdrawals and user-initiated transfers both reserve the source wallet and settle only from the signed webhook. Mulapay applies its configured admin fee; DrimPay fees are not exposed or charged to the source wallet.

**Why:** A transfer to a Mobile Money number is operationally the same provider-side disbursement as a withdrawal, and splitting the flows would create inconsistent settlement and ledger safety.

**How to apply:** Route new Mobile Money outbound operations through the shared DrimPay payout boundary, preserve the signed confirmation requirement, and do not present transfers as locally completed before provider settlement. For inbound payins, the authenticated DrimPay status endpoint may reconcile a delayed webhook after strict reference, wallet, country, currency, and amount validation.

**Why:** The owner explicitly does not want a sandbox workflow exposed or positioned as part of Mulapay; the official DrimPay contract can change, so stale endpoint or signature details must not be trusted.

**How to apply:** Check the official DrimPay API docs before changing integration paths or webhook verification. Keep configuration fail-closed until the production API key, the corresponding webhook secret, and a public HTTPS URL are configured. Keep provider details out of partner-facing Mulapay docs. Payouts require KYB approval and an active provider wallet in the destination country.