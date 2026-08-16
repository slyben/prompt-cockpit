import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveGrokPromptIndex, parseRewindPointsFile } from '../src/grok-rewind.js';

test('resolveGrokPromptIndex maps 1-based turn order onto prompt_index, including gaps', () => {
  const points = [{ prompt_index: 0 }, { prompt_index: 2 }, { prompt_index: 5 }];
  assert.equal(resolveGrokPromptIndex(points, 1), 0);
  assert.equal(resolveGrokPromptIndex(points, 2), 2);
  assert.equal(resolveGrokPromptIndex(points, 3), 5);
});

test('resolveGrokPromptIndex rejects a turn with no point', () => {
  assert.throws(() => resolveGrokPromptIndex([{ prompt_index: 0 }], 2), /no rewind point/);
  assert.throws(() => resolveGrokPromptIndex([], 1), /no rewind point/);
  assert.throws(() => resolveGrokPromptIndex([{ prompt_index: 0 }], 0), /1-based/);
});

test('parseRewindPointsFile reads prompt_index lines and skips junk', () => {
  const text = [
    '{"prompt_index":0,"created_at":"2026-08-16T00:00:00Z"}',
    'not-json',
    '{"prompt_index":2}',
    '',
  ].join('\n');
  assert.deepEqual(parseRewindPointsFile(text), [
    { prompt_index: 0, created_at: '2026-08-16T00:00:00Z' },
    { prompt_index: 2, created_at: null },
  ]);
});
