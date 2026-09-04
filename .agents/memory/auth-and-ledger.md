---
name: Mulapay auth and ledger boundary
description: Authentication, roles, and persisted wallet operations for future Mulapay work
---

Mulapay uses Clerk sessions for the web boundary and PostgreSQL/Drizzle for wallet, transaction, exchange, KYC, notification, payment-link, and ledger state. There is no browser or API demo fallback; admin access must come from the persisted role.

**Why:** Real users must never see seeded balances or gain administrative access from environment mode or a local session. Money-moving routes must fail closed until the PSP contract is configured.

**How to apply:** Keep browser API calls same-origin and cookie-based, use the generated OpenAPI hooks, preserve atomic wallet/ledger updates, and treat role checks as server-side authorization rather than UI hiding.