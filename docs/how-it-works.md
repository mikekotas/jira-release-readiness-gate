# How it works

A walkthrough of what the app actually does, from the point of view of the people using it.

---

## 1. The readiness scorecard

Every Jira issue in a software project gets a **Release Readiness** panel above the activity feed.

```
Blocked    1 blocking rule failing · 1 warning              Readiness 50%
                                                            ▓▓▓▓▓░░░░░

Status   Check                          Detail
Fail     Description is filled in       only 31 of 80 characters
         [Blocks transition]
Fail     Fix version attached           no fix version
Pass     Not blocked by another issue   no blocking issues linked
Pass     Owner assigned                 Dana Dev

  [ Choose a transition… ▾ ]   [ Run gate & move ]   [ Re-check ]

  Evaluated 12 Mar 2026, 14:02 · 4 rules
```

Three things this gets right that a naive checklist doesn't:

**It says *why*, not just *no*.** "only 31 of 80 characters" is actionable. "Acceptance criteria:
✗" is not. Every rule reports its own reason for failing, in its own terms.

**Failures sort to the top.** Blocking failures first, then warnings, then skipped, then passes. A
scorecard is read top-down, so what needs action belongs where the eye lands.

**The score is weighted, not a tick count.** Blockers count triple. Four default rules give a total
weight of 8, so a fresh unassigned issue with a short description scores 38% — the number tracks
release *risk*, not how many boxes are ticked. Rules that were skipped because they're misconfigured
are excluded from the maths entirely, so a broken rule can never silently drag a team's score down.

**Status is never conveyed by colour alone.** Every lozenge carries a word.

### Two meanings of "blocker", kept apart

Early on this panel was genuinely unreadable, because a row saying *"No unresolved blockers: Pass"*
sat directly under a header saying *"Blocked"*. Both were correct and they meant different things:

- **Blocker** the *severity* — a rule that stops a transition.
- **Blocker** the *Jira link* — another issue that must finish first.

Rules are now named for what they check, never for their severity. The link rule is
**"Not blocked by another issue"**; the header counts **"blocking rules failing"**. It is a naming
change with no functional effect and it was one of the highest-value changes in the project, because
a control nobody can read is a control nobody trusts.

---

## 2. The rules, and who owns them

Every project starts with four defaults — two blockers nobody argues with, two warnings that start
a conversation:

| Rule | Severity | Passes when |
| --- | --- | --- |
| Description is filled in | **Blocker** | Description ≥ 80 characters |
| Not blocked by another issue | **Blocker** | No open "is blocked by" link |
| Owner assigned | Warning | Assignee set |
| Fix version attached | Warning | At least one fix version |

A **project administrator** replaces those under *Project settings → Release Readiness Rules*,
with no developer involved. Nine rule types are available:

| Rule type | Checks |
| --- | --- |
| Field is filled in | A field — including any `customfield_*` — has at least N characters |
| Field matches a pattern | A field matches a regular expression |
| Carries one of these labels | The issue has at least one label from a set |
| Has an assignee | Someone owns it |
| Has a fix version | It's attached to a release |
| Due date is set and close enough | A due date exists and is no more than N days out |
| Not blocked by another issue | No open inward "blocks" link |
| Has a required issue link | A link of a given type, optionally to a given issue type |
| Has enough approval comments | N *distinct* people commented a marker — and the assignee cannot approve their own issue |

Each rule is **Blocker** (stops transitions) or **Warning** (visible only).

Design choices in the editor that matter more than they look:

- **Real fields per rule type, not a JSON blob.** An admin configuring a gate should never have to
  know the wire format.
- **Nothing autosaves.** Save is disabled until something actually changed. Autosaving a compliance
  gate mid-keystroke is how a half-typed regular expression ends up blocking a release.
- **The server validates again on save.** Client-side validation is a convenience, never the
  control.
- **Invalid stored rules are dropped on read, not evaluated.** A bad write in the past cannot
  permanently break the panel, and the settings page reports how many were discarded.

---

## 3. Enforcement

The panel's **Run gate & move** button re-evaluates server-side before it does anything. The verdict
the browser is showing is treated as a claim, not a fact — a gate that trusts its own client is a
suggestion.

But the button is only one of six ways to move a Jira issue. Real enforcement is a
**workflow validator** that a project admin attaches to the specific transitions they want gated:

> Project settings → Workflows → edit workflow → select transition → Validators → **Release
> Readiness Gate**

![The Release Readiness Gate listed as a validator on a workflow transition in the Jira workflow editor](../screenshots/workflow-validator.png)

Because it runs inside Jira's workflow engine, it covers the status dropdown, dragging a card on a
board, bulk change, Jira Automation and the REST API. If it refuses, the issue does not move, the
transition's post functions do not run, and Jira shows a message built from the rules themselves:

> *Release readiness: this transition needs one more thing — Description is filled in (only 31 of
> 80 characters).*

Not "a validator failed". The person who hit the wall is told exactly what to do about it.

![Jira refusing a status change made from the issue status dropdown, showing the gate's message naming the failing check](../screenshots/gate-enforced.png)

Note where that refusal came from: the **status dropdown on the issue**, not the app's panel. The
user never opened the scorecard and the gate still held.

**Which transitions are gated is Jira's decision, not the app's.** Gate the transitions that mean
"this work is finished" — into Done, into Released. Never gate backwards transitions: blocking
someone from reopening a broken ticket because its description is short is how an app gets
uninstalled.

**The transition screen counts.** Jira hands the validator the values typed on the transition screen
but not yet saved, so a user can fix the problem and pass in one action rather than cancelling,
editing, and starting over.

---

## 4. Staying honest in the background

Two jobs run with nobody watching.

**On every issue change**, the app re-evaluates and records the outcome. The hard problem here is
not evaluating — it is staying quiet. An issue gets updated dozens of times a day, and an app that
comments on all of them is an app the team mutes within a week. Four guards:

1. The platform drops events the app caused itself, so it cannot react to its own comments.
2. Changes to fields no rule can read — rank, sprint, worklog — are ignored before any work happens.
3. Every evaluation is fingerprinted; an identical verdict produces no comment.
4. Even on a changed verdict it only speaks for the two transitions that matter: newly blocked, or
   newly clear.

**Once a night**, a sweep catches what events cannot: issues that went non-compliant because *time
passed* (a due date slipped) or because *the rules changed*. Neither raises an issue-updated event.
The sweep only ever comments on regressions.

---

## 5. The audit trail

Every gated transition and every readiness regression leaves a structured comment:

> ✅ **Release readiness: PASSED**
> 4/4 checks passing

> ❌ **Release readiness: BLOCKED (2 blockers)**
> 2/4 checks passing · 1 warning
> - **[BLOCKER]** Description is filled in — only 31 of 80 characters
> - **[BLOCKER]** Not blocked by another issue — blocked by REL-9

Deliberately compact. An audit trail that is tedious to read gets muted by the team, and a muted
audit trail has no compliance value.

If the transition succeeds but the comment fails, the user is told so explicitly — the app does not
report a clean result for a half-completed operation.

---

## 6. When things go wrong

**A malformed rule never takes down the panel.** A rule that references an unknown type, is missing
a parameter, or throws on unexpected data is reported as *skipped* with the reason, and excluded
from the score. One bad rule cannot break every issue in a project, and a broken rule can never
block a release on its own.

**The gate fails open.** If the app cannot reach a verdict — Jira unreachable, mid-deploy — the
transition is allowed and the failure is logged. This is a process gate, not an authorisation check:
the cost of wrongly allowing one transition is a comment from the nightly sweep, while the cost of
wrongly refusing is that nobody in the organisation can move any gated issue until the app recovers.
It is a single constant for an organisation whose compliance posture requires the opposite.

**Authorisation fails closed.** The two are different and are treated differently. A permission
check that cannot complete resolves to *denied*, never to *allowed*.
