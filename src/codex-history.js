import { getCodexAppServerManager } from './codex-app-server.js';
import { codexThreadToMessages } from './codex-messages.js';
import { createReadStream } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import path from 'node:path';

function millis(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'number') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return value < 10_000_000_000 ? value * 1000 : value;
}

export function codexSessionsRoot(home = homedir()) {
  return path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'sessions');
}

function numberOrZero(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function sessionIdFromFile(filePath) {
  const name = path.basename(filePath, path.extname(filePath));
  const match = name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return match ? match[1] : null;
}

function modelFromEntry(entry) {
  const payload = entry?.payload || {};
  return payload.model
    || payload.base_instructions?.provenance?.model
    || payload.base_instructions?.model
    || null;
}

// Codex rollout usage uses the app-server shape: input_tokens includes the
// cached subset. Normalize it to the shared accounting shape used by
// costForUsage(), where input_tokens means uncached input.
function usageToShared(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const rawInput = raw.input_tokens ?? raw.inputTokens;
  const rawOutput = raw.output_tokens ?? raw.outputTokens;
  if (rawInput == null && rawOutput == null) return null;

  const hasCachedAppServerShape = raw.cached_input_tokens != null
    || raw.cachedInputTokens != null
    || raw.cache_write_input_tokens != null
    || raw.cacheWriteInputTokens != null
    || raw.input_tokens_details?.cached_tokens != null
    || raw.inputTokensDetails?.cachedTokens != null;
  const cached = numberOrZero(raw.cached_input_tokens ?? raw.cachedInputTokens
    ?? raw.cache_read_input_tokens ?? raw.input_tokens_details?.cached_tokens
    ?? raw.inputTokensDetails?.cachedTokens);
  const written = numberOrZero(raw.cache_write_input_tokens ?? raw.cacheWriteInputTokens
    ?? raw.cache_creation_input_tokens ?? raw.cacheCreationInputTokens);
  const input = numberOrZero(rawInput);

  return {
    input_tokens: hasCachedAppServerShape ? Math.max(0, input - cached - written) : input,
    output_tokens: numberOrZero(rawOutput),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: written,
    reasoning_output_tokens: numberOrZero(raw.reasoning_output_tokens ?? raw.reasoningOutputTokens),
    total_tokens: numberOrZero(raw.total_tokens ?? raw.totalTokens),
  };
}

function usageRecord(entry) {
  const payload = entry?.payload || {};
  if (entry?.type === 'token_usage_record') {
    return {
      kind: 'record',
      turnId: payload.turn_id || payload.turnId || null,
      model: payload.model || null,
      usage: usageToShared(payload.usage || payload.last_token_usage || payload.lastTokenUsage),
    };
  }
  // Pre-token_usage_record Codex rollouts persisted the same per-response
  // usage under event_msg/token_count. Prefer the newer records when both
  // formats are present because token_count is a compatibility fallback.
  if (entry?.type === 'event_msg' && payload.type === 'token_count') {
    const info = payload.info || {};
    return {
      kind: 'legacy',
      turnId: payload.turn_id || payload.turnId || null,
      model: payload.model || null,
      usage: usageToShared(info.last_token_usage || info.lastTokenUsage),
    };
  }
  return null;
}

function addTimestamp(state, value) {
  const timestamp = millis(value);
  if (timestamp == null) return;
  if (state.firstTs == null || timestamp < state.firstTs) state.firstTs = timestamp;
  if (state.lastTs == null || timestamp > state.lastTs) state.lastTs = timestamp;
}

// The Codex app-server does not put usage on thread/list or thread/read
// today. The rollout files do persist it, though: recent versions use
// token_usage_record and older versions use event_msg/token_count.
export async function scanCodexUsageFile(filePath) {
  const state = { firstTs: null, lastTs: null };
  const usageRows = [];
  const legacyRows = [];
  const turnModels = new Map();
  let fallbackModel = null;
  let sessionId = sessionIdFromFile(filePath);
  let rl;
  try {
    rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
  } catch {
    return { sessionId, rows: [], firstTs: state.firstTs, lastTs: state.lastTs };
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

      addTimestamp(state, entry.timestamp);
      if (entry.type === 'session_meta') {
        addTimestamp(state, entry.payload?.timestamp);
        sessionId = entry.payload?.session_id || entry.payload?.id || sessionId;
        fallbackModel = modelFromEntry(entry) || fallbackModel;
      } else if (entry.type === 'turn_context') {
        const turnId = entry.payload?.turn_id || entry.payload?.turnId;
        const model = modelFromEntry(entry);
        if (turnId && model) turnModels.set(turnId, model);
        fallbackModel = model || fallbackModel;
      }

      const record = usageRecord(entry);
      if (!record?.usage) continue;
      const row = {
        ts: millis(entry.timestamp),
        turnId: record.turnId,
        // Older token_count events do not carry a turn id. Capture the model
        // at the point of the record instead of applying the last model in
        // the file to every historical response.
        model: record.model || (record.turnId ? null : fallbackModel),
        usage: record.usage,
      };
      if (record.kind === 'record') usageRows.push(row);
      else legacyRows.push(row);
    }
  } catch {
    // Truncated/unreadable file mid-stream - keep whatever was parsed.
  }

  const selectedRows = usageRows.length ? usageRows : legacyRows;
  const rows = selectedRows.map(({ turnId, model, ...row }) => ({
    ...row,
    model: model || turnModels.get(turnId) || fallbackModel || null,
  }));
  // Keep activity visible for an old/empty rollout, matching the app-server
  // thread/list fallback below. It has no cost or token claim.
  if (rows.length === 0 && state.lastTs != null) {
    rows.push({ ts: state.lastTs, model: fallbackModel || null, usage: null });
  }
  return { sessionId, rows, firstTs: state.firstTs, lastTs: state.lastTs };
}

export async function listAllCodexSessionFiles(sessionsDir = codexSessionsRoot()) {
  const files = [];
  async function walk(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(entryPath);
    }
  }
  await walk(sessionsDir);
  return files.sort();
}

function describeThread(thread) {
  return {
    sessionId: thread.id,
    cwd: thread.cwd || null,
    projectDirName: thread.cwd || '',
    label: thread.name || thread.preview || null,
    title: thread.name || null,
    mtimeMs: millis(thread.updatedAt || thread.createdAt) || 0,
    provider: 'codex',
    // The app-server's documented Thread schema (thread/list and
    // thread/read alike) has no model field - thread.model reads as
    // undefined today. Left in rather than removed in case a future
    // app-server version adds it; null is the honest fallback either way.
    model: thread.model || null,
  };
}

export async function listCodexSessions(manager = getCodexAppServerManager()) {
  const result = await manager.request('thread/list', {
    limit: 30,
    sortKey: 'updated_at',
  });
  return (result?.data || []).map(describeThread);
}

// Resume list stays newest-30. Stats needs every thread the app-server
// will return, paginated the same way model/list is.
export async function listAllCodexThreads(manager = getCodexAppServerManager()) {
  const threads = [];
  let cursor;
  do {
    const result = await manager.request('thread/list', {
      limit: 100,
      sortKey: 'updated_at',
      ...(cursor ? { cursor } : {}),
    });
    threads.push(...(result?.data || []));
    cursor = result?.nextCursor || null;
  } while (cursor);
  return threads;
}

// Merge durable token records with thread/list activity. A file scan is the
// source of cost/tokens; thread/list fills the gaps for sessions whose files
// have been pruned or whose app-server version has not written usage records.
export async function scanCodexUsageSessions(manager = getCodexAppServerManager(), options = {}) {
  const normalizedOptions = (typeof options === 'string' ? { sessionsDir: options } : options) || {};
  const files = await listAllCodexSessionFiles(normalizedOptions.sessionsDir || codexSessionsRoot());
  const fileScans = await Promise.all(files.map((filePath) => scanCodexUsageFile(filePath)));
  const scansById = new Map();
  const scans = [];
  for (const scan of fileScans) {
    const existing = scan.sessionId ? scansById.get(scan.sessionId) : null;
    if (!existing) {
      scans.push(scan);
      if (scan.sessionId) scansById.set(scan.sessionId, scan);
      continue;
    }
    existing.rows.push(...scan.rows);
    if (scan.firstTs != null && (existing.firstTs == null || scan.firstTs < existing.firstTs)) existing.firstTs = scan.firstTs;
    if (scan.lastTs != null && (existing.lastTs == null || scan.lastTs > existing.lastTs)) existing.lastTs = scan.lastTs;
  }

  let threads = [];
  try {
    threads = await listAllCodexThreads(manager);
  } catch {
    // Local rollout usage remains useful when the app-server is unavailable.
  }
  for (const thread of threads) {
    const lastTs = millis(thread.updatedAt || thread.createdAt);
    const firstTs = millis(thread.createdAt) ?? lastTs;
    const existing = thread.id ? scansById.get(thread.id) : null;
    if (existing) {
      if (firstTs != null && (existing.firstTs == null || firstTs < existing.firstTs)) existing.firstTs = firstTs;
      if (lastTs != null && (existing.lastTs == null || lastTs > existing.lastTs)) existing.lastTs = lastTs;
      const fallbackRow = existing.rows.length === 1 && existing.rows[0].usage == null ? existing.rows[0] : null;
      if (fallbackRow && existing.lastTs != null) fallbackRow.ts = existing.lastTs;
      if (thread.model && existing.rows.every((row) => !row.model)) {
        for (const row of existing.rows) row.model = thread.model;
      }
      continue;
    }
    const scan = {
      sessionId: thread.id || null,
      rows: lastTs ? [{ ts: lastTs, model: thread.model || null, usage: null }] : [],
      firstTs,
      lastTs,
    };
    scans.push(scan);
    if (thread.id) scansById.set(thread.id, scan);
  }
  return scans;
}

export async function fetchCodexSessionHistory(threadId, cwd, manager = getCodexAppServerManager()) {
  const result = await manager.request('thread/read', { threadId, includeTurns: true });
  if (!result?.thread) throw new Error(`Codex thread not found: ${threadId}`);
  return codexThreadToMessages(result.thread);
}
