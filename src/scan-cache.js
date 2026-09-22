// Shared by global-stats.js (Claude/Grok/Codex transcript scans for
// Settings > Stats) and codex-history.js's own per-file scan fan-out:
// bounded concurrency for hundreds of transcript reads at once, and an
// mtime-keyed memoization cache so a file untouched since its last scan is
// served from memory instead of re-read and re-parsed. In-memory only,
// process-lifetime by design - not persisted to disk. A persisted cache
// needs its own invalidation format and survives-a-restart guarantees;
// real design work this anticipatory optimization (no observed slowness
// yet) doesn't need to take on.

const scanCacheByPath = new Map(); // filePath -> { mtimeMs, result }

// `scanFn(filePath)` only actually runs when `mtimeMs` doesn't match what's
// cached for this path - an untouched file is served from memory.
export async function cachedScan(filePath, mtimeMs, scanFn) {
  const cached = scanCacheByPath.get(filePath);
  if (cached && cached.mtimeMs === mtimeMs) return cached.result;
  const result = await scanFn(filePath);
  scanCacheByPath.set(filePath, { mtimeMs, result });
  return result;
}

// Test-only: keeps one test's cached scans from leaking into another's
// assertions, same purpose as global-stats.js's own cache being per-Map.
export function _resetScanCache() {
  scanCacheByPath.clear();
}

// Reasonable default for local-disk I/O fan-out - high enough to keep
// hundreds of small files moving, low enough that a handful of huge
// transcripts (tens of MB, seen on real machines) don't all get read into
// memory at once.
export const DEFAULT_SCAN_CONCURRENCY = 8;

// Promise.all's unbounded fan-out is fine for a handful of files, but spikes
// fd/memory usage scanning hundreds of transcripts at once. `limit` workers
// pull from a shared cursor instead of firing every call simultaneously.
export async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i], i);
    }
  }
  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
