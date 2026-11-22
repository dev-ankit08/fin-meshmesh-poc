// The CHANGESET is the contract that makes the bridge generic.
// Whatever the customer asks for (a field, a validation rule, an External Client App, Named/External
// Credentials, a permission set assignment...), MeshMesh must end its PLAN with a machine-readable list of
// every component it will create or modify:
//
//   BEGIN_CHANGESET
//   [{"action":"create","type":"CustomField","name":"Account.Renewal_Risk__c","label":"Renewal Risk","summary":"Text(100)"}]
//   END_CHANGESET
//
// The bridge never has to understand the request itself. It only needs this list to:
//   1. check it against policy (config/policy.json),
//   2. check it against the org (pre-check: "create" of something that already exists = conflict),
//   3. show it to the customer for approval (the customer approves exactly this list, by plan_version),
//   4. verify it after the build and detect anything changed that was NOT in the list.
import { createHash } from 'node:crypto';

export const ACTIONS = ['create', 'modify', 'assign', 'delete'];
const ACTION_ALIASES = { add: 'create', new: 'create', update: 'modify', edit: 'modify', change: 'modify', upsert: 'modify', grant: 'assign', remove: 'delete' };

const str = (v) => (v == null ? '' : String(v).trim());

function extractBlock(text) {
  const s = String(text || '');
  // Last block wins (MeshMesh may restate the plan).
  const marker = [...s.matchAll(/BEGIN_CHANGESET\s*([\s\S]*?)\s*END_CHANGESET/g)].pop();
  if (marker) return marker[1];
  const fence = [...s.matchAll(/```changeset\s*([\s\S]*?)```/g)].pop();
  return fence ? fence[1] : null;
}

/** Parses the CHANGESET block. Returns { ok, changes[], error? }. */
export function parseChangeset(text) {
  let block = extractBlock(text);
  if (block == null) return { ok: false, changes: [], error: 'no CHANGESET block found' };
  block = block.replace(/^```(?:json)?\s*|```\s*$/g, '').trim();
  let arr;
  try { arr = JSON.parse(block); } catch (e) { return { ok: false, changes: [], error: `CHANGESET is not valid JSON: ${e.message}` }; }
  if (!Array.isArray(arr)) arr = Array.isArray(arr?.changes) ? arr.changes : null;
  if (!arr) return { ok: false, changes: [], error: 'CHANGESET must be a JSON array' };

  const changes = [];
  for (const [i, c] of arr.entries()) {
    const rawAction = str(c?.action).toLowerCase();
    const action = ACTION_ALIASES[rawAction] || rawAction;
    const type = str(c?.type).replace(/\s+/g, '');
    const name = str(c?.name ?? c?.fullName ?? c?.api_name);
    if (!action || !type || !name) return { ok: false, changes: [], error: `CHANGESET item ${i + 1} needs action, type and name` };
    changes.push({ action, type, name, label: str(c?.label), summary: str(c?.summary ?? c?.details).slice(0, 200) });
  }
  if (!changes.length) return { ok: false, changes: [], error: 'CHANGESET is empty' };
  return { ok: true, changes };
}

/** Short, stable id of a changeset. The customer approves this exact version. */
export function planVersion(changes) {
  const canon = changes.map((c) => `${c.action}|${c.type}|${c.name.toLowerCase()}`).sort().join('\n');
  return `pv_${createHash('sha256').update(canon).digest('hex').slice(0, 10)}`;
}

const VERB = { create: 'Create', modify: 'Update', assign: 'Assign', delete: 'Delete' };

/** Customer-readable list for Fin: "1. Create CustomField Account.Renewal_Risk__c (Renewal Risk): Text(100)". */
export function formatChanges(changes) {
  return changes.map((c, i) => {
    const label = c.label && c.label.toLowerCase() !== c.name.toLowerCase() ? ` (${c.label})` : '';
    const summary = c.summary ? `: ${c.summary}` : '';
    return `${i + 1}. ${VERB[c.action] || c.action} ${c.type} ${c.name}${label}${summary}`;
  }).join('\n');
}

/** The plan text without the machine block (for the customer-facing summary). */
export function stripChangeset(text) {
  return String(text || '')
    .replace(/BEGIN_CHANGESET[\s\S]*?END_CHANGESET/g, '')
    .replace(/```changeset[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
