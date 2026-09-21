/* ----------------------------------------------------------------------------
 * EXCERPT from the Release Readiness Gate Forge app, reproduced here as a code
 * sample. The surrounding modules it imports are not included in this
 * repository, so this file will not run as-is. Unmodified otherwise.
 * -------------------------------------------------------------------------- */

/**
 * Rules engine tests.
 *
 * No mocks, no Jira, no Forge runtime - the engine is pure, so the tests are
 * plain data in, plain data out. This is the payoff for keeping decision logic
 * out of the resolvers.
 */

import { describe, it, expect } from '@jest/globals';
import { evaluate, validateRule, fingerprintChecks, DEFAULT_RULES, RULE_TYPES } from './rules.js';

/** A fixed clock, so `dueDateWithin` tests are not time bombs. */
const NOW = Date.parse('2026-03-01T00:00:00Z');

/** @returns {import('./rules.js').IssueFacts} */
function facts(overrides = {}) {
  return {
    key: 'REL-1',
    summary: 'Ship the thing',
    status: 'In Progress',
    statusCategory: 'indeterminate',
    issueType: 'Story',
    assignee: { accountId: 'acc-1', displayName: 'Dana Dev' },
    labels: [],
    fixVersions: [],
    dueDate: null,
    description: '',
    fields: {},
    links: [],
    comments: [],
    updated: '2026-02-28T10:00:00.000Z',
    ...overrides,
  };
}

/** @returns {import('./rules.js').Rule} */
function rule(overrides = {}) {
  return {
    id: 'r1',
    type: 'assigneeSet',
    label: 'Owner assigned',
    severity: 'blocker',
    enabled: true,
    params: {},
    ...overrides,
  };
}

const run = (f, rules) => evaluate(f, rules, { now: NOW });

describe('evaluate', () => {
  it('passes when no rules are configured', () => {
    const result = run(facts(), []);
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(0);
    expect(result.score).toBe(100);
  });

  it('skips disabled rules entirely', () => {
    const result = run(facts({ assignee: null }), [rule({ enabled: false })]);
    expect(result.checks).toHaveLength(0);
    expect(result.passed).toBe(true);
  });

  it('fails closed on a blocker but stays passable on a warning', () => {
    const blocked = run(facts({ assignee: null }), [rule({ severity: 'blocker' })]);
    expect(blocked.passed).toBe(false);
    expect(blocked.blockerCount).toBe(1);

    const warned = run(facts({ assignee: null }), [rule({ severity: 'warning' })]);
    expect(warned.passed).toBe(true);
    expect(warned.warningCount).toBe(1);
  });

  it('weights blockers 3x warnings in the score', () => {
    // One blocker passing, one warning failing => 3 of 4 weight earned.
    const result = run(facts({ assignee: { accountId: 'a', displayName: 'Dana' }, labels: [] }), [
      rule({ id: 'a', type: 'assigneeSet', severity: 'blocker' }),
      rule({ id: 'b', type: 'fixVersionSet', severity: 'warning' }),
    ]);
    expect(result.score).toBe(75);
  });

  it('reports a misconfigured rule as skipped rather than throwing', () => {
    const result = run(facts(), [rule({ type: 'fieldMatches', params: { field: 'summary', pattern: '([' } })]);
    expect(result.checks[0].status).toBe('skipped');
    expect(result.checks[0].detail).toMatch(/not a valid regular expression/);
    // A broken rule must not block a release on its own.
    expect(result.passed).toBe(true);
  });

  it('reports an unknown rule type as skipped', () => {
    const result = run(facts(), [rule({ type: 'doesNotExist' })]);
    expect(result.checks[0].status).toBe('skipped');
    expect(result.checks[0].detail).toMatch(/not a known rule type/);
  });

  it('contains a rule that throws at evaluation time', () => {
    // A rule whose params pass validation but whose data breaks the evaluator.
    const facts_ = facts();
    Object.defineProperty(facts_, 'labels', {
      get() {
        throw new Error('boom');
      },
    });
    const result = run(facts_, [rule({ type: 'labelPresent', params: { anyOf: ['x'] } })]);
    expect(result.checks[0].status).toBe('skipped');
    expect(result.checks[0].detail).toMatch(/threw during evaluation: boom/);
  });

  it('excludes skipped checks from the score', () => {
    const result = run(facts(), [
      rule({ id: 'ok', type: 'assigneeSet', severity: 'blocker' }),
      rule({ id: 'bad', type: 'nope' }),
    ]);
    expect(result.score).toBe(100);
  });
});

describe('rule types', () => {
  it('fieldNotEmpty enforces a minimum length', () => {
    const short = run(facts({ description: 'too short' }), [
      rule({ type: 'fieldNotEmpty', params: { field: 'description', minLength: 80 } }),
    ]);
    expect(short.checks[0].status).toBe('fail');
    expect(short.checks[0].detail).toBe('only 9 of 80 characters');

    const long = run(facts({ description: 'x'.repeat(100) }), [
      rule({ type: 'fieldNotEmpty', params: { field: 'description', minLength: 80 } }),
    ]);
    expect(long.checks[0].status).toBe('pass');
  });

  it('fieldNotEmpty reads arbitrary custom fields', () => {
    const result = run(facts({ fields: { customfield_10042: 'CHG-4471' } }), [
      rule({ type: 'fieldNotEmpty', params: { field: 'customfield_10042', minLength: 3 } }),
    ]);
    expect(result.checks[0].status).toBe('pass');
  });

  it('fieldMatches validates a change-reference format', () => {
    const result = run(facts({ fields: { customfield_10042: 'CHG-4471' } }), [
      rule({ type: 'fieldMatches', params: { field: 'customfield_10042', pattern: '^CHG-\\d{4}$' } }),
    ]);
    expect(result.checks[0].status).toBe('pass');
  });

  it('labelPresent accepts any one of the listed labels', () => {
    const result = run(facts({ labels: ['security-reviewed', 'frontend'] }), [
      rule({ type: 'labelPresent', params: { anyOf: ['security-reviewed', 'security-waived'] } }),
    ]);
    expect(result.checks[0].status).toBe('pass');
    expect(result.checks[0].detail).toBe('found security-reviewed');
  });

  it('noOpenBlockers ignores resolved blockers and outward links', () => {
    const result = run(
      facts({
        links: [
          { type: 'Blocks', direction: 'inward', issueKey: 'REL-2', issueType: 'Bug', statusCategory: 'done' },
          { type: 'Blocks', direction: 'outward', issueKey: 'REL-3', issueType: 'Bug', statusCategory: 'new' },
        ],
      }),
      [rule({ type: 'noOpenBlockers' })],
    );
    expect(result.checks[0].status).toBe('pass');
  });

  it('noOpenBlockers names the issues that are blocking', () => {
    const result = run(
      facts({
        links: [
          { type: 'Blocks', direction: 'inward', issueKey: 'REL-9', issueType: 'Bug', statusCategory: 'new' },
        ],
      }),
      [rule({ type: 'noOpenBlockers' })],
    );
    expect(result.checks[0].status).toBe('fail');
    expect(result.checks[0].detail).toBe('blocked by REL-9');
  });

  it('linkedIssueRequired can demand a specific issue type', () => {
    const links = [
      { type: 'Relates', direction: 'outward', issueKey: 'OPS-1', issueType: 'Task', statusCategory: 'new' },
    ];
    const wrongType = run(facts({ links }), [
      rule({ type: 'linkedIssueRequired', params: { linkType: 'Relates', issueType: 'Change' } }),
    ]);
    expect(wrongType.checks[0].status).toBe('fail');

    const anyType = run(facts({ links }), [
      rule({ type: 'linkedIssueRequired', params: { linkType: 'Relates' } }),
    ]);
    expect(anyType.checks[0].status).toBe('pass');
  });

  it('dueDateWithin measures against the injected clock', () => {
    const inside = run(facts({ dueDate: '2026-03-05' }), [
      rule({ type: 'dueDateWithin', params: { days: 14 } }),
    ]);
    expect(inside.checks[0].status).toBe('pass');
    expect(inside.checks[0].detail).toBe('due in 4 days');

    const outside = run(facts({ dueDate: '2026-06-01' }), [
      rule({ type: 'dueDateWithin', params: { days: 14 } }),
    ]);
    expect(outside.checks[0].status).toBe('fail');
  });

  it('dueDateWithin reports overdue issues as passing but overdue', () => {
    const result = run(facts({ dueDate: '2026-02-20' }), [
      rule({ type: 'dueDateWithin', params: { days: 14 } }),
    ]);
    expect(result.checks[0].status).toBe('pass');
    expect(result.checks[0].detail).toBe('overdue by 9 days');
  });

  it('minApprovals counts distinct approvers', () => {
    const result = run(
      facts({
        assignee: null,
        comments: [
          { author: 'Alex', body: '/approved looks good', created: '' },
          { author: 'Alex', body: '/approved again', created: '' },
        ],
      }),
      [rule({ type: 'minApprovals', params: { count: 2 } })],
    );
    expect(result.checks[0].status).toBe('fail');
    expect(result.checks[0].detail).toBe('1 of 2 approvals');
  });

  it('minApprovals does not let the assignee approve their own issue', () => {
    const result = run(
      facts({
        assignee: { accountId: 'acc-1', displayName: 'Dana Dev' },
        comments: [{ author: 'Dana Dev', body: '/approved by me', created: '' }],
      }),
      [rule({ type: 'minApprovals', params: { count: 1 } })],
    );
    expect(result.checks[0].status).toBe('fail');
    expect(result.checks[0].detail).toBe('0 of 1 approvals');
  });
});

describe('validateRule', () => {
  it('accepts a well-formed rule', () => {
    expect(validateRule(rule())).toEqual([]);
  });

  it('collects every problem at once, so the admin UI can show them together', () => {
    const problems = validateRule({ type: 'fieldNotEmpty', severity: 'critical', params: {} });
    expect(problems).toContain('id is required');
    expect(problems).toContain('label is required');
    expect(problems).toContain('severity must be "blocker" or "warning"');
    expect(problems).toContain('params.field is required');
  });
});

describe('fingerprintChecks', () => {
  it('is independent of check order', () => {
    const a = [
      { id: 'x', status: 'pass' },
      { id: 'y', status: 'fail' },
    ];
    expect(fingerprintChecks(a)).toBe(fingerprintChecks([...a].reverse()));
  });

  it('changes when an outcome changes', () => {
    const before = fingerprintChecks([{ id: 'x', status: 'pass' }]);
    const after = fingerprintChecks([{ id: 'x', status: 'fail' }]);
    expect(before).not.toBe(after);
  });
});

describe('DEFAULT_RULES', () => {
  it('is entirely valid, so a fresh project never sees a misconfiguration', () => {
    for (const r of DEFAULT_RULES) {
      expect(validateRule(r)).toEqual([]);
    }
  });

  it('only references rule types that exist', () => {
    for (const r of DEFAULT_RULES) {
      expect(Object.keys(RULE_TYPES)).toContain(r.type);
    }
  });

  it('uses unique ids', () => {
    const ids = DEFAULT_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
