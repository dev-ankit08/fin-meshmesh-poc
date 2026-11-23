// HTTP API the Fin Data connector calls.
//   POST /requests               (Bearer FIN_BEARER_TOKEN) -> 202 {accepted, request_id, status, message}
//                                 generic: {requestor_email, change_request, business_reason, plan_callback_url, ...}
//   POST /requests/:id/decision  (Bearer FIN_BEARER_TOKEN) -> {decision: approve|revise|cancel, plan_version, ...}
//   GET  /requests/:id      (Bearer FIN_BEARER_TOKEN)  -> current status (for polling / debugging)
//   GET  /health                                        -> liveness + MeshMesh auth state
//   GET  /oauth/start, /oauth/callback                  -> one-time MeshMesh sign-in (localhost only)
import http from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { config } from './config.js';
import { validateRequest, okUrl } from './validate.js';
import { createRequest, getRequest, listRequests, updateRequest, logEvent } from './store.js';
import { runPlan, runBuild } from './worker.js';
import * as mesh from './meshmesh.js';
import { findExistingField, sfHealth } from './sfcheck.js';
import { resolveCustomer, connectionReady } from './customers.js';
import { brandScrub } from './notify.js';
import { applyVerifiedIdentity } from './identity.js';

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

const str = (v) => (v == null ? '' : String(v).trim());
const reply = (code, accepted, request_id, status, message, extra = {}) => {
  const body = { accepted, request_id, status, message: brandScrub(message), problems: '', ...extra };
  body.problems = brandScrub(body.problems);
  return { code, body };
};

/** Applies the customer's decision on a plan. Pure state checks first; MeshMesh work runs in the background. */
export function decide(id, body) {
  const r = getRequest(id);
  if (!r) return reply(200, false, id, 'rejected', 'This request was not found. Please start a new request.', { problems: 'not_found' });
  const decision = str(body.decision).toLowerCase();
  if (!['approve', 'revise', 'cancel'].includes(decision)) return reply(200, false, id, r.status, 'decision must be approve, revise or cancel.', { problems: 'invalid_decision' });
  const waiting = r.status === 'plan_ready' || (r.status === 'needs_input' && decision !== 'approve');
  if (!waiting) return reply(200, false, id, r.status, `This request is "${r.status}" and is not waiting for a decision.`, { problems: 'wrong_state' });
  if (r.plan_expires_at && Date.parse(r.plan_expires_at) < Date.now() && decision === 'approve') {
    updateRequest(id, { status: 'expired' }, 'Plan approval window expired');
    return reply(200, false, id, 'expired', 'This plan has expired because the org may have changed since. Please start the request again.', { problems: 'plan_expired' });
  }
  if (decision === 'cancel') {
    updateRequest(id, { status: 'cancelled' }, 'Cancelled by the customer before build');
    return reply(200, true, id, 'cancelled', 'Cancelled. Nothing was changed in Salesforce.');
  }
  if (decision === 'revise') {
    const feedback = str(body.feedback || body.answer);
    if (!feedback) return reply(200, false, id, r.status, 'Please say what should change in the plan, or answer the question.', { problems: 'missing feedback', missing_fields: 'feedback' });
    const planCb = str(body.plan_callback_url);
    if (planCb && !okUrl(planCb)) return reply(200, false, id, r.status, 'plan_callback_url must be an https URL', { problems: 'invalid plan_callback_url' });
    updateRequest(id, { status: 'planning', plan_sent: false, revisions: (r.revisions || 0) + 1, input: { ...r.input, plan_callback_url: planCb || r.input.plan_callback_url } }, `Customer feedback: ${feedback.slice(0, 300)}`);
    runPlan(id, { revision: feedback });
    return reply(202, true, id, 'planning', "Thanks. We're updating the plan. Nothing has been changed yet.");
  }
  // approve
  const version = str(body.plan_version);
  if (version && version !== r.plan_version) return reply(200, false, id, r.status, 'The plan changed since it was shown. Please review the latest plan.', { problems: 'plan_version_mismatch' });
  for (const k of ['callback_url', 'final_callback_url']) {
    const u = str(body[k]);
    if (u && !okUrl(u)) return reply(200, false, id, r.status, `${k} must be an https URL`, { problems: `invalid ${k}` });
  }
  updateRequest(id, { status: 'approved', progress_sent: false, input: { ...r.input, callback_url: str(body.callback_url) || r.input.callback_url, final_callback_url: str(body.final_callback_url) || r.input.final_callback_url } }, `Plan ${r.plan_version} approved by the customer`);
  runBuild(id, r.plan_version);
  return reply(202, true, id, 'building', `Approved. We're now making the ${r.changes?.length || ''} planned changes in Salesforce.`.replace('  ', ' '), { plan_version: r.plan_version });
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
        const rawBody = await readJson(req);
        const ident = applyVerifiedIdentity(rawBody, req.headers);
        const body = ident.body;
        logEvent('request_received', { body, email_source: ident.source, ...(ident.replaced ? { replaced_email: ident.replaced } : {}) });
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
          logEvent('no_connection', { requestor_email: v.value.requestor_email, connect_url: cust.connectUrl });
          return send(res, 200, {
            accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name || '',
            missing_fields: '', problems: 'no_connection: no Salesforce org is connected for this customer',
            message: "Your Salesforce org isn't connected yet, so nothing was changed. Your Salesforce admin needs to connect it first; once that's done, ask again and I can make the change, or I can connect you with a teammate.",
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
            logEvent('connection_not_ready', { customer: cust.customer, why: rd.why, connect_url: cust.connectUrl });
            return send(res, 200, {
              accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name || '',
              missing_fields: '', problems: 'connection_not_ready',
              message: "The connection to your Salesforce org isn't available right now, so nothing was changed. Please ask your Salesforce admin to check it, or I can connect you with a teammate.",
            });
          }
        }
        // Independent duplicate guard (read-only describe) - runs BEFORE MeshMesh is involved.
        // Legacy single-field contract only: answer duplicates synchronously, as in the PoC (T4/T8).
        // Generic requests are pre-checked on MeshMesh's CHANGESET once the plan exists (src/guard.js).
        const guardOn = v.value.contract === 'legacy_field' && config.sfGuard && config.sfPrecheck && v.value.sf_target_org && config.meshmeshMode === 'live';
        if (guardOn) {
          let dup;
          try {
            dup = await findExistingField(v.value.target_object, v.value.field_api_name, v.value.field_label, v.value.sf_target_org);
          } catch (e) {
            logEvent('precheck_error', { error: e.message });
            return send(res, 200, {
              accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name || '',
              missing_fields: '', problems: 'precheck_unavailable',
              message: 'The configuration could not be started because the Salesforce safety check is unavailable. Nothing was changed in Salesforce.',
            });
          }
          if (dup.exists) {
            logEvent('precheck_duplicate', { field: v.value.field_api_name, matchedBy: dup.matchedBy, existing: { name: dup.field.name, label: dup.field.label, type: dup.field.type } });
            return send(res, 200, {
              accepted: false, request_id: '', status: 'rejected', field_api_name: v.value.field_api_name || '',
              missing_fields: '',
              problems: `duplicate_field: a field with this ${dup.matchedBy} already exists on ${v.value.target_object} (${dup.field.label} / ${dup.field.name}, type ${dup.field.type})`,
              message: `A field called "${dup.field.label}" (${dup.field.name}) already exists on ${v.value.target_object}, so nothing was changed. Please choose a different field label.`,
            });
          }
        }
        const r = createRequest(v.value);
        logEvent('request_accepted', { request_id: r.request_id, input: v.value });
        runPlan(r.request_id); // async; status is pushed to Fin's webhook(s)
        const approval = v.value.plan_callback_url ? 'customer' : 'auto';
        return send(res, 202, {
          accepted: true,
          request_id: r.request_id,
          status: 'accepted',
          approval,
          field_api_name: v.value.field_api_name || '',
          missing_fields: '',
          problems: '',
          message: approval === 'customer'
            ? `Request ${r.request_id} accepted. We're reviewing your Salesforce setup and preparing a plan. Nothing will change until you approve the plan.`
            : `Request ${r.request_id} accepted. We'll now plan and configure: ${v.value.title}.`,
        });
      }

      // v2: the customer's answer to the plan shown in Fin.
      //   decision = approve  -> build exactly plan_version (send callback_url + final_callback_url)
      //   decision = revise   -> send feedback / an answer to MeshMesh and re-plan (send a fresh plan_callback_url)
      //   decision = cancel   -> nothing is built
      // Also accepted as POST /requests/decision with request_id in the body, for connector URL editors
      // that can't put a placeholder in the path.
      const dm = url.pathname.match(/^\/requests\/([A-Za-z0-9_-]+)\/decision$/) || (url.pathname === '/requests/decision' && [null, null]);
      if (req.method === 'POST' && dm) {
        const body = await readJson(req);
        const rid = dm[1] && dm[1] !== 'decision' ? dm[1] : String(body.request_id || '').trim();
        logEvent('decision_received', { request_id: rid, body });
        const out = decide(rid, body);
        return send(res, out.code, out.body);
      }

      if (req.method === 'GET' && url.pathname === '/requests') return send(res, 200, listRequests());
      const id = url.pathname.split('/')[2];
      const r = getRequest(id);
      if (!r) return send(res, 404, { error: 'not found' });
      return send(res, 200, { request_id: r.request_id, agent_id: r.agent_id, status: r.status, plan_version: r.plan_version || '', changes: r.changes || [], message: r.last_message || '', history: r.history });
    }

    send(res, 404, { error: 'not found' });
  } catch (e) {
    logEvent('server_error', { path: url.pathname, error: e.message });
    send(res, 500, { accepted: false, status: 'error', message: `Bridge error: ${e.message}` });
  }
});

if (process.env.BRIDGE_NO_LISTEN !== '1') server.listen(config.port, () => {
  console.log(`Fin x MeshMesh bridge on http://localhost:${config.port} (MeshMesh mode: ${config.meshmeshMode})`);
  if (!config.finBearerToken) console.warn('WARNING: FIN_BEARER_TOKEN not set - requests are unauthenticated. Set it before exposing a tunnel.');
});
