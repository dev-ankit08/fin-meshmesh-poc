// Orchestrates one generic setup request (v2):
//
//   PLAN   start_agent(mode: plan) -> poll -> parse CHANGESET -> policy -> org pre-check
//          -> push to Fin (plan webhook): plan_ready | needs_input | rejected | failed
//   (customer approves the exact plan in Fin -> POST /requests/:id/decision)
//   BUILD  snapshot -> continue_agent(mode: build, "build exactly this list") -> poll
//          -> verify every item + detect unapproved changes -> push final: succeeded | failed | needs_review
//
// Without a plan_callback_url (legacy connector), the bridge approves the plan itself after policy and
// pre-check pass, because the customer already confirmed Fin's summary (the original PoC behaviour).
import { config } from './config.js';
import { updateRequest, getRequest, logEvent } from './store.js';
import { notifyFin } from './notify.js';
import * as mesh from './meshmesh.js';
import { parseChangeset, planVersion, formatChanges, stripChangeset } from './changeset.js';
import { loadPolicy, evaluatePolicy, describeBlocked } from './policy.js';
import { buildPlanPrompt, buildApprovalMessage, buildRevisionMessage, CHANGESET_REMINDER } from './prompt.js';
import { liveGuard, mockGuard } from './guard.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Test seams: replace the MeshMesh client / Salesforce guard with stubs (test/live-flow.test.js).
let meshApi = mesh;
let guardOverride;
export const __test = { setMesh: (m) => { meshApi = m; }, setGuard: (g) => { guardOverride = g; } };

/**
 * Maps get_agent_status onto the bridge vocabulary. Observed live shape (2026-11-21):
 *   { status: "waiting", phase: "execution", isExecuting: false, waitingFor: "confirmation" | "" | ..., summary, recentMessages[] }
 * `summary` lags behind, so the outcome is read from the latest assistant message.
 */
export function lastAssistantMessage(json) {
  const msgs = Array.isArray(json?.recentMessages) ? json.recentMessages : [];
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].type === 'assistant' && typeof msgs[i].content === 'string') return msgs[i].content;
  }
  return '';
}

/** 'succeeded' | 'failed' | 'needs_input' from the explicit "RESULT:" line; null when there is none. */
export function outcomeOf(message) {
  const m = String(message).match(/RESULT:\s*\**\s*(SUCCEEDED|FAILED|NEEDS_INPUT)/i);
  return m ? m[1].toLowerCase() : null;
}

/** Customer-safe text from a MeshMesh message: no CHANGESET block, no "RESULT:" line. */
export function cleanMessage(message) {
  return stripChangeset(String(message))
    .replace(/BEGIN_CHANGESET[\s\S]*?END_CHANGESET/g, '')
    .replace(/^\s*\**RESULT:.*$/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

async function setStatus(id, status, message, { isTerminal = false, channel, extra, patch = {} } = {}) {
  const prev = getRequest(id);
  if (prev.status === status && prev.last_message === message && !channel) return prev;
  const req = updateRequest(id, { ...patch, status, last_message: message }, message);
  await notifyFin(req, { status, message, isTerminal, channel, extra });
  return req;
}

const guard = () => guardOverride !== undefined ? guardOverride : (config.meshmeshMode === 'live' ? (config.sfGuard ? liveGuard : null) : mockGuard);
const orgOf = (req) => req.input.sf_target_org || config.sfTargetOrg;
const approvalMode = (req) => (req.input.plan_callback_url ? 'customer' : 'auto');

/**
 * Polls until the agent's current turn ends. `prevMessage` is the last assistant message before the turn
 * started, so a stale "turn complete" from the previous turn is not mistaken for this one.
 * Calls onConfirm() for per-step confirmations. Returns the normalised status of the finished turn.
 */
async function waitForTurn(id, agentId, { deadline, prevMessage = '', onConfirm }) {
  let lastSeen = '';
  let sawWork = false;
  let stalePolls = 0;
  while (Date.now() < deadline) {
    await sleep(config.pollIntervalMs);
    const st = await meshApi.callTool('get_agent_status', { agentId });
    const n = normaliseStatus(st);
    const fp = `${n.status}|${n.summary.slice(0, 120)}`;
    if (fp !== lastSeen) logEvent('meshmesh_status', { request_id: id, agentId, ...n, raw: st.json ?? st.text.slice(0, 1500) });
    lastSeen = fp;
    if (n.status === 'planning' || n.status === 'building') { sawWork = true; continue; }
    if (n.status === 'needs_confirmation' && onConfirm) { await onConfirm(n); sawWork = true; continue; }
    if (n.status === 'turn_complete' && !sawWork && prevMessage && n.summary === prevMessage && ++stalePolls < 4) continue;
    return n;
  }
  return { status: 'timeout', summary: '' };
}

async function readPlan(agentId, n) {
  let parsed = parseChangeset(n.summary);
  let planText = n.summary;
  if (!parsed.ok) {
    const plan = await meshApi.callTool('get_plan', { agentId }).catch(() => null);
    const t = plan ? (plan.text || JSON.stringify(plan.json)) : '';
    const p2 = parseChangeset(t);
    if (p2.ok) { parsed = p2; planText = n.summary || t; }
  }
  return { parsed, planText };
}

export const isTryAgain = (e) => /try again|not available|temporarily/i.test(String(e?.message || ''));

export async function retryableStart(fn, id, { delays = [10_000, 30_000, 60_000], sleep } = {}) {
  let lastErr;
  for (let i = 0; i <= delays.length; i++) {
    try { return await fn(); } catch (e) {
      lastErr = e;
      if (!isTryAgain(e) || i === delays.length) throw e;
      logEvent('start_agent_retry', { request_id: id, attempt: i + 1, error: e.message.slice(0, 200) });
      await (sleep ? sleep(delays[i]) : new Promise((r) => setTimeout(r, delays[i])));
    }
  }
  throw lastErr;
}

// ------------------------------------------------------------------ PLAN

export async function runPlan(id, { revision } = {}) {
  if (config.meshmeshMode !== 'live') return runMockPlan(id, { revision });
  const req = getRequest(id);
  const deadline = Date.now() + config.maxRunMinutes * 60_000;
  try {
    let agentId = req.agent_id;
    let prev = '';
    if (!revision) {
      const policy = loadPolicy();
      const args = { name: `Fin ${id}: ${req.input.title}`.slice(0, 100), prompt: buildPlanPrompt(req.input, id, policy), mode: 'plan' };
      const connId = req.input.connection_id || config.meshmeshConnectionId;
      if (connId) args.connectionIds = [connId];
      // "Sandbox not available - please try again" is MeshMesh saying nothing was started, so repeating is safe.
      const started = await retryableStart(() => meshApi.callTool('start_agent', args), id);
      agentId = started.json?.agentId ?? started.json?.id ?? (started.text.match(/[A-Za-z0-9_-]{12,}/) || [])[0];
      if (!agentId) throw new Error(`start_agent returned no agentId: ${started.text.slice(0, 300)}`);
      updateRequest(id, { agent_id: agentId }, `MeshMesh agent started: ${agentId}`);
      await setStatus(id, 'planning', "We're reviewing your Salesforce setup and preparing a plan.");
    } else {
      prev = req.last_plan_message || '';
      await meshApi.callTool('continue_agent', { agentId, message: buildRevisionMessage(revision), mode: 'plan' });
      updateRequest(id, { status: 'planning' }, 'Customer reply sent to MeshMesh; re-planning');
    }

    // No onConfirm here: in plan mode a confirmation request means the plan is ready (as in v1).
    const n = await waitForTurn(id, agentId, { deadline, prevMessage: prev });
    return await handlePlanTurn(id, agentId, n, deadline);
  } catch (e) {
    logEvent('run_error', { request_id: id, phase: 'plan', error: e.message });
    // The technical cause is in the run_error event above; the customer gets a vendor-free, honest summary.
    return planEnd(id, 'failed', `Reason: we ran into a technical problem while preparing your plan (reference ${id}). Nothing was changed in Salesforce.`);
  }
}

/** Reports a terminal plan-phase outcome on the right channel(s). */
async function planEnd(id, status, message, extra) {
  const req = getRequest(id);
  const terminal = status !== 'plan_ready' && status !== 'needs_input';
  if (approvalMode(req) === 'customer') return setStatus(id, status, message, { channel: 'plan', isTerminal: terminal, extra });
  // legacy/auto: there is no plan wait in Fin; terminal outcomes go to the final webhook
  return setStatus(id, status === 'needs_input' || status === 'rejected' ? 'failed' : status, message, { isTerminal: true, extra });
}

async function handlePlanTurn(id, agentId, n, deadline) {
  if (n.status === 'timeout') return planEnd(id, 'failed', `Reason: we did not finish preparing the plan within ${config.maxRunMinutes} minutes. Nothing was changed in Salesforce.`);
  if (n.status === 'failed') return planEnd(id, 'failed', n.summary || 'We could not prepare the plan. Nothing was changed.');
  if (n.status === 'needs_connection') return planEnd(id, 'failed', 'Reason: we have no usable connection to your Salesforce org. Nothing was changed.');
  updateRequest(id, { last_plan_message: n.summary });

  if (n.outcome === 'failed') {
    // MeshMesh declined in the plan turn (e.g. needs Apex/Flow): nothing was built, so this is a rejection, not an outage.
    const why = cleanMessage(n.summary) || 'We could not plan this request through chat.';
    return planEnd(id, 'rejected', `Reason: ${why}\n\nNothing was changed in Salesforce.`);
  }
  if (n.outcome === 'needs_input' || n.status === 'needs_input') {
    return setStatusNeedsInput(id, n.summary);
  }

  let { parsed, planText } = await readPlan(agentId, n);
  if (!parsed.ok) {
    // One reminder; MeshMesh sometimes forgets the block.
    await meshApi.callTool('continue_agent', { agentId, message: CHANGESET_REMINDER, mode: 'plan' });
    const n2 = await waitForTurn(id, agentId, { deadline, prevMessage: n.summary });
    parsed = parseChangeset(n2.summary);
    if (!parsed.ok) {
      logEvent('changeset_unreadable', { request_id: id, error: parsed.error });
      return planEnd(id, 'failed', 'Reason: the plan could not be checked automatically, so it was not run. Nothing was changed in Salesforce; a teammate can review the request.');
    }
  }
  return reviewPlan(id, parsed.changes, stripChangeset(planText));
}

async function setStatusNeedsInput(id, summary) {
  const req = getRequest(id);
  if (approvalMode(req) === 'auto') return planEnd(id, 'failed', `Reason: we need more information. ${summary}`);
  return setStatus(id, 'needs_input', summary, { channel: 'plan' });
}

/** Policy + org pre-check on a parsed CHANGESET, then ask the customer (or auto-approve in legacy mode). */
export async function reviewPlan(id, changes, planSummary) {
  const req = getRequest(id);
  const policy = loadPolicy();
  const g = guard();
  let pre = { ok: true, conflicts: [], notes: [], existing: new Set() };
  if (g && config.sfPrecheck) {
    try { pre = await g.precheck(changes, orgOf(req)); }
    catch (e) {
      logEvent('precheck_error', { request_id: id, error: e.message });
      return planEnd(id, 'rejected', 'Reason: the Salesforce safety check is unavailable, so the plan was not run. Nothing was changed in Salesforce.');
    }
  }
  const pol = evaluatePolicy(changes, policy, pre.existing);
  logEvent('plan_review', { request_id: id, changes, policy: pol, precheck: { ...pre, existing: [...pre.existing] } });
  const version = planVersion(changes);
  const changesText = formatChanges(changes);
  updateRequest(id, { changes, plan_version: version, plan_summary: planSummary.slice(0, 3000) });

  if (!pre.ok) {
    return planEnd(id, 'rejected', `Reason: ${pre.conflicts.join('; ')}, so nothing was changed. Please choose a different name, or ask to update the existing component instead.`, { changes: changesText });
  }
  if (!pol.ok) {
    return planEnd(id, 'rejected', `Reason: part of this request can't be done through chat (${describeBlocked(pol.blocked)}). Nothing was changed in Salesforce. A teammate or your Salesforce admin can help with that part.`, { changes: changesText });
  }
  const warnings = [...pol.warnings, ...pre.notes].join(' ');
  if (!g) logEvent('guard_disabled', { request_id: id });

  if (approvalMode(req) === 'auto') {
    return runBuild(id, version);
  }
  const expires = new Date(Date.now() + config.planTtlMinutes * 60_000).toISOString();
  return setStatus(id, 'plan_ready', `${planSummary.slice(0, 700)}`.trim() || "We've prepared a plan.", {
    channel: 'plan', extra: { changes: changesText, warnings }, patch: { plan_expires_at: expires },
  });
}

// ------------------------------------------------------------------ BUILD

export async function runBuild(id, approvedVersion) {
  if (config.meshmeshMode !== 'live') return runMockBuild(id, approvedVersion);
  const req = getRequest(id);
  const deadline = Date.now() + config.maxRunMinutes * 60_000;
  try {
    const policy = loadPolicy();
    const g = guard();
    let before = null;
    if (g) {
      before = await g.snapshot(req.changes, policy.watch_types || [], orgOf(req));
      logEvent('snapshot', { request_id: id, types: before.types, counts: Object.fromEntries(Object.entries(before.snap).map(([k, v]) => [k, Object.keys(v).length])) });
    }
    updateRequest(id, { approved_version: approvedVersion, approved_at: new Date().toISOString() });
    await meshApi.callTool('continue_agent', { agentId: req.agent_id, message: buildApprovalMessage(approvedVersion, formatChanges(req.changes)), mode: 'build' });
    await setStatus(id, 'building', "Plan approved. We're applying your changes now.");

    let asked = false;
    let prev = req.last_plan_message || '';
    for (;;) {
      const n = await waitForTurn(id, req.agent_id, {
        deadline, prevMessage: prev,
        onConfirm: async () => {
          await meshApi.callTool('continue_agent', { agentId: req.agent_id, message: 'Confirmed. Proceed with this step only if it is within the approved component list.' });
          await setStatus(id, 'building', "We're applying the changes to Salesforce.");
        },
      });
      if (n.status === 'timeout') return final(id, 'failed', `Reason: we did not get a final result after ${config.maxRunMinutes} minutes. Some changes may have been made; a teammate will check the org.`);
      if (n.status === 'failed' || n.status === 'needs_input' || n.status === 'needs_connection') {
        return final(id, 'failed', n.summary || 'The process stopped before finishing.');
      }
      if (n.outcome === 'failed') return final(id, 'failed', n.summary);
      if (n.outcome === 'succeeded') {
        if (!g) return final(id, 'succeeded', `${n.summary}\n\n(Independent Salesforce check is disabled.)`);
        const check = await g.verify(req.changes, before, orgOf(req)).catch((e) => ({ ok: false, problems: [`verification unavailable: ${e.message}`], unexpected: [], verified: [] }));
        logEvent('postverify', { request_id: id, ...check });
        if (check.problems.length) return final(id, 'failed', `Reason: the setup was reported as complete, but our independent Salesforce check found: ${check.problems.join('; ')}.`);
        if (check.unexpected.length) return final(id, 'needs_review', `The requested changes were made, but the independent check also found changes that were not in the approved plan: ${check.unexpected.slice(0, 10).join('; ')}. A teammate will review them.`);
        return final(id, 'succeeded', `${n.summary}\n\nIndependently verified in Salesforce: ${check.verified.length} of ${req.changes.length} components (${check.verified.slice(0, 8).join('; ')}).`);
      }
      if (!asked) {
        asked = true; prev = n.summary;
        await meshApi.callTool('continue_agent', { agentId: req.agent_id, message: 'Please reply with exactly one line: "RESULT: SUCCEEDED" if every approved component is built and verified, otherwise "RESULT: FAILED - <reason>". Do not make further changes.' });
        continue;
      }
      return final(id, 'failed', `The process finished without a clear result. Last message: ${n.summary}`);
    }
  } catch (e) {
    logEvent('run_error', { request_id: id, phase: 'build', error: e.message });
    // Technical cause stays in the run_error event; a build may have partly run, so do not claim nothing changed.
    return final(id, 'failed', `Reason: we ran into a technical problem while applying your changes (reference ${id}). Some changes may have been made; a teammate will check the org.`);
  }
}

const final = (id, status, message) => setStatus(id, status, message, { isTerminal: true, channel: 'final' });

// Kept for the original entry point / scripts.
export async function runRequest(id) { return runPlan(id); }

// ------------------------------------------------------------------ MOCK (no credits, no Salesforce changes)

/** Deterministic fake plan from keywords, so the whole Fin flow can be exercised offline. */
export function mockPlanFor(input) {
  const t = String(input.change_request || '').toLowerCase();
  if (/\?\?|not sure|unclear/.test(t)) return { needsInput: 'Which object should this be on, and which users need access?' };
  const changes = [];
  if (/delete|remove/.test(t)) changes.push({ action: 'delete', type: 'CustomField', name: 'Account.Old_Field__c', summary: 'delete' });
  if (/apex|trigger/.test(t)) changes.push({ action: 'create', type: 'ApexClass', name: 'FinHelper', summary: 'Apex class' });
  if (/external client app|connected app|oauth client/.test(t)) {
    changes.push(
      { action: 'create', type: 'ExternalClientApplication', name: 'Fin_Integration', label: 'Fin Integration', summary: 'External Client App' },
      { action: 'create', type: 'ExtlClntAppOauthSettings', name: 'Fin_Integration_oauth', summary: 'OAuth: client credentials flow, scope api' },
      { action: 'create', type: 'ExtlClntAppGlobalOauthSettings', name: 'Fin_Integration_glbloauth', summary: 'callback URL' });
  }
  if (/outbound|callout|named credential|https request/.test(t)) {
    changes.push(
      { action: 'create', type: 'ExternalCredential', name: 'Partner_API', label: 'Partner API', summary: 'Custom auth, one named principal' },
      { action: 'create', type: 'NamedCredential', name: 'Partner_API', label: 'Partner API', summary: 'https://api.example.com' },
      { action: 'modify', type: 'PermissionSet', name: 'Fin_PoC_Access', summary: 'access to the Partner API principal' });
  }
  if (/validation rule/.test(t)) changes.push({ action: 'create', type: 'ValidationRule', name: 'Account.Require_Industry', summary: 'Industry required when Type = Customer' });
  if (/assign/.test(t)) changes.push({ action: 'assign', type: 'PermissionSetAssignment', name: `Fin_PoC_Access:${input.requestor_email}`, summary: 'assign permission set' });
  const label = (String(input.change_request).match(/(?:field|called|named)\s+"?([A-Z][\w ]{2,38}?)"?(?:\s+(?:on|to|of|with)|[.,]|$)/) || [])[1];
  if (label || !changes.length) {
    const lbl = label || input.field_label || 'Fin Mock Field';
    changes.push(
      { action: 'create', type: 'CustomField', name: `Account.${lbl.replace(/[^A-Za-z0-9]+/g, '_')}__c`, label: lbl, summary: 'Text(100)' },
      { action: 'modify', type: 'Layout', name: 'Account-Account Layout', summary: 'add the field' },
      { action: 'modify', type: 'PermissionSet', name: 'Fin_PoC_Access', summary: 'Read/Edit on the field' });
  }
  return { changes, summary: `Mock plan for: ${input.change_request.slice(0, 200)}` };
}

async function runMockPlan(id, { revision } = {}) {
  const req = getRequest(id);
  const step = Math.max(300, Math.min(config.pollIntervalMs, 5000));
  if (!revision) updateRequest(id, { agent_id: `mock_${id}` }, 'Mock MeshMesh agent started');
  await setStatus(id, 'planning', "We're reviewing your Salesforce setup and preparing a plan.");
  await sleep(step);
  // A revision answers the open question, so the "unclear" marker no longer applies.
  const input = revision ? { ...req.input, change_request: `${req.input.change_request.replace(/\?\?|not sure|unclear/gi, '')} ${revision}` } : req.input;
  const p = mockPlanFor(input);
  if (p.needsInput) return setStatusNeedsInput(id, `RESULT: NEEDS_INPUT - ${p.needsInput}`);
  return reviewPlan(id, p.changes, p.summary);
}

async function runMockBuild(id, version) {
  const req = getRequest(id);
  const step = Math.max(300, Math.min(config.pollIntervalMs, 5000));
  updateRequest(id, { approved_version: version, approved_at: new Date().toISOString() });
  await setStatus(id, 'building', "Plan approved. We're applying your changes now.");
  await sleep(step);
  const check = await mockGuard.verify(req.changes);
  return final(id, 'succeeded', `Mock build complete.\n\nIndependently verified in Salesforce: ${check.verified.length} of ${req.changes.length} components (${check.verified.slice(0, 8).join('; ')}).`);
}
