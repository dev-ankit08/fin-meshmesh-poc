import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, toApiName } from '../src/validate.js';
import { buildPlanPrompt } from '../src/prompt.js';
import { normaliseStatus } from '../src/worker.js';

const good = {
  requestor_email: 'test.user@example.com',
  field_label: 'Customer Tier',
  field_type: 'text',
  permission_set: 'Sales Ops',
  business_reason: 'Segment accounts for renewals',
};

test('complete request passes and is normalised', () => {
  const v = validateRequest(good);
  assert.equal(v.ok, true);
  assert.equal(v.value.field_type, 'Text');
  assert.equal(v.value.field_api_name, 'Customer_Tier__c');
  assert.equal(v.value.target_object, 'Account');
});

test('missing fields are reported (POC-02)', () => {
  const v = validateRequest({ field_label: 'X' });
  assert.equal(v.ok, false);
  assert.deepEqual(v.missing, ['requestor_email', 'field_type', 'permission_set', 'business_reason']);
});

test('picklist is rejected (not in PoC scope)', () => {
  const v = validateRequest({ ...good, field_type: 'Picklist' });
  assert.equal(v.ok, false);
  assert.match(v.invalid[0], /field_type/);
});

test('api name generation', () => {
  assert.equal(toApiName('PoC Customer Tier'), 'PoC_Customer_Tier__c');
  assert.equal(toApiName('2026 Score!'), 'F_2026_Score__c');
});

test('legacy field request becomes a change_request and a plan prompt carrying every input', () => {
  const v = validateRequest(good).value;
  assert.equal(v.contract, 'legacy_field');
  const p = buildPlanPrompt(v, 'fmr_1');
  for (const s of ['fmr_1', 'Customer_Tier__c', 'Text(100)', 'Sales Ops', 'already exists', 'BEGIN_CHANGESET']) assert.ok(p.includes(s), s);
});

test('status mapping matches the observed MeshMesh shape', () => {
  const msg = (content) => ({ recentMessages: [{ type: 'user', content: 'go' }, { type: 'assistant', content }] });
  assert.equal(normaliseStatus({ json: { status: 'waiting', isExecuting: true, phase: 'execution' } }).status, 'building');
  assert.equal(normaliseStatus({ json: { status: 'waiting', isExecuting: false, waitingFor: 'confirmation' } }).status, 'needs_confirmation');
  assert.equal(normaliseStatus({ json: { status: 'waiting', isExecuting: false, waitingFor: 'plan_approval' } }).status, 'awaiting_approval');
  assert.equal(normaliseStatus({ json: { status: 'failed' } }).status, 'failed');
  const done = normaliseStatus({ json: { status: 'waiting', isExecuting: false, waitingFor: '', summary: 'stale', ...msg('All three items are done and checked.\nRESULT: SUCCEEDED') } });
  assert.deepEqual([done.status, done.outcome], ['turn_complete', 'succeeded']);
  assert.match(done.summary, /All three items/);
  const dup = normaliseStatus({ json: { status: 'waiting', isExecuting: false, waitingFor: '', ...msg('PoC_Customer_Tier__c already exists.\nRESULT: FAILED - duplicate field') } });
  assert.equal(dup.outcome, 'failed');
  // Regression: a plan that merely mentions the words must not count as an outcome (live bug 2026-11-21)
  const plan = normaliseStatus({ json: { status: 'waiting', isExecuting: false, waitingFor: '', ...msg("I'll verify all three items before reporting SUCCEEDED or FAILED. Click Begin Build.") } });
  assert.equal(plan.outcome, null);
});

import { customerMessage } from '../src/notify.js';

test('failure message leads with the real reason and drops the RESULT line', () => {
  const raw = 'I stopped without building anything because Account already has a field called "Account Health Score".\n\nRESULT: FAILED - duplicate field';
  const m = customerMessage('failed', raw);
  assert.match(m, /^Reason: duplicate field\./);
  assert.match(m, /already has a field called "Account Health Score"/);
  assert.doesNotMatch(m, /RESULT:/);
});

test('success message drops the RESULT line without adding a reason', () => {
  const m = customerMessage('succeeded', 'Created the field.\n\nRESULT: SUCCEEDED');
  assert.equal(m, 'Created the field.');
});

import { resolveCustomer, connectionReady } from '../src/customers.js';

const custData = { connectUrl: 'https://studio.meshmesh.io', customers: [
  { name: 'Acme', match: { email_domains: ['acme.com'], company_ids: ['co-1'] }, meshmesh_connection_id: 'conn-acme', sf_target_org: 'acme-sbx' },
] };

test('customer is resolved by email domain or company id (POC-03)', () => {
  const a = resolveCustomer({ requestor_email: 'Jo@ACME.com' }, custData);
  assert.equal(a.ok, true); assert.equal(a.connectionId, 'conn-acme'); assert.equal(a.sfTargetOrg, 'acme-sbx');
  assert.equal(resolveCustomer({ requestor_email: 'x@other.org', company_id: 'co-1' }, custData).customer, 'Acme');
});

test('unknown customer is refused with a connect link instead of using someone else\'s org', () => {
  const r = resolveCustomer({ requestor_email: 'someone@unknown.io' }, custData);
  assert.equal(r.ok, false); assert.equal(r.reason, 'no_connection'); assert.match(r.connectUrl, /meshmesh/);
});

test('connection readiness comes from MeshMesh list_connections', () => {
  const list = { connections: [{ id: 'c1', enabled: true, hasCredentials: true }, { id: 'c2', enabled: true, hasCredentials: false }], notReady: [{ id: 'c3' }] };
  assert.equal(connectionReady(list, 'c1').ready, true);
  assert.equal(connectionReady(list, 'c2').ready, false);
  assert.equal(connectionReady(list, 'c3').ready, false);
  assert.equal(connectionReady(list, 'zz').ready, false);
});