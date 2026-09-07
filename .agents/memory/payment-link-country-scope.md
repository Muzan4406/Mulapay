---
name: Payment link country scope
description: Country restriction behavior for wallet-specific public payment links.
---

When a payment link is attached to a specific wallet, that wallet’s country is the only allowed payer country. The public form must filter to that country, and the public payment endpoint must reject any other country.

**Why:** The link’s `walletId` is the source of truth for where funds are received; showing all regional countries can route a payer to an unintended provider or create a country/wallet mismatch.

**How to apply:** Derive the public `allowedCountry` and `allowedCountryCode` from the linked wallet, initialize and filter the public form from those values, and enforce the same constraint server-side. Links without a wallet may retain the regional country list.