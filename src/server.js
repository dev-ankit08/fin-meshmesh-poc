// HTTP API the Fin Data connector calls.
//   POST /requests          (Bearer FIN_BEARER_TOKEN)  -> 202 {accepted, request_id, status, message}
//   GET  /requests/:id      (Bearer FIN_BEARER_TOKEN)  -> current status (for polling / debugging)
//   GET  /health                                        -> liveness + MeshMesh auth state
//   GET  /oauth/start, /oauth/callback                  -> one-time MeshMesh sign-in (localhost only)
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { validateRequest } from './validate.js';
import { createRequest, getRequest, listRequests, logEvent } from './store.js';
import { runRequest } from './worker.js';
import * as mesh from './meshmesh.js';
import { findExistingField, sfHealth } from './sfcheck.js';
import { resolveCustomer, connectionReady } from './customers.js';

const send = (res, code, body) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

function authorised(req) {
  if (!config.finBearerToken) return true; // allowed only for local testing
  const got = Buffer.from(String(req.headers.authorization || '').replace(/^Bearer\s+/i, ''));
  const want = Buffer.from(config.finBearerToken);
  return got.length === want.length && timingSafeEqual(got, want);
}

const isLocal = (req) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) && !req.headers['x-forwarded-for'] && !req.headers['cf-connecting-ip'];

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) { raw += chunk; if (raw.length > 100_000) throw new Error('body too large'); }
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${config.port}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      return send(res, 200, {
        ok: true,
        mode: config.meshmeshMode,
        meshmesh_authorised: config.meshmeshMode === 'live' ? await mesh.isAuthorised() : 'n/a (mock)',
        salesforce_guard: config.sfGuard && config.sfTargetOrg ? await sfHealth() : 'disabled',
      });
    }

    if (url.pathname.startsWith('/oauth/')) {
      if (!isLocal(req)) return send(res, 403, { error: 'OAuth endpoints are localhost-only' });
      if (url.pathname === '/oauth/start') {
        const authUrl = await mesh.beginAuth();
        if (!authUrl) return send(res, 200, { ok: true, message: 'Already signed in to MeshMesh' });
        res.writeHead(302, { Location: authUrl });
        return res.end();
      }
      if (url.pathname === '/oauth/callback') {
        const code = url.searchParams.get('code');
        if (!code) return send(res, 400, { error: url.searchParams.get('error') || 'missing code' });
        await mesh.finishAuth(code);
        res.writeHead(200, { 'Content-Type': 'text/html' });
        return res.end('<h2>MeshMesh connected to the Fin PoC bridge.</h2><p>You can close this tab.</p>');
      }
    }

    if (url.pathname === '/requests' || url.pathname.startsWith('/requests/')) {
      if (!authorised(req)) return send(res, 401, { accepted: false, error: 'unauthorised' });

      if (req.method === 'POST' && url.pathname === '/requests') {
        const body = await readJson(req);
        logEvent('request_received', { body });
        const v = validateRequest(body);
        if (!v.ok) {
          // 200 (not 4xx) so Fin can read the fields and ask the customer, instead of treating it as a connector outage.
          return send(res, 200, {
            accepted: false,
            request_id: '',
            status: 'rejected',
            field_api_name: '',
            missing_fields: v.missing.join(', '),
            problems: v.invalid.join('; '),
            message: `The request is incomplete. ${v.missing.length ? `Missing: ${v.missing.join(', ')}.` : ''} ${v.invalid.join('; ')}`.trim(),
          });
        }
        // POC-03: which customer is this, and is THEIR Salesforce org connected to MeshMesh?
        const cust = resolveCustomer({ ...v.value, company_id: body.company_id });
        if (!cust.ok) {
          logEvent('no_connection', { requestor_email: v.value.requestor_email });
          return send(res, 200, {
            accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name,
            missing_fields: '', problems: 'no_connection: this customer has no Salesforce sandbox connected to MeshMesh',
            message: `Your Salesforce sandbox is not connected yet, so nothing was changed. A Salesforce admin at your company needs to connect the sandbox once in MeshMesh (${cust.connectUrl}: Connections, then Salesforce, then sign in to the sandbox). After that, ask again and I can make the change.`,
          });
        }
        v.value.customer = cust.customer;
        v.value.connection_id = cust.connectionId || '';
        v.value.sf_target_org = cust.sfTargetOrg || '';
        if (config.meshmeshMode === 'live' && v.value.connection_id) {
          let rd;
          try { rd = connectionReady((await mesh.callTool('list_connections', {})).json, v.value.connection_id); }
          catch (e) { rd = { ready: false, why: `could not be checked (${e.message})` }; }
          if (!rd.ready) {
            logEvent('connection_not_ready', { customer: cust.customer, why: rd.why });
            return send(res, 200, {
              accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name,
              missing_fields: '', problems: `connection_not_ready: ${rd.why}`,
              message: `The connection to your Salesforce sandbox is ${rd.why}, so nothing was changed. Please ask your Salesforce admin to reconnect it in MeshMesh (${cust.connectUrl}), or I can connect you with a teammate.`,
            });
          }
        }
        // Independent duplicate guard (read-only describe) - runs BEFORE MeshMesh is involved.
        const guardOn = config.sfGuard && config.sfPrecheck && v.value.sf_target_org && config.meshmeshMode === 'live';
        if (guardOn) {
          let dup;
          try {
            dup = await findExistingField(v.value.target_object, v.value.field_api_name, v.value.field_label, v.value.sf_target_org);
          } catch (e) {
            logEvent('precheck_error', { error: e.message });
            return send(res, 200, {
              accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name,
              missing_fields: '', problems: 'precheck_unavailable',
              message: 'The configuration could not be started because the Salesforce safety check is unavailable. Nothing was changed in Salesforce.',
            });
          }
          if (dup.exists) {
            logEvent('precheck_duplicate', { field: v.value.field_api_name, matchedBy: dup.matchedBy, existing: { name: dup.field.name, label: dup.field.label, type: dup.field.type } });
            return send(res, 200, {
              accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name,
              missing_fields: '',
              problems: `duplicate_field: a field with this ${dup.matchedBy} already exists on ${v.value.target_object} (${dup.field.label} / ${dup.field.name}, type ${dup.field.type})`,
              message: `A field called "${dup.field.label}" (${dup.field.name}) already exists on ${v.value.target_object}, so nothing was changed. Please choose a different field label.`,
            });
          }
        }
        const r = createRequest(v.value);
        logEvent('request_accepted', { request_id: r.request_id, input: v.value });
        runRequest(r.request_id); // async; status is pushed to Fin's callback URL
        return send(res, 202, {
          accepted: true,
          request_id: r.request_id,
          status: 'accepted',
          field_api_name: v.value.field_api_name,
          missing_fields: '',
          problems: '',
          message: `Request ${r.request_id} accepted. MeshMesh will now configure ${v.value.field_label} on Account.`,
        });
      }

      if (req.method === 'GET' && url.pathname === '/requests') return send(res, 200, listRequests());
      const id = url.pathname.split('/')[2];
      const r = getRequest(id);
      if (!r) return send(res, 404, { error: 'not found' });
      return send(res, 200, { request_id: r.request_id, agent_id: r.agent_id, status: r.status, message: r.last_message || '', history: r.history });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    logEvent('server_error', { path: url.pathname, error: e.message });
    send(res, 500, { accepted: false, status: 'error', message: `Bridge error: ${e.message}` });
  }
});

server.listen(config.port, () => {
  console.log(`Fin x MeshMesh bridge on http://localhost:${config.port} (MeshMesh mode: ${config.meshmeshMode})`);
  if (!config.finBearerToken) console.warn('WARNING: FIN_BEARER_TOKEN not set - requests are unauthenticated. Set it before exposing a tunnel.');
});
