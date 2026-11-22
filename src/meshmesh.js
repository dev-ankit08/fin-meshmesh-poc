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

async function connect() {
  if (client) return client;
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
export async function callTool(name, args = {}) {
  const c = await connect();
  let res;
  try {
    res = await c.callTool({ name, arguments: args });
  } catch (e) {
    // Connection may have gone stale (stateless server, token refresh) - retry once with a fresh client
    client = null;
    res = await (await connect()).callTool({ name, arguments: args });
  }
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
