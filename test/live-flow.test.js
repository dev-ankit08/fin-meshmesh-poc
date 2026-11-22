// The LIVE code path (worker + guard) against a scripted fake MeshMesh MCP and a fake Salesforce CLI.
// Uses the status shapes observed in the PoC (status/isExecuting/waitingFor/recentMessages).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.MESHMESH_MODE = 'live';
process.env.POLL_INTERVAL_MS = '1';
process.env.SF_TARGET_ORG = 'devhub';
process.env.SF_GUARD = 'true';
process.env.SF_PRECHECK = 'true';
process.env.INTERCOM_ACCESS_TOKEN = '';
process.env.DATA_DIR = mkdtempSync(path.join(os.tmpdir(), 'fmlive-'));

let W; let G; let S;
before(async () => {
  W = await import('../src/worker.js');
  G = await import('../src/guard.js');
  S = await import('../src/store.js');
});

const msg = (content, extra = {}) => ({ json: { status: 'waiting', isExecuting: false, waitingFor: '', recentMessages: [{ type: 'assistant', content }], ...extra } });
const busy = (phase) => ({ json: { status: 'waiting', isExecuting: true, phase, recentMessages: [] } });

/** Scripted MeshMesh: each turn is a list of get_agent_status responses; the last one repeats. */
function fakeMesh(turns) {
  let turn = -1; let i = 0; const calls = [];
  return {
    calls,
    onBuild: () => {},
    async callTool(name, args) {
      calls.push({ name, args });
      if (name === 'continue_agent' && args.mode === 'build') this.onBuild(); // the org changes only once MeshMesh builds
      if (name === 'start_agent' || name === 'continue_agent') { turn++; i = 0; return { json: { agentId: 'ag_1' }, text: '' }; }
      if (name === 'get_plan') return { json: null, text: '' };
      if (name === 'get_agent_status') { const t = turns[turn]; return t[Math.min(i++, t.length - 1)]; }
      throw new Error(`unexpected tool ${name}`);
    },
  };
}

/** Fake `sf` CLI: org metadata per phase ("before" until the build starts, then "after"). */
function fakeOrg(beforeState, afterState) {
  let state = beforeState;
  const fn = async (args) => {
    const t = (args.match(/--metadata-type (\w+)/) || [])[1];
    if (t) return Object.entries(state[t] || {}).map(([fullName, lastModifiedDate]) => ({ fullName, lastModifiedDate }));
    if (/FROM FieldPermissions/.test(args)) return { records: state.fieldPerms || [] };
    if (/FieldDefinition/.test(args)) return { records: [{ QualifiedApiName: 'Name', Label: 'Account Name' }, { QualifiedApiName: 'PoC_Customer_Tier__c', Label: 'PoC Customer Tier' }] };
    return { records: [] };
  };
  fn.build = () => { state = afterState; };
  return fn;
}

const PLAN = `Summary: I will add a Renewal Risk text field to Account, put it on the layout and grant Fin PoC Access.
BEGIN_CHANGESET
[{"action":"create","type":"CustomField","name":"Account.Renewal_Risk_2__c","label":"Renewal Risk 2","summary":"Text(100)"},
 {"action":"modify","type":"Layout","name":"Account-Account Layout","summary":"add field"},
 {"action":"modify","type":"PermissionSet","name":"Fin_PoC_Access","summary":"Read/Edit"}]
END_CHANGESET`;

const ORG_BEFORE = {
  CustomField: { 'Account.PoC_Customer_Tier__c': 't0', 'Account.Other__c': 't0' },
  Layout: { 'Account-Account Layout': 't0' },
  PermissionSet: { Fin_PoC_Access: 't0' },
  CustomObject: {}, ValidationRule: {},
};
const ORG_AFTER = {
  ...ORG_BEFORE,
  CustomField: { ...ORG_BEFORE.CustomField, 'Account.Renewal_Risk_2__c': 't1' },
  Layout: { 'Account-Account Layout': 't1' },
  PermissionSet: { Fin_PoC_Access: 't1' },
  fieldPerms: [{ Field: 'Account.Renewal_Risk_2__c', PermissionsRead: true, PermissionsEdit: true }],
};

function newRequest(extra = {}) {
  return S.createRequest({ contract: 'generic', requestor_email: 'jane.doe@test.com', change_request: 'Add a Renewal Risk 2 text field on Account for Fin PoC Access users', business_reason: 'test', title: 'Renewal Risk 2', plan_callback_url: 'https://example.invalid/plan', callback_url: '', final_callback_url: '', conversation_id: '', ...extra });
}

async function planThenBuild(mesh, org) {
  W.__test.setMesh(mesh); G.__test.setCli(org); W.__test.setGuard(undefined);
  const r = newRequest();
  await W.runPlan(r.request_id);
  const planned = S.getRequest(r.request_id);
  if (planned.status !== 'plan_ready') return planned;
  mesh.onBuild = org.build;
  await W.runBuild(r.request_id, planned.plan_version);
  return S.getRequest(r.request_id);
}

test('live: plan -> approve -> build -> independently verified', async () => {
  const mesh = fakeMesh([
    [busy('planning'), msg(PLAN)],
    // first poll after approval still shows the PLAN (stale turn) - must not be taken as finished
    [msg(PLAN), busy('execution'), msg('All three components deployed and verified.\nRESULT: SUCCEEDED')],
  ]);
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, ORG_AFTER));
  assert.equal(r.status, 'succeeded', r.last_message);
  assert.match(r.last_message, /Independently verified in Salesforce: 3 of 3/);
  const build = mesh.calls.find((c) => c.name === 'continue_agent' && c.args.mode === 'build');
  assert.match(build.args.message, /Build exactly these components and nothing else/);
  assert.match(build.args.message, /Account\.Renewal_Risk_2__c/);
  assert.equal(mesh.calls.filter((c) => c.name === 'continue_agent').length, 1); // no extra "verdict?" nudge
});

test('live: a change outside the approved plan -> needs_review, not succeeded', async () => {
  const mesh = fakeMesh([[msg(PLAN)], [busy('execution'), msg('Done.\nRESULT: SUCCEEDED')]]);
  const after = { ...ORG_AFTER, CustomField: { ...ORG_AFTER.CustomField, 'Account.Other__c': 't9' } };
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, after));
  assert.equal(r.status, 'needs_review');
  assert.match(r.last_message, /changed CustomField Account\.Other__c/);
});

test('live: MeshMesh claims success but a component is missing -> failed', async () => {
  const mesh = fakeMesh([[msg(PLAN)], [busy('execution'), msg('Done.\nRESULT: SUCCEEDED')]]);
  const after = { ...ORG_AFTER, CustomField: ORG_BEFORE.CustomField };
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, after));
  assert.equal(r.status, 'failed');
  assert.match(r.last_message, /^Reason: the setup was reported as complete, but our independent Salesforce check found: .*Renewal_Risk_2__c was not found/);
});

test('live: MeshMesh claims success but the permission set never got the field access -> failed (T14 finding)', async () => {
  const mesh = fakeMesh([[msg(PLAN)], [busy('execution'), msg('Done.\nRESULT: SUCCEEDED')]]);
  // field, layout and permission set all exist, but the FieldPermissions row is missing
  const after = { ...ORG_AFTER, fieldPerms: [] };
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, after));
  assert.equal(r.status, 'failed');
  assert.match(r.last_message, /Fin_PoC_Access has no read access to Account\.Renewal_Risk_2__c/);
});

test('live: permission set can read but not edit although Edit was promised -> failed', async () => {
  const mesh = fakeMesh([[msg(PLAN)], [busy('execution'), msg('Done.\nRESULT: SUCCEEDED')]]);
  const after = { ...ORG_AFTER, fieldPerms: [{ Field: 'Account.Renewal_Risk_2__c', PermissionsRead: true, PermissionsEdit: false }] };
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, after));
  assert.equal(r.status, 'failed');
  assert.match(r.last_message, /can read Account\.Renewal_Risk_2__c but not edit it/);
});

test('live: plan creates a field whose LABEL already exists -> rejected before approval', async () => {
  const dupPlan = PLAN.replace(/Renewal_Risk_2__c","label":"Renewal Risk 2"/, 'Customer_Tier_New__c","label":"PoC Customer Tier"');
  const mesh = fakeMesh([[msg(dupPlan)]]);
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, ORG_AFTER));
  assert.equal(r.status, 'rejected');
  assert.match(r.last_message, /labelled "PoC Customer Tier"/);
  assert.equal(mesh.calls.some((c) => c.args?.mode === 'build'), false);
});

test('live: plan without a CHANGESET -> one reminder, then refused (never built)', async () => {
  const mesh = fakeMesh([[msg('Here is my plan: I will add the field.')], [msg('Sure, plan as above.')]]);
  const r = await planThenBuild(mesh, fakeOrg(ORG_BEFORE, ORG_AFTER));
  assert.equal(r.status, 'failed');
  assert.match(r.last_message, /could not be checked automatically/);
  assert.equal(mesh.calls.filter((c) => c.name === 'continue_agent').length, 1);
});

test('live: plan touching Apex is refused by policy', async () => {
  const apex = 'Plan\nBEGIN_CHANGESET\n[{"action":"create","type":"ApexClass","name":"Helper"}]\nEND_CHANGESET';
  const r = await planThenBuild(fakeMesh([[msg(apex)]]), fakeOrg(ORG_BEFORE, ORG_AFTER));
  assert.equal(r.status, 'rejected');
  assert.match(r.last_message, /ApexClass changes need a Salesforce admin/);
});

test('live: MeshMesh asks a question in planning -> needs_input', async () => {
  const r = await planThenBuild(fakeMesh([[msg('I need one detail.\nRESULT: NEEDS_INPUT - Which object should the rule be on?')]]), fakeOrg(ORG_BEFORE, ORG_AFTER));
  assert.equal(r.status, 'needs_input');
});
