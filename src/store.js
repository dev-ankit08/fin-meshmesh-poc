// Tiny JSON-file store: correlation record requestId <-> conversationId <-> agentId <-> callbackUrl,
// plus a status history that doubles as PoC test evidence.
import { mkdirSync, readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { config } from './config.js';

mkdirSync(config.dataDir, { recursive: true });
const FILE = path.join(config.dataDir, 'requests.json');
const LOG = path.join(config.dataDir, 'events.log');

let db = existsSync(FILE) ? JSON.parse(readFileSync(FILE, 'utf8')) : {};
const persist = () => writeFileSync(FILE, JSON.stringify(db, null, 2));

export function logEvent(type, data) {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...data });
  appendFileSync(LOG, line + '\n');
  console.log(line);
}

export function createRequest(input) {
  const id = `fmr_${randomUUID().slice(0, 8)}`;
  db[id] = {
    request_id: id,
    created_at: new Date().toISOString(),
    status: 'accepted',
    agent_id: null,
    input,
    history: [{ ts: new Date().toISOString(), status: 'accepted', message: 'Request received by bridge' }],
  };
  persist();
  return db[id];
}

export function updateRequest(id, patch, historyMessage) {
  const r = db[id];
  if (!r) return null;
  Object.assign(r, patch, { updated_at: new Date().toISOString() });
  if (historyMessage) r.history.push({ ts: new Date().toISOString(), status: r.status, message: historyMessage });
  persist();
  return r;
}

export const getRequest = (id) => db[id] || null;
export const listRequests = () => Object.values(db);
