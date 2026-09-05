---
name: Mulapay auth and ledger boundary
description: Authentication, roles, and persisted wallet operations for future Mulapay work
---

Mulapay uses Clerk sessions for the web boundary and PostgreSQL/Drizzle for wallet, transaction, exchange, KYC, notification, payment-link, and ledger state. Public partner API routes also accept server-side `mp_live_` keys; management routes remain Clerk-only. There is no browser or API demo fallback; admin access must come from the persisted role.

**Why:** Real users must never see seeded balances or gain administrative access from environment mode or a local session. Money-moving routes must fail closed until the PSP contract is configured.

**How to apply:** Keep browser API calls same-origin and cookie-based, use generated OpenAPI hooks, preserve atomic wallet/ledger updates, and treat role checks as server-side authorization rather than UI hiding. Never expose partner keys in browser code; show a newly created key only once.

Public payment-link read routes must bypass the authenticated Mulapay middleware explicitly while remaining limited to sanitized link data.

**Why:** The Mulapay router applies authentication before its business routes; a public link otherwise returns 401 even when the route itself is intended to be unauthenticated.

**How to apply:** Place the narrow `/v1/public/payment-links/` bypass before Clerk/API-key resolution and keep all owner, wallet, ledger, and management routes behind authentication.