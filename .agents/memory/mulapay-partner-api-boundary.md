---
name: Mulapay partner API boundary
description: Product boundary for partner-facing payment documentation and API responses
---

Partner integrations use Mulapay only. DrimPay and AshtechPay are internal payment suppliers selected by Mulapay and must not be presented as partner APIs, public webhook endpoints, or required integration choices.

**Why:** The product owner wants users to integrate automatic payments with Mulapay, while supplier selection remains an implementation detail controlled by Mulapay.

**How to apply:** Keep public docs centered on Mulapay authentication, payment creation, status polling, idempotency, fees, payment links, and local `Completed` settlement. Avoid exposing supplier names, supplier-specific request fields, or supplier webhook routes in partner-facing contracts and responses.