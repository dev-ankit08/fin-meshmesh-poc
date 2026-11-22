import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangeset, planVersion, formatChanges, stripChangeset } from '../src/changeset.js';
import { evaluatePolicy, loadPolicy, typeMatches } from '../src/policy.js';
import { buildPlanPrompt, buildApprovalMessage } from '../src/prompt.js';
import { validateRequest } from '../src/validate.js';
import { customerMessage, redactSecrets } from '../src/notify.js';
import { outcomeOf } from '../src/worker.js';

const policy = loadPolicy();

const planMsg = `Summary: I'll create a Named Credential for outbound callouts.
BEGIN_CHANGESET
[{"action":"create","type":"ExternalCredential","name":"Partner_API","label":"Partner API","summary":"custom auth"},
 {"action":"create","type":"NamedCredential","name":"Partner_API","summary":"https://api.example.com"},
 {"action":"update","type":"PermissionSet","name":"Fin_PoC_Access","summary":"principal access"}]
END_CHANGESET`;

test('CHANGESET is parsed and normalised from a MeshMesh plan', () => {
  const p = parseChangeset(planMsg);
  assert.equal(p.ok, true);
  assert.equal(p.changes.length, 3);
  assert.equal(p.changes[2].action, 'modify'); // "update" alias
  assert.match(formatChanges(p.changes), /^1\. Create ExternalCredential Partner_API \(Partner API\): custom auth/);
  assert.equal(stripChangeset(planMsg), "Summary: I'll create a Named Credential for outbound callouts.");
});

test('missing or broken CHANGESET is reported, never guessed', () => {
  assert.equal(parseChangeset('Here is my plan, no block').ok, false);
  assert.match(parseChangeset('BEGIN_CHANGESET\n[{"action":"create"}]\nEND_CHANGESET').error, /needs action, type and name/);
  assert.match(parseChangeset('BEGIN_CHANGESET\nnot json\nEND_CHANGESET').error, /not valid JSON/);
});

test('plan_version is stable regardless of order and changes when the plan changes', () => {
  const a = parseChangeset(planMsg).changes;
  assert.equal(planVersion(a), planVersion([...a].reverse()));
  assert.notEqual(planVersion(a), planVersion(a.slice(0, 2)));
});

test('policy allows Named/External Credentials and External Client Apps', () => {
  assert.equal(evaluatePolicy(parseChangeset(planMsg).changes, policy).ok, true);
  const eca = [
    { action: 'create', type: 'ExternalClientApplication', name: 'Fin_App' },
    { action: 'create', type: 'ExtlClntAppOauthSettings', name: 'Fin_App_oauth' },
    { action: 'create', type: 'ExtlClntAppGlobalOauthSettings', name: 'Fin_App_glbloauth' },
  ];
  const r = evaluatePolicy(eca, policy);
  assert.equal(r.ok, true, JSON.stringify(r.blocked));
  assert.match(r.warnings.join(' '), /never shown in chat/);
});

test('policy refuses deletes, Apex, profiles, unknown types and oversized plans', () => {
  const bad = (c) => evaluatePolicy([c], policy);
  assert.match(bad({ action: 'delete', type: 'CustomField', name: 'Account.X__c' }).blocked[0].why, /deleting/);
  assert.match(bad({ action: 'create', type: 'ApexClass', name: 'X' }).blocked[0].why, /admin/);
  assert.match(bad({ action: 'modify', type: 'Profile', name: 'Admin' }).blocked[0].why, /admin/);
  assert.match(bad({ action: 'create', type: 'Flow', name: 'F' }).blocked[0].why, /admin/);
  assert.match(bad({ action: 'create', type: 'SomethingNew', name: 'Y' }).blocked[0].why, /not on the list/);
  const many = Array.from({ length: 31 }, (_, i) => ({ action: 'create', type: 'CustomField', name: `Account.F${i}__c` }));
  assert.equal(evaluatePolicy(many, policy).ok, false);
});

test('existing components of create-only types cannot be modified (T4 overwrite protection)', () => {
  const r = evaluatePolicy([{ action: 'modify', type: 'CustomField', name: 'Account.PoC_Customer_Tier__c' }], policy);
  assert.equal(r.ok, false);
  assert.match(r.blocked[0].why, /may not be changed/);
  // existing permission set / layout may be updated
  assert.equal(evaluatePolicy([{ action: 'modify', type: 'Layout', name: 'Account-Account Layout' }, { action: 'modify', type: 'PermissionSet', name: 'Fin_PoC_Access' }], policy).ok, true);
});

test('type patterns', () => {
  assert.equal(typeMatches('ExtlClntAppOauthSettings', ['ExtlClntApp*']), true);
  assert.equal(typeMatches('ApexClass', ['ExtlClntApp*']), false);
});

test('generic contract: free-form change_request is required, legacy fields are not', () => {
  const v = validateRequest({ requestor_email: 'a@b.com', change_request: 'Set up a Named Credential for outbound HTTPS calls to api.example.com', business_reason: 'ERP sync', plan_callback_url: 'https://api.intercom.io/hooks/x' });
  assert.equal(v.ok, true);
  assert.equal(v.value.contract, 'generic');
  const miss = validateRequest({ requestor_email: 'a@b.com' });
  assert.deepEqual(miss.missing, ['change_request', 'business_reason']);
  assert.match(validateRequest({ requestor_email: 'a@b.com', change_request: 'do it', business_reason: 'x' }).invalid.join(), /too short/);
  assert.match(validateRequest({ requestor_email: 'a@b.com', change_request: 'x'.repeat(30), business_reason: 'x' }).invalid.join(), /plan_callback_url is required/);
  assert.match(validateRequest({ requestor_email: 'a@b.com', change_request: 'x'.repeat(30), business_reason: 'x', plan_callback_url: 'http://evil.example/' }).invalid[0], /https/);
});

test('plan prompt fences the customer text and carries the safety rules', () => {
  const v = validateRequest({ requestor_email: 'a@b.com', change_request: 'Create an External Client App for outbound HTTPS requests', business_reason: 'ERP', plan_callback_url: 'https://x.test/p' }).value;
  const p = buildPlanPrompt(v, 'fmr_9', policy);
  for (const s of ['fmr_9', '"""\nCreate an External Client App', 'PLAN ONLY', 'Never delete', 'ApexClass', 'Never generate, print or ask for secrets', 'RESULT: NEEDS_INPUT', 'BEGIN_CHANGESET', 'Named Credential']) assert.ok(p.includes(s), s);
  const a = buildApprovalMessage('pv_1', '1. Create X');
  assert.match(a, /Build exactly these components and nothing else/);
});

test('NEEDS_INPUT outcome and question message', () => {
  assert.equal(outcomeOf('I need one detail.\nRESULT: NEEDS_INPUT - Which object?'), 'needs_input');
  assert.match(customerMessage('needs_input', 'I need one detail.\nRESULT: NEEDS_INPUT - Which object?'), /^Question: Which object\?/);
});

test('secrets never reach Fin', () => {
  const m = redactSecrets('Consumer Key: 3MVG9abcdefghijklmnopqrstuvwxyz0123456789 consumer secret = ABCD1234EF secret token=xyz password: hunter2');
  assert.doesNotMatch(m, /3MVG9|ABCD1234EF|hunter2|xyz/);
  assert.equal(redactSecrets('Created Account.Renewal_Risk__c on the layout'), 'Created Account.Renewal_Risk__c on the layout');
});
