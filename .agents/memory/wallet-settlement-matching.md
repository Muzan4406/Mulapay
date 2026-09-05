---
name: Wallet settlement matching
description: Safety rule for mapping provider callbacks to the exact Mulapay wallet.
---

A provider callback must be matched to the stored transaction and its `walletId`; the ledger entry, balance update, pending release, notification, and payment-link counter must all use that same wallet. For deposits, provider country and currency must also match the wallet/provider contract before crediting.

**Why:** Payment-link recipients can intentionally differ from the payer’s country, while ordinary deposits must target the selected country wallet. Matching only the incoming country would mis-credit valid cross-border links; matching only a reference without validating the deposit contract could accept a misrouted callback.

**How to apply:** Treat the persisted transaction relation as authoritative, validate provider/country/currency where the flow carries those semantics, and fail closed before any ledger mutation on mismatch.