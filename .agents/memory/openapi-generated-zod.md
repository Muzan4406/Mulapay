---
name: OpenAPI and generated Zod
description: Constraints for keeping Mulapay’s OpenAPI contract and generated Zod schemas compatible.
---

OpenAPI schemas used by this workspace must remain compatible with the installed Orval/Zod generator. Declaring `type: integer` currently generates `zod.int()`, which is unavailable in the project’s Zod 3 runtime.

**Why:** The generated library typecheck failed after an otherwise valid contract change because the generator emitted an unsupported Zod API.

**How to apply:** Keep runtime route validation strict with `Number.isInteger`; represent those amount fields as OpenAPI numbers with an explicit integer description until the generator configuration is upgraded and verified.