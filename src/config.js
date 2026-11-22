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

  // Independent read-only Salesforce guard (Salesforce CLI alias of the target org)
  sfTargetOrg: env('SF_TARGET_ORG', ''),
  sfGuard: env('SF_GUARD', 'true') === 'true',

  dataDir: path.join(ROOT, 'data'),
};
