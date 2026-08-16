// Live check against `grok agent stdio`. Not run by `npm test`.
// Run by hand: `node tests/grok-live.manual.mjs`
import assert from 'node:assert/strict';
import { startGrokSession } from '../src/grok-session.js';

const CWD = process.cwd();
const TIMEOUT_MS = 90_000;

function withTimeout(fn) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    fn(
      (value) => { clearTimeout(timer); resolve(value); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

console.log('[1/2] handshake: initialize + session/new emits system/init');
const handshake = await withTimeout((resolve, reject) => {
  const handle = startGrokSession({
    cwd: CWD,
    model: 'grok-4.5',
    onMessage: (message) => {
      if (message.type === 'system' && message.subtype === 'init') {
        resolve({ sessionId: message.session_id, cwd: message.cwd });
        handle.close();
      }
    },
    onStateChange: () => {},
    onError: reject,
    onApprovalRequest: () => {},
  });
});
assert.ok(handshake.sessionId, 'expected a grok session id from session/new');
assert.equal(handshake.cwd, CWD);
console.log('  session', handshake.sessionId);

console.log('[2/2] one turn: reply text comes back as an assistant message');
const turn = await withTimeout((resolve, reject) => {
  let sawInit = false;
  let reply = '';
  const handle = startGrokSession({
    cwd: CWD,
    model: 'grok-4.5',
    onMessage: (message) => {
      if (message.type === 'system' && message.subtype === 'init') {
        sawInit = true;
        handle.pushInput('Reply with exactly the word pong and nothing else.');
        return;
      }
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text') reply += block.text;
        }
      }
      if (message.type === 'result') {
        handle.close();
        resolve({ sawInit, reply, stop: message.stop_reason });
      }
    },
    onStateChange: () => {},
    onError: reject,
    onApprovalRequest: (req) => {
      handle.resolveApproval(req.requestId, { behavior: 'allow' });
    },
  });
});
assert.equal(turn.sawInit, true);
assert.match(turn.reply.toLowerCase(), /pong/);
console.log('  reply:', turn.reply.trim());
console.log('\nALL CHECKS PASSED');
