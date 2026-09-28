// Probe: what does the cockpit's "Off" (setMaxThinkingTokens(0), which the SDK
// maps to thinking:{type:'disabled'}) do on claude-sonnet-5-5? Anthropic's
// docs say disabled returns a 400 there and between_tools is the replacement.
//
// NOT run by `npm test`. Run by hand: `node tests/thinking-off-sonnet55-probe.manual.mjs`
// Costs a few cents: two short turns on claude-sonnet-5-5.
import { fileURLToPath } from 'node:url';
import { startSession } from '../src/session.js';

const CWD = fileURLToPath(new URL('..', import.meta.url));
const MODEL = 'claude-sonnet-5-5';
const TIMEOUT_MS = 120_000;
// Optional effort as argv[2] (low|medium|high|xhigh|max), e.g. `... xhigh`.
const EFFORT = process.argv[2] || null;
const PROMPT = 'A farmer has 17 sheep. All but 9 die. Then he buys 3 times ' +
  'as many new sheep as he has left. How many sheep does he have now? ' +
  'Show your reasoning, then give the final number on its own line.';

function main() {
  return new Promise((resolve, reject) => {
    const turns = [];
    let cur = { thinking: false, reply: '' };
    let handle;
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); handle?.close(); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

    handle = startSession({
      cwd: CWD,
      model: MODEL,
      ...(EFFORT ? { effort: EFFORT } : {}),
      onMessage: async (message) => {
        if (message.type === 'system' && message.subtype === 'init') {
          console.log('--- init model:', message.model);
          handle.pushInput(PROMPT);
        }
        if (message.type === 'assistant') {
          for (const b of message.message.content) {
            if (b.type === 'thinking') cur.thinking = true;
            if (b.type === 'text') cur.reply += b.text;
          }
        }
        if (message.type === 'result') {
          cur.is_error = !!message.is_error;
          cur.subtype = message.subtype;
          cur.errors = message.errors;
          cur.result = typeof message.result === 'string' ? message.result.slice(0, 300) : undefined;
          turns.push(cur);
          cur = { thinking: false, reply: '' };
          if (turns.length === 1) {
            console.log('turn 1 (default):', JSON.stringify(turns[0]));
            try {
              await handle.query.setMaxThinkingTokens(0);
              console.log('setMaxThinkingTokens(0) resolved');
            } catch (err) {
              console.log('setMaxThinkingTokens(0) REJECTED:', err?.message ?? err);
            }
            handle.pushInput(PROMPT);
          } else {
            console.log('turn 2 (after Off):', JSON.stringify(turns[1]));
            finish(resolve);
          }
        }
      },
      onStateChange: () => {},
      onError: (err) => {
        console.log('onError:', err?.message ?? err);
        finish(reject, err);
      },
    });
  });
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
});
