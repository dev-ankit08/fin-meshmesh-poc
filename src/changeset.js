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

// ---------------------------------------------------------------- plain-language plan for customers
// Deterministic templates (no model involved), so the wording is predictable and testable. The technical
// list from formatChanges() is still what the build is told to do and what admins can ask to see.

const humanize = (s) => String(s || '').replace(/__(c|mdt|e|x)$/i, '').replace(/[_]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\s+/g, ' ').trim();
const objectOf = (name) => humanize(String(name).split(/[.\-]/)[0]);
const q = (s) => `“${s}”`;
const labelOf = (c) => (c.label && c.label.trim()) || humanize(String(c.name).split(/[.:]/).pop());
const urlIn = (s) => (String(s || '').match(/https?:\/\/[^\s)"']+/) || [''])[0];
const FIELD_KIND = /\b(Long Text Area|Text Area|Text|Number|Currency|Percent|Date\/Time|Date|Checkbox|Picklist|Multi-?select Picklist|Email|Phone|URL|Lookup|Formula)\b/i;
const shorten = (s, n = 170) => (s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`);
const VERB_PLAIN = { create: 'Add', modify: 'Update', assign: 'Assign', delete: 'Remove' };

function plainLine(c, ctx) {
  const t = c.type;
  const obj = objectOf(c.name);
  const lbl = labelOf(c);
  const sum = (c.summary || '').trim();

  if (t === 'CustomField') {
    if (c.action === 'create') {
      const kind = (sum.match(FIELD_KIND) || [])[1];
      return `Add a ${kind ? `${kind.toLowerCase()} ` : ''}field called ${q(lbl)} to ${obj}`; // no article before the label: "a"/"an" would need guessing
    }
    return `Update the ${q(lbl)} field on ${obj}`;
  }
  if (t === 'Layout') {
    const mine = ctx.fields.filter((f) => f.object === obj).map((f) => q(f.label));
    const where = `the ${q(lbl)} page layout`;
    if (mine.length) return `Show ${mine.join(' and ')} on ${where}`;
    return `Update ${where}`;
  }
  if (t === 'PermissionSet') {
    const access = /read and edit|read\/edit|edit/i.test(sum) ? 'read and edit' : /read/i.test(sum) ? 'read' : 'use';
    if (c.action === 'create') {
      if (/principal|credential/i.test(sum)) return `Create a permission set called ${q(lbl)} that lets people use the new connection`;
      if (ctx.fields.length) return `Create a permission set called ${q(lbl)} that lets people ${access} ${ctx.fields.map((f) => q(f.label)).join(' and ')}`;
      return `Create a permission set called ${q(lbl)}`;
    }
    if (/principal|credential/i.test(sum)) return `Let ${q(lbl)} use the new connection`;
    if (ctx.fields.length) return `Let ${q(lbl)} ${access} ${ctx.fields.map((f) => q(f.label)).join(' and ')}`;
    return `Update the ${q(lbl)} permission set`;
  }
  if (t === 'PermissionSetAssignment') {
    const [ps, ...rest] = String(c.name).split(':');
    return `Give ${rest.join(':').trim() || 'the user'} the ${q(c.label || humanize(ps))} permission set`;
  }
  if (t === 'ValidationRule') {
    return sum ? `Add a validation rule on ${obj}: ${shorten(sum)}` : `Add a validation rule ${q(lbl)} on ${obj}`;
  }
  if (t === 'ExternalCredential') return `Create the ${q(lbl)} sign-in settings for the outside service`;
  if (t === 'NamedCredential') {
    const u = urlIn(sum);
    return `Create the ${q(lbl)} connection${u ? ` to ${u}` : ' to the outside service'}`;
  }
  if (t === 'ExternalClientApplication') return `Create the ${q(lbl)} app that outside systems use to sign in to Salesforce`;
  if (/^ExtlClntApp/.test(t)) return `Add sign-in settings for the ${q(humanize(String(c.name).replace(/_(glbl)?oauth$/i, '')))} app`;
  if (t === 'RemoteSiteSetting') { const u = urlIn(sum); return `Allow Salesforce to call ${u || q(lbl)}`; }
  if (t === 'CustomObject') return `Create an object called ${q(lbl)}`;
  if (t === 'RecordType') return `Add a record type called ${q(lbl)} to ${obj}`;

  const verb = VERB_PLAIN[c.action] || 'Update';
  return `${verb} the ${q(lbl)} ${humanize(t).toLowerCase()}${sum ? `: ${shorten(sum)}` : ''}`;
}

/** Numbered, plain-business-language list of the planned changes (no API names, no component types). */
export function formatChangesForCustomer(changes) {
  const ctx = {
    fields: changes.filter((c) => c.type === 'CustomField' && c.action === 'create').map((c) => ({ object: objectOf(c.name), label: labelOf(c) })),
  };
  return changes.map((c, i) => `${i + 1}. ${plainLine(c, ctx)}`).join('\n');
}

/** The plan text without the machine block (for the customer-facing summary). */
export function stripChangeset(text) {
  return String(text || '')
    .replace(/BEGIN_CHANGESET[\s\S]*?END_CHANGESET/g, '')
    .replace(/```changeset[\s\S]*?```/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
