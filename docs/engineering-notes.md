# Engineering notes

The decisions that took thought, the trade-offs behind them, and two bugs worth writing down.

---

## 1. The gate that wasn't a gate

**The version that felt finished.** The issue panel had a transition dropdown and a *Run gate &
move* button. Pick a transition, the backend re-evaluates the rules server-side, and if a blocker
fails it refuses. Demoed well. Screenshotted well.

**The version that was true.** Moving an issue via the status dropdown worked fine. So did dragging
a card on a board, bulk change, Jira Automation and the REST API. The gate existed in exactly one
place — a button people could simply not press.

The app *detected* the bypass afterwards, via the issue-updated trigger, and posted a "readiness
regressed" comment. That is not enforcement. That is a nicely-worded complaint.

**The fix** is `jira:workflowValidator`, which runs inside Jira's workflow engine. Every route into
a transition goes through it.

**The lesson worth keeping:** *"where is the control actually enforced"* is a different question
from *"does the feature work"*, and only the first one matters for something described as a gate.
The tests passed and the demo worked for the entire time the app was trivially bypassable.

### And a design decision that came with it

The obvious follow-up is a transition picker in the app's settings page: *"gate these transitions."*
Rejected. Jira already owns transition configuration, and a second picker inside the app would
disagree with the workflow the first time someone renames a transition. The admin attaches the
validator to the transitions they want, in the workflow editor, and the app never has an opinion
about which ones those are.

The cost is a manual setup step the app cannot perform for itself — which is why the settings page
carries a permanent notice explaining that rules are inert until the gate is attached. A control
that silently does nothing is worse than no control.

---

## 2. Two things called "blocker"

The panel showed this, and both lines were correct:

```
Blocked    1 blocker · 1 warning
...
Pass    No unresolved blockers    no open blockers
```

**Blocker** meant the *severity* of a rule in the header, and a *linked Jira issue* in the row. A
reader's first conclusion is that the app is producing false positives, and once someone believes
that they stop trusting every other number on the screen.

No logic changed. Rules are now named for what they check rather than for their severity — the link
rule is **"Not blocked by another issue"** — and the header counts **"blocking rules failing"**.

`"Acceptance criteria documented"` was renamed in the same pass for a related reason: it did not
check an acceptance-criteria field, it checked that the *description* was at least 80 characters.
The name described an intention; the new one, **"Description is filled in"**, describes the check.
The Detail column still carries the numbers.

**The lesson:** in a compliance tool, naming *is* the product. A control nobody can read is a
control nobody trusts, and no amount of correct logic underneath compensates.

---

## 3. `"type": "module"` broke production while every local check passed

A one-word change to `package.json` — added so Jest could run the ES-module source — took both
resolvers down in production:

```
TypeError: out_namespaceObject is not a constructor
    at src/resolvers/panel.js   (const resolver = new Resolver();)
```

`@forge/resolver`, `@forge/api` and `@forge/kvs` are all CommonJS. Forge's bundler reads the `type`
field to decide how to treat app source:

- **Without it** — `javascript/auto`: the bundler honours the `__esModule` flag on a CommonJS
  dependency, so `import Resolver from '@forge/resolver'` yields the class.
- **With it** — strict ESM: a default import of a CommonJS package resolves to the *module
  namespace object* instead of `module.exports.default`. `new Resolver()` then throws at module
  load, before any application code runs.

The Forge template omits the field deliberately.

**What makes this worth recording is the detection gap.** `forge lint` passed — it validates the
manifest but does not bundle. ESLint passed — module resolution isn't its job. All 37 tests passed —
Jest was the reason the field was added in the first place. Three green checks, and a completely
dead app.

**The fix**: remove the field, and run Jest through `babel-jest` instead, which transpiles the ESM
syntax for tests only and never touches what Forge bundles.

**The lesson:** know which of your checks actually exercises the production build path. Here, none
of them did. The gap is now documented in the project's setup notes with the exact error string, so
the next person greps their way straight to it.

---

## 4. Trusting the client is the difference between a control and a suggestion

The panel already knows the verdict when the user hits *Run gate & move*. Sending it along would
save a round trip.

It is ignored. The backend re-reads the issue and re-evaluates from scratch immediately before the
write, because the panel runs in the user's browser and its answer is a *claim*, not a fact.

The same reasoning drives three other choices:

- **The issue and project key come from `req.context.extension`**, which Forge populates from the
  page the module rendered on — never from the request payload. A resolver that accepts an issue
  key from its client can be pointed at any issue on the site.
- **The requested transition is checked against the user's own available transitions**, rather than
  forwarding an arbitrary ID to Jira and relying on Jira's error.
- **Every settings write re-checks `ADMINISTER_PROJECTS`.** Jira only renders the settings page for
  people who can reach project settings, but placement is not authorisation. A resolver is an
  endpoint, and an endpoint that assumes its own UI is the only caller is an endpoint waiting to be
  called directly.

---

## 5. The transition-screen merge, and two fields excluded from it

Jira hands a workflow validator the values typed on the transition screen but not yet saved, so the
gate can evaluate the issue *as it will be*. Merging them over the saved issue is three lines.

Two fields are deliberately excluded, and the reasoning differs:

**`comment`** — the REST issue payload nests comments under `comment.comments[]`. A comment typed on
a transition screen is a single unposted comment with a different shape. Merging it would make the
normaliser see *zero* comments and silently wipe every recorded approval. It also must not count:
the person performing the transition approving themselves in the same action is precisely what the
`minApprovals` rule exists to prevent.

**`issuelinks`** — the same risk in the more dangerous direction. If the merged shape doesn't parse,
the normaliser returns an empty list and the "not blocked by another issue" rule **passes an issue
that is genuinely blocked**.

That asymmetry is the rule of thumb: when an unknown payload shape can make a blocker rule fail
*open*, don't accept the payload. Both exclusions have tests asserting the failure mode directly,
rather than tests asserting the happy path and hoping.

---

## 6. Staying quiet is harder than being right

An app that comments on every issue update is muted within a week, and a muted audit trail has no
compliance value. Four independent guards, cheapest first:

1. **Platform-level.** `filter: ignoreSelf: true` on the trigger — Forge drops events the app caused
   itself before the function is invoked. Zero cost.
2. **Field-level.** Changes to fields no rule can read — rank, sprint, worklog — are discarded
   before any I/O.
3. **Verdict-level.** Every evaluation is fingerprinted with a cheap 32-bit hash. An identical
   verdict produces no comment. This is change detection, not security, and the hash is chosen
   accordingly.
4. **Narrative-level.** Even a *changed* verdict only speaks for the two transitions anyone cares
   about: newly blocked, or newly clear.

The first version of guard 1 was written by hand as
`event.atlassianId === context.appId` — comparing a user identifier to an app ARI. It never fired,
and nothing failed visibly; the app just did more work than it needed to, forever. Replacing it
with the platform's own filter removed the bug and the invocation cost together.

**The lesson:** when a platform offers a primitive for something, the hand-rolled version is usually
both wrong and more expensive.

---

## 7. No mocking framework, on purpose

50 tests, 3 suites, zero mocks, under two seconds.

That is not discipline, it is a consequence of the architecture. The rules engine takes plain
objects and returns plain objects, so a test is data in and data out. The current time is passed in
rather than read from the clock, so `dueDateWithin` tests are not time bombs that fail in
production six months from now.

What *isn't* tested is as deliberate. The adapters — REST calls, KVS reads, UI Kit rendering — have
no unit tests, because a test of a mocked `requestJira` asserts that the mock was configured
correctly and nothing else. They are kept thin enough to review by eye, and everything worth
asserting lives in the layer that needs no mocks.

One of the tests caught a regression during this work: a detail string was reworded to
`blocked by open issue REL-9`, which reads badly with several keys (`blocked by open issue REL-9,
REL-10`). The test was right and the change was reverted.

---

## 8. Things deliberately not built

| Not built | Why |
| --- | --- |
| Transition picker in app settings | Jira's workflow editor already owns this. A second picker drifts. |
| Per-rule "only applies when moving to X" | Real, but attaching the validator selectively already covers most of it. Config burden ahead of demonstrated need. |
| Storing full evaluation history in KVS | Recomputable in milliseconds from the issue. Storage is billed. |
| Blocking on warnings | A severity that blocks is not a warning. Two levels, and they mean what they say. |
| A dashboard of project-wide compliance | Genuinely useful, and a different product. Would need its own storage model rather than being bolted onto a fingerprint cache. |
