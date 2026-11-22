// Guardrails for free-form requests: MeshMesh decides HOW to meet the request, the policy decides
// WHAT it may touch. Evaluated on the parsed CHANGESET, before the customer is asked to approve.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

export function loadPolicy(file = config.policyFile || path.join(ROOT, 'config', 'policy.json')) {
  return JSON.parse(readFileSync(file, 'utf8')); // read per request, so edits apply without a restart
}

const toRe = (p) => new RegExp(`^${p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
export const typeMatches = (type, patterns = []) => patterns.some((p) => toRe(p).test(type));

/**
 * Returns { ok, blocked: [{ change, why }], warnings: [] }.
 * `existing` (optional) is the set of lower-cased "Type:fullName" keys the pre-check found in the org;
 * it lets the policy refuse modifying an existing component of a create-only type.
 */
export function evaluatePolicy(changes, policy = loadPolicy(), existing = new Set()) {
  const blocked = [];
  const warnings = [];
  if (changes.length > (policy.max_components ?? 30)) {
    blocked.push({ change: null, why: `the plan has ${changes.length} components; the limit for one request is ${policy.max_components}. Please split the request.` });
  }
  for (const c of changes) {
    const key = `${c.type}:${c.name}`.toLowerCase();
    if (!(policy.allowed_actions || []).includes(c.action)) {
      blocked.push({ change: c, why: c.action === 'delete' ? 'deleting components is not allowed through chat' : `action "${c.action}" is not allowed` });
    } else if (typeMatches(c.type, policy.blocked_types)) {
      blocked.push({ change: c, why: `${c.type} changes need a Salesforce admin and cannot be made through chat` });
    } else if (!typeMatches(c.type, policy.allowed_types)) {
      blocked.push({ change: c, why: `${c.type} is not on the list of supported setup changes` });
    } else if ((c.action === 'modify' || existing.has(key)) && c.action !== 'assign' && !typeMatches(c.type, policy.modify_allowed_types)) {
      blocked.push({ change: c, why: `${c.name} already exists and existing ${c.type} components may not be changed through chat` });
    }
    if (/^ExtlClntApp.*Oauth|^ExternalClientApplication$/i.test(c.type)) {
      warnings.push('OAuth secrets (consumer key/secret) are never shown in chat. Your admin retrieves them in Setup → External Client App Manager.');
    }
    if (/^(NamedCredential|ExternalCredential)$/i.test(c.type)) {
      warnings.push('Passwords, API keys or tokens for the external system are not entered through chat. Your admin adds them to the External Credential principal in Setup.');
    }
  }
  return { ok: blocked.length === 0, blocked, warnings: [...new Set(warnings)] };
}

export const describeBlocked = (blocked) =>
  blocked.map((b) => (b.change ? `${b.change.type} ${b.change.name}: ${b.why}` : b.why)).join('; ');
