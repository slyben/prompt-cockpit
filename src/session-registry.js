// Cockpit-id-keyed session table. Cockpit id is the primary key everywhere
// (registry row, ws route, token); Claude's own session id is a mutable
// attribute refreshed as messages arrive (see plan Decisions).
//
// Settings-store boundary (three stores exist; this is one of them - see
// backlog.md's now-resolved "no stated boundary" item): a registry row is
// the live, in-memory mirror of one running session's SDK-reported state
// (model, mode, thinking budget, auto-continue, usage, etc). Purely
// ephemeral - nothing here ever touches disk, and the whole row is gone the
// moment the session closes or the process restarts. That's deliberate: a
// row's job is to reflect what the SDK connection is doing *right now*, not
// to remember anything. The other two stores: public/settings.js
// (localStorage) holds per-browser UI preferences that never leave the
// client; session-defaults.js + plugin-settings.js (both under one cwd's
// `.claude/settings.local.json`) hold per-project preferences that survive
// a restart and are shared across every tab/browser pointed at that cwd.
// server.js is what bridges this row to that persisted store (see
// seedSessionDefaults() and the 'thinking'/'auto-continue' routes there) -
// this module itself stays filesystem-free.
import { randomUUID } from 'node:crypto';
import { startSession } from './session.js';
import { startGrokSession } from './grok-session.js';
import { forkConversation, rewindFiles as rewindFilesSdk, resolveTurnUuid } from './rewind.js';
import { resolveGrokPromptIndex } from './grok-rewind.js';
import { fetchSessionHistory, countWithinTokenBudget, countRealUserTurns, INITIAL_HISTORY_TOKEN_BUDGET } from './session-history.js';
import { createEventLog, append as appendEvent, replay as replayEvents } from './event-log.js';
import { createUsageAccumulator, costForUsage } from './usage.js';

const sessions = new Map();

// `startSessionImpl` defaults to the real SDK-backed session but can be
// swapped for a stub in tests so unit tests don't spawn a real CLI process.
// `history` (from server.js's resume flow, already fetched via
// fetchSessionHistory) seeds the buffer with a recent tail so a resumed
// session shows its prior conversation immediately rather than starting
// blank - see loadEarlierHistory() for the rest, on demand.
function defaultStart(provider) {
  return provider === 'grok' ? startGrokSession : startSession;
}

export function createSession({ cwd, resume, name, model, permissionMode, history, provider, effort, startSessionImpl }) {
  const resolvedProvider = provider === 'grok' ? 'grok' : 'claude';
  if (!startSessionImpl) startSessionImpl = defaultStart(resolvedProvider);
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
    claudeSessionId: resume || null,
    // `enableFileCheckpointing` can't be turned on retroactively (plan
    // Decisions), so it only actually covers this session's history if the
    // cockpit started it fresh. Any resumed session - whether it was last
    // run in a terminal or in a prior cockpit process - has no snapshots
    // for its earlier turns, so file rewind must be off rather than
    // attempted and failed (see rewind() below, which checks this flag).
    hasFileCheckpointing: resolvedProvider === 'claude' && !resume,
    // `history` is null here in exactly two cases: no resume was requested
    // (fine, turnIndexOffset is genuinely 0), or a resume WAS requested and
    // fetchSessionHistory threw (server.js's `.catch(() => null)`) - the
    // dangerous case, where offset silently defaults to 0 and every rewind
    // on this session would target the wrong turn with no error surfaced.
    // Distinguishing an actually-empty transcript (fetch succeeded, `[]`)
    // from a failed fetch (`null`) is exactly what lets this only trip on
    // the second case. rewind() below refuses to run rather than mistarget.
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
    pendingApproval: null, // last unresolved approval request, so a reconnecting client sees it again instead of a stuck banner it never got
    // MVP4 live stats: cost/token totals accumulate from every assistant
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
    // tool_use id -> { kind: 'create'|'update'|'list', input } for a Task*
    // call whose result hasn't arrived yet - applyTaskOp needs the ORIGINAL
    // input (TaskUpdateOutput only reports which field names changed, not
    // their new values) matched against the tool_result that confirms it
    // actually succeeded. Entries are deleted as soon as their result lands;
    // a call that never gets one (error mid-flight, session closes) just
    // lingers harmlessly for the row's lifetime.
    pendingTaskOps: new Map(),
  };
  // Resumed sessions never replay their history through handleMessage - the
  // tail-append loop below just seeds the event log directly for display, no
  // per-message processing - so without this, two things silently reset on
  // every resume: row.tasks would stay empty (any TaskCreate/TaskUpdate/
  // TaskList from before this attach invisible to the task panel, B10), and
  // row.usageAcc/each message's _usageInfo would stay empty (the header's
  // running cost total and every historical bar in turn-chart.js's cost
  // graph missing until the first new live turn). Walks the FULL history,
  // not just `tail`: a task or cost figure from outside the display budget
  // should still count even though its originating message has scrolled out
  // of view. Runs BEFORE the tail-append loop below, same order live
  // messages get processed in (handleMessage stamps _usageInfo before its
  // own appendEvent call) - `tail`'s messages are the same object references
  // as `history`'s tail slice, so appendEvent's byte-size estimate below
  // ends up counting the stamped _usageInfo like a live message's would,
  // not silently under-counting it. Order also matters within this loop
  // itself - deriveTaskUpdate matches a TaskUpdate's tool_result against the
  // tool_use that came before it - so this must run over `history` in its
  // original order, same as the live stream would have seen it.
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
  });

  return row;
}

export function get(id) {
  return sessions.get(id);
}

// Ends a session's live query() and drops its row. Nothing currently calls
// this automatically (see server.js's DELETE route comment) - sessions
// otherwise accumulate for the cockpit process's entire lifetime.
export function closeSession(id) {
  const row = sessions.get(id);
  if (!row) return false;
  clearAutoContinueTimer(row);
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

export function toSummary(row) {
  return {
    id: row.id,
    name: row.name,
    cwd: row.cwd,
    state: row.state,
    mode: row.mode,
    provider: row.provider,
    claudeSessionId: row.claudeSessionId,
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
    capabilities: {
      fileRewind: row.provider === 'claude' && row.hasFileCheckpointing,
      thinkingBudget: row.provider === 'claude',
      effort: row.provider === 'grok',
      autoContinue: row.provider === 'claude',
      mcpToggle: true,
    },
  };
}

export function checkToken(id, token) {
  const row = sessions.get(id);
  return Boolean(row && token && row.token === token);
}

// `sinceSeq` comes from the client's last-seen event seq (server.js reads
// it off the ws upgrade URL's `since` param). Omitted/0 on a first-ever
// attach - full replay, same as before MVP3. A returning client that still
// holds its rendered DOM sends its real last seq and gets only the delta;
// one that has evicted past what the log still holds gets `gap: true` and
// a full resend instead of a replay with a hole in it (event-log.js).
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
  if (row.pendingApproval) {
    send(ws, { type: 'cockpit:approval-request', request: row.pendingApproval });
  }
  send(ws, usagePayload(row));
  send(ws, tasksPayload(row));
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
  row.handle.pushInput(text);
}

// Shared shape behind every route below that calls straight through to the
// live SDK handle: look up the row (or throw the same "unknown session"
// every other registry function throws), run `action` against it, merge
// `patch` onto the row to keep it in sync (omit it for the read-only
// passthroughs - toggleMcpServer/reconnectMcpServer have no row field to
// keep in sync), then broadcast so every connected tab sees the change.
// Used to be copy-pasted per route (setPermissionMode/setModel/
// setMaxThinkingTokens each hand-rolled this - see backlog.md), which meant
// a 4th/5th route repeating it by hand instead of just calling this.
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

// Same shape as setPermissionMode above, for the CLI's own /model - one
// query() method (setModel), one row field to keep in sync, one broadcast
// so every connected tab sees the switch.
export async function setModel(id, model) {
  return queryPassthrough(id, (row) => row.handle.query.setModel(model), { model: model || null });
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

export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

export async function setEffort(id, effort) {
  return queryPassthrough(id, (row) => row.handle.query.setEffort(effort), { effort });
}

// Desktop's "auto-continue" checkbox (see handleMessage's rate_limit_event
// branch): when on and this session is currently sitting on a rejected
// rate-limit, arms the resume timer immediately rather than waiting for the
// next rate_limit_event to flip it on - turning the box on *after* you've
// already hit the wall shouldn't require another rejected turn to notice.
// Turning it off just disarms whatever timer is pending; rateLimitHit
// itself is left alone since the limit is still actually blocking.
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
// on a plan-request banner (MVP2 scope: ExitPlanMode only).
export function resolveApproval(id, requestId, decision) {
  const row = sessions.get(id);
  if (!row) return false;
  if (row.pendingApproval && row.pendingApproval.requestId === requestId) row.pendingApproval = null;
  return row.handle.resolveApproval(requestId, decision);
}

// Refetches the full transcript and returns whatever falls before the
// slice already shown (see createSession's `historyShownCount`) - not
// cached, same tradeoff claude-realtime-usage's own "load full history"
// button makes. Advances `historyShownCount` so `hasEarlierHistory` goes
// false once there's nothing left before this point.
export async function loadEarlierHistory(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  if (!row.claudeSessionId) throw new Error('session has no claude session id yet');

  const full = await fetchSessionHistory(row.claudeSessionId, row.cwd);
  const earlier = full.slice(0, Math.max(0, full.length - row.historyShownCount));
  row.historyTotal = full.length;
  row.historyShownCount = full.length;
  broadcastSummary(id); // hasEarlierHistory flips to false for every connected tab, not just the requester

  return earlier;
}

// Fork the conversation at `userMessageId` and open the fork as a new,
// independent cockpit session (non-destructive - the original keeps
// running). Optionally reverts files on the *original* session first, per
// plan MVP2 ("forkSession() for the conversation and rewindFiles() for the
// files"). Skips the file half when the row has no checkpointing rather
// than letting it fail.
export async function rewind(id, turnIndex, { dryRun = false } = {}) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  if (!row.claudeSessionId) throw new Error('session has no claude session id yet');
  if (row.turnIndexUnreliable) {
    throw new Error('could not read this session\'s prior transcript when it started, so turn numbering cannot be trusted - rewind is disabled for it. Resuming it again may resolve this.');
  }

  if (row.provider === 'grok') {
    const points = await row.handle.listRewindPoints();
    const promptIndex = resolveGrokPromptIndex(points, turnIndex);
    if (dryRun) {
      return { filesResult: { conversationOnly: true, promptIndex }, forkedSessionId: null };
    }
    // Conversation-only. Grok's stdio fork params are still unknown, so this
    // truncates the current Grok session then the caller reopens it.
    const filesResult = await row.handle.rewindTo(promptIndex);
    const grokSessionId = row.claudeSessionId;
    // Conversation rewind reuses the same Grok session id in a new cockpit
    // row. closeSession drops this row so it does not sit in list() as a
    // phantom 'closed' session forever.
    closeSession(id);
    return { filesResult: { ...filesResult, conversationOnly: true }, forkedSessionId: grokSessionId };
  }

  const userMessageId = await resolveTurnUuid(row.claudeSessionId, row.cwd, turnIndex);

  let filesResult = null;
  if (row.hasFileCheckpointing) {
    filesResult = await rewindFilesSdk(row.handle.query, userMessageId, { dryRun });
  }

  let fork = null;
  if (!dryRun) {
    fork = await forkConversation(row.claudeSessionId, userMessageId);
  }

  return { filesResult, forkedSessionId: fork ? fork.sessionId : null };
}

// Read-only passthrough, same as supportedModels/supportedAgents in
// server.js - no row field tracks MCP state, so there's nothing to mutate
// or broadcast here.
export async function getMcpServerStatus(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  return row.handle.query.mcpServerStatus();
}

// Same shape as setPermissionMode/setModel above: call the SDK method,
// throw on failure (both Query methods already throw), broadcast after so
// any other tab with the settings modal open knows to re-fetch its own MCP
// panel. No row field to keep in sync (no `patch` arg) - mcpServerStatus()
// is the only source of truth and is fetched fresh each time the panel
// opens.
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
}

function handleMessage(id, message) {
  const row = sessions.get(id);
  if (!row) return;
  if (message.session_id) row.claudeSessionId = message.session_id;
  // The CLI can move itself out of the mode it was started/set in (e.g.
  // accepting a plan exits `plan`) without any setPermissionMode() call
  // from us - previously only session.js's own private `currentMode`
  // learned this (via the same 'status' message), leaving `row.mode` and
  // every client's mode button stale. Concretely: accept a plan, the
  // button still reads `mode: plan`, and the next Shift+Tab computes its
  // target off that stale value and lands on `bypassPermissions` instead
  // of the true next mode. broadcastSummary pushes the correction to every
  // connected tab, same as setPermissionMode() does for a client-driven
  // change.
  if (message.type === 'system' && message.subtype === 'status' && message.permissionMode && message.permissionMode !== row.mode) {
    row.mode = message.permissionMode;
    broadcastSummary(id);
  }
  if (applyAssistantUsage(row, message)) broadcastUsage(id); // cost/tokens only - cheap, no round trip, so this can track every message
  // Task* detection/resolution also has to run for a resumed session's
  // replayed history (see createSession's seedTaskState call), not just the
  // live stream - factored out so both call sites share one implementation
  // instead of the seed path silently missing whatever this one does.
  if (deriveTaskUpdate(row, message)) broadcastTasks(id);
  // The hard stop, not the proactive 5h/7d chip (refreshRateLimits above,
  // which is a poll off the experimental usage API): this is the SDK
  // pushing rate_limit_event itself the moment a turn is actually rejected
  // or un-rejected. status 'rejected' is the only one that blocks a turn -
  // 'allowed'/'allowed_warning' both mean the session is free to run, so
  // either clears whatever hit was previously recorded (a limit can lift
  // between one event and the next without us doing anything).
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
  // Second, independent source for the same rateLimitHit state: the CLI
  // also drops a plain-language assistant reply on a session-limit hit
  // ("You've hit your session limit · resets 2:10am (Europe/Paris)") - and
  // confirmed against a real hit, that wall-clock text is trustworthy where
  // rate_limit_event's numeric resetsAt needed a unit fix (see above) to
  // even agree with it. No model call, no token spend - just a regex over
  // text already in the message stream. Overwrites rate_limit_event's guess
  // when both are present; this one wins because it's the one we've
  // actually verified against ground truth.
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
    refreshContextUsage(id); // a real round trip to the CLI - once per finished turn, not per message
    refreshRateLimits(id);
  }
}

// FALLBACK ONLY - the real path is message.toolUseResult (see handleMessage's
// tool_result branch). This exists in case a future CLI build ever stops
// attaching toolUseResult and reverts to putting structured data directly in
// `content`; it was previously (wrongly) assumed to be the primary path,
// which is why the task panel never worked despite tests passing - the CLI's
// actual `content` for Task* results is always a human-readable summary
// string ("Task #1 created successfully: <subject>"), never JSON, so
// JSON.parse here always threw and applyTaskOp always returned false.
// Accepts any of the forms seen elsewhere in this codebase for tool results:
// a plain string, an array of { type: 'text', text } blocks (see
// stream-view.js's flattenToolResult), or an already-parsed object. Returns
// null rather than throwing on anything unexpected - same tolerance
// refreshRateLimits() has for its own experimental API.
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

// Accumulates one assistant message's cost/tokens into row.usageAcc (the
// header stats strip's running total) and stamps message._usageInfo (read by
// stream-view.js for the inline "$0.0X, N in, M out" label on every block
// this message rendered, and by turn-chart.js/app.js for that message's bar
// in the per-turn cost graph). Same B10 shape as deriveTaskUpdate below:
// shared by handleMessage's live stream and createSession's seedUsage
// (a resumed session's replayed history never goes through handleMessage),
// so the seed path can't silently drift from the live path - which is
// exactly what used to happen here: a resumed session's row.usageAcc and
// every historical message's _usageInfo started from nothing, so the header
// total under-reported and the cost graph showed no bars at all until the
// first new live turn landed.
//
// cacheReadTokens/cacheWriteTokens/cacheMiss ride along for the per-turn
// chart: "cache miss" mirrors claude-realtime-usage's own heuristic
// (stepCost's caller in live_watcher_template.html) - a turn wrote more
// cache than it read is one whose prompt cache had expired (or never
// existed), not necessarily the first turn of a session.
//
// Returns whether it actually did anything, so handleMessage's live path
// only pays for a broadcastUsage on messages that could plausibly have
// changed the total (seedUsage ignores the return value - it broadcasts once
// itself, after the whole history is folded in, not per message).
function applyAssistantUsage(row, message) {
  if (message.type !== 'assistant' || !message.message) return false;
  row.usageAcc.addAssistantMessage(message.message);
  const info = costForUsage(message.message.model, message.message.usage);
  if (info) {
    message._usageInfo = {
      costUsd: info.cost,
      inputTokens: info.inputTokens,
      outputTokens: info.outputTokens,
      cacheReadTokens: info.readTokens,
      cacheWriteTokens: info.writeTokens,
      cacheMiss: info.writeTokens > 0 && info.writeTokens >= info.readTokens,
    };
  }
  return true;
}

// Watches one SDK message for Task* tool activity and applies whatever it
// resolves, returning whether row.tasks actually changed (so callers only
// broadcast on a real change). Shared by handleMessage's live stream and
// createSession's seedTaskState (a resumed session's replayed history never
// goes through handleMessage - see its own comment) - keeping this as the
// one place that knows how a Task* tool_use/tool_result pair turns into a
// row.tasks mutation means the seed path can't silently drift from the live
// path the way it did before this was extracted (that's what caused B10:
// tasks created before the current browser attach never showed up).
//
// Stashes Task* tool_use blocks (row.pendingTaskOps) on the way in so the
// matching tool_result - a separate 'user' message, arriving after Claude's
// own turn ends (or, for a replayed history, appearing later in the same
// array) - can be resolved against the input that actually produced it.
// TaskGet isn't tracked: it only enriches one task's description, which the
// panel doesn't show (see task-panel.js).
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
  // Resolves whichever Task* call(s) this tool_result belongs to (stashed
  // above when the tool_use was seen) and applies the resulting task-state
  // change - see applyTaskOp's own comment for why this reads the ORIGINAL
  // input rather than the result payload for TaskUpdate specifically.
  if (message.type === 'user' && message.message && Array.isArray(message.message.content)) {
    for (const block of message.message.content) {
      if (block.type !== 'tool_result') continue;
      const op = row.pendingTaskOps.get(block.tool_use_id);
      if (!op) continue;
      row.pendingTaskOps.delete(block.tool_use_id);
      // message.toolUseResult carries the CLI's real structured payload
      // ({task:{id,subject}}, {success,taskId,...}, {tasks:[...]}) - block.content
      // is always the human-readable summary string it renders for the model
      // (e.g. "Task #3 created successfully: <subject>"), confirmed by pulling
      // the literal template strings out of the CLI binary. toolUseResult is
      // read first, parseToolResultJson(block.content) kept only as a
      // fallback in case a future CLI build stops attaching toolUseResult.
      const data = message.toolUseResult !== undefined ? message.toolUseResult : parseToolResultJson(block.content);
      if (applyTaskOp(row, op, block, data)) changed = true;
    }
  }
  return changed;
}

// Applies one resolved Task* call to row.tasks and reports whether anything
// actually changed (so the caller only broadcasts on a real change, not
// every tool_result that happens to parse). TaskUpdate reads its new field
// values from `op.input` - the tool_use block's own input - not from the
// result: TaskUpdateOutput only reports success + which field *names*
// changed (updatedFields), never the new values, so the input is the only
// place they exist. TaskList's result is the one authoritative full
// resync - it fully replaces row.tasks rather than merging into it, since
// it's also the only way this reconstruction ever learns a task was
// deleted (a deleted task simply stops appearing in it).
//
// Known gap: `addBlocks` (marking this task as blocking others) only
// updates the *other* tasks' blockedBy on the next TaskList resync, not
// immediately - applying it live would mean inventing an entry for a task
// this row hasn't seen a TaskCreate/TaskList for yet.
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

// "Next time it's HH:MM in `tz`" as an epoch-ms instant, computed without a
// tz database of our own: format `now` into tz's wall-clock fields via
// Intl, diff that against the target wall-clock time in minutes, then apply
// the same diff to the real instant `now`. That sidesteps ever computing a
// UTC offset directly - correct as long as the zone's offset doesn't change
// between now and the target (i.e. no DST transition in the gap), which for
// a same-day-or-next-day rate-limit reset is true in all but a freak edge
// case around the one night a year clocks change.
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
// resets, mirroring the desktop checkbox from the announcement. Re-entrant:
// safe to call again on a later rate_limit_event or a mid-wait checkbox
// toggle, always clearing any prior timer first so two never race. No
// resetsAt (older SDK, or the field just wasn't sent) means there's nothing
// to schedule against - autoContinue stays armed for next time, it just
// can't fire on this hit.
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
    row.handle.pushInput('Continue');
    broadcastSummary(id);
  }, delay);
}

function clearAutoContinueTimer(row) {
  if (row.autoContinueTimer) {
    clearTimeout(row.autoContinueTimer);
    row.autoContinueTimer = null;
  }
}

// True once the experimental usage API has thrown once (missing method,
// renamed method, wire error - anything). Process-wide, not per-session:
// the method either exists on this SDK build or it doesn't, so one failure
// means every session's session will fail identically. Stops retrying it
// every turn once that's known, rather than eating the cost of a doomed
// call each time. Our own cost/token numbers (usage.js's accumulator) never
// depend on this - they come from the message stream directly and keep
// working untouched whether this flag is set or not.
let rateLimitsApiBroken = false;

// Best-effort plan/quota display (5h and 7d rate-limit windows) off the
// SDK's experimental `/usage` control request - see the plan doc's Open
// Questions #1. Deliberately isolated from refreshContextUsage/usageAcc:
// if this API is renamed or removed in a future SDK bump, the catch below
// just stops populating row.rateLimits (the panel quietly drops the quota
// chip) rather than taking cost/token/context tracking down with it.
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
// accumulator, which is pure local math off the message stream already
// flowing through), so it's only called once a turn actually finishes -
// still "live, no 1-turn lag" per plan MVP4, just not on every partial
// message. Best-effort: swallows errors (e.g. a session that closed mid
// flight) rather than surfacing a stats-panel failure as a session error.
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
    context: row.contextUsage
      ? { totalTokens: row.contextUsage.totalTokens, maxTokens: row.contextUsage.maxTokens, percentage: row.contextUsage.percentage }
      : null,
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
  if (row) row.pendingApproval = request; // cleared in resolveApproval() once the client decides
  broadcast(id, { type: 'cockpit:approval-request', request });
}

function handleError(id, err) {
  const row = sessions.get(id);
  if (!row) return;
  row.state = 'error';
  broadcast(id, { type: 'cockpit:error', error: String((err && err.stack) || err) });
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
