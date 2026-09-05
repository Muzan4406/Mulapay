---
name: Mulapay fee settlement
description: Business rule for applying the configurable Mulapay platform fee to wallet credits.
---

The platform fee percentage is captured when a new payment or deposit transaction is created. The transaction stores both the fee amount and the resulting merchant amount, and the signed provider webhook credits that stored merchant amount to the wallet. Changing the admin percentage applies to future transactions only; it must not recalculate an existing transaction.

**Why:** The user confirmed that the amount credited is the amount after Mulapay fees, while provider fees must not replace the configured Mulapay fee. A transaction must also remain stable if administration changes the rate while it is pending.

**How to apply:** Keep the provider-reported amount separate for verification and audit. Fail closed if a signed provider callback cannot support the stored merchant amount; never manufacture a larger ledger credit silently.