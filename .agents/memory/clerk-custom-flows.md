---
name: Clerk custom flows
description: Durable guidance for custom Clerk authentication screens in this project.
---

Mulapay uses the user's own external Clerk instance by explicit choice. Preserve this ownership rather than provisioning another Replit-managed instance.

**Why:** The user chose to manage the authentication settings directly, including the minimum password length.

**How to apply:** Use the externally configured keys and the external instance's domain; Replit-managed host-derived keys and its proxy must not override this configuration. Production domain/DNS setup belongs to the external instance's owner.

Custom Mulapay auth screens must use the current Clerk React Future resources: `useSignIn()` and `useSignUp()` expose reactive resources whose flow is completed through factor-specific methods, verification helpers, and `finalize()`. Do not revert to the older `attemptFirstFactor`, `prepareEmailAddressVerification`, or `setActive` pattern for these screens.

**Why:** The installed Clerk React SDK exposes the newer Future resource API; the legacy method names may typecheck only when cast loosely but fail at runtime.

**How to apply:** For sign-up use `signUp.password()` with email and password, `signUp.verifications.sendEmailCode()`, `verifyEmailCode()`, then `signUp.finalize()`. For password sign-in use `signIn.create()`, `signIn.password()`, then `signIn.finalize()`. For password reset use `resetPasswordEmailCode.sendCode()`, `verifyCode()`, `submitPassword()`, then finalize.

The custom sign-in flow has been confirmed working with an email OTP after password authentication; `needs_second_factor` must not be treated as a failed login.

Treat Clerk's enabled sign-up attributes as a separate contract from Mulapay's profile form. A valid SDK parameter such as `firstName` or `lastName` is rejected by Clerk when that attribute is disabled on the instance.

**Why:** A freshly provisioned instance need not enable native name attributes, even though Mulapay still requires names on its registration form.

**How to apply:** Keep application profile fields in registration metadata and validate them when provisioning the local profile from the authenticated Clerk identity. Metadata is user-editable and must never grant a role, KYC approval, balance, or other privilege; use Clerk's verified email as the email source.