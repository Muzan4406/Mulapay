---
name: Plesk build environment
description: Plesk Node.js command runner environment behavior and the safe public-key handoff for builds.
---

Plesk's **Run Node.js commands** field may send input to pnpm as a command rather than interpret shell syntax, so `NAME=value pnpm run ...` can fail as an unknown pnpm command. Variables configured for the running Node.js app may also be unavailable to that build command.

**Why:** Plesk treated an inline assignment as a pnpm command, did not pass the app's runtime Clerk variable to the build, and its Node 26 `corepack` shim was unavailable even though `pnpm` itself worked.

**How to apply:** For the Mulapay production Vite build, prefer a local, Git-ignored `.env.production` containing only the public `VITE_CLERK_PUBLISHABLE_KEY`; invoke `pnpm` directly before falling back to Corepack. Keep private server credentials in Plesk's runtime environment and never add them to the web build.
