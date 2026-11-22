// Pushes status back to Fin.
// Primary: Fin Procedure "Wait for Webhook" callback URLs (flat scalar fields only). Each URL accepts ONE
// delivery per wait, so the bridge routes by channel:
//   plan     -> plan_callback_url   (v2: plan ready for approval / needs input / rejected / failed in planning)
//   progress -> callback_url        (exactly one non-terminal update)
//   final    -> final_callback_url  (terminal result; falls back to callback_url in single-webhook mode)
// Fallback: Intercom REST reply into the conversation (if INTERCOM_ACCESS_TOKEN is set) when a plan or
// final webhook can't be delivered (wait expired, conversation closed).
import { config } from './config.js';
import { logEvent } from './store.js';

/** Removes anything that looks like a credential before text reaches the customer or Fin. */
export function redactSecrets(text) {
  return String(text || '')
    .replace(/((?:consumer\s*)?(?:secret|password|passwd|token|consumer[\s_-]*key|api[\s_-]*key|access[\s_-]*token|refresh[\s_-]*token|bearer|private[\s_-]*key)\s*[:=]\s*)\S+/gi, '$1[redacted]')
    .replace(/\b3MVG[A-Za-z0-9._]{20,}\b/g, '[redacted]')          // Salesforce consumer keys
    .replace(/\b[A-Fa-f0-9]{40,}\b/g, '[redacted]')                // long hex secrets
    .replace(/\b(?=[A-Za-z0-9+/_-]*\d)(?=[A-Za-z0-9+/_-]*[A-Z])[A-Za-z0-9+/_-]{48,}={0,2}/g, '[redacted]'); // long base64-ish tokens
}

/**
 * Customer-facing message for Fin: removes MeshMesh's technical "RESULT: ..." line and, for
 * failures, leads with an explicit "Reason: ..." sentence so Fin relays the real cause
 * instead of inventing one (seen in the live failure test, fmr_251a4833).
 */
export function customerMessage(status, message) {
  const text = redactSecrets(message);
  const result = text.match(/RESULT:\s*\**\s*(SUCCEEDED|FAILED|NEEDS_INPUT)\s*(?:[-:–]\s*(.+))?/i);
  const body = text.replace(/^\s*RESULT:.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
  if (status === 'needs_input') {
    const q = result?.[2]?.trim();
    return q ? `Question: ${q}${body ? `\n\n${body}` : ''}` : body;
  }
  if (!['failed', 'rejected'].includes(status)) return body;
  if (/^Reason:/.test(body)) return body;
  const reason = result?.[2]?.trim();
  // Don't claim "nothing changed" here: a mid-build failure can leave partial changes.
  const lead = reason ? `Reason: ${reason}.` : 'Reason: see details below.';
  return body ? `${lead}\n\n${body}` : lead;
}

const TERMINAL_CHANNEL = 'final';

function pickUrl(req, channel) {
  const i = req.input;
  if (channel === 'plan') return req.plan_sent ? null : i.plan_callback_url || null;
  const finalCb = i.final_callback_url;
  if (channel === TERMINAL_CHANNEL) return finalCb || i.callback_url || null;
  // progress: two-webhook mode sends exactly one; single-webhook mode sends all
  if (finalCb) return req.progress_sent ? null : i.callback_url || null;
  return i.callback_url || null;
}

export async function notifyFin(req, { status, message, isTerminal, channel, extra = {} }) {
  channel = channel || (isTerminal ? TERMINAL_CHANNEL : 'progress');
  const payload = {
    request_id: req.request_id,
    agent_id: req.agent_id || '',
    status,                       // planning | plan_ready | needs_input | rejected | building | succeeded | failed | needs_review | cancelled
    message: customerMessage(status, message).slice(0, 900),
    is_terminal: isTerminal ? 'true' : 'false',
    plan_version: req.plan_version || '',
    change_count: String(req.changes?.length ?? ''),
    changes: redactSecrets(extra.changes ?? '').slice(0, 1500),
    warnings: redactSecrets(extra.warnings ?? '').slice(0, 600),
    updated_at: new Date().toISOString(),
  };

  const results = {};
  const cb = pickUrl(req, channel);
  if (cb) {
    if (channel === 'plan') req.plan_sent = true;
    if (channel === 'progress' && req.input.final_callback_url) req.progress_sent = true;
    try {
      const r = await fetch(cb, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      results.webhook = r.status;
    } catch (e) {
      results.webhook = `error: ${e.message}`;
    }
  }

  // After-conversation fallback: Fin's webhook wait only works while the Procedure is still waiting.
  const delivered = typeof results.webhook === 'number' && results.webhook >= 200 && results.webhook < 300;
  const important = isTerminal || channel === 'plan';
  const needFallback = important && cb !== null && (!delivered || config.intercomReplyMode === 'always')
    || (isTerminal && !cb);
  if (needFallback && config.intercomToken && config.intercomAdminId && req.input.conversation_id) {
    const head = { succeeded: 'completed', failed: 'not completed', plan_ready: 'plan ready for your approval', needs_input: 'question', rejected: 'cannot be done through chat', needs_review: 'needs a teammate to review' }[status] || status;
    const body = [payload.message, payload.changes && `Planned changes:\n${payload.changes}`, payload.warnings].filter(Boolean).join('\n\n');
    try {
      const r = await fetch(`${config.intercomApiBase}/conversations/${encodeURIComponent(req.input.conversation_id)}/reply`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.intercomToken}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Intercom-Version': '2.13',
        },
        body: JSON.stringify({
          message_type: config.intercomReplyType, // 'comment' (customer sees it) or 'note' (internal only)
          type: 'admin',
          admin_id: config.intercomAdminId,
          body: `<p><b>Update on your Salesforce request ${req.request_id}: ${head}</b></p><p>${escapeHtml(body).replace(/\n/g, '<br>')}</p>`,
        }),
      });
      results.intercom_reply = r.status;
    } catch (e) {
      results.intercom_reply = `error: ${e.message}`;
    }
  }

  logEvent('notify_fin', { request_id: req.request_id, status, channel, isTerminal, results });
  return results;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
