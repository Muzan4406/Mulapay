---
name: Clerk automated-test instance selection
description: The programmatic sign-in helper cannot explicitly select Mulapay’s separate development Clerk credential pair.
---

Do not change the application’s development/production key separation or production redirect allowlists merely to make the automated sign-in helper work.

**Why:** The application deliberately uses a separate external Development Clerk instance in preview, while the generic key names contain production credentials. The testing helper exposed only name, email, TTL and base-path inputs, with no instance/secret-selection option. It rejected the preview redirect with a Clerk validation error before opening an authenticated browser. Which instance the helper selected could not be confirmed; production-key selection was only a hypothesis.

**How to apply:** When this exact helper failure recurs, first confirm the application itself still selects the development pair in preview. Report the automated-test limitation separately from application sign-in behavior. Do not claim the signed-in screens passed, rewrite authentication, or broaden live-domain permissions to work around the tool.
