// Tests the after-conversation fallback: sends a final result into an Intercom conversation through the
// REST API, exactly as the bridge does when Fin's final webhook can no longer be delivered
// (wait expired / conversation closed).
// Usage:  node scripts/test-after-conversation.js <conversation_id> [succeeded|failed]
// Needs INTERCOM_ACCESS_TOKEN and INTERCOM_ADMIN_ID in .env. Find the conversation id in the
// Intercom Inbox URL (…/conversation/<id>) or in data/events.log (request_received.body.conversation_id).
import '../src/config.js';
import { notifyFin } from '../src/notify.js';

const [conversationId, status = 'succeeded'] = process.argv.slice(2);
if (!conversationId) { console.error('Usage: node scripts/test-after-conversation.js <conversation_id> [succeeded|failed]'); process.exit(1); }

const fakeReq = {
  request_id: 'fmr_fallback_test',
  agent_id: '',
  input: { conversation_id: conversationId, callback_url: '', final_callback_url: '' }, // no webhook -> forces the fallback
};
const message = status === 'failed'
  ? 'Test only: no change was made.\n\nRESULT: FAILED - fallback test'
  : 'Test only: this message checks that results can reach you after the chat has closed. No change was made.';
const r = await notifyFin(fakeReq, { status, message, isTerminal: true });
console.log(JSON.stringify(r));
console.log(r.intercom_note === 200 ? 'OK: reply posted to the conversation.' : 'Not posted: check the token, admin id and conversation id.');
