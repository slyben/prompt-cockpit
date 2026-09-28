// Probe: does the Agent SDK accept thinkingDisplay 'updates' (Anthropic beta
// thinking-display-updates-2026-08-18: progress notes between tool calls come
// back as short thinking summaries) on claude-sonnet-5-5? The SDK's
// setMaxThinkingTokens type only lists summarized|omitted|highlights, so this
// checks the runtime, not the types.
//
// NOT run by `npm test`. Run by hand: `node tests/thinking-updates-display-probe.manual.mjs`
// Costs a few cents: one tool-using turn on claude-sonnet-5-5.
import { fileURLToPath } from 'node:url';
import { startSession } from '../src/session.js';

const CWD = fileURLToPath(new URL('..', import.meta.url));
const MODEL = 'claude-sonnet-5-5';
const DISPLAY = process.argv[2] || 'updates';
const TIMEOUT_MS = 120_000;
const PROMPT = 'Read package.json, then read tests/README.md, then tell me the package name and the first heading of that README. Use the Read tool for both.';

function main() {
  return new Promise((resolve, reject) => {
    const thinkingBlocks = [];
    let toolUses = 0;
    let handle;
    let settled = false;
    const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); handle?.close(); fn(v); } };
    const timer = setTimeout(() => finish(reject, new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);

    handle = startSession({
      cwd: CWD,
      model: MODEL,
      permissionMode: 'bypassPermissions',
      onMessage: async (message) => {
        if (message.type === 'system' && message.subtype === 'init' && !settled && !handle.__sent) {
          handle.__sent = true;
          try {
            await handle.query.setMaxThinkingTokens(null, DISPLAY);
            console.log(`setMaxThinkingTokens(null, '${DISPLAY}') resolved`);
          } catch (err) {
            console.log(`setMaxThinkingTokens(null, '${DISPLAY}') REJECTED:`, err?.message ?? err);
          }
          handle.pushInput(PROMPT);
        }
        if (message.type === 'assistant') {
          for (const b of message.message.content) {
            if (b.type === 'thinking') thinkingBlocks.push((b.thinking ?? '').slice(0, 160));
            if (b.type === 'tool_use') toolUses++;
          }
        }
        if (message.type === 'result' && message.num_turns > 0) {
          console.log(JSON.stringify({
            display: DISPLAY, is_error: !!message.is_error, subtype: message.subtype,
            errors: message.errors, toolUses, thinkingBlocks,
            result: typeof message.result === 'string' ? message.result.slice(0, 200) : undefined,
          }, null, 2));
          finish(resolve);
        }
      },
      onStateChange: () => {},
      onError: (err) => { console.log('onError:', err?.message ?? err); finish(reject, err); },
    });
  });
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
});
