// Pushes status back to Fin.
// Primary: Fin Procedure "Wait for Webhook" callback URL (flat scalar fields only).
// Fallback: Intercom REST reply into the conversation (if INTERCOM_ACCESS_TOKEN is set).
import { config } from './config.js';
import { logEvent } from './store.js';

export async function notifyFin(req, { status, message, isTerminal }) {
  const payload = {
    request_id: req.request_id,
    agent_id: req.agent_id || '',
    status,                       // accepted | planning | building | succeeded | failed
    message: String(message || '').slice(0, 900),
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

  if (config.intercomToken && config.intercomAdminId && req.input.conversation_id) {
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
          message_type: 'note',
          type: 'admin',
          admin_id: config.intercomAdminId,
          body: `<p><b>Salesforce setup ${req.request_id}</b>: ${status}</p><p>${escapeHtml(payload.message)}</p>`,
        }),
      });
      results.intercom_note = r.status;
    } catch (e) {
      results.intercom_note = `error: ${e.message}`;
    }
  }

  logEvent('notify_fin', { request_id: req.request_id, status, isTerminal, results });
  return results;
}

const escapeHtml = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
