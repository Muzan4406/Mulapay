---
name: AshtechPay webhook boundary
description: Durable AshtechPay integration decision about webhook authentication and activation prerequisites.
---

AshtechPay webhook confirmation remains HMAC-verified, using the server-side AshtechPay API credential because this integration does not require a separate webhook secret.

**Why:** The user confirmed that AshtechPay does not provide or require a distinct webhook secret; disabling signature verification would violate Mulapay’s production-only ledger safety boundary.

**How to apply:** Keep the API credential server-side and require the public HTTPS webhook URL before enabling AshtechPay routing. Never credit a wallet from an unsigned or unverifiable callback.