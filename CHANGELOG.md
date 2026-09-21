# Changelog

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.0] — 2026-09-21

First complete version: the point at which the app enforces its rules rather than reporting on
them.

### Added

- **Readiness scorecard** (`jira:issuePanel`) — per-rule verdict with the reason it failed, a
  weighted risk score, failures sorted to the top, and a re-check action.
- **Rules editor** (`jira:projectSettingsPage`) — nine rule types, per-rule severity, enable/disable,
  and reset to defaults. Configurable by a project admin with no developer involved.
- **Workflow validator** (`jira:workflowValidator`) — the enforcement point. Runs inside Jira's
  workflow engine, so the status dropdown, board drag, bulk change, Automation and the REST API are
  all gated. Admins attach it per transition in the workflow editor.
- **Transition-screen awareness** — the validator evaluates the issue as it *will* be, including
  values entered on the transition screen but not yet saved.
- **Product trigger** on `avi:jira:updated:issue` — re-evaluates on change and records the outcome,
  with four layers of noise suppression.
- **Nightly sweep** (`scheduledTrigger`) — catches issues that went non-compliant because time
  passed or the rules changed, neither of which raises an update event. Bounded on every axis.
- **Audit comments** in Atlassian Document Format on every gated transition and every readiness
  regression.
- 50 unit tests across the pure decision layer. No mocking framework.

### Changed

- **Rules are named for what they check, not for their severity.** The panel previously showed
  `Blocked · 1 blocker` above a row reading `No unresolved blockers: Pass` — two unrelated meanings
  of the same word, which read as a false positive. The link rule is now *"Not blocked by another
  issue"* and the header counts *"blocking rules failing"*.
- `"Acceptance criteria documented"` → **"Description is filled in"**. The rule checks description
  length; the old name described an intention rather than the check.
- The rule-type dropdown shows human names generated from the engine instead of raw type
  identifiers, so adding a rule type still requires no UI change.
- The settings page carries a permanent notice that rules are inert until the gate is attached to a
  transition — a control that silently does nothing is worse than no control.

### Fixed

- **Self-event guard never fired.** The trigger compared `event.atlassianId` to an app ARI — two
  different kinds of identifier. Replaced with the platform's `filter: ignoreSelf: true`, which
  drops the event before the function is invoked, plus a payload-level backstop.
- **Nightly sweep could apply the wrong project's rules.** `/search/jql` returns only the fields it
  is asked for, and `project` was not among them, so the sweep silently fell back to splitting the
  issue key.
- **Nightly sweep could time out.** Scheduled functions default to 55 seconds; the sweep walks up to
  200 issues with a storage read each. Raised explicitly.
- **`"type": "module"` broke the production bundle** while `forge lint`, ESLint and the full test
  suite all passed. Forge's bundler reads that field and switches to strict ESM, where a default
  import of a CommonJS package resolves to the module namespace rather than the default export —
  so `new Resolver()` threw at module load. Removed; Jest now runs through `babel-jest`. Written up
  in [docs/engineering-notes.md](docs/engineering-notes.md).
- Unhandled promise rejection in *Reset to defaults*, which left the settings page with no feedback
  on failure.

### Security

- Panel reads use `asUser()`, so Jira enforces the viewer's own permissions.
- Issue and project keys are read from the Forge extension context, never from the client payload.
- Client-asserted verdicts are ignored; every gated transition is re-evaluated server-side
  immediately before the write.
- Requested transitions are verified against the user's own available transitions.
- Every settings write re-checks `ADMINISTER_PROJECTS`; placement in an admin UI is not treated as
  authorisation.
- Scopes reduced to the minimum the app actually calls: `read:jira-work`, `write:jira-work`,
  `storage:app`. No external network egress.

---

## Known limitations

- `jira:workflowValidator` is an Atlassian **Preview** module — stable and supported, but subject
  to shorter deprecation windows than GA modules.
- The validator is primarily documented for company-managed projects. Team-managed support is
  declared but should be verified per site.
- The app cannot attach its own validator to a transition; an admin does this once per gated
  transition in the workflow editor.
- The issue panel is scoped to software projects by display condition.
- `minApprovals` matches comment authors by display name, so two users with identical display names
  would be counted as one.

## Considered next

- **Per-rule transition scope** — "this rule only applies when moving to Done", so one gated
  transition can require approvals while another only requires an owner.
- **Project-wide compliance view** — which issues are blocked and why, across a project. Needs its
  own storage model rather than reusing the fingerprint cache.
- **Richer audit comments** — naming the actor and the reason the evaluation ran.
