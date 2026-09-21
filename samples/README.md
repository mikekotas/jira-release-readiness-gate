# Code samples

Four representative files from the app, unmodified except where noted. This is not the full source
and it will not run on its own — it is here so the design claims in the documentation can be
checked against real code.

Paths mirror the real source tree, so the imports read as they do in the app.

| File | Why it's here |
| --- | --- |
| [`src/core/rules.js`](src/core/rules.js) | The pure decision layer. Every verdict the app reaches — panel, validator, trigger, sweep — comes from `evaluate()` in this file. Imports nothing from Forge. |
| [`src/core/rules.test.js`](src/core/rules.test.js) | What testing looks like when the logic is pure: plain data in, plain data out, no mocking framework, fixed clock. |
| [`src/validators/transitionGate.js`](src/validators/transitionGate.js) | The enforcement point, and the shortest file that shows the adapter pattern — all I/O, no decisions. |
| [`manifest.yml`](manifest.yml) | All five Forge modules and the scope justification. App ID redacted. |

## What to look at

**In `src/core/rules.js`** — the `RULE_TYPES` catalogue. Each entry owns its own human name, its
parameter validation and its evaluation, which is why adding a rule type touches one file and why a
rule an admin misconfigures degrades to *skipped with a reason* instead of crashing the panel for
every issue in the project.

Also `evaluate()`: it never throws. A rule that blows up on unexpected data is reported and
excluded from the score. One bad rule cannot block a release on its own.

**In `src/core/rules.test.js`** — the clock. `NOW` is a fixed timestamp passed into the engine, so the
due-date tests are not time bombs that start failing in production six months from now.

**In `src/validators/transitionGate.js`** — the `FAIL_OPEN` constant and the comment explaining why a process
gate fails open while an authorisation check in the same codebase fails closed.

**In `manifest.yml`** — `filter: ignoreSelf: true` on the trigger, `timeoutSeconds` on the scheduled
function, and the per-scope comments naming the endpoints that need them.
