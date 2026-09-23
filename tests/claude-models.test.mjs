import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listClaudeModels, _resetCacheForTests } from '../src/claude-models.js';

// Fakes the shape session.js relies on: the prompt iterable's first next()
// must resolve before the fake CLI "sends" the num_turns:0 sentinel result,
// and supportedModels() only resolves after that - matching the real SDK's
// documented system/init gating (see .claude/memory/sdk-streaming-input-gotchas.md).
function fakeQuery(models, { onInterrupt } = {}) {
  return ({ prompt }) => {
    const messages = [];
    let done = false;
    (async () => {
      const iterator = prompt[Symbol.asyncIterator]();
      await iterator.next(); // consume the priming sentinel
      messages.push({ type: 'result', num_turns: 0 });
      done = true;
    })();
    return {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            while (!done) await new Promise((r) => setTimeout(r, 0));
            if (messages.length) return { value: messages.shift(), done: false };
            return { value: undefined, done: true };
          },
        };
      },
      supportedModels: async () => models,
      interrupt: async () => { onInterrupt?.(); },
    };
  };
}

test('listClaudeModels returns the live catalog plus legacy pins not already covered', async () => {
  _resetCacheForTests();
  const live = [
    { value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' },
    { value: 'sonnet', resolvedModel: 'claude-sonnet-5', displayName: 'Sonnet' },
  ];
  const models = await listClaudeModels({ queryImpl: fakeQuery(live) });
  assert.deepEqual(models.slice(0, 2), live);
  // Legacy pins are appended and none collide with the live aliases above.
  const legacyValues = models.slice(2).map((m) => m.value);
  assert.ok(legacyValues.includes('claude-opus-4-6'));
  assert.ok(legacyValues.includes('claude-sonnet-4-6'));
  for (const entry of models.slice(2)) {
    assert.equal(entry.resolvedModel, entry.value);
  }
});

test('listClaudeModels drops a legacy pin already covered by a live alias\'s resolvedModel', async () => {
  _resetCacheForTests();
  const live = [{ value: 'opus', resolvedModel: 'claude-opus-5', displayName: 'Opus' }];
  const models = await listClaudeModels({ queryImpl: fakeQuery(live) });
  assert.equal(models.filter((m) => m.value === 'claude-opus-5').length, 0);
});

test('listClaudeModels interrupts the throwaway CLI process after reading the catalog', async () => {
  _resetCacheForTests();
  let interrupted = false;
  await listClaudeModels({ queryImpl: fakeQuery([], { onInterrupt: () => { interrupted = true; } }) });
  assert.equal(interrupted, true);
});

test('listClaudeModels caches for the life of the process - a second call never spawns another process', async () => {
  _resetCacheForTests();
  let spawnCount = 0;
  const queryImpl = (...args) => {
    spawnCount += 1;
    return fakeQuery([{ value: 'opus', resolvedModel: 'claude-opus-5-5', displayName: 'Opus' }])(...args);
  };
  const first = await listClaudeModels({ queryImpl });
  const second = await listClaudeModels({ queryImpl });
  assert.equal(spawnCount, 1);
  assert.equal(first, second);
});
