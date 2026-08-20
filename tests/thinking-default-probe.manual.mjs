// Throwaway-turned-permanent probe for an open question in
// .claude/memory/sdk-streaming-input-gotchas.md item 3: when maxThinkingTokens
// and effort are left unset (session.js's defaults), does the Agent SDK
// actually omit the `thinking`/`effort` params to the Messages API (meaning
// Claude Opus 5 / Sonnet 5 would run ADAPTIVE THINKING ON by default, per
// Anthropic's own Messages-API docs), or does it send something else that
// forces thinking off regardless of model? The in-repo comment on
// setMaxThinkingTokens claims "off unless started with it on" but that was
// never actually checked against a live session - this is that check.
//
// NOT run by `npm test`. Run by hand: `node tests/thinking-default-probe.manual.mjs`
// Costs a few cents (uses claude-opus-5, not Haiku, since Haiku doesn't
// support adaptive thinking at all and would prove nothing either way).
import { fileURLToPath } from 'node:url';
import { startSession } from '../src/session.js';

// fileURLToPath, not .pathname - on Windows, new URL('..', import.meta.url)
// .pathname yields "/D:/Dev/AI/prompt-cockpit/" (leading slash before the
// drive letter), which Node's child_process.spawn cannot use as `cwd` -
// it throws ENOENT, which the Agent SDK then misreports as a Claude Code
// native-binary/libc mismatch. Confirmed live 2026-08-20; the same bug is
// in tests/integration.manual.mjs's identical CWD line - untested on
// Windows before now, only ever run on Mac/Linux where .pathname is fine.
const CWD = fileURLToPath(new URL('..', import.meta.url));
const MODEL = 'claude-opus-5';
const TIMEOUT_MS = 90_000;

// A question with a real multi-step answer, not a one-word fact - if
// adaptive thinking is genuinely on, this is the kind of prompt likely to
// trigger it. If nothing gets classified as thinking even here, that's a
// meaningful (though not airtight - adaptive thinking is the model's own
// judgment call, not guaranteed per-prompt) signal that it's off by default.
const PROMPT = 'A farmer has 17 sheep. All but 9 die. Then he buys 3 times ' +
  'as many new sheep as he has left. How many sheep does he have now? ' +
  'Show your reasoning, then give the final number on its own line.';

function main() {
  return new Promise((resolve, reject) => {
    let sawThinkingBlock = false;
    let thinkingText = '';
    let replyText = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; reject(new Error(`timed out after ${TIMEOUT_MS}ms`)); }
    }, TIMEOUT_MS);

    const handle = startSession({
      cwd: CWD,
      model: MODEL,
      // Deliberately omitted: effort, no call to setMaxThinkingTokens.
      // This is the exact "unset" state session.js documents as leaving
      // "the SDK/model default in place" - that's the thing being probed.
      onMessage: (message) => {
        if (message.type === 'system' && message.subtype === 'init') {
          console.log('--- system/init arrived ---');
          console.log(JSON.stringify(message, null, 2));
          handle.pushInput(PROMPT);
        }
        if (message.type === 'assistant') {
          for (const block of message.message.content) {
            if (block.type === 'thinking') {
              sawThinkingBlock = true;
              thinkingText += block.thinking ?? '';
            }
            if (block.type === 'text') replyText += block.text;
          }
        }
        if (message.type === 'result' && message.num_turns > 0) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          handle.close();
          console.log('\n--- reply ---');
          console.log(replyText.trim());
          console.log('\n--- verdict ---');
          if (sawThinkingBlock) {
            console.log('Adaptive thinking block WAS present with no explicit config.');
            console.log(`thinking text (may be empty if display defaults to "omitted"): ${JSON.stringify(thinkingText.slice(0, 200))}`);
            console.log('=> maxThinkingTokens/effort left unset does NOT force thinking off on claude-opus-5.');
            console.log('   Update the memory note and the dropdown default-marker plan accordingly.');
          } else {
            console.log('No thinking block observed for this turn.');
            console.log('=> Consistent with (but does not prove) "unset behaves as off" - adaptive');
            console.log('   thinking is the model\'s own judgment call per-prompt, so a single negative');
            console.log('   result here is suggestive, not conclusive. Re-run with a harder prompt or');
            console.log('   multiple prompts before trusting this as a confirmed negative.');
          }
          resolve();
        }
      },
      onStateChange: () => {},
      onError: (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } },
    });
  });
}

main().catch((err) => {
  console.error('\nFAILED:', err);
  process.exitCode = 1;
});
