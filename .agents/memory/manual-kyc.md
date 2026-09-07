---
name: Manual KYC boundary
description: Durable KYC product boundary after removing the external biometric provider
---

Mulapay's current KYC flow is manual: the user submits identity fields and document references, with an optional face photo for human review. Smile ID and automatic liveness, Face Match, OCR, or biometric approval are not part of the product.

**Why:** The provider account was not available, and a local imitation would create a false security boundary. Only compliance staff should decide whether a dossier is verified.

**How to apply:** Keep user copy and server validation aligned with manual review. Do not add provider sessions, provider webhooks, automatic verification states, or claims that a file name proves document authenticity. Private byte storage remains a separate prerequisite before handling real documents in production.