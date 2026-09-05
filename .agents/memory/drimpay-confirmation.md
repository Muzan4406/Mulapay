---
name: DrimPay confirmation boundary
description: Rules for turning a DrimPay Payin into a Mulapay wallet credit
---

Mulapay must create Payin operations as pending and credit balances only from a valid, signed DrimPay webhook. Never infer provider fees or net amounts locally when the provider omits them.

**Why:** A provider initiation response is not proof of settlement, and a guessed net amount can create money that was never confirmed.

**How to apply:** Keep public payments and deposits fail-closed, require the production webhook configuration, and make signed webhook handling idempotent before updating wallets, ledger entries, payment-link counters, or notifications.