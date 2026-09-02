// Cockpit-id-keyed session table (Claude's own session id is a mutable
// attribute refreshed as messages arrive). A row is the live, in-memory
// mirror of one session's SDK-reported state - purely ephemeral, gone the
// moment the session closes, unlike localStorage or the per-project
// settings.local.json stores server.js bridges it to. Stays filesystem-free.
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { countWithinTokenBudget, countRealUserTurns, INITIAL_HISTORY_TOKEN_BUDGET } from './session-history.js';
import { createEventLog, append as appendEvent, replay as replayEvents } from './event-log.js';
import { createUsageAccumulator, costForUsage } from './usage.js';
import { contextPayload } from './context-usage.js';
import { getProvider, parseProvider } from './provider-registry.js';
import { createDelegation } from './delegation.js';
const sessions = new Map();

// Cross-session delegation (handshake trust + `/ask`) lives in delegation.js,
// which takes these as constructor params instead of importing this module
// back (would be a cycle). pushTurn/broadcast/broadcastSummary/findByName
// are hoisted function declarations, so referencing them here before their
// textual definition is safe.
const delegation = createDelegation({ sessions, pushTurn, broadcast, broadcastSummary, findByName });
export const getHandshakeSecret = delegation.getHandshakeSecret;
export const regenerateHandshakeSecret = delegation.regenerateHandshakeSecret;
export const setSessionHandshake = delegation.setSessionHandshake;
export const isSessionTrusted = delegation.isSessionTrusted;
export const delegateTask = delegation.delegateTask;

export function createSession({ cwd, resume, name, model, permissionMode, history, provider, effort, startSessionImpl }) {
  // Authoritative uniqueness check for delegation names - this function has
  // no `await` before it and none until sessions.set() below, closing the
  // TOCTOU window server.js's own pre-check has (that check runs after
  // awaiting the resume-history fetch, so two concurrent creates for the
  // same name could both pass it). `err.code` lets server.js answer 409.
  if (name && findByName(cwd, name)) {
    const err = new Error(`a session named "${name}" already exists in this project`);
    err.code = 'ERR_NAME_TAKEN';
    throw err;
  }
  const providerDescriptor = parseProvider(provider);
  const resolvedProvider = providerDescriptor.id;
  // `startSessionImpl` can still be swapped for a stub in tests so unit
  // tests don't spawn a real CLI process.
  if (!startSessionImpl) startSessionImpl = providerDescriptor.startSession;
  const id = randomUUID();
  const token = randomUUID();
  const historyShownCount = history ? countWithinTokenBudget(history, INITIAL_HISTORY_TOKEN_BUDGET) : 0;
  const tail = history ? history.slice(history.length - historyShownCount) : [];

  const row = {
    id,
    token,
    name: name || null,
    cwd,
    provider: resolvedProvider,
    model: model || null,
    effort: effort || null,
    maxThinkingTokens: null, // set via setMaxThinkingTokens - null means "off" (SDK default, no forced budget)
    thinkingDisplay: null, // 'summarized' | 'omitted' | null (SDK default when thinking is on)
    state: 'starting', // starting | idle | running | error | closed
    mode: permissionMode || 'default',
    // Native conversation id reported by the active provider. toSummary()
    // derives the legacy claudeSessionId wire field from this plus
    // row.provider rather than keeping a second copy in lockstep, so a
    // Grok/Codex row doesn't claim a misleadingly-named "claudeSessionId".
    providerSessionId: resume || null,
    // See delegation.js's own handshakeSecret comment - stamped with
    // the CURRENT canonical value at creation, so a locally-spawned row is
    // trusted for delegation from the moment it exists.
    handshakeSecret: delegation.getHandshakeSecret(),
    // `enableFileCheckpointing` can't be turned on retroactively, so it
    // only covers this session's history if the cockpit started it fresh.
    // Any resumed session has no snapshots for earlier turns, so file
    // rewind must be off rather than attempted and failed.
    hasFileCheckpointing: providerDescriptor.capabilities.fileRewind && !resume,
    // `history` is null both for no resume (offset genuinely 0) and for a
    // resume whose fetchSessionHistory threw - distinguishing that from an
    // actually-empty transcript (`[]`) lets rewind() below refuse to run
    // instead of targeting the wrong turn.
    turnIndexUnreliable: Boolean(resume) && !history,
    createdAt: Date.now(),
    clients: new Set(),
    // Durable, sequence-numbered, byte-capped (event-log.js) - the resume
    // tail is seeded in here too so a reconnect's `since` replay and a
    // brand-new attach draw from the same source instead of two separate
    // buffers that could drift apart.
    eventLog: createEventLog(),
    historyTotal: history ? history.length : 0,
    historyShownCount, // fixed at creation - distinct from the event log, which keeps growing with live traffic
    // Unresolved approval requests in arrival order - a single field would
    // drop the earlier banner (and strand that tool call) whenever two
    // gated tools wait at once. A reconnecting client replays the whole list.
    pendingApprovals: [],
    // Live stats: cost/token totals accumulate from every assistant
    // message's `usage` (usage.js), no 1-turn lag. `contextUsage` is
    // refreshed separately (getContextUsage() is its own round trip to the
    // CLI, not free on every message) - see refreshContextUsage below.
    usageAcc: createUsageAccumulator(),
    contextUsage: null,
    rateLimits: null, // best-effort, see refreshRateLimits - stays null if the experimental API is unavailable/broken
    // Auto-continue (desktop's checkbox, see handleMessage's rate_limit_event
    // branch below): off by default, opt-in per session. rateLimitHit is set
    // the moment a 'rejected' rate_limit_event lands (the hard stop, not the
    // proactive 5h/7d utilization display above) and cleared once the limit
    // allows again or auto-continue actually fires.
    autoContinue: false,
    rateLimitHit: null, // { resetsAt, rateLimitType } | null
    autoContinueTimer: null,
    handle: null,
    // Cockpit-visible task list (TaskCreate/TaskUpdate/TaskList tool calls -
    // see applyTaskOp below). id -> { id, subject, status, owner, blockedBy }.
    // Purely reconstructed from watching the message stream - there's no SDK
    // query for "give me the current tasks" independent of a tool call.
    tasks: new Map(),
    // tool_use id -> { kind, input } for a Task* call whose result hasn't
    // arrived yet - applyTaskOp needs the ORIGINAL input (TaskUpdateOutput
    // only reports which field names changed, not their new values) matched
    // against the tool_result that confirms it succeeded. A call that never
    // gets a result just lingers harmlessly for the row's lifetime.
    pendingTaskOps: new Map(),
    // Visible input queue, kept live by session.js's onQueueChange: [{id,
    // text}], ordered. Not seeded from `history` on resume, same as `tasks`
    // above - a queue only ever holds turns pushed this process's lifetime.
    queue: [],
    // Cross-session delegation state does NOT live on the row - turn order
    // and per-turn `tag` are owned by the handle's result-epoch tracker
    // (fixing a prior hand-mirrored copy that drifted and misrouted
    // replies). `tag` is `null` or `{ fromId, fromName, task, buffer }`,
    // keyed by queueId.
  };
  // Resumed sessions never replay history through handleMessage - the
  // tail-append loop below just seeds the event log - so without this,
  // row.tasks/usageAcc stay empty until the first live turn. Walks the
  // FULL history (an out-of-budget figure should still count) and in
  // original order, since deriveTaskUpdate matches results against inputs.
  if (history) {
    for (const message of history) {
      applyAssistantUsage(row, message);
      deriveTaskUpdate(row, message);
    }
  }
  for (const message of tail) appendEvent(row.eventLog, message);
  sessions.set(id, row);

  row.handle = startSessionImpl({
    cwd,
    resume,
    model,
    effort: row.effort,
    permissionMode: row.mode,
    // Live turnIndex (session.js's turnCounter) must continue where the
    // resumed transcript's real user turns leave off, not restart at 0 -
    // otherwise rewind.js's resolveTurnUuid (which indexes into the whole
    // transcript) targets the wrong message. `history` here is already the
    // full fetched transcript (server.js), not the display-budget tail.
    turnIndexOffset: history ? countRealUserTurns(history) : 0,
    onMessage: (msg) => handleMessage(id, msg),
    onStateChange: (state) => setState(id, state),
    onError: (err) => handleError(id, err),
    onApprovalRequest: (request) => handleApprovalRequest(id, request),
    onQueueChange: (queue) => {
      row.queue = queue;
      broadcastQueue(id);
    },
    // MCP "needs-auth" badge - no row field to keep in sync; session.js's
    // getMcpAuthPending() is the source of truth, this just tells any open
    // MCP panel to re-fetch it (otherwise poll-on-open/refresh-button only,
    // so a panel left open through an auth flow would show a stale badge).
    onMcpAuthRequest: () => broadcastMcpAuth(id),
    onMcpAuthResolved: () => broadcastMcpAuth(id),
  });

  return row;
}

export function get(id) {
  return sessions.get(id);
}

// Cross-session delegation: name -> row lookup, scoped to one cwd so two
// unrelated projects can each have their own "Claude". Case-insensitive;
// cwd is path-canonicalized (resolve + Windows drive-letter case) so
// `D:\foo` vs `d:\foo` still match. Empty names never match.
function canonCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) return cwd;
  let resolved;
  try {
    resolved = path.resolve(cwd);
  } catch {
    resolved = cwd;
  }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function findByName(cwd, name) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const target = norm(name);
  if (!target) return null;
  const want = canonCwd(cwd);
  for (const row of sessions.values()) {
    if (canonCwd(row.cwd) === want && norm(row.name) === target) return row;
  }
  return null;
}

// Cross-session delegation: the ONE place that pushes a turn into a row's
// handle. `tag` is null for a non-delegated turn; a tagged turn registers
// against the queueId the turn tracker mints for it (result-epoch.js), so
// an interleaved human message can't desync the relay. `?? 0` covers a
// handle without a turn tracker rather than throwing on a summary broadcast.
function pendingTurnsCount(row) {
  return row.handle?.turns?.pendingCount ?? 0;
}

function pushTurn(row, text, tag = null) {
  const queueId = row.handle.pushInput(text);
  // `null` means pushInput did NOT enqueue anything (queue already closed,
  // or a grok duplicate-prompt guard). No result will ever come for a turn
  // that wasn't pushed, so registering a tag here would strand its origin
  // waiting forever - best-effort drop instead.
  if (queueId === null) return null;
  if (tag) row.handle.turns?.setTag(queueId, tag);
  // Returned so relayDelegationResult can correlate this turn's echoed
  // 'user' message (stamped with this queueId) with a later, separate
  // cockpit:delegate-full-trace marker. Other callers ignore the return.
  return queueId;
}

// Ends a session's live query() and drops its row. Nothing currently calls
// this automatically (see server.js's DELETE route comment) - sessions
// otherwise accumulate for the cockpit process's entire lifetime.
export function closeSession(id) {
  const row = sessions.get(id);
  if (!row) return false;
  clearAutoContinueTimer(row);
  // session.js's close() only interrupts the current turn; its `result`
  // still arrives asynchronously, but sessions.delete(id) below runs
  // synchronously, so handleMessage would find nothing and skip the
  // tag-claim/relay - stranding a delegation origin forever if not failed
  // explicitly here first.
  delegation.failPendingDelegations(row, 'the target session was closed before it replied');
  row.handle.close();
  sessions.delete(id);
  return true;
}

// Test-only: drop all rows so test files don't leak state into each other
// via this module's singleton map.
export function _reset() {
  sessions.clear();
}

export function list() {
  return [...sessions.values()].map(toSummary);
}

// Debug capture for "spinner spins, nothing running" reports: pendingTurns
// > 0 with no activity points at a turn-accounting bug, while
// pendingTurns === 0 with state still 'running' points at a dropped state
// broadcast instead - two bugs indistinguishable from the browser alone.
export function getDebugInfo(id) {
  const row = sessions.get(id);
  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    state: row.state,
    mode: row.mode,
    tabCount: row.clients.size,
    hasPendingApproval: row.pendingApprovals.length > 0,
    pendingApprovalToolName: row.pendingApprovals[0]?.toolName || null,
    pendingApprovalCount: row.pendingApprovals.length,
    queueLength: row.queue.length,
    pendingResultTagsLength: pendingTurnsCount(row),
    autoContinue: row.autoContinue,
    rateLimitHit: row.rateLimitHit,
    handle: row.handle?.debugSnapshot ? row.handle.debugSnapshot() : null,
  };
}

// Visibility-only introspection for GET /api/system/memory - reports what
// each row's unbounded-looking collections actually hold. Nothing here
// enforces a cap; eventLog is the one collection that's already byte-capped
// (event-log.js), included so its usage against that cap is visible.
// Read-only, so safe to poll from the dashboard on an interval.
export function memorySnapshot() {
  const rows = [...sessions.values()].map((row) => ({
    id: row.id,
    name: row.name,
    state: row.state,
    eventLogBytes: row.eventLog.bytes,
    eventLogMaxBytes: row.eventLog.maxBytes,
    eventLogEntries: row.eventLog.entries.length,
    tasks: row.tasks.size,
    pendingTaskOps: row.pendingTaskOps.size,
    pendingApprovals: row.pendingApprovals.length,
    pendingResultTags: pendingTurnsCount(row),
    queue: row.queue.length,
    clients: row.clients.size,
  }));
  return {
    process: process.memoryUsage(),
    sessionCount: rows.length,
    sessions: rows,
  };
}

export function toSummary(row) {
  const provider = getProvider(row.provider);
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    state: row.state,
    mode: row.mode,
    provider: row.provider,
    providerSessionId: row.providerSessionId,
    // Backward-compatible field for detail-pane.js/agent-liveness.js, which
    // fetch a subagent transcript from ~/.claude/projects - Claude-only.
    // Derived here, only for an actual Claude session, so a Grok/Codex row
    // doesn't claim a "claudeSessionId" that's really its own provider's id.
    claudeSessionId: row.provider === 'claude' ? row.providerSessionId : null,
    hasFileCheckpointing: row.hasFileCheckpointing,
    turnIndexUnreliable: row.turnIndexUnreliable,
    createdAt: row.createdAt,
    tabCount: row.clients.size,
    hasEarlierHistory: row.historyTotal > row.historyShownCount,
    model: row.model,
    maxThinkingTokens: row.maxThinkingTokens,
    thinkingDisplay: row.thinkingDisplay,
    effort: row.effort || null,
    autoContinue: row.autoContinue,
    rateLimitHit: row.rateLimitHit,
    // Whether this row is currently allowed to send/receive a delegated
    // task. The raw secret value itself is NOT included (only the server's
    // canonical copy is meant to be copied around, via /api/handshake).
    handshakeTrusted: delegation.isSessionTrusted(row),
    // Turns cockpit still considers "in flight", read off the handle's
    // turn tracker (result-epoch.js). Surfaced so app.js can show it next
    // to the spinner without polling the debug endpoint - see forceIdle
    // below for manual recovery if this drifts and never returns to 0.
    pendingTurnsCount: pendingTurnsCount(row),
    capabilities: {
      ...provider.capabilities,
      // Checkpointing is session-specific: even a provider that supports
      // it cannot rewind files for a transcript it resumed midstream.
      fileRewind: provider.capabilities.fileRewind && row.hasFileCheckpointing,
    },
  };
}

export function checkToken(id, token) {
  const row = sessions.get(id);
  if (!row || !token) return false;
  // timingSafeEqual over a plain === so a token guess can't be narrowed
  // down via response-time comparison. Buffers must be equal length first -
  // timingSafeEqual throws otherwise, and mismatched length already means
  // "not equal" - so short-circuit rather than pad.
  const expected = Buffer.from(row.token);
  const actual = Buffer.from(token);
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

// `sinceSeq` comes from the client's last-seen event seq. Omitted/0 on a
// first-ever attach means a full replay. A returning client that still
// holds its rendered DOM gets only the delta; one that has evicted past
// what the log still holds gets `gap: true` and a full resend instead of a
// replay with a hole in it (event-log.js).
export function attachClient(id, ws, sinceSeq = 0) {
  const row = sessions.get(id);
  if (!row) return false;
  row.clients.add(ws);
  send(ws, { type: 'cockpit:hello', session: toSummary(row) });
  const { events, gap } = replayEvents(row.eventLog, sinceSeq);
  if (gap) send(ws, { type: 'cockpit:gap' });
  for (const { seq, message } of events) {
    send(ws, { type: 'sdk:message', message, seq });
  }
  for (const request of row.pendingApprovals) {
    send(ws, { type: 'cockpit:approval-request', request });
  }
  send(ws, usagePayload(row));
  send(ws, tasksPayload(row));
  send(ws, queuePayload(row));
  broadcastSummary(id);
  return true;
}

export function detachClient(id, ws) {
  const row = sessions.get(id);
  if (!row) return;
  row.clients.delete(ws);
  broadcastSummary(id);
}

export async function sendInput(id, text) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  pushTurn(row, text); // Must go through pushTurn, not handle.pushInput directly - see its comment
}

// Shared shape behind every route below that calls straight through to the
// live SDK handle: look up the row, run `action`, merge `patch` onto the
// row to keep it in sync (omit it for read-only passthroughs like
// toggleMcpServer, which have no row field to sync), then broadcast so
// every connected tab sees the change.
async function queryPassthrough(id, action, patch) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  await action(row);
  if (patch) Object.assign(row, patch);
  broadcastSummary(id);
}

export async function setPermissionMode(id, mode) {
  return queryPassthrough(id, (row) => row.handle.setMode(mode), { mode });
}

// Cancels whatever turn(s) are running; no row-field patch, since the
// idle/running flip rides in on the interrupted turn's own `result`.
// session.js's interrupt() also drains the local input queue, but can't
// notify a delegation origin (the provider layer knows nothing about
// delegation) - so snapshot the about-to-be-dropped ids and fail their tags.
export async function interruptTurn(id) {
  return queryPassthrough(id, async (row) => {
    const queuedIds = row.handle.listQueue().map((e) => e.id);
    await row.handle.interrupt();
    for (const queueId of queuedIds) failDroppedTurn(row, queueId);
  });
}

// Manual last-resort recovery for "pendingTurnsCount never reaches 0" -
// asserts "stop waiting for a result that isn't coming". Not routed through
// queryPassthrough: this also has to fail stuck delegations (same as
// closeSession/handleError), which its single-action shape has no room for.
export async function forceIdle(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  delegation.failPendingDelegations(row, 'session was manually unstuck (force-idle) before this delegation replied');
  row.handle.forceIdle();
  broadcastSummary(id);
}

// Same shape as setPermissionMode above, for the CLI's own /model - one
// query() method (setModel), one row field to keep in sync, one broadcast
// so every connected tab sees the switch.
export async function setModel(id, model) {
  return queryPassthrough(id, (row) => row.handle.query.setModel(model), { model: model || null });
}

// row.name is purely cockpit-side bookkeeping - the SDK has nothing
// analogous to tell. NOT routed through queryPassthrough: the uniqueness
// check needs zero `await` between it and the mutation it guards (same
// reasoning as createSession's check) - queryPassthrough's own `await` is
// enough of a yield point for two concurrent renames to both pass it.
export async function setSessionName(id, name) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  if (name) {
    const existing = findByName(row.cwd, name);
    if (existing && existing.id !== id) {
      const err = new Error(`a session named "${name}" already exists in this project`);
      err.code = 'ERR_NAME_TAKEN';
      throw err;
    }
  }
  row.name = name;
  broadcastSummary(id);
}

// Same shape as setModel above: one Query method (setMaxThinkingTokens),
// two row fields to keep in sync, one broadcast so every connected tab sees
// the new budget/display. `maxThinkingTokens: null` clears the budget back
// to the SDK default (thinking off unless the session was started with it
// on); `thinkingDisplay` is only meaningful while thinking is actually on.
export async function setMaxThinkingTokens(id, maxThinkingTokens, thinkingDisplay) {
  return queryPassthrough(
    id,
    (row) => row.handle.query.setMaxThinkingTokens(maxThinkingTokens ?? null, thinkingDisplay ?? null),
    { maxThinkingTokens: maxThinkingTokens ?? null, thinkingDisplay: thinkingDisplay ?? null },
  );
}

export async function setEffort(id, effort) {
  return queryPassthrough(id, (row) => row.handle.query.setEffort(effort), { effort });
}

// Auto-continue checkbox: when turned on while sitting on a rejected
// rate-limit, arms the resume timer immediately rather than waiting for the
// next rate_limit_event - turning it on after hitting the wall shouldn't
// need another rejected turn to notice. Turning it off just disarms the
// pending timer; rateLimitHit is left alone since the limit still blocks.
export async function setAutoContinue(id, enabled) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  row.autoContinue = Boolean(enabled);
  if (row.autoContinue && row.rateLimitHit) {
    scheduleAutoContinue(id);
  } else if (!row.autoContinue) {
    clearAutoContinueTimer(row);
  }
  broadcastSummary(id);
}

// `decision` is a PermissionResult - {behavior:'allow', updatedInput?} or
// {behavior:'deny', message?}. Called from the client's accept/reject click
// on a plan-request banner (ExitPlanMode only).
export function resolveApproval(id, requestId, decision) {
  const row = sessions.get(id);
  if (!row) return false;
  const i = row.pendingApprovals.findIndex((r) => r.requestId === requestId);
  if (i >= 0) row.pendingApprovals.splice(i, 1);
  return row.handle.resolveApproval(requestId, decision);
}

// Refetches the full transcript and returns whatever falls before the
// slice already shown (see createSession's `historyShownCount`) - not
// cached, same tradeoff claude-realtime-usage's own "load full history"
// button makes. Advances `historyShownCount` so `hasEarlierHistory` goes
// false once there's nothing left before this point.
export async function loadEarlierHistory(id, fetchHistoryImpl) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  if (!row.providerSessionId) throw new Error('session has no provider session id yet');

  const fetchHistory = fetchHistoryImpl || getProvider(row.provider).fetchHistory;
  const full = await fetchHistory(row.providerSessionId, row.cwd);
  const earlier = full.slice(0, Math.max(0, full.length - row.historyShownCount));
  row.historyTotal = full.length;
  row.historyShownCount = full.length;
  broadcastSummary(id); // hasEarlierHistory flips to false for every connected tab, not just the requester

  return earlier;
}

// Fork the conversation at `userMessageId` into a new, independent cockpit
// session (non-destructive - the original keeps running). Optionally
// reverts files on the *original* session first; skips the file half when
// the row has no checkpointing rather than letting it fail.
export async function rewind(id, turnIndex, { dryRun = false } = {}) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  const provider = getProvider(row.provider);
  if (!provider.capabilities.conversationFork) {
    throw new Error(`${provider.label} sessions do not support conversation rewind`);
  }
  if (!row.providerSessionId) throw new Error('session has no provider session id yet');
  if (row.turnIndexUnreliable) {
    throw new Error('could not read this session\'s prior transcript when it started, so turn numbering cannot be trusted - rewind is disabled for it. Resuming it again may resolve this.');
  }
  // How to fork a conversation is provider-specific and lives on the
  // descriptor (provider-registry.js) rather than branching here - a
  // provider claiming conversationFork without a rewind implementation is
  // a descriptor bug, not something to paper over with Claude's fallback.
  if (typeof provider.rewind !== 'function') {
    throw new Error(`${provider.label} advertises conversation-fork support but has no rewind implementation`);
  }
  return provider.rewind(row, turnIndex, { dryRun });
}

// Read-only passthrough - no row field tracks MCP state. Merges in
// `authUrl`/`authMessage` for any server session.js caught a URL-mode auth
// request for, since McpServerStatus alone gives the panel nothing to link
// to. Grok sessions have no getMcpAuthPending, hence the guard.
export async function getMcpServerStatus(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  const servers = await row.handle.query.mcpServerStatus();
  if (typeof row.handle.getMcpAuthPending !== 'function') return servers;
  const pending = new Map(row.handle.getMcpAuthPending().map((p) => [p.name, p]));
  return servers.map((server) => {
    const auth = pending.get(server.name);
    return auth ? { ...server, authUrl: auth.url, authMessage: auth.message } : server;
  });
}

// No row field to keep in sync (no `patch` arg) - mcpServerStatus() is the
// source of truth, fetched fresh each time the panel opens. Broadcasts
// after so any other tab with the settings modal open re-fetches its panel.
export async function toggleMcpServer(id, name, enabled) {
  return queryPassthrough(id, (row) => row.handle.query.toggleMcpServer(name, enabled));
}

export async function reconnectMcpServer(id, name) {
  return queryPassthrough(id, (row) => row.handle.query.reconnectMcpServer(name));
}

// Reloads plugins (and, as a side effect, commands/agents/MCP servers) from
// disk. Passthrough - none of {commands, agents, plugins, mcpServers} is
// tracked on the row today, so there's nothing to sync locally; the caller
// gets the fresh response straight from the SDK.
export async function reloadPlugins(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  return row.handle.query.reloadPlugins();
}

// Grok writes enable/disable through `grok plugin`, not settings.local.json.
// Claude keeps using plugin-settings.js from the server route.
export async function setHandlePluginEnabled(id, pluginKey, enabled) {
  return queryPassthrough(id, (row) => {
    if (typeof row.handle.query.setPluginEnabled !== 'function') {
      throw new Error('setPluginEnabled is not supported on this session');
    }
    return row.handle.query.setPluginEnabled(pluginKey, enabled);
  });
}

function setState(id, state) {
  const row = sessions.get(id);
  if (!row) return;
  row.state = state;
  broadcastSummary(id);
  // A row whose handle ends on its own would otherwise linger forever,
  // since only closeSession() deletes it - reap here instead. 'error' is
  // excluded: every provider follows it with onError, which does its own
  // cleanup and delete - reaping here first would leave handleError's row
  // lookup empty and silently skip that cleanup.
  if (state === 'closed') sessions.delete(id);
}

function handleMessage(id, message) {
  const row = sessions.get(id);
  if (!row) return;
  if (message.session_id) row.providerSessionId = message.session_id;
  // The CLI can move itself out of the mode it was started/set in (e.g.
  // accepting a plan exits `plan`) without a setPermissionMode() call from
  // us. Without syncing row.mode here, the client's mode button stays
  // stale and the next Shift+Tab computes its target off the wrong value.
  if (message.type === 'system' && message.subtype === 'status' && message.permissionMode && message.permissionMode !== row.mode) {
    row.mode = message.permissionMode;
    broadcastSummary(id);
  }
  const hadModel = !!row.model;
  if (applyAssistantUsage(row, message)) {
    broadcastUsage(id); // cost/tokens only - cheap, no round trip, so this can track every message
    // A "Default model" launch leaves row.model null until this call
    // resolves it; broadcastUsage alone never reaches the header badge,
    // since applyModelBadge only runs off cockpit:state, not cockpit:usage.
    if (!hadModel && row.model) broadcastSummary(id);
  }
  delegation.collectDelegationText(row, message); // buffers this turn's assistant text while a matching delegation is pending, see the 'result' branch below
  // Task* detection/resolution also has to run for a resumed session's
  // replayed history (see createSession's seedTaskState call), not just the
  // live stream - factored out so both call sites share one implementation
  // instead of the seed path silently missing whatever this one does.
  if (deriveTaskUpdate(row, message)) broadcastTasks(id);
  // The hard stop, not the proactive 5h/7d chip (a poll off the
  // experimental usage API): the SDK pushes this the moment a turn is
  // actually rejected or un-rejected. 'rejected' is the only status that
  // blocks a turn - the other statuses clear whatever hit was recorded,
  // since a limit can lift between events without us doing anything.
  if (message.type === 'rate_limit_event' && message.rate_limit_info) {
    const info = message.rate_limit_info;
    if (info.status === 'rejected') {
      // SDKRateLimitInfo.resetsAt is epoch *seconds* (confirmed against a
      // real hit: the value we were getting back only made sense multiplied
      // by 1000 - Date.now()/setTimeout/Date() all want ms). Converted once
      // here so rateLimitHit.resetsAt is plain epoch-ms everywhere below and
      // in app.js, instead of every reader having to remember the *1000.
      row.rateLimitHit = { resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, rateLimitType: info.rateLimitType || null };
      if (row.autoContinue) scheduleAutoContinue(id);
    } else if (row.rateLimitHit) {
      row.rateLimitHit = null;
      clearAutoContinueTimer(row);
    }
    broadcastSummary(id);
  }
  // Second, independent source for rateLimitHit: the CLI also drops a
  // plain-language reply on a session-limit hit ("resets 2:10am (Europe/
  // Paris)"). Overwrites rate_limit_event's guess when both are present,
  // since this text has been verified against a real hit.
  if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type !== 'text' || !block.text) continue;
      const resetsAt = parseSessionLimitResetText(block.text);
      if (resetsAt != null) {
        row.rateLimitHit = { resetsAt: resetsAt + AUTO_CONTINUE_BUFFER_MS, rateLimitType: 'session_limit_text' };
        if (row.autoContinue) scheduleAutoContinue(id);
        broadcastSummary(id);
      }
    }
  }
  const seq = appendEvent(row.eventLog, message);
  broadcast(id, { type: 'sdk:message', message, seq });
  if (message.type === 'result') {
    // Which turn just finished is decided by the turn tracker, never
    // position: every provider stamps `_cockpitQueueId` onto its result,
    // so an interleaved human turn or a late force-idled result stays
    // harmless. `_cockpitStale` means the tag was already failed at
    // force-idle time, so there's nothing to claim.
    if (message._cockpitStale !== true) {
      const tag = row.handle.turns?.claimTag(message._cockpitQueueId);
      if (tag) delegation.relayDelegationResult(row, tag, { ok: true, message });
    }
    refreshContextUsage(id); // a real round trip to the CLI - once per finished turn, not per message
    refreshRateLimits(id);
  }
}

// FALLBACK ONLY - the real path is message.tool_use_result. The CLI's
// actual `content` for Task* results is a human-readable string, never
// JSON, so this realistically always returns null; kept for a hypothetical
// future CLI build that stops attaching tool_use_result.
function parseToolResultJson(content) {
  try {
    if (typeof content === 'string') return JSON.parse(content);
    if (Array.isArray(content)) {
      const textBlock = content.find((c) => c && c.type === 'text' && typeof c.text === 'string');
      return textBlock ? JSON.parse(textBlock.text) : null;
    }
    if (content && typeof content === 'object') return content;
  } catch {
    return null;
  }
  return null;
}

// Accumulates one assistant message's cost/tokens into row.usageAcc and
// stamps message._usageInfo, read by stream-view.js's cost label and
// turn-chart.js's per-turn bar. Shared by the live stream and the
// history-seed path so a resumed session doesn't start from nothing.
function applyAssistantUsage(row, message) {
  if (message.type !== 'assistant' || !message.message) return false;
  // A session started with no explicit model never otherwise learns what
  // the SDK/CLI actually picked; every assistant message carries the
  // resolved model id, so grab it once. An explicit /model switch later
  // overwrites this via setModel's own patch, not this fallback.
  if (!row.model && message.message.model) row.model = message.message.model;
  const toolNames = Array.isArray(message.message.content)
    ? message.message.content.filter((b) => b && b.type === 'tool_use').map((b) => b.name)
    : [];
  row.usageAcc.addAssistantMessage(message.message, toolNames);
  const info = costForUsage(message.message.model, message.message.usage);
  // info is only null when the message has no usage at all - an unpriced
  // model still carries real token counts (info.cost === null), so
  // _usageInfo gets set either way rather than only when a price exists.
  if (info) {
    message._usageInfo = {
      costUsd: info.cost ?? 0,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      cacheReadTokens: info.readTokens,
      cacheWriteTokens: info.writeTokens,
      cacheMiss: info.writeTokens > 0 && info.writeTokens >= info.readTokens,
    };
  }
  return true;
}

// Watches one SDK message for Task* tool activity, returning whether
// row.tasks changed. Shared by the live stream and history-seed path.
// Stashes Task* tool_use blocks so the matching tool_result - a separate
// later 'user' message - resolves against the input that produced it.
function deriveTaskUpdate(row, message) {
  let changed = false;
  if (message.type === 'assistant' && message.message && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type !== 'tool_use') continue;
      if (block.name === 'TaskCreate') row.pendingTaskOps.set(block.id, { kind: 'create', input: block.input || {} });
      else if (block.name === 'TaskUpdate') row.pendingTaskOps.set(block.id, { kind: 'update', input: block.input || {} });
      else if (block.name === 'TaskList') row.pendingTaskOps.set(block.id, { kind: 'list', input: {} });
      else if (block.name === 'todo_write' || block.name === 'TodoWrite') {
        row.pendingTaskOps.set(block.id, { kind: 'todos', input: block.input || {} });
      }
    }
  }
  // Resolves whichever Task* call this tool_result belongs to (stashed
  // above) and applies the resulting task-state change.
  if (message.type === 'user' && message.message && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue;
      const op = row.pendingTaskOps.get(block.tool_use_id);
      if (!op) continue;
      row.pendingTaskOps.delete(block.tool_use_id);
      // message.tool_use_result carries the real structured payload;
      // block.content is the human-readable summary. Live stream uses
      // snake_case tool_use_result; camelCase toolUseResult is a fallback
      // for transcript-read messages; parseToolResultJson is the last resort.
      const structured = message.tool_use_result !== undefined ? message.tool_use_result : message.toolUseResult;
      const data = structured !== undefined ? structured : parseToolResultJson(block.content);
      if (applyTaskOp(row, op, block, data)) changed = true;
    }
  }
  return changed;
}

// Applies one resolved Task* call to row.tasks. TaskUpdate reads new field
// values from `op.input`, since TaskUpdateOutput only reports which names
// changed, never the values. TaskList fully replaces row.tasks rather than
// merging, since that's the only way a deletion is ever noticed.
function grokTodoStatus(status) {
  if (status === 'in_progress' || status === 'completed') return status;
  return 'pending';
}

function applyTaskOp(row, op, resultBlock, data) {
  if (resultBlock.is_error) return false;
  if (op.kind === 'todos') {
    const todos = Array.isArray(op.input.todos)
      ? op.input.todos
      : (data && Array.isArray(data.todos) ? data.todos : null);
    if (!todos) return false;
    row.tasks.clear();
    for (const todo of todos) {
      const id = todo.id || todo.content;
      if (!id) continue;
      row.tasks.set(id, {
        id,
        subject: todo.content || todo.subject || String(id),
        status: grokTodoStatus(todo.status),
        owner: null,
        blockedBy: [],
      });
    }
    return true;
  }
  if (!data || typeof data !== 'object') return false;

  if (op.kind === 'create' && data.task && data.task.id) {
    // A TaskCreate landing while every existing task is already completed
    // means a fresh batch is starting - drop the stale list instead of
    // accumulating it forever. A list with any pending/in_progress task is
    // left alone even if this new task belongs to a different batch.
    if (row.tasks.size > 0 && [...row.tasks.values()].every((t) => t.status === 'completed')) {
      row.tasks.clear();
    }
    row.tasks.set(data.task.id, {
      id: data.task.id,
      subject: data.task.subject || op.input.subject || '',
      status: 'pending',
      owner: null,
      blockedBy: [],
    });
    return true;
  }
  if (op.kind === 'update' && data.success && data.taskId) {
    if (op.input.status === 'deleted') return row.tasks.delete(data.taskId);
    const existing = row.tasks.get(data.taskId);
    if (!existing) return false;
    if (op.input.subject !== undefined) existing.subject = op.input.subject;
    if (op.input.status !== undefined) existing.status = op.input.status;
    if (op.input.owner !== undefined) existing.owner = op.input.owner;
    if (Array.isArray(op.input.addBlockedBy) && op.input.addBlockedBy.length) {
      existing.blockedBy = [...new Set([...existing.blockedBy, ...op.input.addBlockedBy])];
    }
    return true;
  }
  if (op.kind === 'list' && Array.isArray(data.tasks)) {
    row.tasks = new Map(data.tasks.map((t) => [t.id, {
      id: t.id, subject: t.subject, status: t.status, owner: t.owner || null, blockedBy: t.blockedBy || [],
    }]));
    return true;
  }
  return false;
}

// Shared by broadcastTasks and attachClient's initial send, same pattern as
// usagePayload above.
function tasksPayload(row) {
  return { type: 'cockpit:tasks', tasks: [...row.tasks.values()] };
}

function broadcastTasks(id) {
  const row = sessions.get(id);
  if (!row) return;
  broadcast(id, tasksPayload(row));
}

// Same shape as tasksPayload/broadcastTasks above. row.queue is kept live by
// session.js's onQueueChange callback (see createSession) - this just wraps
// whatever the row already has, same as every other *Payload function here.
function queuePayload(row) {
  return { type: 'cockpit:queue', queue: row.queue };
}

function broadcastQueue(id) {
  const row = sessions.get(id);
  if (!row) return;
  broadcast(id, queuePayload(row));
}

// MCP "needs-auth" badge, fired from session.js's onMcpAuthRequest/
// onMcpAuthResolved. Unlike every other broadcast* here, there's no row
// field to read a payload off - the merged {authUrl} list only exists
// behind the async getMcpServerStatus() round trip.
async function broadcastMcpAuth(id) {
  const row = sessions.get(id);
  if (!row) return;
  const servers = await getMcpServerStatus(id).catch(() => null);
  if (servers) broadcast(id, { type: 'cockpit:mcp-auth', servers });
}

// Queue pane operations - all three just forward to the session handle
// (listQueue is synchronous/local, not wrapped in queryPassthrough).
// row.queue/the broadcast are driven by onQueueChange, not by these calls
// succeeding - a grok session's stubbed handle methods return false/[]
// harmlessly rather than throwing.
export function listQueue(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  return row.handle.listQueue();
}

// Shared by removeQueued() and interruptTurn(): queueId's turn will now
// never run, so it will never produce a `result`. The handle's own
// removeQueued/interrupt already dropped it from the turn tracker; all
// that's left is the delegation side - tell the origin now if this was a
// delegated turn.
function failDroppedTurn(row, queueId) {
  const tag = row.handle.turns?.claimTag(queueId);
  if (tag) delegation.relayDelegationResult(row, tag, { ok: false, errorText: 'the delegated task was removed from the queue before it ran' });
}

export async function removeQueued(id, queueId) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  const removed = await row.handle.removeQueued(queueId);
  if (removed) failDroppedTurn(row, queueId);
  return removed;
}

// Pure passthroughs - the provider's own reorderQueue/sendNow drive
// result-epoch.js's turn tracker directly, so there's nothing left here to
// mirror onto a second, registry-side copy.
export async function reorderQueue(id, queueIds) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  return row.handle.reorderQueue(queueIds);
}

export async function sendNow(id, queueId) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  return row.handle.sendNow(queueId);
}

// Wake a minute after the stated reset, not exactly on it - "2:10am" is the
// server's own rounding, not a guarantee the limit is actually clear in the
// same millisecond it flips over.
const AUTO_CONTINUE_BUFFER_MS = 60_000;

const SESSION_LIMIT_TEXT_RE = /resets?\s+(?:at\s+)?(\d{1,2}):(\d{2})\s*([ap]m)\s*\(([^)]+)\)/i;

// Pulls a wall-clock reset time + IANA zone out of the CLI's own
// human-readable hit message and returns it as an epoch-ms instant (no
// buffer added - callers add AUTO_CONTINUE_BUFFER_MS). Returns null if the
// text doesn't match (the overwhelming majority of assistant messages,
// obviously) or the zone name isn't one Intl recognizes.
function parseSessionLimitResetText(text) {
  const m = SESSION_LIMIT_TEXT_RE.exec(text);
  if (!m) return null;
  let hour = parseInt(m[1], 10) % 12;
  if (/pm/i.test(m[3])) hour += 12;
  const minute = parseInt(m[2], 10);
  const tz = m[4].trim();
  try {
    return nextWallClockInstant(hour, minute, tz);
  } catch {
    return null; // Intl rejects an unrecognized zone name - ignore rather than throw
  }
}

// "Next time it's HH:MM in `tz`" without a tz database: format `now` into
// tz's wall-clock fields via Intl, diff against the target in minutes,
// apply that diff to the real instant. Correct unless a DST transition
// falls in the gap - a rare edge case for a same/next-day reset.
function nextWallClockInstant(targetHour, targetMinute, tz) {
  const now = Date.now();
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(now);
  const get = (type) => parseInt(parts.find((p) => p.type === type).value, 10);
  const nowMinutes = (get('hour') % 24) * 60 + get('minute');
  const targetMinutes = targetHour * 60 + targetMinute;
  let diffMinutes = targetMinutes - nowMinutes;
  if (diffMinutes < 0) diffMinutes += 24 * 60; // target already passed today - it means tomorrow
  return now + diffMinutes * 60_000 - get('second') * 1000;
}

// Arms (or re-arms) the timer that pushes "Continue" the moment the limit
// resets. Re-entrant: safe to call again on a later rate_limit_event or a
// mid-wait checkbox toggle, always clearing any prior timer first. No
// resetsAt means there's nothing to schedule against - autoContinue stays
// armed for next time, it just can't fire on this hit.
function scheduleAutoContinue(id) {
  const row = sessions.get(id);
  if (!row || !row.rateLimitHit || !row.rateLimitHit.resetsAt) return;
  clearAutoContinueTimer(row);
  const delay = Math.max(0, row.rateLimitHit.resetsAt - Date.now());
  row.autoContinueTimer = setTimeout(() => {
    row.autoContinueTimer = null;
    // Re-check rather than trusting the closure: the checkbox may have been
    // turned off, or the limit may already have cleared, in the time this
    // timer sat waiting.
    if (!row.autoContinue || !row.rateLimitHit) return;
    row.rateLimitHit = null;
    pushTurn(row, 'Continue'); // Must go through pushTurn, not handle.pushInput directly - see its comment
    broadcastSummary(id);
  }, delay);
}

function clearAutoContinueTimer(row) {
  if (row.autoContinueTimer) {
    clearTimeout(row.autoContinueTimer);
    row.autoContinueTimer = null;
  }
}

// True once the experimental usage API has thrown once. Process-wide, not
// per-session: the method either exists on this SDK build or it doesn't,
// so stop retrying rather than eat a doomed call every turn. Our own
// cost/token numbers never depend on this API.
let rateLimitsApiBroken = false;

// Best-effort plan/quota display (5h/7d rate-limit windows) off the SDK's
// experimental `/usage` control request. Isolated from refreshContextUsage/
// usageAcc: if this API is renamed or removed, the catch below just stops
// populating row.rateLimits rather than taking cost/token/context tracking
// down with it.
async function refreshRateLimits(id) {
  if (rateLimitsApiBroken) return;
  const row = sessions.get(id);
  if (!row || !row.handle?.query?.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET) return;
  try {
    const usage = await row.handle.query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET();
    row.rateLimits = usage.rate_limits_available ? usage.rate_limits : null;
  } catch (err) {
    rateLimitsApiBroken = true;
    console.warn('usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET failed once, not retrying this process:', String(err.message || err));
    return;
  }
  broadcastUsage(id);
}

// getContextUsage() is a Query-handle round trip (unlike usage.js's
// accumulator, pure local math), so it's only called once a turn finishes,
// not on every partial message. Best-effort: swallows errors rather than
// surfacing a stats-panel failure as a session error.
async function refreshContextUsage(id) {
  const row = sessions.get(id);
  if (!row || !row.handle?.query?.getContextUsage) return;
  try {
    row.contextUsage = await row.handle.query.getContextUsage();
  } catch {
    return;
  }
  broadcastUsage(id);
}

// Shared by broadcastUsage and attachClient's initial send, so a
// reconnecting/newly-attached client and every live push agree on shape.
function usagePayload(row) {
  return {
    type: 'cockpit:usage',
    usage: row.usageAcc.snapshot(),
    context: contextPayload(row.contextUsage),
    rateLimits: row.rateLimits, // null until refreshRateLimits succeeds at least once, or forever if the experimental API is unavailable
  };
}

function broadcastUsage(id) {
  const row = sessions.get(id);
  if (!row) return;
  broadcast(id, usagePayload(row));
}

function handleApprovalRequest(id, request) {
  const row = sessions.get(id);
  if (row) {
    if (!row.pendingApprovals.some((r) => r.requestId === request.requestId)) {
      row.pendingApprovals.push(request);
    }
  }
  broadcast(id, { type: 'cockpit:approval-request', request });
}

function handleError(id, err) {
  const row = sessions.get(id);
  if (!row) return;
  // A rate-limit hit can arm scheduleAutoContinue's timer before the CLI
  // dies; left armed, it would later pushTurn 'Continue' into a dead handle
  // and broadcast a ghost 'running' state.
  clearAutoContinueTimer(row);
  row.state = 'error';
  // A crashing row's for-await loop exits without ever emitting the
  // 'result' message the delegation branch waits for, so pending tags
  // would otherwise strand their origin session forever.
  delegation.failPendingDelegations(row, String((err && err.message) || err));
  // abandonAll(), not a plain drop: a result that somehow still lands must
  // read as stale rather than match a slot, and pendingTurnsCount would
  // otherwise never return to 0.
  row.handle?.turns?.abandonAll();
  broadcast(id, { type: 'cockpit:error', error: String((err && err.stack) || err) });
  // The only reap for an errored row - setState deliberately skips 'error'
  // so this cleanup runs first against a still-live row.
  sessions.delete(id);
}

function broadcastSummary(id) {
  const row = sessions.get(id);
  if (!row) return;
  broadcast(id, { type: 'cockpit:state', session: toSummary(row) });
}

function broadcast(id, payload) {
  const row = sessions.get(id);
  if (!row) return;
  const data = JSON.stringify(payload);
  for (const ws of row.clients) {
    if (ws.readyState === ws.OPEN) ws.send(data);
  }
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}
