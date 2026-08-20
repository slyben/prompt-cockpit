import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpUpdateToMessages, turnResultMessage, pickPermissionOption, grokPermissionAction, joinStreamText, coalesceAssistantMessages } from '../src/grok-messages.js';

test('agent_message_chunk becomes an assistant text message', () => {
  const msgs = acpUpdateToMessages({
    sessionUpdate: 'agent_message_chunk',
    content: { type: 'text', text: 'hello' },
  }, 'sess-1');
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].type, 'assistant');
  assert.equal(msgs[0].session_id, 'sess-1');
  assert.equal(msgs[0].message.content[0].text, 'hello');
});

test('agent_thought_chunk becomes a thinking block', () => {
  const msgs = acpUpdateToMessages({
    sessionUpdate: 'agent_thought_chunk',
    content: { text: 'hmm' },
  }, 's');
  assert.equal(msgs[0].message.content[0].type, 'thinking');
  assert.equal(msgs[0].message.content[0].thinking, 'hmm');
});

test('tool_call becomes assistant tool_use; completed update becomes tool_result', () => {
  const start = acpUpdateToMessages({
    sessionUpdate: 'tool_call',
    toolCallId: 'c1',
    toolName: 'read_file',
    rawInput: { path: 'a.js' },
  }, 's');
  assert.equal(start[0].message.content[0].type, 'tool_use');
  assert.equal(start[0].message.content[0].id, 'c1');
  assert.equal(start[0].message.content[0].name, 'read_file');

  const done = acpUpdateToMessages({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'completed',
    rawOutput: { lines: 3 },
  }, 's');
  assert.equal(done[0].type, 'user');
  assert.equal(done[0].message.content[0].type, 'tool_result');
  assert.equal(done[0].message.content[0].tool_use_id, 'c1');
  assert.match(done[0].message.content[0].content, /lines/);
});

test('in_progress tool updates are ignored', () => {
  const msgs = acpUpdateToMessages({
    sessionUpdate: 'tool_call_update',
    toolCallId: 'c1',
    status: 'in_progress',
  }, 's');
  assert.deepEqual(msgs, []);
});

test('turnResultMessage marks non-end_turn as error', () => {
  const ok = turnResultMessage('s', 'end_turn');
  assert.equal(ok.subtype, 'success');
  assert.equal(ok.is_error, false);
  const bad = turnResultMessage('s', 'refusal');
  assert.equal(bad.subtype, 'error');
  assert.equal(bad.is_error, true);
});

test('pickPermissionOption prefers allow_once / reject_once by kind', () => {
  const options = [
    { optionId: 'no', kind: 'reject_once' },
    { optionId: 'yes', kind: 'allow_once' },
  ];
  assert.equal(pickPermissionOption(options, true), 'yes');
  assert.equal(pickPermissionOption(options, false), 'no');
});

test('pickPermissionOption does not fall back to a permissive first option', () => {
  const options = [{ optionId: 'yes', kind: 'allow_once' }];
  assert.equal(pickPermissionOption(options, false), null);
});

test('grokPermissionAction: acceptEdits only auto-allows edit; plan denies writes', () => {
  assert.equal(grokPermissionAction('acceptEdits', { kind: 'edit' }), 'allow');
  assert.equal(grokPermissionAction('acceptEdits', { kind: 'execute' }), 'ask');
  assert.equal(grokPermissionAction('plan', { kind: 'read' }), 'allow');
  assert.equal(grokPermissionAction('plan', { kind: 'edit' }), 'deny');
  assert.equal(grokPermissionAction('bypassPermissions', { kind: 'execute' }), 'allow');
  assert.equal(grokPermissionAction('default', { kind: 'edit' }), 'ask');
});

test('turn_completed becomes an assistant message with model + usage', () => {
  const msgs = acpUpdateToMessages({
    sessionUpdate: 'turn_completed',
    usage: { input_tokens: 10, output_tokens: 4, cache_read_input_tokens: 2 },
  }, 's', { model: 'grok-4.6' });
  assert.equal(msgs[0].message.model, 'grok-4.6');
  assert.equal(msgs[0].message.usage.input_tokens, 10);
  assert.equal(msgs[0].message.usage.output_tokens, 4);
  assert.equal(msgs[0].message.usage.cache_read_input_tokens, 2);
});

test('turn_completed accepts the live Grok camelCase usage stamp', () => {
  const msgs = acpUpdateToMessages({
    sessionUpdate: 'turn_completed',
    usage: {
      inputTokens: 16666,
      outputTokens: 41,
      cachedReadTokens: 1408,
      cacheCreationTokens: 0,
      costUsdTicks: 53492200,
    },
  }, 's', { model: 'grok-4.6' });
  assert.equal(msgs[0].message.usage.input_tokens, 16666);
  assert.equal(msgs[0].message.usage.output_tokens, 41);
  assert.equal(msgs[0].message.usage.cache_read_input_tokens, 1408);
  assert.equal(msgs[0].message.usage.cost_usd_ticks, 53492200);
});

test('joinStreamText treats a single trailing newline as a token boundary', () => {
  assert.equal(joinStreamText('The\n', 'user\n'), 'The user\n');
  assert.equal(joinStreamText('The user\n', 'wants'), 'The user wants');
  assert.equal(joinStreamText('para 1\n\n', 'para 2'), 'para 1\n\npara 2');
  assert.equal(joinStreamText('Hello', ' world'), 'Hello world');
  assert.equal(joinStreamText('Hello ', 'world'), 'Hello world');
  assert.equal(joinStreamText('end', '.'), 'end.');
});

test('joinStreamText keeps newlines between markdown block lines', () => {
  assert.equal(joinStreamText('| A | B |\n', '| --- | --- |\n'), '| A | B |\n| --- | --- |\n');
  assert.equal(
    joinStreamText('| A | B |\n| --- | --- |\n', '| 1 | 2 |\n'),
    '| A | B |\n| --- | --- |\n| 1 | 2 |\n',
  );
  assert.equal(joinStreamText('- one\n', '- two\n'), '- one\n- two\n');
  assert.equal(joinStreamText('1. one\n', '2. two\n'), '1. one\n2. two\n');
  assert.equal(joinStreamText('```\n', 'code\n'), '```\ncode\n');
  assert.equal(joinStreamText('```\ncode\n', '```\n'), '```\ncode\n```\n');
  assert.equal(joinStreamText('## Title\n', 'body'), '## Title\nbody');
  assert.equal(joinStreamText('plain sentence.\n', '- list item'), 'plain sentence.\n- list item');
});

test('coalesceAssistantMessages keeps markdown structure in streamed text', () => {
  const chunks = ['| A | B |\n', '| --- | --- |\n', '| 1 | 2 |\n'].map((text) => (
    acpUpdateToMessages({ sessionUpdate: 'agent_message_chunk', content: { text } }, 's')[0]
  ));
  const merged = coalesceAssistantMessages(chunks);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].message.content[0].text, '| A | B |\n| --- | --- |\n| 1 | 2 |\n');
});

test('joinStreamText does not invent spaces between bare BPE pieces', () => {
  assert.equal(joinStreamText('Rac', 'oon'), 'Racoon');
  assert.equal(joinStreamText('un', 'committed'), 'uncommitted');
  assert.equal(joinStreamText('"', 'output'), '"output');
  assert.equal(joinStreamText('summary', '/'), 'summary/');
  assert.equal(joinStreamText('summary/', 'documentation'), 'summary/documentation');
});

test('coalesceAssistantMessages merges consecutive thinking tokens into one block', () => {
  const chunks = ['The\n', 'user\n', 'wants\n', 'this.'].map((thinking) => (
    acpUpdateToMessages({ sessionUpdate: 'agent_thought_chunk', content: { text: thinking } }, 's')[0]
  ));
  const merged = coalesceAssistantMessages(chunks);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].message.content[0].type, 'thinking');
  assert.equal(merged[0].message.content[0].thinking, 'The user wants this.');
});

test('coalesceAssistantMessages does not merge thinking across a tool call', () => {
  const msgs = [
    ...acpUpdateToMessages({ sessionUpdate: 'agent_thought_chunk', content: { text: 'hmm' } }, 's'),
    ...acpUpdateToMessages({ sessionUpdate: 'tool_call', toolCallId: 'c1', toolName: 'read_file' }, 's'),
    ...acpUpdateToMessages({ sessionUpdate: 'agent_thought_chunk', content: { text: 'ok' } }, 's'),
  ];
  const merged = coalesceAssistantMessages(msgs);
  assert.equal(merged.length, 3);
  assert.equal(merged[0].message.content[0].thinking, 'hmm');
  assert.equal(merged[2].message.content[0].thinking, 'ok');
});

test('usage and usage_update do not become cost-bearing messages', () => {
  const usage = { input_tokens: 10, output_tokens: 4 };
  assert.deepEqual(acpUpdateToMessages({ sessionUpdate: 'usage', usage }, 's'), []);
  assert.deepEqual(acpUpdateToMessages({ sessionUpdate: 'usage_update', usage }, 's'), []);
});
