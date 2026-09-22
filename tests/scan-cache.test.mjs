// Unit tests for scan-cache.js's mtime-keyed memoization and bounded
// concurrency - shared by global-stats.js and codex-history.js's own
// per-file scan fan-out. See tests/global-stats.test.mjs and
// tests/codex-history.test.mjs for the integration-level coverage of each
// caller actually wiring this in.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cachedScan, mapWithConcurrency, _resetScanCache } from '../src/scan-cache.js';

test('cachedScan reuses the cached result when mtimeMs is unchanged', async () => {
  _resetScanCache();
  let calls = 0;
  const scanFn = async (filePath) => { calls += 1; return { filePath, call: calls }; };

  const first = await cachedScan('/fake/a.jsonl', 1000, scanFn);
  const second = await cachedScan('/fake/a.jsonl', 1000, scanFn);

  assert.equal(calls, 1, 'scanFn should only run once for an unchanged mtime');
  assert.equal(second, first, 'the second call must return the exact cached result, not a fresh scan');
});

test('cachedScan rescans once mtimeMs changes', async () => {
  _resetScanCache();
  let calls = 0;
  const scanFn = async () => { calls += 1; return { call: calls }; };

  const first = await cachedScan('/fake/b.jsonl', 1000, scanFn);
  const second = await cachedScan('/fake/b.jsonl', 2000, scanFn);

  assert.equal(calls, 2, 'a changed mtime must trigger a real rescan');
  assert.notEqual(second.call, first.call);
});

test('cachedScan keys independently per file path', async () => {
  _resetScanCache();
  let calls = 0;
  const scanFn = async (filePath) => { calls += 1; return filePath; };

  await cachedScan('/fake/x.jsonl', 1, scanFn);
  await cachedScan('/fake/y.jsonl', 1, scanFn);

  assert.equal(calls, 2, 'two distinct paths must not collide in the cache');
});

test('mapWithConcurrency never runs more than `limit` scans at once', async () => {
  const items = Array.from({ length: 20 }, (_, i) => i);
  let active = 0;
  let maxActive = 0;
  const results = await mapWithConcurrency(items, 4, async (i) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    return i * 2;
  });

  assert.ok(maxActive <= 4, `max concurrent was ${maxActive}, expected <= 4`);
  assert.deepEqual(results, items.map((i) => i * 2), 'results must stay in input order despite concurrent completion order');
});

test('mapWithConcurrency handles an empty list and a limit larger than the list', async () => {
  assert.deepEqual(await mapWithConcurrency([], 4, async () => 1), []);
  const results = await mapWithConcurrency([1, 2], 100, async (n) => n + 1);
  assert.deepEqual(results, [2, 3]);
});
