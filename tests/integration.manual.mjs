// Real end-to-end check against the actual Claude Agent SDK - spawns a
// live Haiku session, so it costs a few cents and takes a few seconds.
// NOT run by `npm test`. Run by hand: `node tests/integration.manual.mjs`.
//
// Covers the MVP1 verification items that a stubbed unit test can't:
//   - system/init actually arrives in streaming-input mode (see the
//     priming-sentinel comment in src/session.js - this is the regression
//     test for that fix)
//   - a real reply comes back for real input
//   - a second message sent while the first turn is still running queues
//     and is processed in order, rather than being dropped or interleaving
import assert from 'node:assert/strict';
import { startSession } from '../src/session.js';

const CWD = new URL('..', import.meta.url).pathname;
const MODEL = 'claude-haiku-4-5-20251001';
const TIMEOUT_MS = 60_000;

async function main() {
  console.log('[1/2] single turn: init arrives, real input gets a real reply');
  await runSingleTurnCheck();

  console.log('[2/2] queue-while-running: second message sent mid-turn is processed after the first');
  await runQueueOrderCheck();

  console.log('\nALL CHECKS PASSED');
}

function runSingleTurnCheck() {
  return withTimeout(async (resolve, reject) => {
    let sawInit = false;
    let replyText = '';

    const handle = startSession({
      cwd: CWD,
      model: MODEL,
      onMessage: (message) => {
        if (message.type === 'system' && message.subtype === 'init') {
          sawInit = true;
          handle.pushInput('reply with exactly the word: pong');
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') replyText += block.text;
          }
        }
        if (message.type === 'result' && message.num_turns > 0) {
          try {
            assert.equal(sawInit, true, 'system/init never arrived');
            assert.equal(replyText.trim(), 'pong', `unexpected reply: ${JSON.stringify(replyText)}`);
            handle.close();
            resolve();
          } catch (err) {
            reject(err);
          }
        }
      },
      onStateChange: () => {},
      onError: reject,
    });
  });
}

function runQueueOrderCheck() {
  return withTimeout(async (resolve, reject) => {
    let stage = 'waiting-for-init';
    const replies = [];
    let turnsSeen = 0;

    const handle = startSession({
      cwd: CWD,
      model: MODEL,
      onMessage: (message) => {
        if (message.type === 'system' && message.subtype === 'init' && stage === 'waiting-for-init') {
          stage = 'sent-both';
          // Both sent back-to-back, before either turn can complete - this
          // is the compose box's "type a follow-up while it's still
          // thinking" case from the plan's Verification section.
          handle.pushInput('reply with exactly the word: one');
          handle.pushInput('reply with exactly the word: two');
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'text') replies.push(block.text.trim());
          }
        }
        if (message.type === 'result' && message.num_turns > 0) {
          turnsSeen += 1;
          if (turnsSeen === 2) {
            try {
              assert.deepEqual(replies, ['one', 'two'], `replies arrived out of order or incomplete: ${JSON.stringify(replies)}`);
              handle.close();
              resolve();
            } catch (err) {
              reject(err);
            }
          }
        }
      },
      onStateChange: () => {},
      onError: reject,
    });
  });
}

function withTimeout(runner) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    const settle = (fn) => (...args) => {
      clearTimeout(timer);
      fn(...args);
    };
    runner(settle(resolve), settle(reject));
  });
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
});
