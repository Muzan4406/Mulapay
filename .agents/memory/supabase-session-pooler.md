---
name: Supabase Session Pooler migration
description: Connection and migration constraints for the Supabase PostgreSQL Session Pooler
---

The Supabase Session Pooler connection can work through the Node `pg` client even when the same URL fails in `psql` or `pg_dump` because of special characters in the password portion.

**Why:** libpq URL parsing may interpret an unencoded password character as part of the hostname, while the runtime PostgreSQL client still connects successfully.

**How to apply:** Prefer the Node `pg` client for controlled schema/data migration when the stored connection URL is opaque. Never print, interpolate into logs, or ask the user to paste the connection string in chat.