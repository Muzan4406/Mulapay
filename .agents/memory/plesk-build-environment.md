---
name: Plesk build environment
description: Plesk Node.js command runner environment behavior and the safe public-key handoff for builds.
---

Plesk's **Run Node.js commands** field may send input to pnpm as a command rather than interpret shell syntax, so `NAME=value pnpm run ...` can fail as an unknown pnpm command. Variables configured for the running Node.js app may also be unavailable to that build command.

**Why:** The Plesk build output showed the assignment being treated as a command, and the build process did not receive the configured Clerk variable.

**How to apply:** For the Mulapay production Vite build, prefer a local, Git-ignored `.env.production` containing only the public `VITE_CLERK_PUBLISHABLE_KEY`; keep private server credentials in Plesk's runtime environment and never add them to the web build.
