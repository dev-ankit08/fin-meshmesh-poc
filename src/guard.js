// Generic, READ-ONLY Salesforce guard for any CHANGESET (v2). Generalises the PoC's field-only checks:
//   precheck(changes)        before the customer is asked: a "create" of something that already exists = conflict
//   snapshot(types)          just before the build: fullName -> lastModifiedDate for every relevant type
//   verify(changes, before)  after MeshMesh reports SUCCEEDED:
//                              - every create/modify/assign item exists in the org
//                              - anything of a watched type that changed, appeared or vanished but is NOT in
//                                the approved CHANGESET is reported as unexpected (-> needs_review)
// Uses the Metadata API listMetadata call through the Salesforce CLI (`sf org list metadata`), which lists
// components regardless of field-level security (unlike describe, the root cause of T4). The CLI holds the
// Salesforce session; the bridge never sees a token.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const sh = promisify(exec);
const SAFE_ALIAS = /^[A-Za-z0-9._@-]{1,80}$/;
const SAFE_TYPE = /^[A-Za-z][A-Za-z0-9]{1,80}$/;
const API = 'v62.0';

// Types that listMetadata can't enumerate without a folder, or that are records rather than metadata.
const FOLDERED = new Set(['emailtemplate', 'report', 'dashboard', 'document']);
const DATA_TYPES = new Set(['permissionsetassignment']);
// listMetadata returns CustomLabels as one "CustomLabels" file; individual labels are type CustomLabel.
const LIST_TYPE_ALIAS = { customlabels: 'CustomLabel' };

const lc = (s) => String(s || '').toLowerCase();
const listTypeOf = (type) => LIST_TYPE_ALIAS[lc(type)] || type;

let cliOverride = null;
export const __test = { setCli: (fn) => { cliOverride = fn; } };

async function sfCli(args, org) {
  if (cliOverride) return cliOverride(args, org);
  if (!SAFE_ALIAS.test(String(org || ''))) throw new Error('no valid Salesforce CLI org alias configured');
  const { stdout } = await sh(`sf ${args} --target-org ${org} --json`, { timeout: 120_000, maxBuffer: 100 * 1024 * 1024, windowsHide: true })
    .catch((e) => ({ stdout: e.stdout || '', error: e }));
  const start = stdout.search(/[{[]/);
  if (start < 0) throw new Error(`Salesforce CLI returned no JSON for "sf ${args}"`);
  const body = JSON.parse(stdout.slice(start));
  if (body.status && body.status !== 0) throw new Error(`Salesforce CLI "sf ${args}": ${body.message || body.name}`);
  return body.result;
}

/** Map of lower-cased fullName -> { fullName, lastModifiedDate } for one metadata type. */
export async function listMetadata(type, org) {
  const t = listTypeOf(type);
  if (!SAFE_TYPE.test(t)) throw new Error(`unsafe metadata type "${type}"`);
  const result = await sfCli(`org list metadata --metadata-type ${t} --api-version ${API.slice(1)}`, org);
  const rows = Array.isArray(result) ? result : result ? [result] : [];
  return new Map(rows.map((r) => [lc(r.fullName), { fullName: r.fullName, lastModifiedDate: r.lastModifiedDate }]));
}

async function soql(q, org, tooling = false) {
  const r = await sfCli(`data query ${tooling ? '--use-tooling-api ' : ''}--query "${q.replace(/"/g, '\\"')}"`, org);
  return r?.records || [];
}

/** What kind of org is this? 'sandbox' | 'developer' | 'production' | 'unknown'. Custom code is only allowed in the first two. */
export async function orgKind(org = config.sfTargetOrg) {
  try {
    const [o] = await soql('SELECT IsSandbox, OrganizationType, TrialExpirationDate FROM Organization', org);
    if (!o) return 'unknown';
    if (o.IsSandbox === true) return 'sandbox';
    if (/developer/i.test(o.OrganizationType || '')) return 'developer';
    return 'production';
  } catch { return 'unknown'; }
}

const APEX_TYPES = new Set(['apexclass', 'apextrigger']);

/** Extra proof for custom code, read-only: Apex is Active and its tests passed since `since`; Flows are inactive; LWC exists. */
async function checkCode(changes, since, org, policy = {}) {
  const problems = [];
  const facts = { tests_passed: false, tests: 0, flow_inactive: null, apex_active: null };
  const apex = changes.filter((c) => APEX_TYPES.has(lc(c.type)));
  const flows = changes.filter((c) => lc(c.type) === 'flow');
  if (apex.length) {
    let ok = true;
    for (const c of apex.filter((x) => lc(x.type) === 'apexclass' || lc(x.type) === 'apextrigger')) {
      const tbl = lc(c.type) === 'apextrigger' ? 'ApexTrigger' : 'ApexClass';
      const rows = await soql(`SELECT Name, Status FROM ${tbl} WHERE Name = '${esc(c.name)}'`, org, true);
      if (!rows.length) { problems.push(`${c.type} ${c.name} was not found in the org`); ok = false; }
      else if (rows[0].Status !== 'Active') { problems.push(`${c.type} ${c.name} is not active (status ${rows[0].Status})`); ok = false; }
    }
    facts.apex_active = ok;
    const since_ = String(since || '').replace(/\.\d+Z$/, '.000+0000').replace(/Z$/, '.000+0000');
    const res = await soql(`SELECT Outcome FROM ApexTestResult WHERE TestTimestamp >= ${new Date(since).toISOString().replace(/\.\d+Z$/, 'Z')}`, org, true).catch(() => []);
    facts.tests = res.length;
    const failed = res.filter((r) => r.Outcome !== 'Pass').length;
    facts.tests_passed = res.length > 0 && failed === 0;
    if (!res.length) problems.push('no test results were recorded for the new code');
    else if (failed) problems.push(`${failed} of ${res.length} tests did not pass`);
  }
  for (const c of flows) {
    const rows = await soql(`SELECT ApiName, ActiveVersionId, LatestVersionId FROM FlowDefinitionView WHERE ApiName = '${esc(c.name)}'`, org).catch(() => []);
    if (!rows.length) { problems.push(`Flow ${c.name} was not found in the org`); continue; }
    const active = !!rows[0].ActiveVersionId;
    facts.flow_inactive = !active;
    if (active && policy.flow_activate !== true) problems.push(`Flow ${c.name} is active but it should have been deployed switched off`);
  }
  return { problems, facts };
}

// Label match for fields (FieldDefinition ignores FLS, unlike describe).
async function fieldByLabel(object, label, org) {
  if (!/^[A-Za-z0-9_]+$/.test(object)) return null;
  const rows = await soql(`SELECT QualifiedApiName, Label FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${object}'`, org, true);
  return rows.find((r) => lc(r.Label) === lc(label)) || null;
}

const esc = (s) => String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'");

async function permSetAssigned(name, org) {
  const [ps, user] = String(name).split(':').map((s) => s.trim());
  if (!ps || !user) return { checked: false, why: 'name must be "<PermissionSet>:<username>"' };
  const rows = await soql(`SELECT Id FROM PermissionSetAssignment WHERE (PermissionSet.Name = '${esc(ps)}' OR PermissionSet.Label = '${esc(ps)}') AND (Assignee.Username = '${esc(user)}' OR Assignee.Email = '${esc(user)}')`, org);
  return { checked: true, exists: rows.length > 0 };
}

/**
 * A permission set's field grants do not bump its LastModifiedDate, so "the set exists" proves nothing.
 * For every field this change set creates, check the set really has the access its summary promises.
 * Returns null when there is nothing checkable (the caller then says so instead of claiming it was verified).
 */
async function checkFieldGrants(change, changes, org) {
  const fields = changes.filter((x) => lc(x.type) === 'customfield' && x.action === 'create').map((x) => x.name);
  if (!fields.length || !/read|edit|field|access|grant/i.test(`${change.summary || ''} ${change.label || ''}`)) return null;
  const needEdit = /edit/i.test(change.summary || '');
  const problems = []; const ok = [];
  for (const f of fields) {
    const rows = await soql(`SELECT Field, PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Parent.Name = '${esc(change.name)}' AND Field = '${esc(f)}'`, org);
    const r = rows[0];
    if (!r || !r.PermissionsRead) problems.push(`${change.name} has no read access to ${f}`);
    else if (needEdit && !r.PermissionsEdit) problems.push(`${change.name} can read ${f} but not edit it`);
    else ok.push(`${f} ${r.PermissionsEdit ? 'read+edit' : 'read'}`);
  }
  return { problems, ok };
}

const typesOf = (changes) => [...new Set(changes.map((c) => c.type).filter((t) => !FOLDERED.has(lc(t)) && !DATA_TYPES.has(lc(t))))];

async function listAll(types, org) {
  const out = new Map();
  // a few at a time: each CLI call takes ~3-10 s
  for (let i = 0; i < types.length; i += 4) {
    const batch = types.slice(i, i + 4);
    const res = await Promise.all(batch.map((t) => listMetadata(t, org).then((m) => [t, m]).catch((e) => [t, e])));
    for (const [t, m] of res) out.set(lc(t), m);
  }
  return out;
}

/** Before approval. Returns { ok, conflicts[], notes[], existing:Set<"type:name"> } */
export async function precheck(changes, org = config.sfTargetOrg) {
  const conflicts = [];
  const notes = [];
  const existing = new Set();
  const lists = await listAll(typesOf(changes), org);
  for (const c of changes) {
    const key = `${c.type}:${c.name}`.toLowerCase();
    let exists = false;
    if (DATA_TYPES.has(lc(c.type))) {
      const r = await permSetAssigned(c.name, org);
      if (!r.checked) { conflicts.push(`${c.type} ${c.name}: ${r.why}`); continue; }
      exists = r.exists;
      if (exists) notes.push(`${c.name} is already assigned; nothing to do for it`);
      continue;
    }
    if (FOLDERED.has(lc(c.type))) { notes.push(`${c.type} ${c.name} can't be pre-checked automatically`); continue; }
    const list = lists.get(lc(c.type));
    if (list instanceof Error) throw new Error(`pre-check of ${c.type} failed: ${list.message}`);
    exists = list.has(lc(c.name));
    // Fields: also match by label (FieldDefinition), exactly as the PoC guard did.
    if (!exists && c.action === 'create' && lc(c.type) === 'customfield' && c.name.includes('.') && c.label) {
      const [obj] = c.name.split('.');
      const dup = await fieldByLabel(obj, c.label, org);
      if (dup) { exists = true; conflicts.push(`a field labelled "${dup.Label}" (${obj}.${dup.QualifiedApiName}) already exists`); continue; }
    }
    if (exists) existing.add(key);
    if (exists && c.action === 'create') conflicts.push(`${c.type} ${c.name} already exists`);
    if (!exists && c.action === 'modify') notes.push(`${c.type} ${c.name} does not exist yet and will be created`);
  }
  return { ok: conflicts.length === 0, conflicts, notes, existing };
}

/** Just before the build: what the watched types look like now. */
export async function snapshot(changes, watchTypes = [], org = config.sfTargetOrg) {
  const types = [...new Set([...typesOf(changes), ...watchTypes])];
  const lists = await listAll(types, org);
  const snap = {};
  for (const [t, m] of lists) if (!(m instanceof Error)) snap[t] = Object.fromEntries([...m].map(([k, v]) => [k, v.lastModifiedDate || '']));
  return { types, snap, taken_at: new Date().toISOString() };
}

// Salesforce creates some components as a side effect, e.g. a new object gets "Obj__c-Obj Layout",
// list views and a tab; a new External Client App gets its settings children. Tolerate those.
function isSideEffectOf(fullName, changes) {
  const n = lc(fullName);
  return changes.some((c) => c.action === 'create' && (
    n.startsWith(`${lc(c.name)}.`) || n.startsWith(`${lc(c.name)}-`) || n === lc(c.name) || n.startsWith(`${lc(c.name)}_`)));
}

/** After MeshMesh says SUCCEEDED. Returns { ok, problems[], unexpected[], verified[] } */
export async function verify(changes, before, org = config.sfTargetOrg, policy = {}) {
  const problems = [];
  let code = null;
  const unexpected = [];
  const verified = [];
  const lists = await listAll(before?.types?.length ? before.types : typesOf(changes), org);
  const planned = new Set(changes.map((c) => `${lc(c.type)}:${lc(c.name)}`));

  for (const c of changes) {
    if (DATA_TYPES.has(lc(c.type))) {
      const r = await permSetAssigned(c.name, org);
      if (r.checked && !r.exists) problems.push(`${c.name} is not assigned`); else verified.push(`${c.type} ${c.name}`);
      continue;
    }
    if (FOLDERED.has(lc(c.type))) { verified.push(`${c.type} ${c.name} (not auto-checkable)`); continue; }
    const list = lists.get(lc(c.type));
    if (list instanceof Error || !list) { problems.push(`could not check ${c.type}: ${list?.message || 'not listed'}`); continue; }
    const now = list.get(lc(c.name));
    if (!now) { problems.push(`${c.type} ${c.name} was not found in the org`); continue; }
    const was = before?.snap?.[lc(c.type)]?.[lc(c.name)];
    if (lc(c.type) === 'permissionset') {
      const g = await checkFieldGrants(c, changes, org);
      if (g) {
        problems.push(...g.problems);
        if (!g.problems.length) verified.push(`${c.type} ${c.name} (field access ok: ${g.ok.join(', ')})`);
        continue;
      }
      // Nothing we can prove (e.g. credential principal access): say so rather than claiming it was verified.
      verified.push(`${c.type} ${c.name} (exists; grants not auto-checked)`);
      continue;
    }
    if (c.action === 'modify' && was && was === now.lastModifiedDate) {
      // Not a failure on its own (some types don't bump lastModifiedDate for every sub-change), but say so.
      verified.push(`${c.type} ${c.name} (exists; no new modification timestamp)`);
    } else verified.push(`${c.type} ${c.name}`);
  }

  if (changes.some((c) => APEX_TYPES.has(lc(c.type)) || lc(c.type) === 'flow')) {
    code = await checkCode(changes, before?.taken_at, org, policy).catch((e) => ({ problems: [`could not check the new code: ${e.message}`], facts: {} }));
    problems.push(...code.problems);
    if (!code.problems.length) verified.push(`code checks passed (${code.facts.tests ? code.facts.tests + ' tests' : 'no Apex'}${code.facts.flow_inactive ? ', Flow off' : ''})`);
  }

  // Drift: anything of a snapshotted type that changed but wasn't approved.
  const typeName = Object.fromEntries((before?.types || []).map((x) => [lc(x), x]));
  for (const [t, list] of lists) {
    if (list instanceof Error) continue;
    const T = typeName[t] || t;
    const prev = before?.snap?.[t];
    if (!prev) continue;
    for (const [k, v] of list) {
      if (planned.has(`${t}:${k}`) || isSideEffectOf(v.fullName, changes)) continue;
      if (!(k in prev)) unexpected.push(`new ${T} ${v.fullName}`);
      else if (prev[k] && v.lastModifiedDate && prev[k] !== v.lastModifiedDate) unexpected.push(`changed ${T} ${v.fullName}`);
    }
    for (const k of Object.keys(prev)) if (!list.has(k)) unexpected.push(`removed ${T} ${k}`);
  }
  return { ok: problems.length === 0 && unexpected.length === 0, problems, unexpected, verified, code };
}

// ---- mock guard (MESHMESH_MODE=mock): same interface, no Salesforce calls ----
export const MOCK_EXISTING = new Set(['customfield:account.poc_customer_tier__c', 'customfield:account.customer_tier__c', 'permissionset:fin_poc_access']);
export const mockGuard = {
  async precheck(changes) {
    const existing = new Set(changes.map((c) => `${c.type}:${c.name}`.toLowerCase()).filter((k) => MOCK_EXISTING.has(k)));
    const conflicts = changes.filter((c) => c.action === 'create' && existing.has(`${c.type}:${c.name}`.toLowerCase())).map((c) => `${c.type} ${c.name} already exists`);
    return { ok: conflicts.length === 0, conflicts, notes: [], existing };
  },
  async snapshot(changes, watch) { return { types: [...new Set([...changes.map((c) => c.type), ...watch])], snap: {}, taken_at: new Date().toISOString() }; },
  async verify(changes) { return { ok: true, problems: [], unexpected: [], verified: changes.map((c) => `${c.type} ${c.name}`), code: null }; },
  async orgKind() { return mockGuard.kind; },
  kind: 'developer',
};
export const liveGuard = { precheck, snapshot, verify, orgKind };
