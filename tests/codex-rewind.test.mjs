import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCodexRewindTurn, rewindCodexConversation } from '../src/codex-rewind.js';

const user = (text) => ({ type: 'userMessage', content: [{ type: 'text', text }] });
const turn = (id, text, status = 'completed') => ({ id, status, items: [user(text), { type: 'agentMessage', text: `answer ${text}` }] });
const source = { id: 'source', turns: [turn('one', 'first'), { id: 'internal', status: 'completed', items: [] }, turn('two', 'second'), turn('three', 'third')] };

function managerFor(thread = source, forkOverride) {
  const calls = [];
  let forkTargetId = null;
  return {
    calls,
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/read') {
        if (params.threadId === thread.id) return { thread: structuredClone(thread) };
        const child = forkOverride || {
          id: 'child',
          turns: thread.turns.slice(0, thread.turns.findIndex((t) => t.id === forkTargetId) + 1),
        };
        return { thread: structuredClone(child) };
      }
      if (method === 'thread/fork') {
        forkTargetId = params.lastTurnId;
        return { thread: forkOverride || { id: 'child', sessionId: thread.id, forkedFromId: thread.id } };
      }
      if (method === 'thread/unsubscribe') return {};
      throw new Error(`Unexpected RPC: ${method}`);
    },
  };
}

test('Codex rewind resolves visible user turns and preserves the selected response', async () => {
  const before = structuredClone(source);
  const manager = managerFor();
  const result = await rewindCodexConversation(manager, 'source', '/repo', 2);
  assert.deepEqual(result, { filesResult: { conversationOnly: true, turnId: 'two' }, forkedSessionId: 'child' });
  assert.deepEqual(manager.calls, [
    ['thread/read', { threadId: 'source', includeTurns: true }],
    ['thread/fork', { threadId: 'source', lastTurnId: 'two' }],
    ['thread/read', { threadId: 'child', includeTurns: true }],
    ['thread/unsubscribe', { threadId: 'child' }],
  ]);
  assert.deepEqual(source, before);
});

test('Codex rewind preview only reads history', async () => {
  const manager = managerFor();
  assert.deepEqual(await rewindCodexConversation(manager, 'source', '/repo', 1, { dryRun: true }), {
    filesResult: { conversationOnly: true, turnId: 'one' }, forkedSessionId: null,
  });
  assert.equal(manager.calls.length, 1);
});

test('first and last user turns are valid fork boundaries', async () => {
  for (const index of [1, 3]) {
    assert.equal((await rewindCodexConversation(managerFor(), 'source', '/repo', index)).forkedSessionId, 'child');
  }
});

test('invalid, missing, and in-progress targets never create a fork', async () => {
  for (const index of [0, -1, 1.5, '1', 4]) {
    const manager = managerFor();
    await assert.rejects(() => rewindCodexConversation(manager, 'source', '/repo', index));
    assert.equal(manager.calls.length, 1);
  }
  const manager = managerFor({ id: 'source', turns: [turn('running', 'hello', 'inProgress')] });
  await assert.rejects(() => rewindCodexConversation(manager, 'source', '/repo', 1), /finish/);
  assert.equal(manager.calls.length, 1);
  assert.throws(() => resolveCodexRewindTurn(null, 1), /could not find/);
});

test('multiple user items cannot silently include a later prompt', () => {
  const thread = { id: 'source', turns: [{ id: 'one', status: 'completed', items: [user('a'), user('b')] }] };
  assert.throws(() => resolveCodexRewindTurn(thread, 1), /multiple user messages/);
  assert.equal(resolveCodexRewindTurn(thread, 2).turnId, 'one');
});

test('ignored fork boundary fails and releases the child subscription', async () => {
  const manager = managerFor(source, { id: 'child', turns: source.turns });
  await assert.rejects(() => rewindCodexConversation(manager, 'source', '/repo', 1), /update the Codex CLI/);
  assert.deepEqual(manager.calls.at(-1), ['thread/unsubscribe', { threadId: 'child' }]);
});

test('a malformed fork response cannot unsubscribe or return the original thread', async () => {
  for (const fork of [{}, source]) {
    const manager = managerFor(source, fork);
    await assert.rejects(() => rewindCodexConversation(manager, 'source', '/repo', 1), /new forked thread/);
    assert.equal(manager.calls.length, 2);
  }
});

test('fork RPC failures propagate without modifying the source', async () => {
  const manager = managerFor();
  const request = manager.request.bind(manager);
  manager.request = (method, params) => {
    if (method === 'thread/fork') throw new Error('fork unavailable');
    return request(method, params);
  };
  await assert.rejects(() => rewindCodexConversation(manager, 'source', '/repo', 1), /fork unavailable/);
  assert.equal(manager.calls.length, 1);
});
