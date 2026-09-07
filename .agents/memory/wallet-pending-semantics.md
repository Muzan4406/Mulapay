---
name: Wallet pending semantics
description: The wallet pending amount represents reserved outgoing funds, not incoming deposits or payment-link collections.
---

`wallets.pending` must contain only amounts reserved for withdrawals, transfers, and pending exchanges. Incoming deposits and payment-link payments are not reservations against the existing wallet balance because they have not been credited yet.

**Why:** Subtracting pending incoming funds from the current balance made an empty wallet display a negative available balance whenever a deposit or payment failed or remained pending.

**How to apply:** When adding a new incoming payment flow, do not increment `wallets.pending`; when rebuilding pending reservations, include active outgoing transactions and pending exchanges only.