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
import { randomUUID, randomBytes } from 'node:crypto';
import { startSession } from './session.js';
import { startGrokSession } from './grok-session.js';
import { forkConversation, rewindFiles as rewindFilesSdk, resolveTurnUuid } from './rewind.js';
import { resolveGrokPromptIndex } from './grok-rewind.js';
import { fetchSessionHistory, countWithinTokenBudget, countRealUserTurns, INITIAL_HISTORY_TOKEN_BUDGET } from './session-history.js';
import { fetchGrokSessionHistory } from './grok-history.js';
import { createEventLog, append as appendEvent, replay as replayEvents } from './event-log.js';
import { createUsageAccumulator, costForUsage } from './usage.js';
import { contextPayload } from './context-usage.js';
const sessions = new Map();

// MVP6 seed (backlog.md): a single per-process "handshake secret" minted
// fresh every time this server starts, in memory only - never persisted,
// never sent anywhere automatically. It's the shared value that will
// eventually let a session running on a DIFFERENT machine (an SSH'd Windows
// cockpit, the actual MVP6 target) prove it belongs to the same trusted
// group as sessions running locally, so delegation isn't gated on nothing
// more than "the name string matched." Pairing today is deliberately manual
// (copy from the session-list pane, paste into the other side's session) -
// no exchange protocol exists yet, which is fine for a single human running
// both ends.
//
// Every LOCALLY-created row is stamped with the CURRENT secret at creation
// time (see createSession below), so local sessions are trusted by
// construction - they were spawned by this very process, there's nothing to
// prove. The override only matters two ways: (1) a future non-local row
// type (once MVP6 actually exists) that does NOT get stamped automatically
// and has to be manually promoted via setSessionHandshake, and (2) as a
// manual revoke - blank/garble a row's value via the same setter to opt
// that session out of delegation entirely, in either direction.
let handshakeSecret = randomBytes(16).toString('hex');

export function getHandshakeSecret() {
  return handshakeSecret;
}

// Rotating invalidates every row's trust in one move (their stamped value
// now mismatches) - a broader hammer than setSessionHandshake, deliberately:
// this is the "something looked wrong, cut everyone off" control, not a
// per-row action. Existing rows are NOT re-stamped, so this is also how you
// audit who was actually trusted - anyone still `isSessionTrusted` after a
// rotation was re-synced (or is a fresh row created after the rotation, which
// gets the new value automatically).
export function regenerateHandshakeSecret() {
  handshakeSecret = randomBytes(16).toString('hex');
  return handshakeSecret;
}

export function setSessionHandshake(id, value) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  row.handshakeSecret = typeof value === 'string' ? value.trim() : '';
  return isSessionTrusted(row);
}

export function isSessionTrusted(row) {
  return Boolean(row.handshakeSecret) && row.handshakeSecret === handshakeSecret;
}

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
  // MVP5: authoritative uniqueness check - this function has no `await`
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
    // See handshakeSecret's own module-level comment above - stamped with
    // the CURRENT canonical value at creation, so a locally-spawned row is
    // trusted for delegation from the moment it exists.
    handshakeSecret,
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
    // Visible input queue (backlog.md) - full snapshot from session.js's
    // onQueueChange, same shape session.js's listQueue() returns:
    // [{id, text}], ordered. Empty on grok sessions (stubbed - see
    // grok-session.js). Not persisted/resumed across a reconnect for the
    // same reason `tasks`/`pendingTaskOps` above aren't seeded from
    // `history` either - a queue only ever holds turns pushed THIS process
    // lifetime, there is nothing about it in a resumed transcript.
    queue: [],
    // MVP5 cross-session delegation (backlog.md): ordered record of every
    // turn pushed into THIS row that hasn't produced its `result` yet - one
    // entry per pushTurn() call (see below), `{ queueId, tag }`. `tag` is
    // `null` for an ordinary human/auto-continue turn, or
    // `{ fromId, fromName, task, buffer }` for a turn pushed by
    // delegateTask() on behalf of another session.
    //
    // Turns are strictly FIFO per session (session.js's inputQueue,
    // grok-session.js's promptTail - each pushed input yields exactly one
    // `result` before the next is pulled), so handleMessage's `result`
    // branch can `shift()` this array to find the entry that just finished
    // - PROVIDED this array's order always matches actual execution order.
    // That's not automatically true: a plain human message typed directly
    // into this session interleaves with a pending delegation's turn (both
    // go through the same underlying queue), and the queue pane can
    // remove/reorder/send-now a still-queued turn out of push order. Naively
    // tagging only delegated pushes and blind-shifting on every result
    // silently misroutes a later delegation's reply to the wrong origin
    // session the moment either happens - a real bug caught in review, not
    // a hypothetical.
    //
    // The fix: EVERY push - human (sendInput), delegated (delegateTask),
    // a relayed result landing back on its origin (relayDelegationResult),
    // or auto-continue's synthetic 'Continue' (scheduleAutoContinue) - goes
    // through pushTurn() below, which always appends an entry (tag or not).
    // removeQueued/reorderQueue/sendNow mirror the exact same mutation onto
    // this array that they perform on session.js's own queue (keyed by the
    // same `queueId` session.js's pushInput now returns), so this array
    // stays in lockstep with actual future execution order even after a
    // queue-pane edit - shift() at result time is then always correct.
    // `queueId` is `undefined` for grok sessions (grok-session.js's
    // pushInput has no queue/id concept - positional order is exact there
    // anyway, since grok has no real remove/reorder to desync it).
    pendingResultTags: [],
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
    // MCP "needs-auth" badge (backlog.md) - no row field to keep in sync,
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

// MVP5 cross-session delegation: name -> row lookup, scoped to one cwd
// (v1 routing is same-project only - see backlog.md). Case-insensitive,
// exact match otherwise (no path normalization on `cwd` - two sessions
// started from the same launcher cwd string will always match; a
// differently-spelled-but-equivalent path won't, that's a known v1 gap).
// Empty/whitespace names never match anything, since an unnamed row's
// `name` is `null`.
export function findByName(cwd, name) {
  const norm = (s) => (s || '').trim().toLowerCase();
  const target = norm(name);
  if (!target) return null;
  for (const row of sessions.values()) {
    if (row.cwd === cwd && norm(row.name) === target) return row;
  }
  return null;
}

// MVP5 cross-session delegation: the ONE place that pushes a turn into a
// row's handle - every call site (sendInput, delegateTask, a relayed result
// landing back on its origin, scheduleAutoContinue's synthetic 'Continue')
// goes through this, so row.pendingResultTags can never silently miss an
// entry the way it did when only delegateTask tagged its own push (see that
// field's own comment on createSession's row object for the full failure
// mode this closes). `tag` is null for a non-delegated turn.
function pushTurn(row, text, tag = null) {
  const queueId = row.handle.pushInput(text);
  row.pendingResultTags.push({ queueId, tag });
  // Returned so relayDelegationResult can correlate this turn's own echoed
  // 'user' message (which session.js stamps with this same queueId, see its
  // pushInput comment) with a later, separate cockpit:delegate-full-trace
  // marker - see that function for why the two can't just be sent as one
  // message. Every other caller here ignores the return value, unaffected.
  return queueId;
}

// MVP5 cross-session delegation: the whole feature in one call. Triggered
// by a user typing `/ask <Name>: <text>` in the ORIGIN session's compose
// box (server.js's ws 'delegate' handler) - not an LLM tool call, so there
// is no real tool_use id for the eventual reply to attach to as a genuine
// SDK tool_result (see relayDelegationResult below for how that's handled
// instead). Same-cwd only: findByName is scoped to origin.cwd, so a target
// in a different project is indistinguishable from "no such session" here.
export function delegateTask(originId, targetName, text) {
  const origin = sessions.get(originId);
  if (!origin) throw new Error(`unknown session: ${originId}`);
  const target = findByName(origin.cwd, targetName);
  if (!target) throw new Error(`no session named "${targetName}" in this project`);
  if (target.id === origin.id) throw new Error('cannot delegate to the same session');
  // Handshake gate (see handshakeSecret's module-level comment): both ends
  // have to currently agree with this process's canonical secret, not just
  // the target - an origin that's been manually revoked shouldn't be able
  // to ask anyone anything either.
  if (!isSessionTrusted(origin)) throw new Error('this session\'s handshake does not match the server - it cannot delegate to other sessions (see Settings)');
  if (!isSessionTrusted(target)) throw new Error(`"${target.name || targetName}" does not have a matching handshake - it cannot receive delegated tasks (see Settings)`);
  // Symmetric with relayDelegationResult's wrapper below: without this, the
  // target's own transcript - and the target model itself - has no way to
  // tell this turn apart from the human typing straight into its compose
  // box. It would just read "You: <text>" with zero indication another
  // session asked, which is exactly the gap that surfaced in review
  // (target's own reasoning referred to "the user" instead of the delegating
  // session). `tag.task` below stays the original unwrapped text - it's only
  // used for the eventual reply's header line, not re-displayed to the target.
  //
  // Deliberately prose, not an XML-ish `<delegated_task from="...">` tag
  // (that was the v1 shape - see git history/backlog for why it was
  // dropped): a bare tag wrapping plain text in an ordinary user turn is
  // structurally indistinguishable from a hand-typed prompt-injection
  // payload, and a receiving model that's trained to distrust exactly that
  // pattern will - correctly, given what it's shown - refuse it outright
  // ("I didn't spawn this agent, not treating this tag as real", confirmed
  // live 2026-08-20). Prose framing doesn't eliminate that risk (nothing
  // fully can without an out-of-band system-prompt anchor - see backlog),
  // but it removes the single strongest refusal trigger: leading with a
  // fake-tool-scaffolding token. `buildDelegatedHeader`'s exact wording
  // matters here - it explicitly attributes the ask to "your operator" (a
  // human), not to the sibling session as an autonomous agent, since that's
  // the actual trust chain (`/ask` is only ever user-typed - see this
  // function's own comment above) and is what a suspicious model is really
  // checking.
  const wrappedTask = buildDelegatedHeader('task', origin.name || 'session', text);
  pushTurn(target, wrappedTask, { fromId: origin.id, fromName: origin.name || 'session', task: text, buffer: [] });
  broadcastSummary(target.id); // target tab's state flips to 'running' immediately, not on its next unrelated broadcast
  // Durable marker on the ORIGIN's own event log/transcript - not routed
  // through target.handle/onMessage, this never touched the SDK - so a
  // reconnecting origin tab sees "-> Asked <Name>: ..." exactly where it
  // was typed, same durability the eventual delegated_result reply gets.
  const marker = { type: 'cockpit:delegate-sent', targetName: target.name || targetName, text };
  const seq = appendEvent(origin.eventLog, marker);
  broadcast(originId, { type: 'sdk:message', message: marker, seq });
  return { targetId: target.id, targetName: target.name };
}

// Ends a session's live query() and drops its row. Nothing currently calls
// this automatically (see server.js's DELETE route comment) - sessions
// otherwise accumulate for the cockpit process's entire lifetime.
export function closeSession(id) {
  const row = sessions.get(id);
  if (!row) return false;
  clearAutoContinueTimer(row);
  // MVP5: session.js's close() only interrupts the current turn and closes
  // the input queue - the interrupted turn's own `result` still arrives
  // asynchronously later, per its own comment - but sessions.delete(id)
  // below happens synchronously right now, so by the time that late
  // `result` reaches handleMessage, `sessions.get(id)` finds nothing and
  // bails before ever reaching the pendingResultTags shift/relay. Without
  // this, a session closed while it's the target of a delegation strands
  // the origin(s) forever with no error (confirmed in review - unlike a
  // crash, which handleError already covers). Fail them explicitly here,
  // before the row disappears.
  failPendingDelegations(row, 'the target session was closed before it replied');
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
    hasPendingApproval: Boolean(row.pendingApproval),
    pendingApprovalToolName: row.pendingApproval?.toolName || null,
    queueLength: row.queue.length,
    pendingResultTagsLength: row.pendingResultTags.length,
    autoContinue: row.autoContinue,
    rateLimitHit: row.rateLimitHit,
    handle: row.handle?.debugSnapshot ? row.handle.debugSnapshot() : null,
  };
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
    // See handshakeSecret's module-level comment - whether this row is
    // currently allowed to send/receive a delegated task. The raw secret
    // value itself is NOT included here (only the server's own canonical
    // copy is meant to be copied around, via the /api/handshake route).
    handshakeTrusted: isSessionTrusted(row),
    // Turns cockpit still considers "in flight" for this row - mirrors
    // session.js/grok-session.js's own pendingTurns 1:1 (both increment on
    // pushTurn, both decrement on the same 'result' message, see
    // handleMessage's pendingResultTags.shift() below), just read from the
    // registry side so app.js can show it next to the spinner without
    // polling the debug endpoint. A number here that never comes back to 0
    // despite nothing actually running is exactly the drift getDebugInfo's
    // own comment describes - see forceIdle below for the manual recovery.
    pendingTurnsCount: row.pendingResultTags.length,
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
  pushTurn(row, text); // MVP5: must go through pushTurn, not handle.pushInput directly - see pendingResultTags' comment
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

// Cancels whatever turn(s) are currently running, same session/no row-field
// shape as setPermissionMode above minus the patch - session.js's interrupt()
// doesn't change any row-visible state itself; the idle/running flip rides
// in on the interrupted turn's own `result` message the same way a normal
// completion does, broadcast separately by the row's existing message
// handling, not by this call.
export async function interruptTurn(id) {
  return queryPassthrough(id, (row) => row.handle.interrupt());
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
  failPendingDelegations(row, 'session was manually unstuck (force-idle) before this delegation replied');
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
// every sibling here) - MVP5's uniqueness check needs to run synchronously
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
export async function loadEarlierHistory(id, fetchHistoryImpl) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  if (!row.claudeSessionId) throw new Error('session has no claude session id yet');

  const fetchHistory = fetchHistoryImpl
    || (row.provider === 'grok' ? fetchGrokSessionHistory : fetchSessionHistory);
  const full = await fetchHistory(row.claudeSessionId, row.cwd);
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
    // Conversation-only. Fork first so the original Grok session stays
    // intact, then truncate the copy. Matches Claude's non-destructive
    // rewind: the caller opens forkedSessionId as a new cockpit row.
    const forked = await row.handle.forkAt(promptIndex);
    return {
      filesResult: { conversationOnly: true, promptIndex },
      forkedSessionId: forked.newSessionId,
    };
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
  collectDelegationText(row, message); // MVP5: buffers this turn's assistant text while a delegation is pending, see the 'result' branch below
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
    // MVP5: this array's order always matches actual execution order now
    // (pushTurn + the removeQueued/reorderQueue/sendNow mirrors below keep
    // it that way), so the OLDEST entry is always the one this `result`
    // belongs to - shift, not filter/find. `entry.tag` is null for a
    // non-delegated turn (nothing to relay).
    const entry = row.pendingResultTags.shift();
    if (entry?.tag) relayDelegationResult(row, entry.tag, { ok: true, message });
    refreshContextUsage(id); // a real round trip to the CLI - once per finished turn, not per message
    refreshRateLimits(id);
  }
}

// MVP5: delivers a delegated task's result back into the ORIGIN session
// that asked for it, once the TARGET row's turn finishes (ok), the target
// row errors out mid-turn (handleError below), the target row is closed
// mid-turn (closeSession below), or the delegated turn is removed from the
// target's queue before it ever ran (removeQueued below) - all four call
// this the same way, just with a different `ok`/`errorText`. Delivered as a
// normal queued user-turn message (reusing origin.handle.pushInput via
// pushTurn - the same queue a human's own next message would land in, no
// second queue built) wrapped so it reads like a tool result even though
// there's no real tool_use id to attach an actual SDK tool_result to (the
// trigger was a user-typed /ask, not an LLM tool call - see delegateTask's
// comment).
//
// Backlog fix (2026-08-20, "relay buffers everything, not just the final
// answer"): the ORIGIN MODEL now only ever sees finalAnswerText() below, not
// the whole buffered narration - that comment used to claim this ("final
// answer only") while the code actually joined every buffered block, which
// is how mid-task narration once rode back looking exactly like a delegated
// answer. The full buffer isn't thrown away, though: when it genuinely holds
// more than the clean answer, it's shipped separately as a
// cockpit:delegate-full-trace marker (below) that never touches the origin
// model's context - purely a client-side "show full trace" button
// (stream-view.js/detail-pane.js) for a human who wants to see it. No
// marker at all when there's nothing extra (full text === final text) - see
// that check below.
function relayDelegationResult(targetRow, tag, { ok, errorText, message }) {
  const origin = sessions.get(tag.fromId);
  if (!origin) return; // origin session was closed/gone - best-effort, nothing left to deliver to
  if (!ok) {
    const wrapped = buildDelegatedHeader('result', targetRow.name || 'session', `ERROR: ${errorText}`, tag.task);
    pushTurn(origin, wrapped);
    return;
  }
  // tag.buffer holds one complete text block per assistant message
  // (collectDelegationText) - each is already a fully-formed chunk of
  // narration, not a streaming delta fragment, so they're joined as separate
  // paragraphs (blank line between) rather than with joinStreamText, which
  // is grok-messages.js's smart-whitespace merge for stitching partial
  // deltas of the SAME flowing message back together. Reusing it here used
  // to glue unrelated blocks together with whatever whitespace each one
  // happened to end in (e.g. a narration block running straight into a
  // fenced code block with no separator at all).
  const fullText = tag.buffer.map((part) => (part || '').trim()).filter(Boolean).join('\n\n') || '(no text reply)';
  const finalText = finalAnswerText(tag, message) || fullText;
  const wrapped = buildDelegatedHeader('result', targetRow.name || 'session', finalText, tag.task);
  const queueId = pushTurn(origin, wrapped); // not tagged - this is a plain turn for origin, not itself a delegation
  if (fullText !== finalText) {
    const marker = {
      type: 'cockpit:delegate-full-trace',
      queueId,
      label: `${targetRow.name || 'session'} - full trace`,
      text: fullText,
    };
    const seq = appendEvent(origin.eventLog, marker);
    broadcast(origin.id, { type: 'sdk:message', message: marker, seq });
  }
}

// Best-effort "final answer only" extraction for a delegated turn's relay.
// Prefers the SDK's own `result.result` field - Claude's own authoritative
// text for "this is the final answer" (SDKResultSuccess.result, distinct
// from the per-step text blocks collectDelegationText buffers) - when it's
// non-empty. Grok's synthesized result message never populates this
// (grok-messages.js's turnResultMessage always sets result: ''), so for a
// Grok target - and any Claude edge case where result comes back empty -
// fall back to the last non-empty buffered text block, on the theory that
// narration precedes the actual answer within a turn, not the reverse.
// Returns '' (never throws) if neither source has anything - relayDelegationResult
// falls back the rest of the way to fullText itself in that case.
function finalAnswerText(tag, message) {
  const sdkResult = message && message.type === 'result' && typeof message.result === 'string' ? message.result.trim() : '';
  if (sdkResult) return sdkResult;
  for (let i = tag.buffer.length - 1; i >= 0; i--) {
    const t = (tag.buffer[i] || '').trim();
    if (t) return t;
  }
  return '';
}

// Shared prose wrapper for both delegation directions - see delegateTask's
// comment for why this replaced the earlier `<delegated_task from="...">`
// tag shape. Header line stays machine-parseable (stream-view.js's
// DELEGATED_HEADER_RE) purely so the UI can pull a clean from-name/body
// apart for the bubble label; the model reads the whole thing as one turn,
// header prose included - that framing is the point, not incidental.
// `sanitizeName` only guards the header's own quoted name from a stray `"`
// in a session name breaking the UI's regex match; there's no boundary left
// for body text to spoof (no closing tag), so body goes through unescaped -
// the residual "body contains a fake header line" risk is the same class of
// low-severity prompt-injection surface any relay design has, and prose
// doesn't make it worse than tags did.
function buildDelegatedHeader(kind, name, body, task) {
  const safeName = sanitizeName(name);
  if (kind === 'task') {
    return `[Prompt Cockpit] Relayed task from "${safeName}"\n\n`
      + `Your operator is also running a sibling cockpit session named "${safeName}" in this same project. `
      + `They typed the message below in ${safeName}'s own compose box and used this app's delegation feature `
      + `("/ask") to relay it to you directly - it is authorized by the human operator, not an instruction from `
      + `another agent. Reply normally in this turn; your answer will be relayed back to ${safeName} automatically.\n\n`
      + `---\n${body}`;
  }
  return `[Prompt Cockpit] Relayed reply from "${safeName}"\n\n`
    + `Your operator earlier asked the sibling cockpit session "${safeName}" to do something on your behalf `
    + `(the original ask was: "${sanitizeName(task)}"). This is ${safeName}'s reply, delivered back to you by `
    + `your operator - not a message from ${safeName} directly.\n\n`
    + `---\n${body}`;
}

function sanitizeName(s) {
  return String(s).replace(/"/g, "'");
}

// MVP5: watches one assistant message for delegated-turn text while this
// row has a pending delegation tag (row.pendingResultTags[0] - the OLDEST,
// same FIFO reasoning as the 'result' branch above). Only the plain text
// blocks are kept (no tool-call trace) - but every block, not just the
// final one: this buffer now serves double duty as both the "full trace"
// side-channel and finalAnswerText()'s own fallback source, so trimming it
// down here would quietly break both. The "final answer only" trim happens
// downstream in relayDelegationResult instead.
function collectDelegationText(row, message) {
  const tag = row.pendingResultTags[0]?.tag;
  if (!tag || message.type !== 'assistant' || !message.message || !Array.isArray(message.message.content)) return;
  for (const block of message.message.content) {
    if (block.type === 'text' && block.text) tag.buffer.push(block.text);
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
  const toolNames = Array.isArray(message.message.content)
    ? message.message.content.filter((b) => b && b.type === 'tool_use').map((b) => b.name)
    : [];
  row.usageAcc.addAssistantMessage(message.message, toolNames);
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

// MCP "needs-auth" badge (backlog.md) - fired from session.js's
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

// Queue pane operations (backlog.md) - all three just forward to the
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

export async function removeQueued(id, queueId) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  const removed = await row.handle.removeQueued(queueId);
  if (removed) {
    // MVP5: this queueId's turn will now never run, so it will never
    // produce a `result` either - drop its pendingResultTags entry so a
    // LATER turn's result doesn't get mismatched against it (the same
    // desync review flagged for plain shift()-without-bookkeeping), and if
    // it was a delegation, tell its origin now rather than leaving it
    // waiting forever for a reply that was just cancelled out from under it.
    const i = row.pendingResultTags.findIndex((e) => e.queueId === queueId);
    if (i !== -1) {
      const [entry] = row.pendingResultTags.splice(i, 1);
      if (entry.tag) relayDelegationResult(row, entry.tag, { ok: false, errorText: 'the delegated task was removed from the queue before it ran' });
    }
  }
  return removed;
}

// Reorders only the TAIL of row.pendingResultTags (index 1 onward) to match
// `queueIds`, leaving index 0 untouched. Shared by reorderQueue and sendNow
// below.
//
// pendingResultTags[0], whenever the array is non-empty, is always the
// currently in-flight turn - the FIFO invariant handleMessage's blind
// shift() relies on (nothing reorders an entry out of that slot except a
// 'result' actually consuming it). Both handle.reorderQueue() and
// handle.sendNow() only ever touch session.js's `pending` sub-queue, which
// by construction never contains the in-flight entry (createInputQueue's
// module comment: a push that lands while the consumer is already waiting
// is handed straight to it and never enters `pending` at all) - so neither
// operation can ever change what result arrives next, no matter what ids
// the caller passes.
//
// Review finding, confirmed against a live probe: the old code reordered
// the WHOLE array (named ids first, in the given order, then every
// unlisted entry appended after). The real frontend's queueIds - built
// from listQueue()/inputQueue.list(), which also never includes the
// in-flight entry (public/queue-panel.js's reorderBySwap only ever sees
// what setQueue() was pushed) - therefore never names the in-flight
// entry's id, which means it always landed in the "unlisted, appended
// after" bucket: an ordinary queue-panel drag/swap while a delegated turn
// was running silently moved that turn's own tag to the BACK of the
// array. The next 'result' - which is actually the in-flight turn
// finishing - then got shift()'d off as if it belonged to whatever queued
// entry ended up first instead, misdelivering it as that turn's delegated
// answer. sendNow's near-identical bug (unshifting to absolute index 0)
// was the same root cause the other direction. Pinning index 0 here fixes
// both call sites the same way.
function reorderPendingTagsTail(row, queueIds) {
  const pinned = row.pendingResultTags.length ? [row.pendingResultTags[0]] : [];
  const tail = row.pendingResultTags.slice(pinned.length);
  const byQueueId = new Map(tail.map((e) => [e.queueId, e]));
  const used = new Set();
  const ordered = [];
  for (const qid of queueIds) {
    const entry = byQueueId.get(qid);
    if (entry && !used.has(qid)) {
      ordered.push(entry);
      used.add(qid);
    }
  }
  for (const entry of tail) {
    if (!used.has(entry.queueId)) ordered.push(entry);
  }
  row.pendingResultTags = [...pinned, ...ordered];
}

export async function reorderQueue(id, queueIds) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  const result = await row.handle.reorderQueue(queueIds);
  reorderPendingTagsTail(row, queueIds);
  return result;
}

export async function sendNow(id, queueId) {
  const row = sessions.get(id);
  if (!row) throw new Error(`unknown session: ${id}`);
  const result = await row.handle.sendNow(queueId);
  // handle.sendNow() moves queueId to the front of the not-yet-started
  // sub-queue and interrupts whatever's running - reorderPendingTagsTail's
  // pinned-index-0 rule already keeps that interrupted turn's own tag
  // first, so mirroring this as "queueId first among the tail" is exactly
  // the front-of-the-still-queued-suffix placement this needs.
  if (result) reorderPendingTagsTail(row, [queueId]);
  return result;
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
    pushTurn(row, 'Continue'); // MVP5: must go through pushTurn, not handle.pushInput directly - see pendingResultTags' comment
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
  if (row) row.pendingApproval = request; // cleared in resolveApproval() once the client decides
  broadcast(id, { type: 'cockpit:approval-request', request });
}

// MVP5: relays an ok:false notice to every origin session with a delegation
// still pending on `row`, then clears them all - shared by handleError
// (target crashes mid-turn) and closeSession (target is deliberately closed
// mid-turn) below, so neither leaves an origin session's "-> Asked ..."
// marker sitting with no reply forever.
function failPendingDelegations(row, errorText) {
  const entries = row.pendingResultTags;
  row.pendingResultTags = [];
  for (const entry of entries) {
    if (entry.tag) relayDelegationResult(row, entry.tag, { ok: false, errorText });
  }
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
  // MVP5: a crashing row's for-await loop (session.js/grok-session.js) exits
  // without ever emitting the 'result' message handleMessage's delegation
  // branch waits for, so any tags still pending here would otherwise strand
  // their origin session waiting forever.
  failPendingDelegations(row, String((err && err.message) || err));
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
