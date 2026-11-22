// POC-03: per-customer Salesforce connection.
// MeshMesh's MCP API can list and attach org connections but cannot create one: a connection is
// authorised once by the customer's Salesforce admin in MeshMesh Studio (OAuth). So the bridge:
//   1. maps the requesting customer to THEIR MeshMesh connection (+ the CLI alias used by the guard),
//   2. checks with MeshMesh that the connection exists and is ready (list_connections),
//   3. if not, refuses before anything runs and tells Fin how the customer gets connected.
// Mapping file: config/customers.json (git-ignored; see config/customers.example.json).
// If the file is absent the bridge falls back to the single MESHMESH_CONNECTION_ID / SF_TARGET_ORG.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { ROOT, config } from './config.js';

const FILE = path.join(ROOT, 'config', 'customers.json');
const SAFE_ALIAS = /^[A-Za-z0-9._@-]{1,80}$/;

export function loadCustomers(file = FILE) {
  if (!existsSync(file)) return null;
  const j = JSON.parse(readFileSync(file, 'utf8'));
  return { customers: j.customers || [], connectUrl: j.connect_url || 'https://studio.meshmesh.io' };
}

const domainOf = (email) => String(email || '').split('@')[1]?.trim().toLowerCase() || '';

/**
 * Finds the customer for a validated request. PoC key: the requester's email domain or an explicit
 * company_id. Production should use Intercom's VERIFIED company/user identity, not a typed email.
 * Returns { ok, customer?, connectionId?, sfTargetOrg?, reason?, connectUrl? }.
 */
export function resolveCustomer(value, data = loadCustomers()) {
  if (!data) {
    return { ok: true, customer: 'default', connectionId: config.meshmeshConnectionId, sfTargetOrg: config.sfTargetOrg };
  }
  const dom = domainOf(value.requestor_email);
  const cid = String(value.company_id || '').trim().toLowerCase();
  const c = data.customers.find((x) =>
    (cid && (x.match?.company_ids || []).map((s) => s.toLowerCase()).includes(cid)) ||
    (dom && (x.match?.email_domains || []).map((s) => s.toLowerCase()).includes(dom)));
  if (!c) return { ok: false, reason: 'no_connection', connectUrl: data.connectUrl };
  if (c.sf_target_org && !SAFE_ALIAS.test(c.sf_target_org)) throw new Error(`unsafe sf_target_org for ${c.name}`);
  return { ok: true, customer: c.name, connectionId: c.meshmesh_connection_id, sfTargetOrg: c.sf_target_org || config.sfTargetOrg, connectUrl: data.connectUrl };
}

/** Checks a list_connections result: is this connection present, enabled and authorised? */
export function connectionReady(listResult, connectionId) {
  const conns = listResult?.connections || [];
  const notReady = listResult?.notReady || [];
  if (notReady.some((n) => (n.id || n.connectionId) === connectionId)) return { ready: false, why: 'not ready yet in MeshMesh' };
  const c = conns.find((x) => x.id === connectionId);
  if (!c) return { ready: false, why: 'not found in MeshMesh' };
  if (c.enabled === false) return { ready: false, why: 'disabled in MeshMesh' };
  if (c.hasCredentials === false) return { ready: false, why: 'not authorised (no Salesforce credentials)' };
  return { ready: true, name: c.name };
}
