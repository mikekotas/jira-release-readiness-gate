/* ----------------------------------------------------------------------------
 * EXCERPT from the Release Readiness Gate Forge app, reproduced here as a code
 * sample. The surrounding modules it imports are not included in this
 * repository, so this file will not run as-is. Unmodified otherwise.
 * -------------------------------------------------------------------------- */

/**
 * Workflow validator: THE enforcement point.
 *
 * The issue panel's "Run gate & move" button is a convenience. This is the
 * control. A `jira:workflowValidator` runs inside Jira's own workflow engine,
 * so it applies to every route into a transition — the status dropdown, a card
 * dragged on a board, bulk change, Automation, the REST API and other apps —
 * not just to people who happened to use our panel.
 *
 * WHICH TRANSITIONS ARE GATED is not our decision and is deliberately not
 * configured in this app. A project admin adds this validator to the specific
 * transitions they want gated, in Jira's workflow editor. That is the right
 * place for it: Jira already owns transition configuration, and an app that
 * builds a second transition picker will disagree with the workflow sooner or
 * later.
 *
 * If the validator fails, the issue does not move, no post functions run, and
 * the message from buildGateMessage() is shown on the transition screen.
 */

import { evaluate } from '../core/rules.js';
import { normalizeIssue } from '../core/normalize.js';
import { mergeModifiedFields, buildGateMessage } from '../core/transition.js';
import { fetchIssue } from '../services/jira.js';
import { getRules } from '../services/store.js';

/**
 * What to do when the gate cannot reach a verdict — the issue read fails, KVS
 * is unavailable, the app is mid-deploy.
 *
 * `true` (fail open) allows the transition and logs loudly.
 * `false` (fail closed) refuses every transition it cannot evaluate.
 *
 * Fail open is the default on purpose. This is a process gate, not an
 * authorisation check: the cost of wrongly allowing one transition is a
 * comment from the nightly sweep, while the cost of wrongly refusing is that
 * nobody in the site can move any gated issue until the app recovers. An
 * outage in a readiness app must not become an outage in the customer's
 * workflow.
 *
 * Flip this single constant if your compliance posture requires the opposite.
 */
const FAIL_OPEN = true;

/** @returns {{ result: boolean, errorMessage?: string }} */
function onUnavailable(reason) {
  if (FAIL_OPEN) return { result: true };
  return {
    result: false,
    errorMessage: `Release readiness could not be checked (${reason}). This transition is blocked because the gate is configured to fail closed.`,
  };
}

/**
 * @param {{
 *   issue?: { key?: string },
 *   configuration?: Record<string, unknown>,
 *   transition?: { from?: { id?: string }, to?: { id?: string }, modifiedFields?: Record<string, unknown> }
 * }} args
 * @returns {Promise<{ result: boolean, errorMessage?: string }>}
 */
export async function validateTransition(args) {
  const issueKey = args?.issue?.key;

  if (!issueKey) {
    console.error('workflow validator invoked without an issue key');
    return onUnavailable('no issue key in the validator payload');
  }

  try {
    // No reliable user context inside a validator, so read as the app.
    const rawIssue = await fetchIssue(issueKey, { asApp: true });
    const projectKey = rawIssue?.fields?.project?.key ?? issueKey.split('-')[0];
    const { rules } = await getRules(projectKey);

    // Evaluate the issue as it WILL be after this transition, including the
    // values typed on the transition screen but not yet saved. Without this,
    // someone could satisfy a rule on the transition screen and still be
    // refused, or clear a field there and still be let through.
    const pending = mergeModifiedFields(rawIssue, args?.transition?.modifiedFields);
    const evaluation = evaluate(normalizeIssue(pending), rules);

    if (evaluation.passed) return { result: true };

    console.log('transition blocked by readiness gate', {
      issueKey,
      blockerCount: evaluation.blockerCount,
      score: evaluation.score,
      to: args?.transition?.to?.id,
    });

    return { result: false, errorMessage: buildGateMessage(evaluation) };
  } catch (err) {
    console.error('workflow validator failed', {
      issueKey,
      message: err.message,
      status: err.status,
    });
    return onUnavailable(err.message);
  }
}
