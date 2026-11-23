# Mulapay

Mulapay is a West African wallet platform for managing country wallets, transfers, exchanges, payment links, KYC, and operations.

## Run & Operate

- Start the `artifacts/mulapay: web` and `artifacts/api-server: API Server` workflows to run the app and API in Replit. The web app is at `/`; the API is routed under `/api`.
- `pnpm install --frozen-lockfile` — install workspace dependencies
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — apply Drizzle schema changes; review the target database before running
- Required secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY`, and `SUPABASE_DATABASE_URL`. Set the same Clerk publishable key for both publishable-key names. Use Replit Secrets; never commit or share secret values.
- Preview additionally requires `CLERK_DEV_PUBLISHABLE_KEY` and `CLERK_DEV_SECRET_KEY` from the external Clerk Development instance. Vite's dev server and the development API use these together. Production builds/API use only the live keys above; missing keys fail explicitly rather than falling back to another instance. Password requirements must be configured separately in Clerk Development and Production.
- Administration guide: `docs/admin-panel.md`. Telegram can be configured from the admin panel; encrypted storage requires `ADMIN_ENCRYPTION_KEY` (at least 32 characters). Environment-only `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` remain supported.
- Real merchant e-mails require Resend (`RESEND_API_KEY`) and a verified sender (`MAIL_FROM`). Without these, sends fail explicitly; notifications shown in-app work independently.
- Existing Supabase administration tables are reused. The additive migration is `lib/db/migrations/20261123_admin_console.sql`; do not drop tables to reconcile a cancelled worker’s schema.
- API health check: `/api/healthz`

## Stack

- pnpm workspaces, Node.js 20, TypeScript 5.9
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod, `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild

## Where things live

- `artifacts/mulapay` — React/Vite web app
- `artifacts/api-server` — Express API server and routes
- `lib/api-spec` — OpenAPI contract and generated API client/schema packages
- `lib/db` — Drizzle schema and database configuration

## Architecture decisions

- Clerk handles web authentication; PostgreSQL persistence uses Drizzle.
- Clerk is now an externally owned instance, configured directly through the stored keys. Do not restore Replit-managed host-derived keys or its Clerk proxy for this setup. External production requires its Clerk domain and DNS configuration to be completed in the owner's Clerk dashboard.
- The API and web app run as separate artifact services, routed under `/api` and `/`.

## Product

The public home page links to Clerk sign-in and account creation. Authenticated application features depend on the configured database and applicable provider settings.

## User preferences

No additional preferences recorded.

## Gotchas

- A new Clerk setup has a separate user store; it does not restore accounts from a previous Clerk instance.
- The API health check confirms the server is responding, not that every database-backed route or provider integration is configured.
- Do not run database schema changes against a shared or production database without reviewing the planned changes first.

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
