---
name: Cancelled work and external Supabase state
description: Cancelling an isolated task can leave its external database changes in place even when its code was not merged.
---

Inspect Supabase before recreating work from a cancelled task. Do not assume that unmerged code means its database changes were rolled back.

**Why:** A cancelled administrator-panel task had already created administration tables and added columns in the shared external Supabase database. Those structures survived cancellation even though its application code was absent from the main project.

**How to apply:** Compare the live schema with the current source, reuse compatible existing structures, and apply only reviewed additive changes. Never drop tables or overwrite financial data merely to make an old source schema match.
