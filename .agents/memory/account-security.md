---
name: Account security boundary
description: Ownership boundaries for passwords, connected devices, PINs, and security activity.
---

Clerk owns password changes, identity reverification, email OTP, and session revocation. Mulapay must not simulate those operations or store passwords.

**Why:** Security controls must reflect real authentication state. Fake OTPs, invented devices, or client-stored PINs create a false sense of protection.

**How to apply:** Use Clerk reverification for password changes and Clerk sessions for connected devices. Hash the four-digit PIN on the server and store only the hash in Clerk private metadata. Security activity must come from real sessions or persisted account-security notifications.