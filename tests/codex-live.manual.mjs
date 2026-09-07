// Live check against `codex app-server`. Not run by `npm test` because it
// uses the signed-in account and consumes model quota.
//
// Run the read-only/default checks with:
//   node tests/codex-live.manual.mjs
//
// Optional checks:
//   CODEX_LIVE_APPROVAL=1 node tests/codex-live.manual.mjs
//   CODEX_LIVE_REWIND=1 node tests/codex-live.manual.mjs
//
// The approval probe asks Codex to run a harmless node command. The rewind
// probe creates a conversation-only fork and never changes files.
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { createCodexAppServerManager } from '../src/codex-app-server.js';
import { startCodexSession } from '../src/codex-session.js';

const CWD = process.env.CODEX_TEST_CWD || fileURLToPath(new URL('..', import.meta.url));
const MODEL = process.env.CODEX_TEST_MODEL || undefined;
const TIMEOUT_MS = 90_000;

function openSession({ onMessage, onApprovalRequest } = {}) {
  const manager = createCodexAppServerManager();
  let handle = null;
  let timer = null;
  let settled = false;
  let settle;
  const done = new Promise((resolve, reject) => {
    settle = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };
    timer = setTimeout(() => settle(reject, new Error(`timed out after ${TIMEOUT_MS}ms`)), TIMEOUT_MS);
    try {
      handle = startCodexSession({
        cwd: CWD,
        model: MODEL,
        permissionMode: 'default',
        manager,
        onMessage: (message) => {
          try {
            onMessage?.(message, {
              handle,
              resolve: (value) => settle(resolve, value),
              reject: (error) => settle(reject, error),
            });
          } catch (error) {
            settle(reject, error);
          }
        },
        onStateChange: () => {},
        onError: (error) => settle(reject, error),
        onApprovalRequest,
        onApprovalResolved: () => {},
      });
    } catch (error) {
      settle(reject, error);
    }
  });
  return {
    manager,
    handle,
    done,
    close() {
      try { handle?.close(); } finally { manager.close(); }
    },
  };
}

async function singleTurnCheck() {
  let sawInit = false;
  let sawResult = false;
  let reply = '';
  let usage = null;
  const session = openSession({
    onMessage(message, control) {
      if (message.type === 'system' && message.subtype === 'init') {
        sawInit = true;
        control.handle.pushInput('Reply with exactly the word pong and nothing else.');
      }
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text') reply += block.text;
        }
      }
      if (message.type === 'assistant' && message.message?.usage) usage = message.message.usage;
      if (message.type === 'result') {
        if (message.is_error) return control.reject(new Error(`live turn failed: ${message.error || message.stop_reason}`));
        sawResult = true;
      }
      // Some app-server builds deliver token usage immediately after the
      // turn result, so require both before resolving the check.
      if (sawResult && usage) control.resolve({ reply, usage });
    },
  });
  try {
    const result = await session.done;
    assert.equal(sawInit, true, 'system/init never arrived');
    assert.equal(result.reply.trim(), 'pong', `unexpected reply: ${JSON.stringify(result.reply)}`);
    assert.ok(result.usage.input_tokens > 0, `expected input tokens, got ${result.usage.input_tokens}`);
    assert.ok(result.usage.output_tokens > 0, `expected output tokens, got ${result.usage.output_tokens}`);

    // Exercise the read-only native extension calls used by Settings and the
    // slash picker, against the same live app-server connection.
    const [mcpServers, plugins, commands, rateLimits] = await Promise.all([
      session.handle.query.mcpServerStatus(),
      session.handle.query.reloadPlugins(),
      session.handle.query.supportedCommands(),
      session.handle.query.codexRateLimits(),
    ]);
    assert.ok(Array.isArray(mcpServers), 'MCP status was not an array');
    assert.ok(Array.isArray(plugins.plugins), 'plugin list was not an array');
    assert.ok(Array.isArray(commands), 'skill command list was not an array');
    assert.ok(rateLimits === null || typeof rateLimits === 'object', 'rate limits were not normalized');
    return { ...result, mcpCount: mcpServers.length, pluginCount: plugins.plugins.length, rateLimits };
  } finally {
    session.close();
  }
}

async function queueOrderCheck() {
  let sawInit = false;
  let currentReply = '';
  let resultsSeen = 0;
  const replies = [];
  const session = openSession({
    onMessage(message, control) {
      if (message.type === 'system' && message.subtype === 'init' && !sawInit) {
        sawInit = true;
        control.handle.pushInput('Reply with exactly the word one and nothing else.');
        control.handle.pushInput('Reply with exactly the word two and nothing else.');
      }
      if (message.type === 'assistant' && Array.isArray(message.message?.content)) {
        for (const block of message.message.content) {
          if (block.type === 'text') currentReply += block.text;
        }
      }
      if (message.type !== 'result') return;
      if (message.is_error) return control.reject(new Error(`queued turn failed: ${message.error || message.stop_reason}`));
      replies.push(currentReply.trim());
      currentReply = '';
      resultsSeen += 1;
      if (resultsSeen === 2) control.resolve(replies);
    },
  });
  try {
    const ordered = await session.done;
    assert.equal(sawInit, true, 'system/init never arrived');
    assert.deepEqual(ordered, ['one', 'two'], `queued replies were not ordered: ${JSON.stringify(ordered)}`);
    if (process.env.CODEX_LIVE_REWIND === '1') {
      const rewind = await session.handle.rewindConversation(1);
      assert.ok(rewind.forkedSessionId, 'rewind did not return a forked thread id');
      console.log('  rewind fork:', rewind.forkedSessionId);
    }
    return ordered;
  } finally {
    session.close();
  }
}

async function approvalCheck() {
  let sawInit = false;
  let sawApproval = false;
  let sawResult = false;
  const session = openSession({
    onApprovalRequest: (request) => {
      sawApproval = true;
      const resolved = session.handle.resolveApproval(request.requestId, { behavior: 'allow' });
      if (!resolved) throw new Error(`could not resolve live approval ${request.requestId}`);
    },
    onMessage(message, control) {
      if (message.type === 'system' && message.subtype === 'init' && !sawInit) {
        sawInit = true;
        control.handle.pushInput(
          "Use command execution to run exactly `node -e \"console.log('cockpit-codex-approval-check')\"`, then reply with exactly approval-passed.",
        );
      }
      if (message.type === 'result') {
        if (message.is_error) return control.reject(new Error(`approval turn failed: ${message.error || message.stop_reason}`));
        sawResult = true;
        control.resolve();
      }
    },
  });
  try {
    await session.done;
    assert.equal(sawInit, true, 'system/init never arrived');
    assert.equal(sawApproval, true, 'Codex did not issue the expected command approval');
    assert.equal(sawResult, true, 'approval turn did not complete');
  } finally {
    session.close();
  }
}

async function main() {
  console.log('[1/2] handshake, one turn, usage, MCP/plugin/skill reads');
  const single = await singleTurnCheck();
  console.log(`  reply: ${single.reply.trim()}`);
  console.log(`  usage: ${single.usage.input_tokens} in / ${single.usage.output_tokens} out`);
  console.log(`  extensions: ${single.mcpCount} MCP / ${single.pluginCount} plugins`);
  if (single.rateLimits?.five_hour) {
    console.log(`  plan: ${single.rateLimits.five_hour.utilization}% used in the primary window`);
  }

  console.log('[2/2] queue-while-running: two prompts finish in order');
  await queueOrderCheck();

  if (process.env.CODEX_LIVE_APPROVAL === '1') {
    console.log('[optional] command approval round-trip');
    await approvalCheck();
  }

  console.log('\nALL CHECKS PASSED');
}

main().catch((error) => {
  console.error('\nFAILED:', error);
  process.exitCode = 1;
});
