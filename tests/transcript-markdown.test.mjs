import { test } from 'node:test';
import assert from 'node:assert/strict';
import { messagesToMarkdown } from '../src/transcript-markdown.js';

test('messagesToMarkdown on an empty transcript yields just the header, not a crash', () => {
  const md = messagesToMarkdown([], { title: 'Empty', cwd: '/tmp/proj', sessionId: 'abc' });
  assert.match(md, /^# Empty\n/);
  assert.match(md, /cwd: `\/tmp\/proj`/);
  assert.match(md, /session: `abc`/);
});

test('messagesToMarkdown renders a user text turn under "## You"', () => {
  const messages = [{ type: 'user', message: { role: 'user', content: 'hello there' } }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /## You\n\nhello there/);
});

test('messagesToMarkdown skips the priming sentinel (isSynthetic)', () => {
  const messages = [{ type: 'user', isSynthetic: true, message: { role: 'user', content: 'priming' } }];
  const md = messagesToMarkdown(messages);
  assert.doesNotMatch(md, /priming/);
});

test('messagesToMarkdown renders an assistant text reply under the given assistantLabel heading', () => {
  const messages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'the answer' }] } }];
  const md = messagesToMarkdown(messages, { assistantLabel: 'Grok' });
  assert.match(md, /## Grok\n\nthe answer/);
});

test('messagesToMarkdown tucks thinking into a <details> block', () => {
  const messages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'pondering...' }] } }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /<details><summary>Thinking<\/summary>/);
  assert.match(md, /pondering\.\.\./);
  assert.match(md, /<\/details>/);
});

test('messagesToMarkdown skips an empty/signature-only thinking block', () => {
  const messages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '   ' }] } }];
  const md = messagesToMarkdown(messages);
  assert.doesNotMatch(md, /Thinking/);
});

test('messagesToMarkdown fences a tool_use call with its input', () => {
  const messages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /\*\*Tool call: Bash\*\*/);
  assert.match(md, /ls -la/);
  assert.match(md, /```/);
});

test('messagesToMarkdown fences a tool_result, flattening array content blocks', () => {
  const messages = [{
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', content: [{ type: 'text', text: 'ok done' }] }] },
  }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /\*\*Tool result\*\*/);
  assert.match(md, /ok done/);
});

test('messagesToMarkdown widens the fence when content already contains a run of backticks', () => {
  const messages = [{ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', name: 'Write', input: { content: 'has ```js\ncode\n``` inside' } }] } }];
  const md = messagesToMarkdown(messages);
  // The tool_use input gets JSON-stringified, so the longest backtick run
  // inside is 3 - the fence must be at least 4 to still parse as a fence.
  assert.match(md, /````\n/);
});

test('messagesToMarkdown truncates a block over the char cap with a marker', () => {
  const longText = 'x'.repeat(3000);
  const messages = [{ type: 'user', message: { role: 'user', content: longText } }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /… \(truncated\)/);
  assert(md.length < longText.length + 200);
});

test('messagesToMarkdown records a turn error from a result message', () => {
  const messages = [{ type: 'result', subtype: 'error', error: 'something broke' }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /\*\*Turn error\*\*/);
  assert.match(md, /something broke/);
});

test('messagesToMarkdown ignores an unknown message type without crashing', () => {
  const messages = [{ type: 'rate_limit_event' }, { type: 'system', subtype: 'init' }, { type: 'totally-unknown' }];
  const md = messagesToMarkdown(messages);
  assert.match(md, /^# Session transcript\n/);
});
