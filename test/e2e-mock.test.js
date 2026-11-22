// End-to-end in mock mode: real bridge process + a fake "Fin" that receives the Wait-for-webhook posts.
// No MeshMesh credits, no Salesforce calls.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TOKEN = 'test-token-123';
const BRIDGE_PORT = 18000 + Math.floor(Math.random() * 1000);
let fin; let finPort; let bridge;
const hooks = {}; const waiters = {};
const seenText = []; // every webhook payload and every HTTP reply, to prove the vendor never leaks

function hook(name) {
  return new Promise((resolve) => {
    if (hooks[name]) return resolve(hooks[name]);
    waiters[name] = resolve;
  });
}
const url = (name) => `http://127.0.0.1:${finPort}/${name}`;
const uniq = () => Math.random().toString(36).slice(2, 8);

async function call(p, body, token = TOKEN) {
  const r = await fetch(`http://127.0.0.1:${BRIDGE_PORT}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body),
  });
  const out = await r.json();
  seenText.push(JSON.stringify(out));
  return { code: r.status, body: out };
}

before(async () => {
  fin = http.createServer(async (req, res) => {
    let raw = ''; for await (const c of req) raw += c;
    const name = req.url.slice(1);
    hooks[name] = JSON.parse(raw);
    seenText.push(raw);
    waiters[name]?.(hooks[name]);
    res.writeHead(200).end('{}');
  });
  await new Promise((r) => fin.listen(0, '127.0.0.1', r));
  finPort = fin.address().port;
  bridge = spawn(process.execPath, ['src/server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(BRIDGE_PORT), FIN_BEARER_TOKEN: TOKEN, MESHMESH_MODE: 'mock', POLL_INTERVAL_MS: '300', DATA_DIR: mkdtempSync(path.join(os.tmpdir(), 'fmb-')), INTERCOM_ACCESS_TOKEN: '' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) {
    try { await fetch(`http://127.0.0.1:${BRIDGE_PORT}/health`); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error('bridge did not start');
});
after(() => { bridge?.kill(); fin?.close(); });

const base = { requestor_email: 'jane.doe@test.com', business_reason: 'PoC test', conversation_id: '1' };

test('no token -> 401', async () => {
  assert.equal((await call('/requests', base, '')).code, 401);
});

test('generic happy path: outbound HTTPS setup -> plan -> customer approves -> build -> verified', async () => {
  const k = uniq();
  const r = await call('/requests', { ...base, change_request: 'Set up outbound HTTPS callouts (named credential) to https://api.example.com for the integration team', plan_callback_url: url(`plan_${k}`) });
  assert.equal(r.code, 202); assert.equal(r.body.approval, 'customer');
  const plan = await hook(`plan_${k}`);
  assert.equal(plan.status, 'plan_ready');
  assert.match(plan.changes, /Create NamedCredential Partner_API/);
  assert.match(plan.changes, /Create ExternalCredential/);
  assert.match(plan.warnings, /not entered through chat/);
  assert.ok(plan.plan_version.startsWith('pv_'));

  const wrong = await call(`/requests/${r.body.request_id}/decision`, { decision: 'approve', plan_version: 'pv_wrong' });
  assert.equal(wrong.body.problems, 'plan_version_mismatch');

  const d = await call(`/requests/${r.body.request_id}/decision`, { decision: 'approve', plan_version: plan.plan_version, callback_url: url(`prog_${k}`), final_callback_url: url(`final_${k}`) });
  assert.equal(d.code, 202); assert.equal(d.body.status, 'building');
  assert.equal((await hook(`prog_${k}`)).status, 'building');
  const fin2 = await hook(`final_${k}`);
  assert.equal(fin2.status, 'succeeded'); assert.equal(fin2.is_terminal, 'true');
  assert.match(fin2.message, /Independently verified/);

  const again = await call(`/requests/${r.body.request_id}/decision`, { decision: 'approve' });
  assert.equal(again.body.problems, 'wrong_state'); // a plan can only be built once
});

test('External Client App request is planned with its OAuth settings components', async () => {
  const k = uniq();
  const r = await call('/requests', { ...base, change_request: 'Create an External Client App so our ERP can call Salesforce with OAuth client credentials', plan_callback_url: url(`plan_${k}`) });
  const plan = await hook(`plan_${k}`);
  assert.equal(plan.status, 'plan_ready', plan.message);
  assert.match(plan.changes, /ExternalClientApplication Fin_Integration/);
  assert.match(plan.warnings, /never shown in chat/);
  const c = await call('/requests/decision', { request_id: r.body.request_id, decision: 'cancel' });
  assert.equal(c.body.status, 'cancelled');
});

test('duplicate field in the plan is refused before the customer is asked (T4 protection)', async () => {
  const k = uniq();
  await call('/requests', { ...base, change_request: 'Add a field called PoC Customer Tier on Account for segmentation', plan_callback_url: url(`plan_${k}`) });
  const plan = await hook(`plan_${k}`);
  assert.equal(plan.status, 'rejected');
  assert.match(plan.message, /^Reason: CustomField Account\.PoC_Customer_Tier__c already exists/);
});

test('policy refuses Apex and deletes through chat', async () => {
  for (const cr of ['Write an apex trigger that updates the account rating', 'Please delete the old field on Account']) {
    const k = uniq();
    await call('/requests', { ...base, change_request: cr, plan_callback_url: url(`plan_${k}`) });
    const plan = await hook(`plan_${k}`);
    assert.equal(plan.status, 'rejected', cr);
    assert.match(plan.message, /can't be done through chat/);
  }
});

test('MeshMesh question -> customer answers (revise) -> new plan', async () => {
  const k = uniq();
  const r = await call('/requests', { ...base, change_request: 'Add a validation rule, not sure where exactly', plan_callback_url: url(`plan_${k}`) });
  const q = await hook(`plan_${k}`);
  assert.equal(q.status, 'needs_input');
  assert.match(q.message, /^Question: Which object/);
  const rv = await call(`/requests/${r.body.request_id}/decision`, { decision: 'revise', feedback: 'On Account, Industry required when Type is Customer', plan_callback_url: url(`plan2_${k}`) });
  assert.equal(rv.code, 202);
  const p2 = await hook(`plan2_${k}`);
  assert.equal(p2.status, 'plan_ready');
  assert.match(p2.changes, /ValidationRule Account\.Require_Industry/);
});

test('legacy single-field connector still works (auto-approve, two webhooks)', async () => {
  const k = uniq();
  const r = await call('/requests', { ...base, field_label: 'Renewal Risk', field_type: 'Text', permission_set: 'Fin PoC Access', callback_url: url(`prog_${k}`), final_callback_url: url(`final_${k}`) });
  assert.equal(r.code, 202); assert.equal(r.body.field_api_name, 'Renewal_Risk__c'); assert.equal(r.body.approval, 'auto');
  assert.equal((await hook(`prog_${k}`)).status, 'planning');
  const f = await hook(`final_${k}`);
  assert.equal(f.status, 'succeeded');
});

test('legacy duplicate goes to the final webhook as failed, never succeeded', async () => {
  const k = uniq();
  await call('/requests', { ...base, field_label: 'PoC Customer Tier', field_type: 'Text', permission_set: 'Fin PoC Access', callback_url: url(`prog_${k}`), final_callback_url: url(`final_${k}`) });
  const f = await hook(`final_${k}`);
  assert.equal(f.status, 'failed');
  assert.match(f.message, /already exists/);
});

test('no webhook payload or HTTP reply in this whole run names the vendor or its tools', () => {
  assert.ok(seenText.length > 5, 'expected the earlier tests to have produced traffic');
  const bad = seenText.filter((t) => /meshmesh|start_agent|continue_agent|get_agent_status|\bMCP\b|sandbox not available/i.test(t.replace(/"agent_id":"[^"]*"/g, '')));
  assert.deepEqual(bad.map((t) => t.slice(0, 200)), []);
});
