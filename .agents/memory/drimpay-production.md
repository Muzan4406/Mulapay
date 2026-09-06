---
name: DrimPay production boundary
description: Mulapay’s DrimPay integration is intentionally production-only; public documentation must not present a sandbox workflow.
---

Mulapay uses the DrimPay production contract only in the product. The payout contract is `POST /api/v2/payout/send` with `order_id` idempotency, `total_debited` confirmation data, and signed webhooks; partner-facing pages should describe production credentials, signed webhooks, idempotency, and supported countries without offering a sandbox path.

All Mobile Money outbound flows currently share that payout contract: withdrawals and user-initiated transfers both reserve the source wallet and settle only from the signed webhook. DrimPay fees are charged to the source wallet; recipient-paid fees are not represented as a separate provider flow.

**Why:** A transfer to a Mobile Money number is operationally the same provider-side disbursement as a withdrawal, and splitting the flows would create inconsistent settlement and ledger safety.

**How to apply:** Route new Mobile Money outbound operations through the shared DrimPay payout boundary, preserve the signed confirmation requirement, and do not present transfers as locally completed before provider settlement.

**Why:** The product owner explicitly does not want a sandbox workflow exposed or positioned as part of Mulapay.

**How to apply:** Keep DrimPay configuration fail-closed until production secrets and a public HTTPS webhook URL are configured; do not reintroduce sandbox copy or credentials into user-facing pages. Payouts require KYB approval and an active provider wallet in the destination country.