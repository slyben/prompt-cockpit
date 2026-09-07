import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  codexItemToMessages,
  codexNotificationToMessages,
  codexThreadToMessages,
} from '../src/codex-messages.js';

test('streamed Codex text and reasoning deltas use the shared transcript shape', () => {
  const text = codexNotificationToMessages(
    'item/agentMessage/delta',
    { delta: 'hello' },
    'thread-1',
    { model: 'codex-model' },
  );
  assert.equal(text[0].type, 'assistant');
  assert.equal(text[0].message.model, 'codex-model');
  assert.deepEqual(text[0].message.content, [{ type: 'text', text: 'hello' }]);

  const reasoning = codexNotificationToMessages(
    'item/reasoning/summaryTextDelta',
    { delta: 'thinking' },
    'thread-1',
  );
  assert.deepEqual(reasoning[0].message.content, [{ type: 'thinking', thinking: 'thinking' }]);

  // Their completed items contain the accumulated text again. Live sessions
  // must not append that after already rendering the deltas.
  assert.deepEqual(codexNotificationToMessages('item/completed', {
    item: { type: 'agentMessage', text: 'hello' },
  }, 'thread-1'), []);
  assert.deepEqual(codexNotificationToMessages('item/completed', {
    item: { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
  }, 'thread-1'), []);
});

test('completed command and file-change items become tool use/result pairs', () => {
  const command = codexItemToMessages({
    id: 'cmd-1', type: 'commandExecution', command: 'npm test', cwd: '/repo',
    aggregatedOutput: 'ok', exitCode: 0, status: 'completed',
  }, 'thread-1');
  assert.equal(command[0].message.content[0].name, 'Bash');
  assert.equal(command[1].message.content[0].tool_use_id, 'cmd-1');
  assert.equal(command[1].message.content[0].is_error, false);

  const file = codexItemToMessages({
    id: 'file-1', type: 'fileChange', changes: [{ path: 'a.js' }], status: 'declined',
  }, 'thread-1');
  assert.equal(file[0].message.content[0].name, 'Edit');
  assert.equal(file[1].message.content[0].is_error, true);
  assert.equal(file[1].message.content[0].content, 'File change declined');
});

test('Codex item phases use explicit started/result-only/both names', () => {
  const item = { id: 'cmd-phase', type: 'commandExecution', command: 'echo ok', status: 'completed' };
  assert.equal(codexItemToMessages(item, 'thread-1', { phase: 'result-only' }).length, 1);
  assert.equal(codexItemToMessages(item, 'thread-1', { phase: 'both' }).length, 2);
  assert.throws(() => codexItemToMessages(item, 'thread-1', { phase: 'completed' }), /invalid Codex item phase/);
});

test('turn completion and stored threads preserve status and history', () => {
  const failed = codexNotificationToMessages('turn/completed', {
    turn: { id: 'turn-1', status: 'failed', error: { message: 'boom' } },
  }, 'thread-1');
  assert.equal(failed[0].subtype, 'error');
  assert.equal(failed[0].error, 'boom');

  const messages = codexThreadToMessages({
    id: 'thread-1', model: 'codex-model', turns: [{
      status: 'completed',
      items: [
        { type: 'userMessage', content: [{ type: 'text', text: 'question' }] },
        { type: 'agentMessage', text: 'answer' },
      ],
    }],
  });
  assert.deepEqual(messages.map(({ type }) => type), ['user', 'assistant']);
  assert.equal(messages[1].message.model, 'codex-model');
});

test('current Codex item shapes preserve reasoning, MCP objects, and collaboration calls', () => {
  const history = codexThreadToMessages({
    id: 'thread-1', turns: [{ status: 'completed', items: [
      { type: 'reasoning', summary: ['first thought', 'second thought'] },
    ] }],
  });
  assert.equal(history[0].message.content[0].thinking, 'first thought\nsecond thought');

  const mcp = codexItemToMessages({
    id: 'mcp-object', type: 'mcpToolCall', server: 'github', tool: 'search', arguments: {},
    status: 'completed', result: { content: [{ type: 'text', text: 'found it' }] },
  }, 'thread-1');
  assert.equal(mcp[1].message.content[0].content, 'found it');

  const failed = codexItemToMessages({
    id: 'mcp-error', type: 'mcpToolCall', server: 'github', tool: 'search', arguments: {},
    status: 'failed', error: { message: 'permission denied' },
  }, 'thread-1');
  assert.equal(failed[1].message.content[0].content, 'permission denied');

  const collab = codexItemToMessages({
    id: 'collab-1', type: 'collabAgentToolCall', tool: 'spawnAgent', prompt: 'inspect',
    receiverThreadIds: ['agent-1'], senderThreadId: 'thread-1', status: 'completed', agentsStates: {},
  }, 'thread-1');
  assert.equal(collab[0].message.content[0].name, 'spawnAgent');
  assert.equal(collab[1].message.content[0].tool_use_id, 'collab-1');
});

test('item started/completed events render one pending tool row and one result', () => {
  const startedItemIds = new Set();
  const started = codexNotificationToMessages('item/started', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'mcp-live', type: 'mcpToolCall', server: 'github', tool: 'search', arguments: {}, status: 'inProgress' },
  }, 'thread-1', { startedItemIds });
  assert.equal(started.length, 1);
  assert.equal(started[0].message.content[0].type, 'tool_use');

  const completed = codexNotificationToMessages('item/completed', {
    threadId: 'thread-1', turnId: 'turn-1',
    item: { id: 'mcp-live', type: 'mcpToolCall', server: 'github', tool: 'search', arguments: {}, status: 'completed', result: { content: [{ type: 'text', text: 'done' }] } },
  }, 'thread-1', { startedItemIds });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].message.content[0].type, 'tool_result');
  assert.equal(completed[0].message.content[0].tool_use_id, 'mcp-live');
});

test('item started/completed command events do not duplicate tool rows', () => {
  const startedItemIds = new Set();
  const started = codexNotificationToMessages('item/started', {
    item: { id: 'cmd-live', type: 'commandExecution', command: 'npm test', cwd: '/repo', status: 'inProgress' },
  }, 'thread-1', { startedItemIds });
  assert.equal(started.length, 1);
  assert.equal(started[0].message.content[0].name, 'Bash');

  const completed = codexNotificationToMessages('item/completed', {
    item: { id: 'cmd-live', type: 'commandExecution', command: 'npm test', cwd: '/repo', status: 'completed', aggregatedOutput: 'ok' },
  }, 'thread-1', { startedItemIds });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].message.content[0].type, 'tool_result');
  assert.equal(completed[0].message.content[0].tool_use_id, 'cmd-live');
});

test('previously-dropped item types (MCP calls, plans, web search, review mode, ...) render as generic tool calls', () => {
  const mcp = codexItemToMessages({
    id: 'mcp-1', type: 'mcpToolCall', server: 'github', tool: 'search_issues',
    arguments: { q: 'bug' }, status: 'completed', result: 'three issues found',
  }, 'thread-1');
  assert.equal(mcp[0].message.content[0].name, 'mcp__github__search_issues');
  assert.equal(mcp[0].message.content[0].input.q, 'bug');
  assert.equal(mcp[1].message.content[0].tool_use_id, 'mcp-1');
  assert.equal(mcp[1].message.content[0].is_error, false);

  const mcpFailed = codexItemToMessages({
    id: 'mcp-2', type: 'mcpToolCall', server: 'github', tool: 'search_issues',
    arguments: {}, status: 'failed', error: 'timeout',
  }, 'thread-1');
  assert.equal(mcpFailed[1].message.content[0].is_error, true);

  const dynamic = codexItemToMessages({
    id: 'dyn-1', type: 'dynamicToolCall', tool: 'custom_tool', arguments: { x: 1 },
    status: 'completed', success: true, contentItems: [{ text: 'done' }],
  }, 'thread-1');
  assert.equal(dynamic[0].message.content[0].name, 'custom_tool');
  assert.equal(dynamic[1].message.content[0].is_error, false);

  const search = codexItemToMessages({ id: 'ws-1', type: 'webSearch', query: 'weather' }, 'thread-1');
  assert.equal(search.length, 2, 'generic completed items should close their tool row');
  assert.equal(search[0].message.content[0].name, 'WebSearch');
  assert.equal(search[1].message.content[0].tool_use_id, 'ws-1');

  const image = codexItemToMessages({ id: 'img-1', type: 'imageView', path: '/tmp/x.png' }, 'thread-1');
  assert.equal(image[0].message.content[0].name, 'ViewImage');
  assert.equal(image[1].message.content[0].content, 'Viewed x.png');

  const plan = codexItemToMessages({ id: 'plan-1', type: 'plan', text: '1. do x\n2. do y' }, 'thread-1');
  assert.equal(plan[0].message.content[0].name, 'Plan');
  assert.equal(plan[0].message.content[0].input.text, '1. do x\n2. do y');

  const entered = codexItemToMessages({ id: 'rv-1', type: 'enteredReviewMode', review: { instructions: 'be strict' } }, 'thread-1');
  assert.equal(entered[0].message.content[0].name, 'EnterReviewMode');

  const compaction = codexItemToMessages({ id: 'cc-1', type: 'contextCompaction' }, 'thread-1');
  assert.equal(compaction[0].message.content[0].name, 'ContextCompaction');

  // An unrecognized future item type still drops silently rather than throwing.
  assert.deepEqual(codexItemToMessages({ id: 'x', type: 'somethingBrandNew' }, 'thread-1'), []);
});

test('thread/tokenUsage/updated stamps a usage-only assistant message the stats pipeline can price', () => {
  const withUsage = codexNotificationToMessages('thread/tokenUsage/updated', {
    threadId: 'thread-1',
    turnId: 'turn-1',
    tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 10, outputTokens: 40, reasoningOutputTokens: 12, totalTokens: 140 },
      total: { inputTokens: 300, cachedInputTokens: 20, outputTokens: 60, reasoningOutputTokens: 18, totalTokens: 360 },
      modelContextWindow: 200000,
    },
  }, 'thread-1', { model: 'gpt-5-codex' });
  assert.equal(withUsage.length, 1);
  assert.deepEqual(withUsage[0].message.content, []);
  assert.deepEqual(withUsage[0].message.usage, {
    input_tokens: 90, output_tokens: 40, cache_read_input_tokens: 10, cache_creation_input_tokens: 0,
    reasoning_output_tokens: 12, total_tokens: 140,
  });
  assert.deepEqual(withUsage[0]._cumulativeUsage, {
    input_tokens: 280, output_tokens: 60, cache_read_input_tokens: 20, cache_creation_input_tokens: 0,
    reasoning_output_tokens: 18, total_tokens: 360,
  });
  assert.equal(withUsage[0]._contextUsage.totalTokens, 140);
  assert.equal(withUsage[0]._contextUsage.maxTokens, 200000);
  assert.ok(Math.abs(withUsage[0]._contextUsage.percentage - 0.07) < 1e-12);
  assert.equal(withUsage[0]._contextUsage.isAutoCompactEnabled, false);
  assert.equal(withUsage[0]._contextUsage.autoCompactThreshold, null);

  // Also accepts the legacy flat/camelCase spelling from older bridges.
  const camel = codexNotificationToMessages('thread/tokenUsage/updated', {
    tokenUsage: { inputTokens: 5, outputTokens: 2 },
  }, 'thread-1');
  assert.equal(camel[0].message.usage.input_tokens, 5);

  assert.deepEqual(codexNotificationToMessages('thread/tokenUsage/updated', {}, 'thread-1'), []);
});

test('item started/completed generic items stay pending until completed', () => {
  const startedItemIds = new Set();
  const started = codexNotificationToMessages('item/started', {
    item: { id: 'ws-live', type: 'webSearch', query: 'weather', status: 'inProgress' },
  }, 'thread-1', { startedItemIds });
  assert.equal(started.length, 1);
  assert.equal(started[0].message.content[0].type, 'tool_use');
  assert.equal(started[0].message.content[0].name, 'WebSearch');

  const completed = codexNotificationToMessages('item/completed', {
    item: { id: 'ws-live', type: 'webSearch', query: 'weather', status: 'completed' },
  }, 'thread-1', { startedItemIds });
  assert.equal(completed.length, 1);
  assert.equal(completed[0].message.content[0].type, 'tool_result');
  assert.equal(completed[0].message.content[0].tool_use_id, 'ws-live');
});
