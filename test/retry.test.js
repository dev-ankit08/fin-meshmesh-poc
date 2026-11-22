// Regression: a transient "fetch failed" while polling MeshMesh (seen live right after a token refresh)
// must not fail a healthy run. Read-only tools retry with backoff; write tools are not repeated more than once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, READ_ONLY_TOOLS, RETRY_DELAYS_MS, isAuthError } from '../src/meshmesh.js';

const noSleep = { sleep: async () => {} };

test('withRetry recovers from transient failures', async () => {
  let calls = 0;
  const out = await withRetry(async () => { if (++calls < 3) throw new Error('fetch failed'); return 'ok'; }, [1, 1, 1], noSleep);
  assert.equal(out, 'ok');
  assert.equal(calls, 3);
});

test('withRetry gives up after the last delay and rethrows', async () => {
  let calls = 0;
  await assert.rejects(withRetry(async () => { calls++; throw new Error('fetch failed'); }, [1, 1], noSleep), /fetch failed/);
  assert.equal(calls, 3);
});

test('polling tools retry with backoff, non-idempotent tools retry at most once', () => {
  for (const t of ['get_agent_status', 'get_plan', 'list_connections']) assert.ok(READ_ONLY_TOOLS.has(t));
  for (const t of ['start_agent', 'continue_agent']) assert.ok(!READ_ONLY_TOOLS.has(t));
  assert.ok(RETRY_DELAYS_MS.read.length >= 3);
  assert.ok(RETRY_DELAYS_MS.write.length >= 2); // later write retries are gated to auth errors by shouldRetry
});

// ---- Shapes seen live on 22 Nov 2026 (T19 / T20)
import { cleanMessage, outcomeOf, retryableStart, isTryAgain } from '../src/worker.js';

const T19_MESSAGE = `I can't build this through chat: Salesforce's recommended way is a before-save record-triggered Flow (or the Apex trigger you asked for), and neither can be changed here.

BEGIN_CHANGESET
[]
END_CHANGESET

RESULT: FAILED - needs ApexTrigger (or Flow), which cannot be changed through chat`;

test('T19: a declined plan turn is a failed outcome and the customer text has no CHANGESET or RESULT line', () => {
  assert.equal(outcomeOf(T19_MESSAGE), 'failed');
  const clean = cleanMessage(T19_MESSAGE);
  assert.ok(clean.startsWith("I can't build this through chat"));
  assert.ok(!/CHANGESET|RESULT:/.test(clean));
});

test('T20: "Sandbox not available - please try again" on start_agent is retried, other errors are not', async () => {
  const err = new Error('MeshMesh tool start_agent failed: {"error":"Sandbox not available - please try again"}');
  assert.ok(isTryAgain(err));
  assert.ok(!isTryAgain(new Error('MeshMesh tool start_agent failed: invalid connection id')));
  let calls = 0;
  const out = await retryableStart(async () => { if (++calls < 3) throw err; return 'started'; }, 'fmr_test', { delays: [1, 1, 1], sleep: async () => {} });
  assert.equal(out, 'started');
  let n = 0;
  await assert.rejects(retryableStart(async () => { n++; throw new Error('invalid connection id'); }, 'fmr_test', { delays: [1, 1], sleep: async () => {} }), /invalid connection id/);
  assert.equal(n, 1);
});

import { customerMessage } from '../src/notify.js';

const T21_MESSAGE = `I can't plan the rule yet: the request doesn't say which object it's for. I made no changes to the org.

BEGIN_CHANGESET
[]
END_CHANGESET

RESULT: NEEDS_INPUT - Which object should the validation rule apply to, and what condition should block a save (with the error message users should see)?`;

test('T21: what Fin receives for needs_input has the question first and no CHANGESET block or RESULT line', () => {
  assert.equal(outcomeOf(T21_MESSAGE), 'needs_input');
  const t = customerMessage('needs_input', T21_MESSAGE);
  assert.ok(t.startsWith('Question: Which object should the validation rule apply to'));
  assert.ok(!/CHANGESET|RESULT:/.test(t));
  assert.match(t, /I made no changes to the org\./);
});

test('T19: a rejected message sent to Fin has no CHANGESET block either', () => {
  const t = customerMessage('rejected', 'Reason: ' + cleanMessage(T19_MESSAGE) + '\n\nNothing was changed in Salesforce.');
  assert.ok(!/CHANGESET|RESULT:/.test(t));
});
