/* ----------------------------------------------------------------------------
 * EXCERPT from the Release Readiness Gate Forge app, reproduced here as a code
 * sample. The surrounding modules it imports are not included in this
 * repository, so this file will not run as-is. Unmodified otherwise.
 * -------------------------------------------------------------------------- */

/**
 * Release-readiness rules engine.
 *
 * PURE MODULE - no Forge imports, no network, no ambient clock.
 * Every decision the app makes lives here, so it can be unit tested in
 * milliseconds without a Jira instance, a tunnel, or a single mock.
 *
 * The adapters (src/services, src/resolvers, src/triggers) do I/O and nothing
 * else: they normalise a Jira issue into `IssueFacts` and hand it to evaluate().
 */

import { adfToPlainText } from './adf.js';

/**
 * @typedef {Object} IssueFacts
 * @property {string} key
 * @property {string} summary
 * @property {string} status
 * @property {'new'|'indeterminate'|'done'|'unknown'} statusCategory
 * @property {string} issueType
 * @property {{ accountId: string, displayName: string } | null} assignee
 * @property {string[]} labels
 * @property {string[]} fixVersions
 * @property {string|null} dueDate ISO date (YYYY-MM-DD)
 * @property {string} description plain text
 * @property {Record<string, unknown>} fields raw field map, for custom fields
 * @property {IssueLink[]} links
 * @property {IssueComment[]} comments
 * @property {string} updated ISO timestamp
 *
 * @typedef {Object} IssueLink
 * @property {string} type e.g. "Blocks"
 * @property {'inward'|'outward'} direction
 * @property {string} issueKey
 * @property {string} issueType
 * @property {'new'|'indeterminate'|'done'|'unknown'} statusCategory
 *
 * @typedef {Object} IssueComment
 * @property {string} author
 * @property {string} body plain text
 * @property {string} created ISO timestamp
 *
 * @typedef {Object} Rule
 * @property {string} id
 * @property {string} type one of RULE_TYPES
 * @property {string} label
 * @property {'blocker'|'warning'} severity
 * @property {boolean} enabled
 * @property {Record<string, any>} params
 *
 * @typedef {Object} CheckResult
 * @property {string} id
 * @property {string} label
 * @property {'blocker'|'warning'} severity
 * @property {'pass'|'fail'|'skipped'} status
 * @property {string} detail
 *
 * @typedef {Object} Evaluation
 * @property {string} issueKey
 * @property {string} evaluatedAt
 * @property {CheckResult[]} checks
 * @property {boolean} passed
 * @property {number} blockerCount
 * @property {number} warningCount
 * @property {number} score 0-100, weighted so blockers dominate
 * @property {string} fingerprint stable hash of the outcome, for change detection
 */

const MS_PER_DAY = 86400000;

/**
 * Read a field from facts, supporting both the named top-level facts and
 * arbitrary custom fields (e.g. "customfield_10042").
 * @param {IssueFacts} facts
 * @param {string} field
 */
function readField(facts, field) {
  switch (field) {
    case 'summary':
      return facts.summary;
    case 'description':
      return facts.description;
    case 'assignee':
      return facts.assignee ? facts.assignee.displayName : '';
    case 'duedate':
      return facts.dueDate || '';
    default:
      return facts.fields ? facts.fields[field] : undefined;
  }
}

/** Render any Jira field value as comparable plain text. */
function asText(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(', ');
  if (typeof value === 'object') {
    // Rich-text field: an ADF document.
    if (value.type === 'doc') return adfToPlainText(value);
    // Option / user / version style objects.
    return String(value.value ?? value.name ?? value.displayName ?? value.key ?? '');
  }
  return '';
}

function truncate(value, max) {
  return value.length > max ? value.slice(0, max - 1) + '…' : value;
}

/**
 * The rule catalogue.
 *
 * Each entry declares how to validate its own params - so a malformed rule
 * written by an admin degrades to `skipped` instead of crashing the panel -
 * and how to evaluate itself against the facts.
 *
 * Adding a rule type is one self-contained entry here plus a test. No changes
 * to the resolvers, the UI, or the storage layer.
 */
export const RULE_TYPES = {
  fieldNotEmpty: {
    title: 'Field is filled in',
    describe: (p) => `${p.field} must contain at least ${p.minLength ?? 1} characters`,
    validate: (p) => (typeof p?.field === 'string' && p.field ? null : 'params.field is required'),
    evaluate: (facts, p) => {
      const value = asText(readField(facts, p.field)).trim();
      const min = Number(p.minLength ?? 1);
      if (value.length >= min) return { ok: true, detail: `${value.length} characters` };
      return {
        ok: false,
        detail: value.length ? `only ${value.length} of ${min} characters` : 'empty',
      };
    },
  },

  fieldMatches: {
    title: 'Field matches a pattern',
    describe: (p) => `${p.field} must match the regular expression /${p.pattern}/`,
    validate: (p) => {
      if (!p?.field) return 'params.field is required';
      if (!p?.pattern) return 'params.pattern is required';
      try {
        new RegExp(p.pattern, p.flags ?? '');
      } catch (err) {
        return `params.pattern is not a valid regular expression: ${err.message}`;
      }
      return null;
    },
    evaluate: (facts, p) => {
      const value = asText(readField(facts, p.field));
      const matched = new RegExp(p.pattern, p.flags ?? '').test(value);
      if (matched) return { ok: true, detail: 'pattern matched' };
      return {
        ok: false,
        detail: value ? `"${truncate(value, 60)}" does not match` : 'field is empty',
      };
    },
  },

  labelPresent: {
    title: 'Carries one of these labels',
    describe: (p) => `the issue must carry one of these labels: ${(p.anyOf ?? []).join(', ')}`,
    validate: (p) =>
      Array.isArray(p?.anyOf) && p.anyOf.length ? null : 'params.anyOf must be a non-empty array',
    evaluate: (facts, p) => {
      const labels = facts.labels ?? [];
      const found = (p.anyOf ?? []).filter((l) => labels.includes(l));
      if (found.length) return { ok: true, detail: `found ${found.join(', ')}` };
      return { ok: false, detail: labels.length ? `has ${labels.join(', ')}` : 'no labels set' };
    },
  },

  assigneeSet: {
    title: 'Has an assignee',
    describe: () => 'the issue must have an assignee',
    validate: () => null,
    evaluate: (facts) =>
      facts.assignee
        ? { ok: true, detail: facts.assignee.displayName }
        : { ok: false, detail: 'unassigned' },
  },

  fixVersionSet: {
    title: 'Has a fix version',
    describe: () => 'the issue must be attached to a fix version',
    validate: () => null,
    evaluate: (facts) => {
      const versions = facts.fixVersions ?? [];
      return versions.length
        ? { ok: true, detail: versions.join(', ') }
        : { ok: false, detail: 'no fix version' };
    },
  },

  dueDateWithin: {
    title: 'Due date is set and close enough',
    describe: (p) =>
      `the issue must have a due date no more than ${p.days} days away (an overdue date still counts)`,
    validate: (p) =>
      Number.isFinite(Number(p?.days)) && Number(p.days) > 0
        ? null
        : 'params.days must be a positive number',
    evaluate: (facts, p, now) => {
      if (!facts.dueDate) return { ok: false, detail: 'no due date' };
      const due = Date.parse(`${facts.dueDate}T00:00:00Z`);
      if (Number.isNaN(due)) {
        return { ok: false, detail: `unparseable due date "${facts.dueDate}"` };
      }
      const days = Math.ceil((due - now) / MS_PER_DAY);
      if (days <= Number(p.days)) {
        return { ok: true, detail: days < 0 ? `overdue by ${-days} days` : `due in ${days} days` };
      }
      return { ok: false, detail: `due in ${days} days, limit is ${p.days}` };
    },
  },

  noOpenBlockers: {
    // NOTE: "blocker" here means a BLOCKING LINKED ISSUE, not the `blocker`
    // severity. Keep the wording explicit — the two are unrelated and reading
    // one as the other is the single most confusing thing about this panel.
    title: 'Not blocked by another issue',
    describe: () =>
      'no other issue is linked to this one as "is blocked by" while still open',
    validate: () => null,
    evaluate: (facts) => {
      const open = (facts.links ?? []).filter(
        (l) => /block/i.test(l.type) && l.direction === 'inward' && l.statusCategory !== 'done',
      );
      if (open.length === 0) return { ok: true, detail: 'no blocking issues linked' };
      return { ok: false, detail: `blocked by ${open.map((l) => l.issueKey).join(', ')}` };
    },
  },

  linkedIssueRequired: {
    title: 'Has a required issue link',
    describe: (p) => `the issue must link a ${p.issueType ?? 'issue'} via "${p.linkType}"`,
    validate: (p) =>
      typeof p?.linkType === 'string' && p.linkType ? null : 'params.linkType is required',
    evaluate: (facts, p) => {
      const wantedType = String(p.linkType).toLowerCase();
      const wantedIssueType = p.issueType ? String(p.issueType).toLowerCase() : null;
      const matches = (facts.links ?? []).filter((l) => {
        if (l.type.toLowerCase() !== wantedType) return false;
        if (!wantedIssueType) return true;
        return String(l.issueType ?? '').toLowerCase() === wantedIssueType;
      });
      return matches.length
        ? { ok: true, detail: matches.map((l) => l.issueKey).join(', ') }
        : { ok: false, detail: 'no matching link' };
    },
  },

  minApprovals: {
    title: 'Has enough approval comments',
    describe: (p) =>
      `${p.count} different people (never the assignee) must comment "${p.marker ?? '/approved'}"`,
    validate: (p) =>
      Number.isInteger(Number(p?.count)) && Number(p.count) > 0
        ? null
        : 'params.count must be a positive integer',
    evaluate: (facts, p) => {
      const marker = String(p.marker ?? '/approved').toLowerCase();
      // Distinct approvers only - one person cannot approve their way past a gate.
      const approvers = new Set(
        (facts.comments ?? [])
          .filter((c) => String(c.body ?? '').toLowerCase().includes(marker))
          .map((c) => c.author),
      );
      // A self-approval by the assignee never counts toward the threshold.
      if (facts.assignee?.displayName) approvers.delete(facts.assignee.displayName);
      const count = Number(p.count);
      if (approvers.size >= count) {
        return { ok: true, detail: `approved by ${[...approvers].join(', ')}` };
      }
      return { ok: false, detail: `${approvers.size} of ${count} approvals` };
    },
  },
};

/**
 * Validate a rule definition before it is stored or evaluated.
 * @param {Partial<Rule>} rule
 * @returns {string[]} human-readable problems; empty means valid
 */
export function validateRule(rule) {
  const problems = [];
  if (!rule || typeof rule !== 'object') return ['rule must be an object'];
  if (!rule.id) problems.push('id is required');
  if (!rule.label) problems.push('label is required');
  if (!RULE_TYPES[rule.type]) {
    problems.push(`type "${rule.type}" is not a known rule type`);
    return problems; // cannot validate params against an unknown type
  }
  if (rule.severity !== 'blocker' && rule.severity !== 'warning') {
    problems.push('severity must be "blocker" or "warning"');
  }
  const paramProblem = RULE_TYPES[rule.type].validate(rule.params ?? {});
  if (paramProblem) problems.push(paramProblem);
  return problems;
}

/**
 * A stable, order-independent fingerprint of an evaluation outcome.
 *
 * The product trigger uses this to decide whether anything actually changed,
 * so a re-run that reaches the same verdict does not post a duplicate audit
 * comment. Cheap 32-bit FNV-1a: this is change detection, not security.
 *
 * @param {CheckResult[]} checks
 * @returns {string}
 */
export function fingerprintChecks(checks) {
  const canonical = [...checks]
    .map((c) => `${c.id}:${c.status}`)
    .sort()
    .join('|');
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i += 1) {
    hash ^= canonical.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/**
 * Evaluate a rule set against an issue.
 *
 * Never throws. A rule that is malformed, or whose evaluator blows up on
 * unexpected data, is reported as `skipped` with the reason. One bad rule must
 * not take down the panel for every issue in the project.
 *
 * @param {IssueFacts} facts
 * @param {Rule[]} rules
 * @param {{ now?: number }} [options]
 * @returns {Evaluation}
 */
export function evaluate(facts, rules, options = {}) {
  const now = options.now ?? Date.now();
  const checks = [];

  for (const rule of rules ?? []) {
    if (rule?.enabled === false) continue;

    const problems = validateRule(rule);
    if (problems.length) {
      checks.push({
        id: rule?.id ?? 'unknown',
        label: rule?.label ?? 'Misconfigured rule',
        severity: 'warning',
        status: 'skipped',
        detail: `Rule is misconfigured: ${problems.join('; ')}`,
      });
      continue;
    }

    try {
      const outcome = RULE_TYPES[rule.type].evaluate(facts, rule.params ?? {}, now);
      checks.push({
        id: rule.id,
        label: rule.label,
        severity: rule.severity,
        status: outcome.ok ? 'pass' : 'fail',
        detail: outcome.detail,
      });
    } catch (err) {
      checks.push({
        id: rule.id,
        label: rule.label,
        severity: 'warning',
        status: 'skipped',
        detail: `Rule threw during evaluation: ${err.message}`,
      });
    }
  }

  const failures = checks.filter((c) => c.status === 'fail');
  const blockerCount = failures.filter((c) => c.severity === 'blocker').length;
  const warningCount = failures.filter((c) => c.severity === 'warning').length;
  const scored = checks.filter((c) => c.status !== 'skipped');

  // Blockers weigh 3x warnings, so the score tracks release risk rather than
  // a raw count of ticked boxes.
  const weight = (c) => (c.severity === 'blocker' ? 3 : 1);
  const totalWeight = scored.reduce((sum, c) => sum + weight(c), 0);
  const earnedWeight = scored
    .filter((c) => c.status === 'pass')
    .reduce((sum, c) => sum + weight(c), 0);

  return {
    issueKey: facts.key,
    evaluatedAt: new Date(now).toISOString(),
    checks,
    passed: blockerCount === 0,
    blockerCount,
    warningCount,
    score: totalWeight === 0 ? 100 : Math.round((earnedWeight / totalWeight) * 100),
    fingerprint: fingerprintChecks(checks),
  };
}

/**
 * The rule set applied to a project that has never been configured.
 * Useful-but-not-annoying on day one: two blockers nobody argues with,
 * two warnings that start a conversation.
 * @type {Rule[]}
 */
export const DEFAULT_RULES = [
  {
    id: 'acceptance-criteria',
    type: 'fieldNotEmpty',
    label: 'Description is filled in',
    severity: 'blocker',
    enabled: true,
    params: { field: 'description', minLength: 80 },
  },
  {
    id: 'no-open-blockers',
    type: 'noOpenBlockers',
    label: 'Not blocked by another issue',
    severity: 'blocker',
    enabled: true,
    params: {},
  },
  {
    id: 'assignee-set',
    type: 'assigneeSet',
    label: 'Owner assigned',
    severity: 'warning',
    enabled: true,
    params: {},
  },
  {
    id: 'fix-version',
    type: 'fixVersionSet',
    label: 'Fix version attached',
    severity: 'warning',
    enabled: true,
    params: {},
  },
];
