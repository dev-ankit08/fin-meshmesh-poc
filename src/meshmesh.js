// MeshMesh MCP client (Streamable HTTP + OAuth 2.0 with PKCE / dynamic client registration).
// First use: GET /oauth/start on the bridge -> sign in to MeshMesh in the browser -> /oauth/callback stores tokens.
// After that the SDK refreshes tokens automatically from data/meshmesh-oauth.json.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { config } from './config.js';
import { logEvent } from './store.js';

const AUTH_FILE = path.join(config.dataDir, 'meshmesh-oauth.json');
const readAuth = () => (existsSync(AUTH_FILE) ? JSON.parse(readFileSync(AUTH_FILE, 'utf8')) : {});
const writeAuth = (patch) => writeFileSync(AUTH_FILE, JSON.stringify({ ...readAuth(), ...patch }, null, 2));

export const redirectUrl = `http://localhost:${config.port}/oauth/callback`;
let pendingAuthUrl = null;

const authProvider = {
  get redirectUrl() { return redirectUrl; },
  get clientMetadata() {
    return {
      client_name: 'Fin MeshMesh PoC Bridge',
      redirect_uris: [redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  },
  clientInformation: () => readAuth().client,
  saveClientInformation: (client) => writeAuth({ client }),
  tokens: () => readAuth().tokens,
  saveTokens: (tokens) => { writeAuth({ tokens, tokens_saved_at: new Date().toISOString() }); logEvent('meshmesh_tokens_saved', {}); },
  redirectToAuthorization: (url) => { pendingAuthUrl = url.toString(); logEvent('meshmesh_auth_required', { open: `http://localhost:${config.port}/oauth/start` }); },
  saveCodeVerifier: (codeVerifier) => writeAuth({ codeVerifier }),
  codeVerifier: () => readAuth().codeVerifier,
};

let client = null;
let transport = null;

let connecting = null;

// Access tokens live only 300 s, so refreshes are frequent. Serialise connection setup so two callers never
// refresh at once (a rotating refresh token would be spent by the first and rejected for the second).
async function connect() {
  if (client) return client;
  if (connecting) return connecting;
  connecting = (async () => {
    transport = new StreamableHTTPClientTransport(new URL(config.meshmeshMcpUrl), { authProvider });
    const c = new Client({ name: 'fin-meshmesh-bridge', version: '0.1.0' });
    try {
      await c.connect(transport);
    } catch (e) {
      if (e instanceof UnauthorizedError) throw new Error('MESHMESH_AUTH_REQUIRED');
      throw e;
    }
    client = c;
    return client;
  })().finally(() => { connecting = null; });
  return connecting;
}

/** Called by /oauth/start: kicks off the flow and returns the URL to open. */
export async function beginAuth() {
  client = null;
  pendingAuthUrl = null;
  try { await connect(); return null; } catch (e) { if (e.message !== 'MESHMESH_AUTH_REQUIRED') throw e; }
  return pendingAuthUrl;
}

/** Called by /oauth/callback with ?code=... */
export async function finishAuth(code) {
  if (!transport) throw new Error('No auth flow in progress; open /oauth/start first');
  await transport.finishAuth(code);
  client = null;
  await connect();
}

export async function isAuthorised() {
  try { await connect(); return true; } catch { return false; }
}

/** Calls an MCP tool and returns { raw, text, json } where json is parsed from the first text block if possible. */
// Read-only tools are safe to repeat, so a transient network/token-refresh failure while polling must not fail a run
// (seen live: one "fetch failed" right after a token refresh killed a healthy plan turn).
export const READ_ONLY_TOOLS = new Set(['get_agent_status', 'get_plan', 'list_connections', 'list_agents', 'get_connection']);
export const RETRY_DELAYS_MS = { read: [2000, 5000, 15000, 30000], write: [0, 3000, 10000] };

// A 401 means the call was rejected before it ran, so repeating even a write tool is safe.
export const isAuthError = (e) => /unauthori[sz]ed|401|MESHMESH_AUTH_REQUIRED|invalid_token|expired/i.test(String(e?.message || e));

export async function withRetry(fn, delays, { sleep = (ms) => new Promise((r) => setTimeout(r, ms)), onRetry = () => {}, shouldRetry = () => true } = {}) {
  let lastErr;
  for (let i = 0; i <= delays.length; i++) {
    try { return await fn(i); } catch (e) {
      lastErr = e;
      if (i === delays.length || !shouldRetry(e, i + 1)) break;
      onRetry(e, i + 1);
      if (delays[i]) await sleep(delays[i]);
    }
  }
  throw lastErr;
}

export async function callTool(name, args = {}) {
  const readOnly = READ_ONLY_TOOLS.has(name);
  const delays = readOnly ? RETRY_DELAYS_MS.read : RETRY_DELAYS_MS.write;
  // Write tools: first retry always (stale connection), later retries only for auth errors (never ran).
  const shouldRetry = readOnly ? () => true : (e, n) => n === 1 || isAuthError(e);
  const res = await withRetry(async (attempt) => {
    // Connection may have gone stale (stateless server, token refresh) - retry with a fresh client
    if (attempt > 0) client = null;
    return (await connect()).callTool({ name, arguments: args });
  }, delays, { shouldRetry, onRetry: (e, n) => logEvent('meshmesh_call_retry', { tool: name, attempt: n, error: e.message }) });
  const text = (res.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
  let json = res.structuredContent ?? null;
  if (!json) { try { json = JSON.parse(text); } catch { /* not JSON */ } }
  if (res.isError) {
    const err = new Error(`MeshMesh tool ${name} failed: ${text.slice(0, 500)}`);
    err.meshmesh = { text, json };
    throw err;
  }
  return { raw: res, text, json };
}

export async function listTools() {
  const c = await connect();
  return (await c.listTools()).tools;
}
