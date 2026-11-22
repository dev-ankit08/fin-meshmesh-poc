// Independent, READ-ONLY Salesforce checks used by the bridge:
//   1. Pre-check: refuse a request whose field (API name or label) already exists on Account,
//      so MeshMesh never gets the chance to upsert/overwrite an existing field (PoC finding T4).
//   2. Post-verify: after MeshMesh reports SUCCEEDED, confirm the field really exists with the right
//      type and that the permission set has Read/Edit - instead of trusting the agent's own report.
// Auth: reuses an existing Salesforce CLI login (`sf org login web --alias <alias>`). The CLI itself makes
// the GET calls (`sf api request rest`), so the bridge never sees or stores a Salesforce token.
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from './config.js';

const sh = promisify(exec);
const API = 'v62.0';

const SAFE_ALIAS = /^[A-Za-z0-9._@-]{1,80}$/;

// org = Salesforce CLI alias of the customer's org (POC-03); defaults to SF_TARGET_ORG.
async function sfGet(path, org = config.sfTargetOrg) {
  if (!SAFE_ALIAS.test(String(org || ''))) throw new Error('no valid Salesforce CLI org alias configured');
  const cmd = `sf api request rest "/services/data/${API}${path}" --method GET --target-org ${org}`;
  const { stdout } = await sh(cmd, { timeout: 90_000, maxBuffer: 50 * 1024 * 1024, windowsHide: true });
  const start = stdout.search(/[\[{]/);
  if (start < 0) throw new Error(`Salesforce CLI returned no JSON for ${path}: ${stdout.slice(0, 200)}`);
  const body = JSON.parse(stdout.slice(start));
  if (Array.isArray(body) && body[0]?.errorCode) throw new Error(`Salesforce GET ${path}: ${body[0].errorCode} ${body[0].message}`);
  return body;
}

const norm = (s) => String(s || '').trim().toLowerCase();

// IMPORTANT: do NOT use /sobjects/<obj>/describe for existence checks. Describe only returns fields the
// running user has field-level security on, so a field granted only via an unassigned permission set looks
// absent. (This is exactly why MeshMesh, running as the same user, missed an existing field in test T4.)
// The Tooling API FieldDefinition entity lists field metadata regardless of FLS.
async function listFieldDefinitions(object, org) {
  const q = `SELECT QualifiedApiName, Label, DataType FROM FieldDefinition WHERE EntityDefinition.QualifiedApiName = '${object.replace(/'/g, '')}'`;
  const r = await sfGet(`/tooling/query?q=${encodeURIComponent(q)}`, org);
  return (r.records || []).map((x) => ({ name: x.QualifiedApiName, label: x.Label, type: x.DataType }));
}

/** Returns { exists, matchedBy, field } for the requested field on the target object. */
export async function findExistingField(object, apiName, label, org) {
  const fields = await listFieldDefinitions(object, org);
  const byApi = fields.find((f) => norm(f.name) === norm(apiName));
  if (byApi) return { exists: true, matchedBy: 'API name', field: byApi };
  const byLabel = fields.find((f) => norm(f.label) === norm(label));
  if (byLabel) return { exists: true, matchedBy: 'label', field: byLabel };
  return { exists: false };
}

// FieldDefinition.DataType values look like "Text(100)", "Number(18, 0)", "Checkbox", "Date"
const EXPECTED_TYPE = { Text: /^text\(/i, Number: /^number\(/i, Checkbox: /^checkbox$/i, Date: /^date$/i };

/** Verifies the configuration MeshMesh claims to have made. Returns { ok, problems[], details }. */
export async function verifyConfiguration(v) {
  const problems = [];
  const org = v.sf_target_org || config.sfTargetOrg;
  const fields = await listFieldDefinitions(v.target_object, org);
  const f = fields.find((x) => norm(x.name) === norm(v.field_api_name));
  if (!f) problems.push(`field ${v.field_api_name} not found on ${v.target_object}`);
  else if (EXPECTED_TYPE[v.field_type] && !EXPECTED_TYPE[v.field_type].test(f.type)) {
    problems.push(`field type is ${f.type}, expected ${v.field_type}`);
  }

  const ps = v.permission_set.replace(/'/g, "\\'");
  const q = `SELECT PermissionsRead, PermissionsEdit FROM FieldPermissions WHERE Field = '${v.target_object}.${v.field_api_name}' AND Parent.Label = '${ps}'`;
  const fp = await sfGet(`/query?q=${encodeURIComponent(q)}`, org);
  const rec = fp.records?.[0];
  if (!rec) problems.push(`permission set "${v.permission_set}" has no access to the field`);
  else if (!rec.PermissionsRead || !rec.PermissionsEdit) problems.push(`permission set "${v.permission_set}" lacks Read/Edit (read=${rec.PermissionsRead}, edit=${rec.PermissionsEdit})`);

  return { ok: problems.length === 0, problems, details: f ? { name: f.name, label: f.label, type: f.type } : null };
}

export async function sfHealth() {
  try { const r = await sfGet('/limits'); return { ok: true, daily_api_remaining: r?.DailyApiRequests?.Remaining }; }
  catch (e) { return { ok: false, error: e.message.slice(0, 200) }; }
}
