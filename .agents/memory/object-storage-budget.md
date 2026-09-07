---
name: KYC file storage boundary
description: KYC uploads use private Supabase Storage when Replit App Storage cannot be provisioned.
---

Replit App Storage provisioning may fail with a permission-denied response stating that all credits have been used. Mulapay therefore stores KYC files in a private Supabase Storage bucket while Supabase PostgreSQL continues to store the KYC records and object paths.

**Why:** KYC image upload and admin review must remain usable without a public file fallback or an artificial local filesystem dependency.

**How to apply:** Keep the Supabase Storage bucket private, upload through the authenticated API, and stream admin document reads through the `requireAdmin` route. Never expose the service-role key to the browser.