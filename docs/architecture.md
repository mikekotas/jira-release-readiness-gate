# Architecture

## The shape

```
                     ┌──────────────────────────────────────────┐
   Jira issue view ─▶│ jira:issuePanel            (UI Kit)      │
  Project settings ─▶│ jira:projectSettingsPage   (UI Kit)      │
                     └────────────────┬─────────────────────────┘
                                      │ invoke()
                     ┌────────────────▼─────────────────────────┐
                     │ resolvers/   panel · settings            │ ← authorisation,
                     └────────────────┬─────────────────────────┘   context extraction
                                      │
  jira:workflowValidator ────────────▶│  ← ENFORCEMENT, inside Jira's
  avi:jira:updated:issue ────────────▶│    workflow engine
  scheduledTrigger (daily) ──────────▶│
                     ┌────────────────▼─────────────────────────┐
                     │ core/   rules · normalize · adf ·        │ ← PURE. no I/O.
                     │         transition                       │   100% of the
                     │                                          │   decision logic.
                     └────────────────┬─────────────────────────┘
                     ┌────────────────▼─────────────────────────┐
                     │ services/   jira (REST) · store (KVS)    │ ← the only I/O
                     └────────────────┬─────────────────────────┘
                              ┌───────┴────────┐
                         Jira REST v3      Forge KVS
```

## Source layout

```
src/
├── index.js                    re-exports every handler the manifest names
├── core/                       PURE — imports nothing from Forge
│   ├── rules.js                the rule catalogue, evaluation, scoring, fingerprinting
│   ├── normalize.js            Jira REST payload → flat IssueFacts
│   ├── adf.js                  Atlassian Document Format in both directions
│   └── transition.js           transition-screen merge + gate message
├── services/                   the only modules that perform I/O
│   ├── jira.js                 Jira REST v3
│   └── store.js                Forge KVS
├── resolvers/                  UI entry points
│   ├── panel.js
│   └── settings.js
├── validators/
│   └── transitionGate.js       the workflow validator — the enforcement point
├── triggers/
│   ├── onIssueUpdated.js
│   └── nightlySweep.js
└── frontend/                   UI Kit
    ├── panel.jsx
    └── settings.jsx
```

The layering is conventional; the discipline is not. **Nothing in `core/` imports from Forge, and
nothing outside `services/` performs I/O.** That single constraint is what makes the rest work.

## Why the pure core is the load-bearing decision

An earlier and more obvious design puts the rule evaluation inside the panel resolver, where the
data already is. It works, and then it fails three times:

1. **The scheduled sweep needs the same logic**, and it has no user context, so the code gets
   copied and the two copies drift.
2. **The workflow validator needs the same logic again**, and now there are three verdicts for one
   question.
3. **None of it can be tested** without standing up a Jira instance, so it isn't.

Keeping the decision in one pure function makes all three problems disappear at once. The panel,
the validator, the product trigger and the nightly sweep are four callers of `evaluate(facts,
rules)`. They cannot disagree, because there is only one of it.

The cost is one extra layer — `normalize.js` — that flattens Jira's wide, deeply nested,
`fields`-dependent issue payload into a small flat object. That layer pays for itself as an
anti-corruption boundary: a change in the REST response shape is a one-file fix, and the rules
engine never sees a `null` nested three levels down.

## Data flow: rendering the panel

```
Panel mounts
   └─ invoke('getReadiness')                    ← ONE round trip, not one per widget
        └─ resolver reads issueKey + projectKey from req.context.extension
             ├─ getRules(projectKey)            KVS  ─┐
             ├─ fetchIssue(issueKey)            REST  ├─ in parallel
             └─ fetchTransitions(issueKey)      REST ─┘
        └─ evaluate(normalizeIssue(raw), rules) PURE
        └─ { evaluation, transitions, meta }
```

One resolver call per render. Each `invoke()` is a billed function invocation, and three chatty
calls do not render faster than one.

## Data flow: a gated transition

```
User picks a transition, hits "Run gate & move"
   └─ invoke('gatedTransition', { transitionId })    ← only the ID crosses the wire
        └─ re-read the issue, re-evaluate from scratch
        └─ if any blocker fails        → refuse, return the reason
        └─ verify transitionId ∈ the USER's own available transitions
        └─ execute the transition (as the user)
        └─ post the audit comment, record the fingerprint
```

And independently, whatever route the user took:

```
Jira workflow engine reaches the transition
   └─ jira:workflowValidator invoked
        └─ fetch the issue (as the app)
        └─ merge transition-screen edits over it
        └─ evaluate
        └─ { result: false, errorMessage } → Jira refuses and shows the message
```

The panel's check is a friendly pre-flight. The validator is the control. They run the same
function, so a user never sees one say yes and the other say no.

## Security model

| Concern | How it's handled |
| --- | --- |
| Reading issues the user can't see | Panel reads go through `api.asUser()`. Jira enforces the viewer's own permissions, so the app cannot become a hole to read issues through. |
| Forged issue keys | The issue and project key come from `req.context.extension`, which Forge populates from the page. Never from the client payload. A resolver that accepts an issue key from its client can be pointed at any issue on the site. |
| Client-asserted "checks passed" | Ignored. Re-evaluated server-side immediately before the write. |
| Unauthorised rule changes | Every write re-checks `ADMINISTER_PROJECTS` via `/mypermissions`. Rendering inside an admin UI is placement, not authorisation — a resolver is an endpoint, and an endpoint that assumes its own UI is the only caller is waiting to be called directly. |
| Transition escalation | The requested transition is verified against the user's *own* available transitions, rather than forwarding an arbitrary ID to Jira and relying on its error. |
| Bypassing the app's UI | Enforcement is a workflow validator, so every route into a transition is covered. |
| Failed permission check | Resolves to **denied**. An authorisation check that cannot complete never resolves to "allowed". |
| Gate unavailable | **Fails open**, and logs. Deliberately the opposite of the row above — see *Failure posture*. |
| Secrets | None in the repository. Runtime configuration uses the encrypted Forge CLI variable store. |

### Failure posture: two different answers on purpose

Authorisation fails **closed**. If the app cannot determine whether you may edit these rules, you
may not.

The gate fails **open**. If the app cannot determine whether an issue is ready, the transition
proceeds and the failure is logged loudly.

They look inconsistent and they are not. An authorisation failure that resolves to "allowed" is a
vulnerability. A process gate that resolves to "refused" during an app outage takes every team in
the organisation offline until it recovers — a far larger incident than the one it prevents, and
the nightly sweep will flag anything that slipped through within a day. It is one constant for an
organisation that disagrees.

## Storage

Forge KVS, two key spaces, deliberately kept apart:

| Key | Contents | Write pattern |
| --- | --- | --- |
| `rules:<projectKey>` | The rule set an admin configured, plus who changed it and when | Rare |
| `state:<issueKey>` | An 8-character evaluation fingerprint, the pass/fail flag and the score | Hot |

`state:` stores a **fingerprint, not the evaluation**. The full result is recomputable from the
issue in milliseconds, and KVS is a billed resource — keeping a copy of every check for every issue
would be paying to store something free to regenerate. The fingerprint exists for exactly one
purpose: deciding whether anything actually changed, so an unchanged verdict produces no comment.

Every read is defensive. KVS returns whatever was last written, and what was last written may have
been produced by an older version of the app.

## Cost discipline

Forge bills invocations, GB-seconds and storage, and an app that comments too often gets
uninstalled. This is a design constraint, not an optimisation pass:

- Issue reads request **only the 12 fields** the app uses, never `*all`.
- One resolver round trip per panel render.
- The product trigger discards changes to fields no rule can read before doing any work.
- Evaluations are fingerprinted, so an identical verdict costs nothing downstream.
- The platform drops self-generated events before the function is even invoked.
- The nightly sweep is bounded on every axis: a 30-day JQL window, a page cap, a 200-issue ceiling,
  and per-project rule caching so it reads each rule set once per run rather than once per issue.
- The sweep runs with a raised timeout because it legitimately needs one — the default 55 seconds
  does not reliably cover 200 issues, and a function that dies halfway is billed for the whole
  attempt.

## Extensibility

Adding a rule type is one entry in `RULE_TYPES`:

```js
myNewRule: {
  title: 'Human name for the dropdown',
  describe: (p) => `what this rule requires, given ${p.someParam}`,
  validate: (p) => (p.someParam ? null : 'params.someParam is required'),
  evaluate: (facts, p, now) => ({ ok: true, detail: 'why' }),
}
```

…plus a test. Nothing else changes:

- the **admin UI generates its catalogue from the engine**, so the new type appears in the dropdown
  automatically;
- **storage is schema-less** with respect to rule params;
- the **panel renders whatever checks come back**.

Each entry validates its own parameters, so a rule an admin misconfigures degrades to *skipped*
with a reason rather than crashing the panel for everyone.
