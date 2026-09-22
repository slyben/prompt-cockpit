import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { aggregateGlobalStats, computeGlobalStats, getCachedStats } from '../src/global-stats.js';

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
      provider: 'claude',
    },
    {
      firstTs: Date.parse('2026-08-19T10:00:00Z'),
      lastTs: Date.parse('2026-08-19T10:00:00Z'),
      rows: [
        { ts: Date.parse('2026-08-19T10:00:00Z'), model: 'claude-haiku-4-5', usage: { input_tokens: 5, output_tokens: 5 } },
      ],
      provider: 'claude',
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

  // Per-model cost table (costForUsage-backed): an unpriced model's tokens
  // still land in perModel (B1) - only its cost is skipped, and it's
  // reported separately in unpricedModels instead of silently costing $0.
  const haiku = stats.perModel.find((m) => m.model === 'claude-haiku-4-5');
  assert.ok(stats.perModel.some((m) => m.model === 'claude-sonnet-5'));
  assert.ok(haiku); // no pricing.json entry for this exact id, but still present
  assert.equal(haiku.inputTokens, 5);
  assert.equal(haiku.outputTokens, 5);
  assert.equal(haiku.costUsd, 0);
  assert.ok(stats.unpricedModels.includes('claude-haiku-4-5'));
  assert.ok(stats.totalCostUsd > 0);
  assert.equal(stats.currentStreak, 2); // 08-18 and 08-19 are consecutive; 08-20 (now) has no activity yet
  assert.equal(stats.perProvider.claude.sessions, 2);
  assert.equal(stats.perProvider.claude.inputTokens, 125);
  assert.equal(stats.perProvider.grok.sessions, 0);
  assert.equal(Object.values(stats.dailyByProvider).reduce((n, day) => n + (day.claude || 0), 0), 3);
});

test('aggregateGlobalStats splits heatmap days and cost across providers', () => {
  const scans = [
    {
      firstTs: Date.parse('2026-09-06T12:00:00Z'),
      lastTs: Date.parse('2026-09-06T12:00:00Z'),
      provider: 'claude',
      rows: [{ ts: Date.parse('2026-09-06T12:00:00Z'), model: 'claude-sonnet-5', usage: { input_tokens: 100, output_tokens: 20 } }],
    },
    {
      firstTs: Date.parse('2026-09-06T18:00:00Z'),
      lastTs: Date.parse('2026-09-06T18:00:00Z'),
      provider: 'grok',
      rows: [{ ts: Date.parse('2026-09-06T18:00:00Z'), model: 'grok-4.6', usage: { input_tokens: 50, output_tokens: 8, cost_usd_ticks: 53492200 } }],
    },
    {
      firstTs: Date.parse('2026-09-06T20:00:00Z'),
      lastTs: Date.parse('2026-09-06T20:00:00Z'),
      provider: 'codex',
      rows: [{ ts: Date.parse('2026-09-06T20:00:00Z'), model: null, usage: null }],
    },
  ];
  const stats = aggregateGlobalStats(scans, { range: 'all', now: Date.parse('2026-09-07T12:00:00Z') });
  const mixedDay = Object.values(stats.dailyByProvider).find((day) => (day.claude || 0) + (day.grok || 0) + (day.codex || 0) === 3);
  assert.ok(mixedDay);
  assert.deepEqual(mixedDay, { claude: 1, grok: 1, codex: 1 });
  assert.equal(stats.perProvider.claude.sessions, 1);
  assert.equal(stats.perProvider.grok.sessions, 1);
  assert.equal(stats.perProvider.codex.sessions, 1);
  assert.ok(stats.perProvider.claude.costUsd > 0);
  assert.equal(stats.perProvider.grok.costUsd, 53492200 / 10_000_000_000);
  assert.equal(stats.perProvider.codex.costUsd, 0);

  const week = aggregateGlobalStats(scans, { range: '7d', now: Date.parse('2026-09-07T12:00:00Z') });
  assert.ok(week.perProvider.claude.costUsd > 0);
  assert.equal(week.perProvider.grok.costUsd, 53492200 / 10_000_000_000);
  assert.equal(week.perProvider.codex.sessions, 1);
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

// 2026-08-24 review fix: longestSessionMs used to come from the whole
// file's firstTs/lastTs even under a range filter - a session with one
// message inside the window but a real span going back a month reported
// that full month as "longest session". It must be bounded by the range.
test('range=7d bounds longestSessionMs to the in-range messages, not the whole file span', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const scans = [
    {
      // File spans a full month, but only its LAST message (a few minutes
      // before `now`) falls inside the 7-day window.
      firstTs: now - 30 * 86400000,
      lastTs: now - 1 * 3600000,
      rows: [
        { ts: now - 30 * 86400000, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
        { ts: now - 1 * 3600000, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } },
      ],
    },
  ];
  const stats = aggregateGlobalStats(scans, { range: '7d', now });
  assert.equal(stats.sessions, 1);
  assert.equal(stats.longestSessionMs, 0, 'only one message is in-range, so its session span within the window is 0, not the whole-file month');
});

test('range=all still uses the whole-file span for longestSessionMs (no filtering needed)', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const scans = [
    { firstTs: now - 30 * 86400000, lastTs: now - 1 * 3600000, rows: [{ ts: now - 1 * 3600000, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } }] },
  ];
  const stats = aggregateGlobalStats(scans, { range: 'all', now });
  assert.equal(stats.longestSessionMs, 30 * 86400000 - 3600000);
});

// 2026-09-21 review fix: rangeFirstTs/rangeLastTs used to come from
// Math.min(...inRangeTimestamps)/Math.max(...inRangeTimestamps) - spreading
// a session's in-range rows as call arguments throws once the array is big
// enough to exceed the engine's argument-count limit. Real, if rare: a
// single long scripted/automated session can rack up tens of thousands of
// usage-bearing messages.
test('range filtering bounds longestSessionMs correctly for a session with 100k in-range rows, without a spread-argument crash', () => {
  const now = Date.parse('2026-08-20T12:00:00Z');
  const rowCount = 100_000;
  const rows = [];
  for (let i = 0; i < rowCount; i += 1) {
    // All within the last ~16.6 minutes - well inside the 30d window, but
    // still ordered oldest-first so the first/last rows define the span.
    rows.push({ ts: now - (rowCount - i) * 10, model: 'm', usage: { input_tokens: 1, output_tokens: 1 } });
  }
  const scans = [{ firstTs: now - 30 * 86400000, lastTs: rows[rows.length - 1].ts, rows, provider: 'claude' }];

  const stats = aggregateGlobalStats(scans, { range: '30d', now });
  assert.equal(stats.longestSessionMs, rows[rows.length - 1].ts - rows[0].ts);
});

test('getCachedStats returns a fresh hit without rescanning', async () => {
  const cache = new Map();
  const inFlight = new Map();
  cache.set('all', { result: 'cached-value', atMs: 1000 });
  let calls = 0;
  const scanFn = async () => { calls += 1; return 'fresh-value'; };

  const result = await getCachedStats(cache, inFlight, 'all', 15000, scanFn, 6000);
  assert.equal(result, 'cached-value');
  assert.equal(calls, 0, 'a fresh hit must not trigger any scan at all');
});

test('getCachedStats serves a stale hit immediately and refreshes it in the background', async () => {
  const cache = new Map();
  const inFlight = new Map();
  cache.set('all', { result: 'stale-value', atMs: 0 });
  let resolveScan;
  let calls = 0;
  const scanFn = async () => {
    calls += 1;
    return new Promise((resolve) => { resolveScan = resolve; });
  };

  const result = await getCachedStats(cache, inFlight, 'all', 15000, scanFn, 20000);
  assert.equal(result, 'stale-value', 'a stale hit must return immediately, never blocking on the rescan');
  assert.equal(calls, 1, 'a background refresh must have started');
  assert.ok(inFlight.has('all'), 'the refresh must be tracked so a concurrent caller can dedupe against it');

  resolveScan('fresh-value');
  await new Promise((resolve) => setImmediate(resolve)); // let the background .then/.finally chain settle
  assert.equal(cache.get('all').result, 'fresh-value', 'the cache must update once the background refresh completes');
  assert.equal(inFlight.has('all'), false, 'in-flight tracking must clear once the refresh settles');
});

test('getCachedStats dedupes concurrent callers hitting the same stale key onto one background refresh', async () => {
  const cache = new Map();
  const inFlight = new Map();
  cache.set('all', { result: 'stale-value', atMs: 0 });
  let calls = 0;
  const scanFn = async () => { calls += 1; return 'fresh-value'; };

  const [a, b] = await Promise.all([
    getCachedStats(cache, inFlight, 'all', 15000, scanFn, 20000),
    getCachedStats(cache, inFlight, 'all', 15000, scanFn, 20000),
  ]);
  assert.equal(calls, 1, 'two callers hitting a stale cache together must share one background refresh');
  assert.equal(a, 'stale-value');
  assert.equal(b, 'stale-value');
});

test('getCachedStats blocks on the real scan only when there is no cached value at all', async () => {
  const cache = new Map();
  const inFlight = new Map();
  let calls = 0;
  const scanFn = async () => { calls += 1; return 'first-value'; };

  const result = await getCachedStats(cache, inFlight, 'all', 15000, scanFn, 1000);
  assert.equal(result, 'first-value');
  assert.equal(calls, 1);
  assert.equal(cache.get('all').result, 'first-value');
});

test('getCachedStats dedupes concurrent callers with no cached value onto one blocking scan', async () => {
  const cache = new Map();
  const inFlight = new Map();
  let calls = 0;
  const scanFn = async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return 'value';
  };

  const [a, b] = await Promise.all([
    getCachedStats(cache, inFlight, 'all', 15000, scanFn, 1000),
    getCachedStats(cache, inFlight, 'all', 15000, scanFn, 1000),
  ]);
  assert.equal(calls, 1);
  assert.equal(a, 'value');
  assert.equal(b, 'value');
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

test('computeGlobalStats merges Grok turn_completed usage into the heatmap totals', async () => {
  const claudeRoot = await mkdtemp(path.join(tmpdir(), 'cockpit-stats-claude-'));
  const grokRoot = await mkdtemp(path.join(tmpdir(), 'cockpit-stats-grok-'));
  try {
    const proj = path.join(claudeRoot, '-Users-x-proj');
    await mkdir(proj, { recursive: true });
    await writeFile(
      path.join(proj, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
      assistantLine('2026-09-06T12:00:00.000Z', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 5 }) + '\n',
    );

    const grokDir = path.join(grokRoot, encodeURIComponent('D:\\proj'), 'sess-grok');
    await mkdir(grokDir, { recursive: true });
    await writeFile(path.join(grokDir, 'summary.json'), JSON.stringify({ current_model_id: 'grok-4.6' }));
    await writeFile(path.join(grokDir, 'updates.jsonl'), JSON.stringify({
      timestamp: Date.parse('2026-09-06T18:00:00.000Z') / 1000,
      params: {
        update: {
          sessionUpdate: 'turn_completed',
          usage: { inputTokens: 50, outputTokens: 8, cachedReadTokens: 20, costUsdTicks: 53492200 },
        },
      },
    }) + '\n');

    const stats = await computeGlobalStats(claudeRoot, {
      range: 'all',
      now: Date.parse('2026-09-07T12:00:00.000Z'),
      grokSessionsDir: grokRoot,
    });
    assert.equal(stats.sessions, 2);
    assert.equal(stats.inputTokens, 60);
    assert.equal(stats.outputTokens, 13);
    assert.equal(stats.cacheReadTokens, 20);
    assert.equal(stats.activeDays, 1);
    assert.ok(stats.perModel.some((row) => row.model === 'grok-4.6'));
    assert.equal(stats.perProvider.claude.sessions, 1);
    assert.equal(stats.perProvider.grok.sessions, 1);
    assert.equal(stats.perProvider.claude.inputTokens, 10);
    assert.equal(stats.perProvider.grok.inputTokens, 50);
  } finally {
    await rm(claudeRoot, { recursive: true, force: true });
    await rm(grokRoot, { recursive: true, force: true });
  }
});

test('computeGlobalStats counts Codex thread activity without adding token totals', async () => {
  const claudeRoot = await mkdtemp(path.join(tmpdir(), 'cockpit-stats-codex-'));
  try {
    const proj = path.join(claudeRoot, '-Users-x-proj');
    await mkdir(proj, { recursive: true });
    await writeFile(
      path.join(proj, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
      assistantLine('2026-09-06T12:00:00.000Z', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 5 }) + '\n',
    );

    const stats = await computeGlobalStats(claudeRoot, {
      range: 'all',
      now: Date.parse('2026-09-07T12:00:00.000Z'),
      grokSessionsDir: path.join(claudeRoot, 'no-grok'),
      scanCodexSessions: async () => [{
        firstTs: Date.parse('2026-09-06T10:00:00.000Z'),
        lastTs: Date.parse('2026-09-06T18:00:00.000Z'),
        rows: [{ ts: Date.parse('2026-09-06T18:00:00.000Z'), model: null, usage: null }],
      }],
    });
    assert.equal(stats.sessions, 2);
    assert.equal(stats.inputTokens, 10);
    assert.equal(stats.outputTokens, 5);
    assert.equal(stats.activeDays, 1);
    assert.equal(stats.perModel.some((row) => row.model === 'codex'), false);
    assert.equal(stats.perProvider.codex.sessions, 1);
    assert.equal(stats.perProvider.codex.costUsd, 0);
  } finally {
    await rm(claudeRoot, { recursive: true, force: true });
  }
});

test('computeGlobalStats keeps Claude totals when the Codex scan fails', async () => {
  const claudeRoot = await mkdtemp(path.join(tmpdir(), 'cockpit-stats-codex-fail-'));
  try {
    const proj = path.join(claudeRoot, '-Users-x-proj');
    await mkdir(proj, { recursive: true });
    await writeFile(
      path.join(proj, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa.jsonl'),
      assistantLine('2026-09-06T12:00:00.000Z', 'claude-sonnet-5', { input_tokens: 10, output_tokens: 5 }) + '\n',
    );

    const stats = await computeGlobalStats(claudeRoot, {
      range: 'all',
      now: Date.parse('2026-09-07T12:00:00.000Z'),
      grokSessionsDir: path.join(claudeRoot, 'no-grok'),
      scanCodexSessions: async () => { throw new Error('app-server down'); },
    });
    assert.equal(stats.sessions, 1);
    assert.equal(stats.inputTokens, 10);
  } finally {
    await rm(claudeRoot, { recursive: true, force: true });
  }
});
