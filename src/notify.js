// Pushes status back to Fin.
// Primary: Fin Procedure "Wait for Webhook" callback URL (flat scalar fields only).
// Fallback: Intercom REST reply into the conversation (if INTERCOM_ACCESS_TOKEN is set).
import { config } from './config.js';
import { logEvent } from './store.js';

/**
 * Customer-facing message for Fin: removes MeshMesh's technical "RESULT: ..." line and, for
 * failures, leads with an explicit "Reason: ..." sentence so Fin relays the real cause
 * instead of inventing one (seen in the live failure test, fmr_251a4833).
 */
export function customerMessage(status, message) {
  const text = String(message || '');
  const result = text.match(/RESULT:\s*(SUCCEEDED|FAILED)\s*(?:[-:–]\s*(.+))?/i);
  const body = text.replace(/^\s*RESULT:.*$/gim, '').replace(/\n{3,}/g, '\n\n').trim();
  if (status !== 'failed') return body;
  const reason = result?.[2]?.trim();
  // Don't claim "nothing changed" here: a mid-build failure can leave partial changes.
  const lead = reason ? `Reason: ${reason}.` : 'Reason: see details below.';
  return body ? `${lead}\n\n${body}` : lead;
}

export async function notifyFin(req, { status, message, isTerminal }) {
  const payload = {
    request_id: req.request_id,
    agent_id: req.agent_id || '',
    status,                       // accepted | planning | building | succeeded | failed
    message: customerMessage(status, message).slice(0, 900),
    is_terminal: isTerminal ? 'true' : 'false',
    updated_at: new Date().toISOString(),
  };

  const results = {};
  // Two-webhook mode (if final_callback_url is supplied): the progress URL gets exactly one
  // non-terminal update (Fin consumes a webhook once per wait), the final URL gets the terminal result.
  // Single-webhook mode: everything goes to callback_url.
  const finalCb = req.input.final_callback_url;
  let cb = req.input.callback_url;
  if (finalCb) {
    if (isTerminal) cb = finalCb;
    else if (req.progress_sent) cb = null;
  }
  if (cb && finalCb && !isTerminal) req.progress_sent = true;
  if (cb) {
    try {
      const r = await fetch(cb, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      results.webhook = r.status;
    } catch (e) {
      results.webhook = `error: ${e.message}`;
    }
  }

  // After-conversation fallback: Fin's webhook wait only works while the Procedure is still waiting.
  // If the final result can't be delivered that way (wait expired -> 404/410, conversation closed,
  // no callback), reply into the conversation via the Intercom REST API instead. A "comment" is
  // visible to the customer and reopens the conversation (Intercom also emails it if they're away).
  const delivered = typeof results.webhook === 'number' && results.webhook >= 200 && results.webhook < 300;
  const needFallback = isTerminal && (!delivered || config.intercomReplyMode === 'always');
  if (needFallback && config.intercomToken && config.intercomAdminId && req.input.conversation_id) {
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
          body: `<p><b>Update on your Salesforce request ${req.request_id}: ${status === 'succeeded' ? 'completed' : status === 'failed' ? 'not completed' : status}</b></p><p>${escapeHtml(payload.message).replace(/\n/g, '<br>')}</p>`,
        }),
      });
      results.intercom_reply = r.status;
    } catch (e) {
      results.intercom_reply = `error: ${e.message}`;
    }
  }

  logEvent('notify_fin', { request_id: req.request_id, status, isTerminal, results });
  return results;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
