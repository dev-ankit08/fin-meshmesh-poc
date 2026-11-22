import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseChangeset, planVersion, formatChanges, formatChangesForCustomer, stripChangeset } from '../src/changeset.js';
import { evaluatePolicy, loadPolicy, typeMatches } from '../src/policy.js';
import { buildPlanPrompt, buildApprovalMessage } from '../src/prompt.js';
import { validateRequest } from '../src/validate.js';
import { customerMessage, redactSecrets, brandScrub } from '../src/notify.js';
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

// ---- vendor-free customer text (Phase 2, step 1)
const VENDOR = /meshmesh|start_agent|continue_agent|get_agent_status|get_plan|list_connections|agentId|\bMCP\b|sandbox not available|\bthe bridge\b/i;

test('brandScrub removes the vendor name, its URL, tool names and the known sandbox error', () => {
  const dirty = "MeshMesh's plan is ready. MeshMesh tool start_agent failed: {\"error\":\"Sandbox not available - please try again\"} See https://studio.meshmesh.io/connections. The bridge is not signed in. agentId abc.";
  const clean = brandScrub(dirty);
  assert.doesNotMatch(clean, VENDOR);
  assert.match(clean, /^Our system's plan is ready\./);
  assert.equal(brandScrub('We will add the field.'), 'We will add the field.');
});

test('brandScrub leaves real Salesforce component names alone (no generic "agent" rule)', () => {
  const t = 'The permission set "AncCrmIntegrationUser" and the "Einstein Agent User" profile are unchanged; Support_Agent416632420_Permissions stays.';
  assert.equal(brandScrub(t), t);
});

test('customerMessage is vendor-free on every status, including raw upstream text', () => {
  const raw = 'MeshMesh could not finish. MeshMesh tool get_agent_status failed.\nRESULT: FAILED - MeshMesh needs ApexTrigger, which cannot be changed through chat';
  for (const st of ['planning', 'plan_ready', 'needs_input', 'rejected', 'building', 'succeeded', 'failed', 'needs_review', 'cancelled']) {
    assert.doesNotMatch(customerMessage(st, raw), VENDOR, st);
  }
});

test('every prompt sent to the planner carries the voice rule', () => {
  const v = { requestor_email: 'a@b.com', change_request: 'Add a field', business_reason: 'x' };
  for (const p of [buildPlanPrompt(v, 'fmr_x', policy), buildApprovalMessage('pv_1', '1. create CustomField A.B__c')]) {
    assert.match(p, /Write as "we"/);
    assert.match(p, /shown to the customer/);
  }
});

// ---- plain-language plan (Phase 2, step 2). Shapes below are the real plans from live runs.
const API_NAME = /__c\b|\bCustomField\b|\bPermissionSet\b|\bNamedCredential\b|\bExternalCredential\b|\bValidationRule\b|[A-Za-z]+-[A-Za-z]+ Layout/;

test('plain plan: field + layout + permission set (live runs fmr_cb3f8628 / fmr_1219e7b4)', () => {
  const plain = formatChangesForCustomer([
    { action: 'create', type: 'CustomField', name: 'Contact.Preferred_Contact_Time__c', label: 'Preferred Contact Time', summary: 'New Text(255) field on Contact' },
    { action: 'modify', type: 'Layout', name: 'Contact-Contact Layout', label: 'Contact Layout', summary: 'Add the field below Email' },
    { action: 'modify', type: 'PermissionSet', name: 'Fin_PoC_Access', label: 'Fin PoC Access', summary: 'Grant Read and Edit field access on Contact.Preferred_Contact_Time__c' },
  ]);
  assert.equal(plain, [
    '1. Add a text field called “Preferred Contact Time” to Contact',
    '2. Show “Preferred Contact Time” on the “Contact Layout” page layout',
    '3. Let “Fin PoC Access” read and edit “Preferred Contact Time”',
  ].join('\n'));
  assert.doesNotMatch(plain, API_NAME);
});

test('plain plan: outbound credentials (live run fmr_50551f28)', () => {
  const plain = formatChangesForCustomer([
    { action: 'create', type: 'ExternalCredential', name: 'Partner_API', label: 'Partner API', summary: 'Custom-auth external credential with Named Principal PartnerApiPrincipal sending X-API-Key header' },
    { action: 'create', type: 'NamedCredential', name: 'Partner_API', label: 'Partner API', summary: 'Secured endpoint https://api.partner.example.com linked to External Credential Partner_API' },
    { action: 'modify', type: 'PermissionSet', name: 'Fin_PoC_Access', label: 'Fin PoC Access', summary: 'Add principal access Partner_API-PartnerApiPrincipal and Read on UserExternalCredential' },
  ]);
  assert.equal(plain, [
    '1. Create the “Partner API” sign-in settings for the outside service',
    '2. Create the “Partner API” connection to https://api.partner.example.com',
    '3. Let “Fin PoC Access” use the new connection',
  ].join('\n'));
  assert.doesNotMatch(plain, /Principal|X-API-Key/);
});

test('plain plan: validation rule, assignment, new permission set, unknown type', () => {
  const plain = formatChangesForCustomer([
    { action: 'create', type: 'ValidationRule', name: 'Opportunity.Amount_Required_When_Closed_Won', label: 'Amount_Required_When_Closed_Won', summary: 'Blocks saving a Closed Won Opportunity unless Amount is greater than zero' },
    { action: 'assign', type: 'PermissionSetAssignment', name: 'Fin_PoC_Access:someone@example.com', label: 'Fin PoC Access', summary: 'assign' },
    { action: 'create', type: 'PermissionSet', name: 'Contact_Language_Access', label: 'Contact Language Access', summary: 'Read/Edit' },
    { action: 'create', type: 'CustomField', name: 'Contact.Language__c', label: 'Language', summary: 'Text(50)' },
    { action: 'create', type: 'GlobalValueSet', name: 'Tier_Values', label: 'Tier Values', summary: 'Gold, Silver, Bronze' },
  ]);
  assert.match(plain, /^1\. Add a validation rule on Opportunity: Blocks saving a Closed Won Opportunity unless Amount is greater than zero$/m);
  assert.match(plain, /^2\. Give someone@example\.com the “Fin PoC Access” permission set$/m);
  assert.match(plain, /^3\. Create a permission set called “Contact Language Access” that lets people read and edit “Language”$/m);
  assert.match(plain, /^5\. Add the “Tier Values” global value set: Gold, Silver, Bronze$/m);
});

test('plain plan never leaks API names for any allowed type, and the technical list is unchanged', () => {
  const policy = loadPolicy();
  const changes = policy.allowed_types.filter((t) => !t.includes('*')).map((t) => ({ action: 'create', type: t, name: `Thing_${t}`, label: 'Thing', summary: '' }));
  const plain = formatChangesForCustomer(changes);
  assert.equal(plain.split('\n').length, changes.length);
  assert.doesNotMatch(plain, /__c\b|Thing_/);
  assert.match(formatChanges(changes), /^1\. Create /); // technical form (used for the build) keeps API names
});
