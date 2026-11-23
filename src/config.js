import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const envFile = path.join(ROOT, '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

const env = (k, d) => (process.env[k] ?? d);

export const config = {
  port: Number(env('PORT', 8787)),
  // Public HTTPS base URL of this bridge (the tunnel URL). Needed for the MeshMesh OAuth redirect only if not localhost.
  publicBaseUrl: env('PUBLIC_BASE_URL', ''),
  // Shared secret Fin sends as "Authorization: Bearer <token>"
  finBearerToken: env('FIN_BEARER_TOKEN', ''),

  // MeshMesh
  meshmeshMcpUrl: env('MESHMESH_MCP_URL', 'https://gateway.meshmesh.io/mcp'),
  meshmeshConnectionId: env('MESHMESH_CONNECTION_ID', ''),
  // "mock" = simulate MeshMesh locally (no credits, no Salesforce changes); "live" = real MCP calls
  meshmeshMode: env('MESHMESH_MODE', 'mock'),
  // Auto-approve MeshMesh's plan after Fin has already captured customer confirmation
  autoApprovePlan: env('AUTO_APPROVE_PLAN', 'true') === 'true',
  pollIntervalMs: Number(env('POLL_INTERVAL_MS', 15000)),
  maxRunMinutes: Number(env('MAX_RUN_MINUTES', 30)),

  // Optional fallback: post progress into the Intercom conversation via REST
  intercomToken: env('INTERCOM_ACCESS_TOKEN', ''),
  intercomAdminId: env('INTERCOM_ADMIN_ID', ''),
  intercomApiBase: env('INTERCOM_API_BASE', 'https://api.intercom.io'),
  // 'comment' = customer-visible reply (default); 'note' = internal note for teammates only
  intercomReplyType: env('INTERCOM_REPLY_TYPE', 'comment') === 'note' ? 'note' : 'comment',
  // 'fallback' = REST reply only when the final webhook can't be delivered; 'always' = also on success
  intercomReplyMode: env('INTERCOM_REPLY_MODE', 'fallback'),

  // Independent read-only Salesforce guard (Salesforce CLI alias of the target org)
  sfTargetOrg: env('SF_TARGET_ORG', ''),
  sfGuard: env('SF_GUARD', 'true') === 'true',
  // Duplicate pre-check before MeshMesh runs. Set false ONLY for controlled-failure tests
  // (lets MeshMesh itself detect and report the duplicate); post-verify stays on via SF_GUARD.
  sfPrecheck: env('SF_PRECHECK', 'true') === 'true',

  // v2 generic requests: what MeshMesh may change (see config/policy.json) and how long an
  // unapproved plan stays valid before the customer must start again.
  policyFile: env('POLICY_FILE', path.join(ROOT, 'config', 'policy.json')),
  planTtlMinutes: Number(env('PLAN_TTL_MINUTES', 60)),

  // Smarter planning for generic (customer-approval) requests: the planner also reports what is already done,
  // redundant or conflicting, its dependencies, and manual steps. OFF by default; turn on only after the Fin
  // Procedure has branches and attributes for assessment / dependencies / manual_steps / already_done.
  smartPlanning: env('SMART_PLANNING', 'false') === 'true',

  dataDir: env('DATA_DIR', path.join(ROOT, 'data')),
};
