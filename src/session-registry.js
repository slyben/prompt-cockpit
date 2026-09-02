// Cockpit-id-keyed session table. Cockpit id is the primary key everywhere
// (registry row, ws route, token); Claude's own session id is a mutable
// attribute refreshed as messages arrive (see plan Decisions).
//
// Settings-store boundary (three stores exist; this is one of them): a registry row is
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
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { countWithinTokenBudget, countRealUserTurns, INITIAL_HISTORY_TOKEN_BUDGET } from './session-history.js';
import { createEventLog, append as appendEvent, replay as replayEvents } from './event-log.js';
import { createUsageAccumulator, costForUsage } from './usage.js';
import { contextPayload } from './context-usage.js';
import { getProvider, parseProvider } from './provider-registry.js';
import { createDelegation } from './delegation.js';
const sessions = new Map();

// Cross-session delegation (handshake trust + `/ask`) lives in delegation.js
// now - see that module's own comment for why it takes these as constructor
// params instead of importing this module back (would be a cycle).
// pushTurn/broadcast/broadcastSummary/findByName are function DECLARATIONS
// further down this file - fully hoisted before any top-level statement
// (this one included) runs, so referencing them here is safe regardless of
// textual order.
const delegation = createDelegation({ sessions, pushTurn, broadcast, broadcastSummary, findByName });
export const getHandshakeSecret = delegation.getHandshakeSecret;
export const regenerateHandshakeSecret = delegation.regenerateHandshakeSecret;
export const setSessionHandshake = delegation.setSessionHandshake;
export const isSessionTrusted = delegation.isSessionTrusted;
export const delegateTask = delegation.delegateTask;

export function createSession({ cwd, resume, name, model, permissionMode, history, provider, effort, startSessionImpl }) {
  // Authoritative uniqueness check for delegation names - this function has no `await`
  // before it and none until sessions.set() further down, so this closes
  // the TOCTOU window server.js's own pre-check has on its own (that check
  // runs after awaiting the resume-history fetch, so two concurrent
  // POST /api/sessions for the same name can both pass it before either
  // has actually created a row - confirmed in review). `err.code` lets
  // server.js tell this apart from any other createSession failure and
  // answer 409 instead of 500.
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
    // below derives the legacy claudeSessionId wire field from this plus
    // row.provider instead of this row keeping a second copy in lockstep -
    // a Grok/Codex row used to get a `claudeSessionId` too (just a copy of
    // its own, non-Claude, id), which was actively misleading given the
    // field's name.
    providerSessionId: resume || null,
    // See delegation.js's own handshakeSecret comment - stamped with
    // the CURRENT canonical value at creation, so a locally-spawned row is
    // trusted for delegation from the moment it exists.
    handshakeSecret: delegation.getHandshakeSecret(),
    // `enableFileCheckpointing` can't be turned on retroactively (plan
    // Decisions), so it only actually covers this session's history if the
    // cockpit started it fresh. Any resumed session - whether it was last
    // run in a terminal or in a prior cockpit process - has no snapshots
    // for its earlier turns, so file rewind must be off rather than
    // attempted and failed (see rewind() below, which checks this flag).
    hasFileCheckpointing: providerDescriptor.capabilities.fileRewind && !resume,
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
    // Unresolved approval requests in arrival order. Last-write-wins on a
    // single field dropped the earlier banner (and stranded that tool call)
    // whenever two gated tools waited at once - parallel tool_use in one
    // turn, or Codex/Grok overlapping permission prompts. A reconnecting
    // client is replayed the whole list, not only the latest.
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
    // tool_use id -> { kind: 'create'|'update'|'list', input } for a Task*
    // call whose result hasn't arrived yet - applyTaskOp needs the ORIGINAL
    // input (TaskUpdateOutput only reports which field names changed, not
    // their new values) matched against the tool_result that confirms it
    // actually succeeded. Entries are deleted as soon as their result lands;
    // a call that never gets one (error mid-flight, session closes) just
    // lingers harmlessly for the row's lifetime.
    pendingTaskOps: new Map(),
    // Visible input queue - full snapshot from session.js's
    // onQueueChange, same shape session.js's listQueue() returns:
    // [{id, text}], ordered. Empty on grok sessions (stubbed - see
    // grok-session.js). Not persisted/resumed across a reconnect for the
    // same reason `tasks`/`pendingTaskOps` above aren't seeded from
    // `history` either - a queue only ever holds turns pushed THIS process
    // lifetime, there is nothing about it in a resumed transcript.
    queue: [],
    // Cross-session delegation state does NOT live on the row. Both the
    // in-flight turn ORDER and the per-turn delegation `tag` are owned by
    // the handle's result-epoch tracker (`row.handle.turns`, see
    // result-epoch.js) - this module reads them off it and keeps no copy.
    //
    // That is deliberate and hard-won: this row used to carry its own
    // ordered `pendingResultTags` array that every call site had to mirror
    // by hand onto the provider's real queue, and every time the two copies
    // drifted, a delegated reply got relayed to the wrong origin session.
    // result-epoch.js's module comment lists the three production bugs that
    // produced. `tag` itself is `null` for an ordinary human/auto-continue
    // turn, or `{ fromId, fromName, task, buffer }` for a turn pushed by
    // delegateTask() on behalf of another session; it is keyed by the
    // `queueId` every provider's pushInput mints on success (Claude, Grok,
    // Codex), never by position.
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
    onQueueChange: (queue) => {
      row.queue = queue;
      broadcastQueue(id);
    },
    // MCP "needs-auth" badge - no row field to keep in sync,
    // same as toggleMcpServer/reconnectMcpServer below: session.js's
    // getMcpAuthPending() is the only source of truth, this just tells any
    // open MCP panel to re-fetch it (mcp-panel.js is poll-on-open/refresh-
    // button only otherwise - see its own module comment - so without this
    // push a panel left open through an auth flow would sit on a stale
    // "needs-auth" badge with no link until the user thought to hit refresh).
    onMcpAuthRequest: () => broadcastMcpAuth(id),
    onMcpAuthResolved: () => broadcastMcpAuth(id),
  });

  return row;
}

export function get(id) {
  return sessions.get(id);
}

// Cross-session delegation: name -> row lookup, scoped to one cwd
// (fast, unambiguous path for the common single-project case; also what
// session creation/rename use to enforce name uniqueness, so two unrelated
// projects can each have their own "Claude" without colliding). Names are
// case-insensitive. cwd is path-canonicalized (resolve + Windows
// drive-letter case) so `D:\foo` vs `d:\foo` vs a trailing slash still
// match - that was a silent miss, not a safety rail.
// Empty/whitespace names never match anything, since an unnamed row's
// `name` is `null`.
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

// Cross-session delegation: the ONE place that pushes a turn into a
// row's handle - every call site (sendInput, delegateTask, a relayed result
// landing back on its origin, scheduleAutoContinue's synthetic 'Continue')
// goes through this. `tag` is null for a non-delegated turn; a tagged turn
// registers its tag against the queueId the handle's own turn tracker
// already minted for it, so there is exactly one record of this turn's
// identity (see result-epoch.js). Untagged turns register nothing at all -
// the tracker's ordering already accounts for them, which is the whole
// reason a plain human message interleaved with a delegation can no longer
// desync the relay.
// Turns still awaiting a `result` on this row. `?? 0` covers a handle
// without a turn tracker at all (older test doubles, and any future row
// type that isn't backed by a local CLI - see delegation.js's module
// comment on MVP6) rather than throwing from a summary broadcast.
function pendingTurnsCount(row) {
  return row.handle?.turns?.pendingCount ?? 0;
}

function pushTurn(row, text, tag = null) {
  const queueId = row.handle.pushInput(text);
  // `null` means pushInput did NOT enqueue anything: the target queue was
  // already closed, or (grok only) this exact prompt was already pending.
  // No result will ever come for a turn that was never actually pushed, so
  // registering a tag for it here would strand its origin forever waiting
  // on a reply (the 2026-08-24 review's finding #2). Best-effort drop
  // instead, same as relayDelegationResult already does when its own origin
  // lookup misses.
  if (queueId === null) return null;
  if (tag) row.handle.turns?.setTag(queueId, tag);
  // Returned so relayDelegationResult can correlate this turn's own echoed
  // 'user' message (which session.js stamps with this same queueId, see its
  // pushInput comment) with a later, separate cockpit:delegate-full-trace
  // marker - see that function for why the two can't just be sent as one
  // message. Every other caller here ignores the return value, unaffected.
  return queueId;
}

// Ends a session's live query() and drops its row. Nothing currently calls
// this automatically (see server.js's DELETE route comment) - sessions
// otherwise accumulate for the cockpit process's entire lifetime.
export function closeSession(id) {
  const row = sessions.get(id);
  if (!row) return false;
  clearAutoContinueTimer(row);
  // For a delegated turn: session.js's close() only interrupts the current turn and closes
  // the input queue - the interrupted turn's own `result` still arrives
  // asynchronously later, per its own comment - but sessions.delete(id)
  // below happens synchronously right now, so by the time that late
  // `result` reaches handleMessage, `sessions.get(id)` finds nothing and
  // bails before ever reaching the tag-claim/relay below. Without
  // this, a session closed while it's the target of a delegation strands
  // the origin(s) forever with no error (confirmed in review - unlike a
  // crash, which handleError already covers). Fail them explicitly here,
  // before the row disappears.
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

// Debug capture (backlog: "spinner spins, nothing running" reports with no
// live state to catch when it happens). Combines this row's own bookkeeping
// with the handle's internal debugSnapshot() (session.js/grok-session.js) -
// the latter is what actually explains a stuck spinner: row.state is just
// the last value onStateChange reported, but pendingTurns is the counter
// that value is computed FROM, so a report with pendingTurns > 0 and no
// visible activity points at a real turn-accounting bug, while
// pendingTurns === 0 with state still 'running' points at a dropped/
// out-of-order state broadcast instead - two different bugs that look
// identical from the browser alone.
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

// Visibility-only introspection for GET /api/system/memory (see
// routes/system.js) - reports what each row's unbounded-looking collections
// actually hold right now. Nothing here enforces a cap; eventLog is the one
// collection that already is byte-capped (event-log.js), included so its
// current usage against that cap is visible next to everything else instead
// of only being knowable by reading the source. Read-only: never mutates a
// row, so it's safe to poll from the dashboard on an interval.
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
    // Backward-compatible response field for existing browser tabs (still
    // read by public/detail-pane.js and agent-liveness.js, which fetch a
    // subagent transcript from ~/.claude/projects - a genuinely Claude-only
    // path). Derived here rather than stored on the row, and only for an
    // actual Claude session, so a Grok/Codex row no longer claims a
    // "claudeSessionId" that's really its own provider's id.
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
    // See handshakeSecret's module-level comment - whether this row is
    // currently allowed to send/receive a delegated task. The raw secret
    // value itself is NOT included here (only the server's own canonical
    // copy is meant to be copied around, via the /api/handshake route).
    handshakeTrusted: delegation.isSessionTrusted(row),
    // Turns cockpit still considers "in flight" for this row - read straight
    // off the handle's turn tracker (result-epoch.js), which is also what
    // session.js/grok-session.js/codex-session.js's own pendingTurns
    // counters move in step with. Surfaced here so app.js can show it next
    // to the spinner without polling the debug endpoint. A number here that
    // never comes back to 0 despite nothing actually running is exactly the
    // drift getDebugInfo's own comment describes - see forceIdle below for
    // the manual recovery.
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

// `sinceSeq` comes from the client's last-seen event seq (server.js reads
// it off the ws upgrade URL's `since` param). Omitted/0 on a first-ever
// attach - full replay, same as before reconnect support existed. A
// returning client that still holds its rendered DOM sends its real last
// seq and gets only the delta;
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
// live SDK handle: look up the row (or throw the same "unknown session"
// every other registry function throws), run `action` against it, merge
// `patch` onto the row to keep it in sync (omit it for the read-only
// passthroughs - toggleMcpServer/reconnectMcpServer have no row field to
// keep in sync), then broadcast so every connected tab sees the change.
// Used to be copy-pasted per route (setPermissionMode/setModel/
// setMaxThinkingTokens each hand-rolled this), which meant
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

// Cancels whatever turn(s) are currently running, same session/no row-field
// shape as setPermissionMode above minus the patch - session.js's interrupt()
// doesn't change any row-visible state itself; the idle/running flip rides
// in on the interrupted turn's own `result` message the same way a normal
// completion does, broadcast separately by the row's existing message
// handling, not by this call.
//
// session.js's interrupt() (the client's Stop button) also drains its own
// local input queue now, not just the in-flight turn - "stop" means stop
// everything. It does that synchronously, before this call even returns, and
// drops those turns from the turn tracker's ordering as it goes. What it
// can't do is notify a delegation origin that its task was cancelled (the
// provider layer knows nothing about delegation), so snapshot which ids are
// about to be dropped first and fail their tags right alongside - same
// treatment removeQueued() above gives a single manual removal.
export async function interruptTurn(id) {
  return queryPassthrough(id, async (row) => {
    const queuedIds = row.handle.listQueue().map((e) => e.id);
    await row.handle.interrupt();
    for (const queueId of queuedIds) failDroppedTurn(row, queueId);
  });
}

// Manual last-resort recovery for the "pendingTurnsCount never reaches 0"
// drift (see that field's own comment on toSummary) - the click-through for
// the badge next to the spinner (app.js) that lets a human assert "nothing
// is actually running, stop waiting for a result that isn't coming".
// Doesn't route through queryPassthrough: this has to fail this row's own
// stuck delegations too (same as closeSession/handleError do, via
// failPendingDelegations), which queryPassthrough's single-action shape
// doesn't have room for, and forceIdle's own onStateChange already
// broadcasts the state flip - a second broadcastSummary here just also
// covers the pendingTurnsCount reset for any tab that already rendered the
// stale count before this ran.
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

// Same shape as setModel above, except the "one query() method" is a no-op:
// row.name is purely cockpit-side bookkeeping (session-titles.js persists
// the durable copy; server.js's rename route calls both), the SDK has
// nothing analogous to tell. NOT routed through queryPassthrough (unlike
// every sibling here) - the delegation-name uniqueness check needs to run synchronously
// right next to the mutation it's guarding, with zero `await` in between,
// the same reasoning as createSession's own check above. queryPassthrough's
// `await action(row)` - even against a no-op async function - is enough of
// a yield point that two concurrent renames to the same name could both
// pass a check performed before it.
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

// Fork the conversation at `userMessageId` and open the fork as a new,
// independent cockpit session (non-destructive - the original keeps
// running). Optionally reverts files on the *original* session first
// (forkSession() for the conversation, rewindFiles() for the files). Skips
// the file half when the row has no checkpointing rather
// than letting it fail.
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
  // How to actually fork a conversation is provider-specific (Claude's SDK
  // forkSession() vs Grok's own fork-then-truncate ACP calls) and lives on
  // the descriptor itself (provider-registry.js) rather than branching here
  // - a provider that sets conversationFork: true without a rewind
  // implementation is a descriptor bug, not something this function should
  // silently paper over by falling back to Claude's.
  if (typeof provider.rewind !== 'function') {
    throw new Error(`${provider.label} advertises conversation-fork support but has no rewind implementation`);
  }
  return provider.rewind(row, turnIndex, { dryRun });
}

// Read-only passthrough, same as supportedModels/supportedAgents in
// server.js - no row field tracks MCP state, so there's nothing to mutate
// or broadcast here (broadcastMcpAuth below is the exception, fired
// directly off session.js's onMcpAuthRequest/onMcpAuthResolved instead of
// from a row mutation, same "push without a row field" shape as
// toggleMcpServer/reconnectMcpServer). Merges in `authUrl`/`authMessage` for
// any server session.js's onElicitation caught a URL-mode auth request for -
// McpServerStatus itself has no such field (name/status/error only), and
// `status: 'needs-auth'` alone gives the panel nothing to link to. Grok
// sessions have no getMcpAuthPending (grok-session.js's handle doesn't
// expose one - grok-extensions.js's mcpServerStatus() stub has no
// elicitation concept), hence the guard.
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
  // A row whose underlying handle ends on its own - the CLI process exits,
  // or session.js/grok-session.js's for-await loop throws - previously
  // lingered in `sessions` forever: only the manual closeSession() route
  // (the "Close session" button) ever called sessions.delete, so a session
  // nobody clicked "close" on accumulated for the cockpit process's entire
  // lifetime (2026-08-26 review, finding #1). Reap it here, once every
  // connected client has already been told via the broadcastSummary above -
  // the handle is dead either way, so there's nothing left a manual close
  // would additionally have done.
  //
  // 'error' is deliberately excluded from that reap (2026-09-02 review,
  // finding #1): every production provider calls onStateChange('error')
  // immediately followed by onError(err) (session.js/grok-session.js/
  // codex-session.js), and onError routes to handleError below, which does
  // its own cleanup - failPendingDelegations, turns.abandonAll(), the
  // cockpit:error broadcast - before its own sessions.delete. Reaping here
  // first made handleError's `sessions.get(id)` come back empty, silently
  // skipping all of that on every real crash. A 'closed' transition has no
  // such follow-up call (the for-await loop's normal-exit path only ever
  // calls onStateChange('closed')), so it still reaps here.
  if (state === 'closed') sessions.delete(id);
}

function handleMessage(id, message) {
  const row = sessions.get(id);
  if (!row) return;
  if (message.session_id) row.providerSessionId = message.session_id;
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
  const hadModel = !!row.model;
  if (applyAssistantUsage(row, message)) {
    broadcastUsage(id); // cost/tokens only - cheap, no round trip, so this can track every message
    // A "Default model" launch leaves row.model null until this call resolves
    // it (see applyAssistantUsage's own comment) - broadcastUsage alone never
    // reaches the header badge, since applyModelBadge only runs off
    // cockpit:hello/cockpit:state (applySession), not cockpit:usage. Without
    // this the badge stayed hidden for the rest of the session unless some
    // unrelated event (e.g. renaming) happened to trigger a state broadcast.
    if (!hadModel && row.model) broadcastSummary(id);
  }
  delegation.collectDelegationText(row, message); // buffers this turn's assistant text while a matching delegation is pending, see the 'result' branch below
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
    // Which turn just finished is decided by the handle's own turn tracker,
    // never by position here: every provider stamps the finishing turn's
    // `_cockpitQueueId` onto its result message (result-epoch.js's stamp/
    // applyResultStamp), so the delegation tag is looked up by identity.
    // That is what makes an interleaved human turn, a queue-pane reorder,
    // and a late result from a force-idled generation all harmless - see
    // result-epoch.js's module comment for the three bugs the old
    // shift()-a-parallel-array approach kept re-introducing.
    //
    // `_cockpitStale` means this result belongs to an abandoned generation;
    // its tag (if it had one) was already failed by failPendingDelegations
    // at force-idle time, so there is deliberately nothing to claim.
    if (message._cockpitStale !== true) {
      const tag = row.handle.turns?.claimTag(message._cockpitQueueId);
      if (tag) delegation.relayDelegationResult(row, tag, { ok: true, message });
    }
    refreshContextUsage(id); // a real round trip to the CLI - once per finished turn, not per message
    refreshRateLimits(id);
  }
}

// FALLBACK ONLY - the real path is message.tool_use_result (see handleMessage's
// tool_result branch). This exists in case a future CLI build ever stops
// attaching tool_use_result and reverts to putting structured data directly in
// `content`; it was previously (wrongly) read as camelCase toolUseResult - that
// spelling is only the persisted-JSONL field name, not the live wire one, so it
// was always undefined and the task panel never worked despite tests passing -
// the CLI's actual `content` for Task* results is always a human-readable
// summary string ("Task #1 created successfully: <subject>"), never JSON, so
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
  // A session started with no explicit model (row.model stays null - see
  // createSession) never otherwise learns what the SDK/CLI actually picked;
  // every assistant message already carries the resolved model id (both
  // providers - see grok-messages.js's assistantMessage), so grab it once
  // and stop - an explicit /model switch afterward overwrites this via
  // setModel's own queryPassthrough patch, not this fallback.
  if (!row.model && message.message.model) row.model = message.message.model;
  const toolNames = Array.isArray(message.message.content)
    ? message.message.content.filter((b) => b && b.type === 'tool_use').map((b) => b.name)
    : [];
  row.usageAcc.addAssistantMessage(message.message, toolNames);
  const info = costForUsage(message.message.model, message.message.usage);
  // info is only null when the message has no usage at all - an unpriced
  // model still carries real token counts (info.cost === null in that
  // case), so _usageInfo gets set either way now. Previously this whole
  // block was gated on `info` truthy, which meant an unpriced model (e.g.
  // Codex before it has a pricing table) never got a _usageInfo at all -
  // no tokens, no cost graph bar, nothing - not just an understated cost.
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
      // message.tool_use_result carries the CLI's real structured payload
      // ({task:{id,subject}}, {success,taskId,...}, {tasks:[...]}) - block.content
      // is always the human-readable summary string it renders for the model
      // (e.g. "Task #3 created successfully: <subject>"), confirmed by pulling
      // the literal template strings out of the CLI binary. The live SDK
      // stream uses snake_case tool_use_result; camelCase toolUseResult is
      // only the persisted-JSONL field name (kept as a secondary fallback in
      // case a message ever originates from a transcript read instead of the
      // live stream). parseToolResultJson(block.content) is the last resort,
      // for a future CLI build that stops attaching either field.
      const structured = message.tool_use_result !== undefined ? message.tool_use_result : message.toolUseResult;
      const data = structured !== undefined ? structured : parseToolResultJson(block.content);
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
    // A TaskCreate landing while every existing task is already completed
    // means the previous batch is done and this is the start of a fresh
    // one (e.g. another round of spawned agents) - drop the stale completed
    // list instead of letting it accumulate forever across unrelated
    // batches. A list with any pending/in_progress task is still active and
    // is left alone even if this new task belongs to a different batch.
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

// MCP "needs-auth" badge - fired from session.js's
// onMcpAuthRequest/onMcpAuthResolved (see createSession above). Unlike every
// other broadcast* here, there's no row field to read a payload off - the
// merged {authUrl} list only exists behind the async getMcpServerStatus()
// round trip (session.js's mcpAuthPending Map plus a fresh SDK status call),
// so this awaits that instead of building a payload from `row` directly.
async function broadcastMcpAuth(id) {
  const row = sessions.get(id);
  if (!row) return;
  const servers = await getMcpServerStatus(id).catch(() => null);
  if (servers) broadcast(id, { type: 'cockpit:mcp-auth', servers });
}

// Queue pane operations - all three just forward to the
// session handle (listQueue is synchronous and local, no round trip, so it
// isn't wrapped in queryPassthrough's async shape). row.queue/the broadcast
// itself are driven by onQueueChange, not by these calls succeeding - a
// grok session's stubbed handle methods return false/[] harmlessly (see
// grok-session.js) rather than throwing "not a function".
export function listQueue(id) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  return row.handle.listQueue();
}

// Shared by removeQueued() below and interruptTurn(): queueId's turn will
// now never run, so it will never produce a `result` either. The handle's
// own removeQueued/interrupt has already dropped it from the turn tracker's
// ordering; all that's left for this layer is the delegation side - if it
// was a delegated turn, tell its origin now rather than leaving it waiting
// forever for a reply that was just cancelled out from under it.
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

// Both of these are now pure passthroughs. They used to also re-apply the
// exact same pin-index-0 tail reorder to a registry-side copy of the
// in-flight turn list - a second implementation of an algorithm
// result-epoch.js's reorderTail already owned, and the source of two
// misrouted-delegation bugs whenever the two drifted (see that module's
// comment). The provider's own reorderQueue/sendNow drive the tracker
// directly, so there is nothing left here to mirror.
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
// still "live, no 1-turn lag" for the stats panel, just not on every partial
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
  // dies. Unlike closeSession, this used to leave that timer armed - it
  // would fire later, pushTurn 'Continue' into a now-dead handle, and
  // broadcast a live-looking 'running' state for a session that's actually
  // errored (confirmed in review: ghost spinner/pending-turn count with
  // nothing behind it, since compose only re-disables on error/closed, it
  // never re-enables on a stray running broadcast).
  clearAutoContinueTimer(row);
  row.state = 'error';
  // A crashing row's for-await loop (session.js/grok-session.js) exits
  // without ever emitting the 'result' message handleMessage's delegation
  // branch waits for, so any tags still pending here would otherwise strand
  // their origin session waiting forever.
  delegation.failPendingDelegations(row, String((err && err.message) || err));
  // ...and the tracker's own in-flight list has to give up on them too, or
  // this row keeps reporting a non-zero pendingTurnsCount forever (the row
  // is reaped below, but a summary can still be broadcast off it first).
  // abandonAll(), not a plain drop: a result that somehow still lands must
  // read as stale rather than match a slot.
  row.handle?.turns?.abandonAll();
  broadcast(id, { type: 'cockpit:error', error: String((err && err.stack) || err) });
  // The only reap for an errored row (setState deliberately does not reap
  // on 'error' - see its own comment) - happens last, after the cleanup
  // above has had a live row to work with.
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
