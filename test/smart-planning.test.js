// Smart planning: the planner's ASSESSMENT / DEPENDENCIES / MANUAL_STEPS reach Fin as separate fields.
// The planner answers below are the REAL ones from the capability test (test/fixtures), played through the live
// worker code with a scripted MeshMesh and a recording `fetch`, so the exact webhook payloads are checked.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MESHMESH_MODE = 'live';
process.env.POLL_INTERVAL_MS = '1';
process.env.SF_TARGET_ORG = 'devhub';
process.env.SF_GUARD = 'true';
process.env.SF_PRECHECK = 'true';
process.env.SMART_PLANNING = 'true';
process.env.INTERCOM_ACCESS_TOKEN = '';
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'fmsmart-'));

const fx = (n) => readFileSync(new URL(`./fixtures/planner-${n}.txt`, import.meta.url), 'utf8');
const VENDOR = /meshmesh|start_agent|continue_agent|get_agent_status|\bMCP\b|sandbox not available/i;

let W; let G; let S; let C; let P;
const posts = [];
before(async () => {
  globalThis.fetch = async (url, init) => { posts.push({ url: String(url), body: JSON.parse(init.body) }); return { status: 200 }; };
  W = await import('../src/worker.js');
  G = await import('../src/guard.js');
  S = await import('../src/store.js');
  C = await import('../src/changeset.js');
  P = await import('../src/prompt.js');
});

const msg = (content) => ({ json: { status: 'waiting', isExecuting: false, waitingFor: '', recentMessages: [{ type: 'assistant', content }] } });
function fakeMesh(turns, savedPlan = '') {
  let turn = -1; let i = 0; const calls = [];
  return {
    calls,
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'start_agent' || name === 'continue_agent') { turn++; i = 0; return { json: { agentId: 'ag_1' }, text: '' }; }
      if (name === 'get_plan') return savedPlan ? { json: { plan: savedPlan, mode: 'plan' }, text: '' } : { json: null, text: '' };
      if (name === 'get_agent_status') { const t = turns[turn]; return t[Math.min(i++, t.length - 1)]; }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}
const org = async (args) => { if (/FieldDefinition/.test(args)) return { records: [] }; const t = (args.match(/--metadata-type (\w+)/) || [])[1]; return t ? [] : { records: [] }; };

async function planOnly(plannerText, extraInput = {}, savedPlan = '') {
  posts.length = 0;
  W.__test.setMesh(fakeMesh([[msg(plannerText)]], savedPlan)); G.__test.setCli(org); W.__test.setGuard(undefined);
  const r = S.createRequest({ contract: 'generic', requestor_email: 'jane.doe@test.com', change_request: 'x'.repeat(30), business_reason: 'test', title: 't', plan_callback_url: 'https://example.invalid/plan', callback_url: '', final_callback_url: '', conversation_id: '', ...extraInput });
  await W.runPlan(r.request_id);
  return { req: S.getRequest(r.request_id), hook: posts.map((p) => p.body).at(-1) };
}

test('already done (real planner answer S1): terminal already_done with the evidence in `assessment`, nothing built', async () => {
  const { req, hook } = await planOnly(fx('S1'));
  assert.equal(req.status, 'already_done');
  assert.equal(hook.status, 'already_done');
  assert.equal(hook.is_terminal, 'true');
  assert.match(hook.assessment, /^• Already in place: Opportunity\.Amount_Required_When_Closed_Won — /);
  assert.match(hook.assessment, /Enter an Amount before closing the deal/);
  assert.match(hook.assessment, /AND\(ISPICKVAL\(StageName, "Closed Won"\), OR\(ISBLANK\(Amount\), Amount <= 0\)\)/, 'the formula is kept: it is the evidence');
  assert.doesNotMatch(hook.message, /BEGIN_CHANGESET|RESULT:|ASSESSMENT:/);
  assert.equal(hook.change_count, '');           // no plan, no build
  assert.equal(req.plan_version || '', '');
});

test('redundant (S2a): says it is covered, keeps the planner\'s dependency note, no formula, no duplicate sections in message', async () => {
  const { hook } = await planOnly(fx('S2a'));
  assert.equal(hook.status, 'already_done');
  assert.match(hook.assessment, /^• Already covered: /);
  assert.match(hook.assessment, /stricter|blank, 0 or below 0/i);
  assert.match(hook.assessment, /ISPICKVAL\(StageName, "Closed Won"\)/);
  assert.match(hook.dependencies, /may be incomplete/i);
  assert.doesNotMatch(hook.message, /DEPENDENCIES|ASSESSMENT/);
});

test('conflict (S2b): needs_input carries the question first plus assessment, dependencies and manual steps', async () => {
  const { hook } = await planOnly(fx('S2b'));
  assert.equal(hook.status, 'needs_input');
  assert.match(hook.message, /^Question: The existing active rule/);
  assert.match(hook.assessment, /^• Conflict: /);
  assert.match(hook.assessment, /No Amount satisfies both/);
  assert.match(hook.dependencies, /may be incomplete/i);
  assert.match(hook.manual_steps, /^1\. Go to Setup > Object Manager > Opportunity > Validation Rules\./);
  assert.equal(hook.manual_steps.split('\n').length, 4);
});

test('declined request (S3b, Apex): rejected, with the full manual steps in their own field (the old 900-char cut lost these)', async () => {
  const { hook } = await planOnly(fx('S3b'));
  assert.equal(hook.status, 'rejected');
  assert.match(hook.message, /^Reason: We can't build this request through chat/);
  assert.equal(hook.manual_steps.split('\n').length, 5);
  assert.match(hook.manual_steps, /HttpCalloutMock/);
  assert.match(hook.dependencies, /may be incomplete/i);
  assert.match(hook.assessment, /Already in place: NamedCredential Partner_API/);
  assert.doesNotMatch(hook.message, /MANUAL_STEPS|DEPENDENCIES/);
});

test('a normal plan still works and also carries the findings (S3a-style plan with a question is not mistaken for a plan)', async () => {
  const plan = `${fx('S3a').split('BEGIN_CHANGESET')[0]}`.trim() && fx('S3a').replace(/RESULT: NEEDS_INPUT.*$/m, '').trim();
  const { hook } = await planOnly(plan);
  assert.equal(hook.status, 'plan_ready');
  assert.match(hook.changes, /^1\. Create ExternalCredential Partner_API_OAuth/);
  assert.match(hook.changes_plain, /^1\. Create the “Partner API OAuth” sign-in settings for the outside service/);
});

test('every payload from these real planner answers is vendor-free', async () => {
  for (const c of ['S1', 'S2a', 'S2b', 'S3b']) {
    const { hook } = await planOnly(fx(c));
    for (const k of ['message', 'assessment', 'dependencies', 'manual_steps', 'changes']) assert.doesNotMatch(hook[k] || '', VENDOR, `${c}.${k}`);
  }
});

test('parser: tags, plain text, sections removed from the free text', () => {
  const f = C.parsePlannerFindings(fx('S2b'));
  assert.deepEqual(f.tags, ['CONFLICT']);
  assert.deepEqual(f.has, { assessment: true, dependencies: true, manual_steps: true });
  const rest = C.stripFindings(fx('S2b'));
  assert.doesNotMatch(rest, /^ASSESSMENT:|^DEPENDENCIES:|^MANUAL_STEPS:|BEGIN_CHANGESET/m);
  assert.match(rest, /Summary/);
  assert.equal(C.parsePlannerFindings('A plain message with nothing tagged.').has.assessment, false);
  // formulas and API names are kept (they are the evidence); only markdown and backticks are removed
  assert.equal(C.plainText('It uses the formula `AND(A(B), C)`. In plain words, it **blocks** empty values.'), 'It uses the formula AND(A(B), C). In plain words, it blocks empty values.');
  assert.equal(C.plainText('See `Amount` and `Stage`.'), 'See Amount and Stage.');
});

test('the planner prompt only carries the smart rules when asked; the build message only asks for customer steps when asked', () => {
  const v = { requestor_email: 'a@b.com', change_request: 'Add a field', business_reason: 'x' };
  assert.match(P.buildPlanPrompt(v, 'fmr_x', {}, { smart: true }), /ASSESSMENT:.*ALREADY_DONE\|REDUNDANT\|CONFLICT\|NEW/s);
  assert.match(P.buildPlanPrompt(v, 'fmr_x', {}, { smart: true }), /RESULT: ALREADY_DONE/);
  assert.doesNotMatch(P.buildPlanPrompt(v, 'fmr_x', {}, {}), /ASSESSMENT|DEPENDENCIES|MANUAL_STEPS/);
  assert.doesNotMatch(P.buildPlanPrompt(v, 'fmr_x'), /ASSESSMENT/);
  assert.match(P.buildApprovalMessage('pv_1', '1. x', { smart: true }), /MANUAL_STEPS/);
  assert.doesNotMatch(P.buildApprovalMessage('pv_1', '1. x'), /MANUAL_STEPS/);
});

test('outcomeOf understands ALREADY_DONE', () => {
  assert.equal(W.outcomeOf('x\nRESULT: ALREADY_DONE - nothing to build'), 'already_done');
});

// ---- live finding: the planner writes its findings into the SAVED plan (get_plan) and only a short summary into
// its final chat message. These pairs are the real message + real saved plan from the live runs.
test('declined request, real v2 shape: short chat message, manual steps and dependencies come from the saved plan', async () => {
  const message = fx('v2-S3b-message');
  assert.doesNotMatch(message, /MANUAL_STEPS|DEPENDENCIES/, 'the real chat message has no sections');
  const { hook } = await planOnly(message, {}, fx('v2-S3b-saved-plan'));
  assert.equal(hook.status, 'rejected');
  assert.match(hook.message, /^Reason: We can't build the PartnerCallout code itself/);
  assert.ok(hook.manual_steps.split('\n').length >= 3, `manual steps: ${hook.manual_steps}`);
  assert.match(hook.dependencies, /may be incomplete/i);
  assert.match(hook.assessment, /Already in place: Partner API/);
  for (const k of ['message', 'assessment', 'dependencies', 'manual_steps']) assert.doesNotMatch(hook[k], VENDOR, k);
});

test('question with a conflict, real v2 shape: needs_input carries the conflict from the saved plan', async () => {
  const { hook } = await planOnly(fx('v2-S3a-message'), {}, fx('v2-S3a-saved-plan'));
  assert.equal(hook.status, 'needs_input');
  assert.match(hook.message, /^Question: Your existing "Partner API" connection/);
  assert.match(hook.assessment, /^• Conflict: Partner API \(named credential\)/);
  assert.match(hook.assessment, /Conflict: Partner API \(external credential\)/);
});

test('without the saved plan the chat message alone still works (get_plan unavailable)', async () => {
  const { hook } = await planOnly(fx('S1'));            // fake get_plan returns nothing
  assert.equal(hook.status, 'already_done');
  assert.match(hook.assessment, /Already in place/);
});

test('when get_plan fails the request still completes with what the chat message has', async () => {
  posts.length = 0;
  const mesh = fakeMesh([[msg(fx('S2b'))]]);
  const orig = mesh.callTool.bind(mesh);
  mesh.callTool = async (n, a) => { if (n === 'get_plan') throw new Error('network'); return orig(n, a); };
  W.__test.setMesh(mesh); G.__test.setCli(org); W.__test.setGuard(undefined);
  const r = S.createRequest({ contract: 'generic', requestor_email: 'jane.doe@test.com', change_request: 'x'.repeat(30), business_reason: 't', title: 't', plan_callback_url: 'https://example.invalid/plan', callback_url: '', final_callback_url: '', conversation_id: '' });
  await W.runPlan(r.request_id);
  assert.equal(posts.at(-1).body.status, 'needs_input');
  assert.match(posts.at(-1).body.assessment, /Conflict/);
});
