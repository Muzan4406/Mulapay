---
name: Mulapay auth and ledger boundary
description: Authentication, roles, and persisted wallet operations for future Mulapay work
---

Mulapay uses Clerk sessions for the web boundary and PostgreSQL/Drizzle for wallet, transaction, exchange, KYC, notification, payment-link, and ledger state. In development, the API keeps a demo fallback and new Clerk users are admin-capable for previewing operations; production must rely on persisted roles and never inherit that fallback.

**Why:** The product is still a no-PSP demonstration, but its core flows should exercise real server mutations and remain easy to promote to production controls.

**How to apply:** Keep browser API calls same-origin and cookie-based, use the generated OpenAPI hooks, preserve atomic wallet/ledger updates, and treat role checks as server-side authorization rather than UI hiding.