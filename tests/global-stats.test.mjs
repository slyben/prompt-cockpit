import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateGlobalStats, computeGlobalStats } from '../src/global-stats.js';

function assistantLine(ts, model, usage) {
  return JSON.stringify({ type: 'assistant', timestamp: ts, message: { model, usage } });
}

test('aggregateGlobalStats sums tokens, picks the favorite model, and counts active days', () => {
  const scans = [
    {
      firstTs: Date.parse('2026-08-18T09:00:00Z'),
      lastTs: Date.parse('2026-08-18T09:05:00Z'),
      rows: [
        { ts: Date.parse('2026-08-18T09:00:00Z'), model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10 } },
        { ts: Date.parse('2026-08-18T09:05:00Z'), model: 'claude-sonnet-5', usage: { input_tokens: 20, output_tokens: 30 } },
      ],
    },
    {
      firstTs: Date.parse('2026-08-19T10:00:00Z'),
      lastTs: Date.parse('2026-08-19T10:00:00Z'),
      rows: [
        { ts: Date.parse('2026-08-19T10:00:00Z'), model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 5 } },
      ],
    },
  ];

  const now = Date.parse('2026-08-20T12:00:00Z');
  const stats = aggregateGlobalStats(scans, { range: 'all', now });

  assert.equal(stats.favoriteModel, 'claude-sonnet-5'); // 200 tokens vs 10
  assert.equal(stats.inputTokens, 125);
  assert.equal(stats.outputTokens, 85);
  assert.equal(stats.cacheReadTokens, 10);
  assert.equal(stats.sessions, 2);
  assert.equal(stats.activeDays, 2);

  // Per-model cost table (costForUsage-backed): unpriced models are dropped
  // from perModel and reported separately instead of silently costing $0.
  const modelNames = stats.perModel.map((m) => m.model);
  assert.ok(modelNames.includes('claude-sonnet-5'));
  assert.ok(!modelNames.includes('claude-haiku-4-5')); // no pricing.json entry for this exact id
  assert.ok(stats.unpricedModels.includes('claude-haiku-4-5'));
  assert.ok(stats.totalCostUsd > 0);
  assert.equal(stats.currentStreak, 2); // 08-18 and 08-19 are consecutive; 08-20 (now) has no activity yet
});

test('computeStreaks counts consecutive days ending yesterday when today has no activity yet', () => {
  const scans = [
    { firstTs: null, lastTs: null, rows: [{ ts: Date.parse('2026-08-17T08:00:00Z'), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
    { firstTs: null, lastTs: null, rows: [{ ts: Date.parse('2026-08-18T08:00:00Z'), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
    { firstTs: null, lastTs: null, rows: [{ ts: Date.parse('2026-08-19T08:00:00Z'), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
  ];
  const now = Date.parse('2026-08-20T06:00:00Z'); // nothing logged today yet
  const stats = aggregateGlobalStats(scans, { range: 'all', now });
  assert.equal(stats.currentStreak, 3);
  assert.equal(stats.longestStreak, 3);
});

test('a gap breaks the streak', () => {
  const scans = [
    { firstTs: null, lastTs: null, rows: [{ ts: Date.parse('2026-08-10T08:00:00Z'), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
    { firstTs: null, lastTs: null, rows: [{ ts: Date.parse('2026-08-19T08:00:00Z'), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
    { firstTs: null, lastTs: null, rows: [{ ts: Date.parse('2026-08-20T08:00:00Z'), model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
  ];
  const now = Date.parse('2026-08-20T12:00:00Z');
  const stats = aggregateGlobalStats(scans, { range: 'all', now });
  assert.equal(stats.currentStreak, 2); // 08-19, 08-20
  assert.equal(stats.longestStreak, 2);
  assert.equal(stats.activeDays, 3);
});

test('range=7d drops sessions and tokens outside the window', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const scans = [
    { firstTs: now - 20 * 86400000, lastTs: now - 20 * 86400000, rows: [{ ts: now - 20 * 86400000, model: 'old', usage: { input_tokens: 1000, output_tokens: 1000 } }] },
    { firstTs: now - 1 * 86400000, lastTs: now - 1 * 86400000, rows: [{ ts: now - 1 * 86400000, model: 'recent', usage: { input_tokens: 5, output_tokens: 5 } }] },
  ];
  const stats = aggregateGlobalStats(scans, { range: '7d', now });
  assert.equal(stats.sessions, 1);
  assert.equal(stats.favoriteModel, 'recent');
  assert.equal(stats.inputTokens, 5);
});

test('computeGlobalStats reads real transcript files across multiple projects', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-stats-'));
  try {
    const projA = path.join(root, '-Users-x-proj-a');
    const projB = path.join(root, '-Users-x-proj-b');
    await mkdir(projA, { recursive: true });
    await mkdir(projB, { recursive: true });

    await writeFile(
      path.join(projA, '11111111-1111-1111-1111-111111111111.jsonl'),
      [
        JSON.stringify({ type: 'user', timestamp: '2026-08-19T09:00:00.000Z', cwd: '/Users/x/proj-a', message: { content: 'hi' } }),
        assistantLine('2026-08-19T09:00:05.000Z', 'claude-sonnet-5', { input_tokens: 50, output_tokens: 20 }),
      ].join('\n') + '\n',
    );
    await writeFile(
      path.join(projB, '22222222-2222-2222-2222-222222222222.jsonl'),
      [
        assistantLine('2026-08-20T08:00:00.000Z', 'claude-sonnet-5', { input_tokens: 5, output_tokens: 5 }),
      ].join('\n') + '\n',
    );

    const stats = await computeGlobalStats(root, { range: 'all', now: Date.parse('2026-08-20T12:00:00Z') });
    assert.equal(stats.sessions, 2);
    assert.equal(stats.inputTokens, 55);
    assert.equal(stats.outputTokens, 25);
    assert.equal(stats.favoriteModel, 'claude-sonnet-5');
    assert.equal(stats.activeDays, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('computeGlobalStats returns zeros for a missing projects dir', async () => {
  const stats = await computeGlobalStats(path.join(tmpdir(), 'cockpit-stats-does-not-exist'), { range: 'all' });
  assert.equal(stats.sessions, 0);
  assert.equal(stats.totalTokens, 0);
  assert.equal(stats.favoriteModel, null);
});
