// All-projects usage stats for cockpit's Settings > Stats tab. Deliberately
// NOT built on `~/.claude/stats-cache.json`, which only updates once
// `/stats` has run in the terminal and can lag real usage. Instead
// re-derives everything from local transcripts: Claude JSONL under
// ~/.claude/projects, Grok updates.jsonl under ~/.grok/sessions, and Codex
// rollout JSONL under ~/.codex/sessions, with thread/list activity as a
// fallback for records that are no longer on disk.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { listAllSessionFiles } from './session-launcher.js';
import { grokSessionsRoot, listAllGrokSessionFiles } from './grok-launcher.js';
import { scanGrokUsageFile } from './grok-history.js';
import { scanCodexUsageSessions } from './codex-history.js';
import { costForUsage } from './usage.js';
import { cachedScan, mapWithConcurrency, DEFAULT_SCAN_CONCURRENCY } from './scan-cache.js';

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');

const RANGE_DAYS = { '7d': 7, '30d': 30, all: null };

function dayKey(ts) {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Local-midnight Date for a "YYYY-MM-DD" key - all day arithmetic below goes
// through this (not Date.parse/ISO-UTC) so it agrees with dayKey's own
// local-calendar reckoning; mixing the two would off-by-one the streak count
// for anyone not on UTC.
function dayKeyToLocalDate(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function daysBetween(dayA, dayB) {
  return Math.round((dayKeyToLocalDate(dayB) - dayKeyToLocalDate(dayA)) / 86400000);
}

function addDays(key, delta) {
  const dt = dayKeyToLocalDate(key);
  dt.setDate(dt.getDate() + delta);
  return dayKey(dt.getTime());
}

const STATS_PROVIDERS = ['claude', 'grok', 'codex'];

function emptyProviderTotals() {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, sessions: 0 };
}

// Reads one session transcript down to the handful of fields the aggregator
// needs: one row per assistant message that actually carries `usage`
// (skips tool_result echoes, meta/sentinel lines, thinking-only deltas,
// etc.), plus the file's own first/last timestamp for session-duration.
async function scanSessionFile(filePath) {
  const rows = [];
  let firstTs = null;
  let lastTs = null;
  let rl;
  try {
    rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
  } catch {
    return { rows, firstTs, lastTs };
  }
  try {
    for await (const line of rl) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      const ts = entry.timestamp ? Date.parse(entry.timestamp) : NaN;
      if (Number.isFinite(ts)) {
        if (firstTs == null || ts < firstTs) firstTs = ts;
        if (lastTs == null || ts > lastTs) lastTs = ts;
      }
      if (entry.type === 'assistant' && entry.message && entry.message.usage) {
        rows.push({ ts: Number.isFinite(ts) ? ts : null, model: entry.message.model || null, usage: entry.message.usage });
      }
    }
  } catch {
    // Truncated/unreadable file mid-stream - keep whatever was parsed so
    // far rather than losing the whole session over one bad tail.
  }
  return { rows, firstTs, lastTs };
}

// Pure aggregation over already-scanned sessions - split out from
// computeGlobalStats so it's unit-testable without touching the filesystem.
export function aggregateGlobalStats(sessionScans, { range = 'all', now = Date.now() } = {}) {
  const rangeDays = RANGE_DAYS[range] ?? null;
  const cutoff = rangeDays ? now - rangeDays * 86400000 : null;

  const dailyCounts = new Map(); // dayKey -> assistant-message count
  const dailyByProvider = new Map(); // dayKey -> { claude, grok, codex }
  const perProvider = Object.fromEntries(STATS_PROVIDERS.map((id) => [id, emptyProviderTotals()]));
  const modelTokens = new Map(); // model -> input+output tokens (favorite-model ranking only)
  // model -> {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,
  // costUsd,calls} for the per-model cost table. Built via costForUsage
  // (src/usage.js), the same per-message pricing math the live stats panel
  // uses - a model missing from pricing.json/pricing_grok.json is tracked
  // in unpricedModels below instead of silently contributing a wrong $0.
  const perModelStats = new Map();
  const unpricedModels = new Set();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let sessionsInRange = 0;
  let longestSessionMs = 0;

  for (const { rows, firstTs, lastTs, provider } of sessionScans) {
    const inRangeRows = cutoff ? rows.filter((r) => r.ts && r.ts >= cutoff) : rows;
    if (inRangeRows.length === 0) continue;
    sessionsInRange += 1;
    if (provider && perProvider[provider]) perProvider[provider].sessions += 1;
    // "Longest session" must be the span WITHIN the selected range, not the
    // whole file's firstTs/lastTs - otherwise one message inside a `range=7d`
    // window but a real span going back a month would report that full
    // month as its duration. 'all' needs no filtering, so the whole-file
    // span (already tracked by scanSessionFile) is exact either way.
    let rangeFirstTs = firstTs;
    let rangeLastTs = lastTs;
    if (cutoff) {
      // Loop instead of Math.min/max(...inRangeTimestamps) - spreading a
      // single session's in-range rows as call arguments can exceed the
      // engine's argument-count limit for a session with tens of thousands
      // of usage-bearing messages (a real, if rare, shape for a long
      // scripted/automated run).
      rangeFirstTs = null;
      rangeLastTs = null;
      for (const row of inRangeRows) {
        const ts = row.ts;
        if (ts == null) continue;
        if (rangeFirstTs == null || ts < rangeFirstTs) rangeFirstTs = ts;
        if (rangeLastTs == null || ts > rangeLastTs) rangeLastTs = ts;
      }
    }
    if (rangeFirstTs != null && rangeLastTs != null) longestSessionMs = Math.max(longestSessionMs, rangeLastTs - rangeFirstTs);

    for (const row of inRangeRows) {
      if (row.ts) {
        const key = dayKey(row.ts);
        dailyCounts.set(key, (dailyCounts.get(key) || 0) + 1);
        if (provider && perProvider[provider]) {
          const byP = dailyByProvider.get(key) || {};
          byP[provider] = (byP[provider] || 0) + 1;
          dailyByProvider.set(key, byP);
        }
      }
      const u = row.usage || {};
      const input = u.input_tokens || 0;
      const output = u.output_tokens || 0;
      const cacheRead = u.cache_read_input_tokens || 0;
      const cc = u.cache_creation || {};
      const cacheWrite = (cc.ephemeral_5m_input_tokens || 0) + (cc.ephemeral_1h_input_tokens || 0)
        + (!u.cache_creation && u.cache_creation_input_tokens ? u.cache_creation_input_tokens : 0);
      totalInput += input;
      totalOutput += output;
      totalCacheRead += cacheRead;
      totalCacheWrite += cacheWrite;
      if (row.model) modelTokens.set(row.model, (modelTokens.get(row.model) || 0) + input + output);

      if (row.model) {
        const info = costForUsage(row.model, row.usage);
        // info is only null when row.usage itself is missing now - an
        // unpriced model still returns its real token breakdown (cost:
        // null), so it stays in the per-model table with a $0 cost line
        // instead of getting excluded from it entirely.
        if (info) {
          const m = perModelStats.get(row.model)
            || { model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 };
          m.inputTokens += info.inputTokens;
          m.outputTokens += info.outputTokens;
          m.cacheReadTokens += info.readTokens;
          m.cacheWriteTokens += info.writeTokens;
          if (info.cost == null) unpricedModels.add(row.model);
          else m.costUsd += info.cost;
          m.calls += 1;
          perModelStats.set(row.model, m);
          if (provider && perProvider[provider]) {
            perProvider[provider].inputTokens += info.inputTokens;
            perProvider[provider].outputTokens += info.outputTokens;
            if (info.cost != null) perProvider[provider].costUsd += info.cost;
          }
        }
      }
    }
  }

  const activeDayKeys = [...dailyCounts.keys()].sort();
  const { longestStreak, currentStreak } = computeStreaks(activeDayKeys, now);
  const mostActiveDay = activeDayKeys.reduce(
    (best, day) => (!best || dailyCounts.get(day) > dailyCounts.get(best) ? day : best),
    null,
  );
  const favoriteModel = [...modelTokens.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
  const totalDaysSpan = activeDayKeys.length ? daysBetween(activeDayKeys[0], dayKey(now)) + 1 : 0;

  const perModel = [...perModelStats.values()]
    .map((m) => ({ ...m, totalTokens: m.inputTokens + m.outputTokens + m.cacheReadTokens + m.cacheWriteTokens }))
    // Drops zero-token rows - notably the SDK's own "<synthetic>" model id
    // (compaction markers etc., zero-rated on purpose in pricing.json - see
    // its own "confidence" note) - correct at $0 either way, just noise in
    // a cost table.
    .filter((m) => m.totalTokens > 0)
    .sort((a, b) => b.costUsd - a.costUsd);
  const totalCostUsd = perModel.reduce((sum, m) => sum + m.costUsd, 0);

  return {
    dailyCounts: Object.fromEntries(dailyCounts),
    dailyByProvider: Object.fromEntries(dailyByProvider),
    perProvider,
    favoriteModel,
    totalTokens: totalInput + totalOutput + totalCacheRead + totalCacheWrite,
    inputTokens: totalInput,
    outputTokens: totalOutput,
    cacheReadTokens: totalCacheRead,
    cacheWriteTokens: totalCacheWrite,
    sessions: sessionsInRange,
    activeDays: activeDayKeys.length,
    totalDaysSpan,
    mostActiveDay,
    longestSessionMs,
    longestStreak,
    currentStreak,
    earliestDay: activeDayKeys[0] || null,
    perModel,
    unpricedModels: [...unpricedModels],
    totalCostUsd,
  };
}

function computeStreaks(sortedDayKeys, now) {
  if (sortedDayKeys.length === 0) return { longestStreak: 0, currentStreak: 0 };

  let longest = 1;
  let run = 1;
  for (let i = 1; i < sortedDayKeys.length; i += 1) {
    run = daysBetween(sortedDayKeys[i - 1], sortedDayKeys[i]) === 1 ? run + 1 : 1;
    longest = Math.max(longest, run);
  }

  // Current streak: walk back from today (or yesterday, if today has no
  // activity logged yet) while consecutive days are present.
  const todayKey = dayKey(now);
  const set = new Set(sortedDayKeys);
  let cursor = set.has(todayKey) ? todayKey : addDays(todayKey, -1);
  let current = 0;
  while (set.has(cursor)) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  return { longestStreak: longest, currentStreak: current };
}

// /api/stats has no session token gate, only Origin/Host allowlisting,
// and re-parses every local transcript per call. This TTL lets a burst of
// Stats-tab opens share one scan instead of paying the full re-parse each
// time, and a STALE hit (past the TTL) is still served immediately rather
// than blocking the request - see getCachedStats below. Only engaged when
// `projectsDir` is the real default, so tests passing their own dir always
// get a fresh scan.
const STATS_CACHE_TTL_MS = 15_000;
const statsCache = new Map(); // range -> { result, atMs }
const statsInFlight = new Map(); // range -> Promise

// Stale-while-revalidate, split out for direct unit testing (fake cache/
// in-flight Maps, controlled `now`) without touching the real filesystem -
// same reasoning as aggregateGlobalStats being split from
// computeGlobalStats. A fresh hit returns immediately with no work done. A
// STALE hit also returns immediately (a caller never blocks on a rescan
// once anything has been cached once) but kicks a background refresh,
// deduped against any refresh already in flight. Only a key with no cached
// value at all blocks on the real scan - there's nothing else to serve.
export async function getCachedStats(cache, inFlight, key, ttlMs, scanFn, now = Date.now()) {
  const hit = cache.get(key);
  if (hit) {
    if (now - hit.atMs < ttlMs) return hit.result;
    scheduleBackgroundRefresh(cache, inFlight, key, scanFn);
    return hit.result;
  }
  const pending = inFlight.get(key);
  if (pending) return pending;
  return trackRefresh(cache, inFlight, key, scanFn);
}

function scheduleBackgroundRefresh(cache, inFlight, key, scanFn) {
  if (inFlight.has(key)) return; // a refresh for this key is already running
  // Fire-and-forget: nothing is awaiting this branch, and a failed
  // background refresh just leaves the existing stale value in place for
  // the next request to retry, rather than surfacing an error nobody asked
  // for right now.
  trackRefresh(cache, inFlight, key, scanFn).catch(() => {});
}

function trackRefresh(cache, inFlight, key, scanFn) {
  const tracked = scanFn().then((result) => {
    cache.set(key, { result, atMs: Date.now() });
    return result;
  }).finally(() => inFlight.delete(key));
  inFlight.set(key, tracked);
  return tracked;
}

async function scanAllProviders(projectsDir, grokSessionsDir, scanCodex) {
  const claudeFiles = await listAllSessionFiles(projectsDir);
  const scans = await mapWithConcurrency(claudeFiles, DEFAULT_SCAN_CONCURRENCY, async (f) => ({
    ...await cachedScan(f.filePath, f.mtimeMs, scanSessionFile),
    provider: 'claude',
  }));
  if (grokSessionsDir) {
    const grokFiles = await listAllGrokSessionFiles(grokSessionsDir);
    scans.push(...await mapWithConcurrency(grokFiles, DEFAULT_SCAN_CONCURRENCY, async (f) => ({
      // summary.json (session model fallback) isn't itself mtime-tracked,
      // only updates.jsonl is - an accepted staleness tradeoff for keeping
      // this cache in-memory-simple (scan-cache.js), not a bug: the two
      // files are written together in practice.
      ...await cachedScan(f.filePath, f.mtimeMs, (filePath) => scanGrokUsageFile(filePath, { summaryPath: f.summaryPath })),
      provider: 'grok',
    })));
  }
  if (scanCodex) {
    try {
      const codexScans = await scanCodex();
      scans.push(...codexScans.map((scan) => ({ ...scan, provider: 'codex' })));
    } catch {
      // Codex missing or app-server down: keep Claude/Grok totals.
    }
  }
  return scans;
}

export async function computeGlobalStats(projectsDir = PROJECTS_DIR, {
  range = 'all', now = Date.now(), grokSessionsDir, scanCodexSessions,
} = {}) {
  const grokDir = grokSessionsDir === undefined
    ? (projectsDir === PROJECTS_DIR ? grokSessionsRoot() : null)
    : grokSessionsDir;
  const codexScan = scanCodexSessions === undefined
    ? (projectsDir === PROJECTS_DIR ? () => scanCodexUsageSessions() : null)
    : scanCodexSessions;
  const cacheable = projectsDir === PROJECTS_DIR
    && grokSessionsDir === undefined
    && scanCodexSessions === undefined;
  if (!cacheable) {
    const scans = await scanAllProviders(projectsDir, grokDir, codexScan);
    return aggregateGlobalStats(scans, { range, now });
  }
  // Aggregation uses a fresh Date.now() (not the possibly-stale `now`
  // captured above) - correct for a background refresh that completes
  // later, and equivalent for every real caller today, since system.js's
  // route never passes an explicit `now` and the blocking first-ever-call
  // path runs immediately anyway.
  const scanFn = async () => {
    const scans = await scanAllProviders(projectsDir, grokDir, codexScan);
    return aggregateGlobalStats(scans, { range, now: Date.now() });
  };
  return getCachedStats(statsCache, statsInFlight, range, STATS_CACHE_TTL_MS, scanFn, now);
}
