---
name: Mulapay reference boundary
description: Public transaction references must be Mulapay-owned, with provider references retained only for callbacks.
---

Every new transaction exposes a generated Mulapay reference to the app, partner API, admin ledger, exports, and status URLs. AshtechPay and DrimPay references are stored separately only for server-side webhook/status reconciliation.

**Why:** Provider identifiers are implementation details and should not leak into customer or partner-facing screens; changing PSP routing must not change the public transaction identity.

**How to apply:** Match callbacks against the provider-reference field or provider order ID, while all response payloads and transaction listings use the Mulapay `reference`. Keep a backward-compatible lookup for historical provider references during migration.