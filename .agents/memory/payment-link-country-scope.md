---
name: Payment link country scope
description: Country restriction behavior for wallet-specific public payment links.
---

Payment links support either all available countries or an explicit allowlist of one or more country codes. A single-country link may remain attached to that wallet; multi-country links route each payment to the matching local wallet. The public form must filter to the allowlist, and the public payment endpoint must reject any other country.

**Why:** The payer country determines the provider route and receiving wallet. Showing all regional countries for a restricted link can route a payer to an unintended provider or create a country/wallet mismatch.

**How to apply:** Persist `allowedCountryCodes` as null for all available countries or as a non-empty allowlist. Initialize and filter the public form from it, validate selected countries have active wallets in the link currency, route multi-country payments by payer country, and enforce the same constraint server-side. For legacy single-wallet links, derive the allowlist from the linked wallet.