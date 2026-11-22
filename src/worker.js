// Orchestrates one configuration request end to end:
// start_agent(plan) -> wait for plan -> continue_agent(approve, build) -> poll get_agent_status -> notify Fin.
import { config } from './config.js';
import { updateRequest, getRequest, logEvent } from './store.js';
import { buildMeshMeshPrompt } from './validate.js';
import { notifyFin } from './notify.js';
import * as mesh from './meshmesh.js';
import { verifyConfiguration } from './sfcheck.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Maps get_agent_status onto the PoC vocabulary. Observed live shape (2026-11-21):
 *   { status: "waiting", phase: "execution", isExecuting: false, waitingFor: "confirmation" | "" | ..., summary, recentMessages[] }
 * - isExecuting=true                      -> agent is working
 * - status=waiting + waitingFor non-empty -> blocked on a confirmation / plan approval / question / connection
 * - status=waiting + waitingFor empty     -> the agent's turn is complete (plan ready in plan mode, or build finished)
 * `summary` lags behind, so the outcome is read from the latest assistant message.
 */
export function lastAssistantMessage(json) {
  const msgs = Array.isArray(json?.recentMessages) ? json.recentMessages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'assistant' && typeof msgs[i].content === 'string') return msgs[i].content;
  }
  return '';
}

/** 'succeeded' | 'failed' from the explicit "RESULT:" line; null when the agent has not reported one. */
export function outcomeOf(message) {
  const m = String(message).match(/RESULT:\s*\**\s*(SUCCEEDED|FAILED)/i);
  return m ? m[1].toLowerCase() : null;
}

export function normaliseStatus({ json, text = '' }) {
  const j = json || {};
  const status = String(j.status ?? j.state ?? '').toLowerCase();
  const waitingFor = String(j.waitingFor ?? j.waiting_for ?? '').toLowerCase();
  const phase = String(j.phase ?? '').toLowerCase();
  const summary = lastAssistantMessage(j) || String(j.summary ?? '').trim() || text.slice(0, 600);

  if (/fail|error|cancel|abort/.test(status)) return { status: 'failed', summary };
  if (j.isExecuting === true || /running|working|executing/.test(status)) {
    return { status: /plan/.test(phase) ? 'planning' : 'building', summary };
  }
  if (/confirm/.test(waitingFor)) return { status: 'needs_confirmation', summary };
  if (/plan|approv/.test(waitingFor)) return { status: 'awaiting_approval', summary };
  if (/connection/.test(waitingFor)) return { status: 'needs_connection', summary };
  if (waitingFor) return { status: 'needs_input', summary };
  if (/waiting|idle|complete|done|finished|stopped/.test(status)) return { status: 'turn_complete', outcome: outcomeOf(summary), summary };
  return { status: 'building', summary };
}

async function setStatus(id, status, message, isTerminal = false) {
  const prev = getRequest(id);
  if (prev.status === status && prev.last_message === message) return prev;
  const req = updateRequest(id, { status, last_message: message }, message);
  await notifyFin(req, { status, message, isTerminal });
  return req;
}

export async function runRequest(id) {
  return config.meshmeshMode === 'live' ? runLive(id) : runMock(id);
}

async function runLive(id) {
  const req = getRequest(id);
  const deadline = Date.now() + config.maxRunMinutes * 60_000;
  try {
    const prompt = buildMeshMeshPrompt(req.input, id);
    const args = { name: `Fin PoC ${id}: ${req.input.field_label}`, prompt, mode: 'plan' };
    if (config.meshmeshConnectionId) args.connectionIds = [config.meshmeshConnectionId];
    const started = await mesh.callTool('start_agent', args);
    const agentId = started.json?.agentId ?? started.json?.id ?? (started.text.match(/[A-Za-z0-9_-]{12,}/) || [])[0];
    if (!agentId) throw new Error(`start_agent returned no agentId: ${started.text.slice(0, 300)}`);
    updateRequest(id, { agent_id: agentId }, `MeshMesh agent started: ${agentId}`);
    await setStatus(id, 'planning', 'MeshMesh is reviewing your org and preparing a plan.');

    let approved = false;
    let askedForVerdict = false;
    let lastSeen = '';
    while (Date.now() < deadline) {
      await sleep(config.pollIntervalMs);
      const st = await mesh.callTool('get_agent_status', { agentId });
      const n = normaliseStatus(st);
      const fingerprint = `${n.status}|${n.summary.slice(0, 120)}`;
      if (fingerprint !== lastSeen) logEvent('meshmesh_status', { request_id: id, agentId, ...n, raw: st.json ?? st.text.slice(0, 1500) });
      lastSeen = fingerprint;

      if (!approved && (n.status === 'awaiting_approval' || n.status === 'turn_complete' || n.status === 'needs_confirmation')) {
        // Plan mode turn finished = plan ready. The customer already confirmed the summary in Fin.
        // A plan that itself reports FAILED (e.g. duplicate field found during discovery) ends the run here.
        if (n.status === 'turn_complete' && n.outcome === 'failed') { await setStatus(id, 'failed', n.summary, true); return; }
        if (!config.autoApprovePlan) { await setStatus(id, 'awaiting_approval', 'Plan ready; waiting for manual approval in MeshMesh.'); continue; }
        const plan = await mesh.callTool('get_plan', { agentId }).catch(() => null);
        logEvent('meshmesh_plan', { request_id: id, agentId, plan: plan?.json ?? plan?.text?.slice(0, 3000) });
        await mesh.callTool('continue_agent', { agentId, message: 'Approved. Build the plan now and verify each item. End your final message with "RESULT: SUCCEEDED" or "RESULT: FAILED - <reason>".', mode: 'build' });
        approved = true;
        await setStatus(id, 'building', 'Plan approved. MeshMesh is now configuring Salesforce.');
        continue;
      }
      if (approved && n.status === 'needs_confirmation') {
        // Per-step approval (e.g. "deploy to org"). Within the scope the customer confirmed, so approve it.
        await mesh.callTool('continue_agent', { agentId, message: 'Confirmed. Proceed with this step; it is within the approved plan.' });
        await setStatus(id, 'building', 'MeshMesh is applying the changes to Salesforce.');
        continue;
      }
      if (n.status === 'needs_input' || n.status === 'needs_connection') {
        await setStatus(id, 'failed', `MeshMesh needs more information before it can continue: ${n.summary}`, true);
        return;
      }
      if (n.status === 'failed') { await setStatus(id, 'failed', n.summary || 'MeshMesh reported a failure.', true); return; }
      if (approved && n.status === 'turn_complete') {
        if (n.outcome === 'succeeded' && config.sfGuard && config.sfTargetOrg) {
          // Don't trust the agent's own report: verify independently in Salesforce.
          const check = await verifyConfiguration(req.input).catch((e) => ({ ok: false, problems: [`verification unavailable: ${e.message}`] }));
          logEvent('postverify', { request_id: id, ...check });
          if (!check.ok) { await setStatus(id, 'failed', `MeshMesh reported success, but the independent Salesforce check failed: ${check.problems.join('; ')}.`, true); return; }
          await setStatus(id, 'succeeded', `${n.summary}\n\nIndependently verified in Salesforce: ${check.details.label} (${check.details.name}, ${check.details.type}) exists and "${req.input.permission_set}" has Read/Edit.`, true);
          return;
        }
        if (n.outcome) { await setStatus(id, n.outcome, n.summary || 'Configuration completed.', true); return; }
        // Finished without a RESULT line: ask once for an explicit verdict rather than guessing.
        if (!askedForVerdict) {
          askedForVerdict = true;
          await mesh.callTool('continue_agent', { agentId, message: 'Please reply with exactly one line: "RESULT: SUCCEEDED" if all three items are verified, otherwise "RESULT: FAILED - <reason>". Do not make further changes.' });
          continue;
        }
        await setStatus(id, 'failed', `MeshMesh finished without a clear result. Last message: ${n.summary}`, true);
        return;
      }
      if (approved) await setStatus(id, 'building', 'MeshMesh is still configuring Salesforce.');
    }
    await setStatus(id, 'failed', `Timed out after ${config.maxRunMinutes} minutes without a final result.`, true);
  } catch (e) {
    logEvent('run_error', { request_id: id, error: e.message });
    const msg = e.message === 'MESHMESH_AUTH_REQUIRED' ? 'The bridge is not signed in to MeshMesh.' : `Could not complete the configuration: ${e.message}`;
    await setStatus(id, 'failed', msg, true);
  }
}

// Mock mode: same status sequence, no MeshMesh credits used, no Salesforce changes.
const MOCK_EXISTING_FIELDS = new Set(['PoC_Customer_Tier__c', 'Customer_Tier__c']);
async function runMock(id) {
  const req = getRequest(id);
  const step = Math.max(1500, Math.min(config.pollIntervalMs, 5000));
  updateRequest(id, { agent_id: `mock_${id}` }, 'Mock MeshMesh agent started');
  await setStatus(id, 'planning', 'MeshMesh is reviewing your org and preparing a plan.');
  await sleep(step);
  await setStatus(id, 'building', 'Plan approved. MeshMesh is now configuring Salesforce.');
  await sleep(step);
  if (MOCK_EXISTING_FIELDS.has(req.input.field_api_name)) {
    await setStatus(id, 'failed', `FAILED: duplicate field. ${req.input.field_api_name} already exists on Account; nothing was changed.`, true);
    return;
  }
  await setStatus(id, 'succeeded', `SUCCEEDED: ${req.input.field_label} (${req.input.field_api_name}) created on Account, added to the layout, and ${req.input.permission_set} has Read/Edit.`, true);
}
