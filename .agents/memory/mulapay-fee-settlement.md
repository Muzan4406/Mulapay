---
name: Mulapay fee settlement
description: Business rule for applying the configurable Mulapay platform fee to wallet credits.
---

The platform fee percentage is captured when a new transaction is created for deposits, payments, withdrawals, and transfers. Provider fees are ignored for customer-facing pricing and wallet debits; the stored Mulapay fee and resulting amount are authoritative. Changing the admin percentage applies to future transactions only.

**Why:** The user explicitly wants one fee policy controlled by the admin panel, without AshtechPay or DrimPay fees replacing it. A transaction must also remain stable if administration changes the rate while it is pending.

**How to apply:** Keep provider-reported fee/amount fields server-side for validation only. Set transaction fee, pending reservation, response totals, and ledger settlement from the captured Mulapay fee; never debit or display a provider fee.