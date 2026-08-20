// All-projects usage stats for cockpit's Settings > Stats tab - a GitHub-
// style heatmap plus overview numbers, in the spirit of Claude Code's own
// `/stats`. Deliberately NOT built on `~/.claude/stats-cache.json` (the
// CLI's own persisted cache for that screen): that file only exists/updates
// when `/stats` has actually been opened in the terminal at least once, and
// its `lastComputedDate` can lag real usage by a day or more - exactly the
// "requires a previous CLI launch" and "not live" gaps flagged in review
// (2026-08-20). This module instead re-derives everything itself, on every
// request, straight from the same `~/.claude/projects/**/*.jsonl` transcripts
// session-launcher.js/session-history.js already read - real per-message
// `usage` blocks, not an estimate, and available from a fresh cockpit
// install with no CLI warm-up step.
//
// The one honest limitation, not papered over: Claude Code prunes old
// transcript files (see `~/.claude/.last-cleanup`), so history older than
// whatever's still on disk simply isn't visible here - narrower than the
// CLI's own cache in that one respect, but everything shown is exact for
// the window it does cover.
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';
import { listAllSessionFiles } from './session-launcher.js';
import { costForUsage } from './usage.js';

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
  const modelTokens = new Map(); // model -> input+output tokens (favorite-model ranking only)
  // model -> {inputTokens,outputTokens,cacheReadTokens,cacheWriteTokens,costUsd,calls} for the
  // per-model cost table. Built via costForUsage (src/usage.js) - the exact same per-message
  // pricing math the live per-session stats panel uses, not a separate estimate - so a model
  // missing from pricing.json/pricing_grok.json is tracked in unpricedModels below instead of
  // silently contributing a wrong $0.
  const perModelStats = new Map();
  const unpricedModels = new Set();
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheWrite = 0;
  let sessionsInRange = 0;
  let longestSessionMs = 0;

  for (const { rows, firstTs, lastTs } of sessionScans) {
    const inRangeRows = cutoff ? rows.filter((r) => r.ts && r.ts >= cutoff) : rows;
    if (inRangeRows.length === 0) continue;
    sessionsInRange += 1;
    if (firstTs != null && lastTs != null) longestSessionMs = Math.max(longestSessionMs, lastTs - firstTs);

    for (const row of inRangeRows) {
      if (row.ts) {
        const key = dayKey(row.ts);
        dailyCounts.set(key, (dailyCounts.get(key) || 0) + 1);
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
        if (info) {
          const m = perModelStats.get(row.model)
            || { model: row.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, calls: 0 };
          m.inputTokens += info.inputTokens;
          m.outputTokens += info.outputTokens;
          m.cacheReadTokens += info.readTokens;
          m.cacheWriteTokens += info.writeTokens;
          m.costUsd += info.cost;
          m.calls += 1;
          perModelStats.set(row.model, m);
        } else {
          unpricedModels.add(row.model);
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

export async function computeGlobalStats(projectsDir = PROJECTS_DIR, { range = 'all', now = Date.now() } = {}) {
  const files = await listAllSessionFiles(projectsDir);
  const scans = await Promise.all(files.map((f) => scanSessionFile(f.filePath)));
  return aggregateGlobalStats(scans, { range, now });
}
