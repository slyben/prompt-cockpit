import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fetchGrokSessionHistory, findSessionDir, isSafeSessionId } from '../src/grok-history.js';

test('fetchGrokSessionHistory maps updates.jsonl into sdk messages', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-hist-'));
  const cwd = 'D:\\proj';
  const id = 'sess-1';
  const dir = path.join(root, encodeURIComponent(cwd), id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify({ info: { id, cwd } }));
  await writeFile(path.join(dir, 'updates.jsonl'), [
    JSON.stringify({ params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hi' } } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'pong' } } } }),
    JSON.stringify({ params: { update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 10, outputTokens: 2 } } } }),
  ].join('\n') + '\n');

  try {
    const messages = await fetchGrokSessionHistory(id, cwd, root);
    assert.equal(messages[0].type, 'user');
    assert.equal(messages[0].message.content, 'hi');
    assert.equal(messages[1].type, 'assistant');
    assert.equal(messages[1].message.content[0].text, 'pong');
    assert.equal(messages[2].message.usage.input_tokens, 10);
    assert.equal(findSessionDir(id, cwd, root), dir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fetchGrokSessionHistory throws when the session is missing', async () => {
  await assert.rejects(fetchGrokSessionHistory('nope', '/tmp', '/nonexistent'), /unknown grok session/);
});

test('findSessionDir rejects a session id that is not a single path segment', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-hist-trav-'));
  try {
    const cwd = 'D:\\proj';
    const outside = path.join(root, 'secret');
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'summary.json'), '{}');

    assert.equal(isSafeSessionId('01a007e9-4eee-7022-82af-6cfa348090ca'), true);
    assert.equal(isSafeSessionId('sess-1'), true);
    assert.equal(isSafeSessionId('..'), false);
    assert.equal(isSafeSessionId(path.join('..', 'secret')), false);
    assert.equal(isSafeSessionId(`nested${path.sep}id`), false);
    assert.equal(findSessionDir('..', cwd, root), null);
    assert.equal(findSessionDir(path.join('..', 'secret'), cwd, root), null);
    await assert.rejects(fetchGrokSessionHistory(path.join('..', 'secret'), cwd, root), /unknown grok session/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
