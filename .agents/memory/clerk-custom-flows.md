---
name: Clerk custom flows
description: Durable guidance for custom Clerk authentication screens in this project.
---

Custom Mulapay auth screens must use the current Clerk React Future resources: `useSignIn()` and `useSignUp()` expose reactive resources whose flow is completed through factor-specific methods, verification helpers, and `finalize()`. Do not revert to the older `attemptFirstFactor`, `prepareEmailAddressVerification`, or `setActive` pattern for these screens.

**Why:** The installed Clerk React SDK exposes the newer Future resource API; the legacy method names may typecheck only when cast loosely but fail at runtime.

**How to apply:** For sign-up use `signUp.create()`, `signUp.password()`, `signUp.verifications.sendEmailCode()`, `verifyEmailCode()`, then `signUp.finalize()`. For password sign-in use `signIn.create()`, `signIn.password()`, then `signIn.finalize()`. For password reset use `resetPasswordEmailCode.sendCode()`, `verifyCode()`, `submitPassword()`, then finalize.