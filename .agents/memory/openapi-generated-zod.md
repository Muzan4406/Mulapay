---
name: OpenAPI and generated Zod
description: Constraints for keeping Mulapay’s OpenAPI contract and generated Zod schemas compatible.
---

OpenAPI schemas used by this workspace must remain compatible with the installed Orval/Zod generator. Declaring `type: integer` currently generates `zod.int()`, which is unavailable in the project’s Zod 3 runtime.

**Why:** The generated library typecheck failed after an otherwise valid contract change because the generator emitted an unsupported Zod API.

**How to apply:** Keep runtime route validation strict with `Number.isInteger`; represent those amount fields as OpenAPI numbers with an explicit integer description until the generator configuration is upgraded and verified.

An operation combining path parameters and query parameters can produce colliding `Params` exports between the generated Zod file and the generated TypeScript barrel.

**Why:** Adding a path-based section selector together with search/pagination parameters generated duplicate exported names and failed the library typecheck.

**How to apply:** For section-selection endpoints, keep the required section selector in the query alongside search/pagination, or explicitly resolve the generator naming collision before introducing mixed parameter locations. Run the generator and its library typecheck after such contract changes.