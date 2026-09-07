---
name: App Storage budget boundary
description: App Storage provisioning can be refused before code-level storage flows are usable when the workspace has exhausted its credits.
---

The object storage setup callback may fail with a permission-denied response stating that all credits have been used. This blocks bucket provisioning and leaves PRIVATE_OBJECT_DIR unset, even though the application code and dependencies can still be validated.

**Why:** KYC uploads depend on a provisioned private bucket; without it, presigned upload URL generation cannot run.

**How to apply:** Treat this as an environment prerequisite, not an application fallback. Do not expose a public file-serving fallback; re-run storage setup after credits are restored.