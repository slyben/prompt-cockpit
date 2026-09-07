import { test } from 'node:test';
import assert from 'node:assert/strict';
import { listCodexModels } from '../src/codex-models.js';

test('Codex discovery paginates without starting a session and normalizes effort objects', async () => {
  const calls = [];
  const models = await listCodexModels({ async request(method, params) {
    calls.push([method, params]);
    return params.cursor ? { data: [{ id: 'second', supportedReasoningEfforts: ['high'] }], nextCursor: null }
      : { data: [
        { id: 'first-id', model: 'first', displayName: 'First model', isDefault: true, supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'Fast' }] },
        { id: 'hidden', hidden: true },
      ], nextCursor: 'page-two' };
  } });
  assert.deepEqual(models.map(m => [m.value, m.displayName, Boolean(m.isDefault), m.supportedEfforts]), [
    ['first', 'First model', true, ['low']], ['second', 'second', false, ['high']],
  ]);
  assert.deepEqual(calls, [
    ['model/list', { limit: 100, includeHidden: false }],
    ['model/list', { limit: 100, includeHidden: false, cursor: 'page-two' }],
  ]);
});

test('Codex discovery surfaces failures so the launcher can report an unavailable catalog', async () => {
  await assert.rejects(listCodexModels({ request: async () => { throw new Error('disconnected'); } }), /disconnected/);
});
