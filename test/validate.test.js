import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateRequest, toApiName, buildMeshMeshPrompt } from '../src/validate.js';
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

test('prompt carries every input and the duplicate rule', () => {
  const p = buildMeshMeshPrompt(validateRequest(good).value, 'fmr_1');
  for (const s of ['fmr_1', 'Customer_Tier__c', 'Text(100)', 'Sales Ops', 'duplicate field']) assert.ok(p.includes(s), s);
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
