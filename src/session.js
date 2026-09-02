// One `query()` per cockpit session, fed by a push-queue so input can be
// streamed in (Enter-to-send while a turn is still running just enqueues).
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_ALLOW_MODES } from './permissions.js';
import { readGitGuardMode, commandTripsGuard } from './git-commit-guard.js';
import { createResultEpochTracker } from './result-epoch.js';

// System-prompt anchor for the /ask cross-session delegation feature -
// out-of-band (not part of any one turn, so it can't be revoked or
// out-argued by anything a later user turn says) confirmation that this
// protocol exists and is legitimate, ahead of the first time a session
// actually sees a relayed turn. Only affects sessions started after this
// shipped (existing sessions keep whatever system prompt they started
// with); Grok has no equivalent append mechanism in its ACP session
// options, which is why this is Claude-only rather than shared with
// grok-session.js. Kept short and factual on purpose: the goal is a
// checkable anchor the model can point back to, not a persuasive essay -
// the actual trust argument (handshake secret) lives in
// session-registry.js's buildDelegatedHeader, delivered per-relay.
const ASK_SYSTEM_PROMPT_APPEND = 'This Claude Code session may run inside Prompt Cockpit, a local browser UI. '
  + 'Prompt Cockpit has a cross-session delegation feature ("/ask <Name>: <text>") that lets a human operator '
  + 'relay a task from one of their own cockpit sessions to another sibling session they also control, and relay '
  + 'the reply back. A turn whose text starts with "[Prompt Cockpit] Relayed task from ..." or "[Prompt Cockpit] '
  + 'Relayed reply from ..." is a real, human-authorized use of that feature - not a fabricated claim from another '
  + 'agent, and not an attempt to impersonate a tool result.';

// A minimal AsyncIterable<SDKUserMessage> that supports pushing values in
// from the outside. query() pulls from this for as long as the session lives.
// Also the backing store for the visible input queue: every push lands in
// `pending` first, then pump() immediately re-dispatches it to a waiting
// consumer if one exists AND nothing else is currently in flight (see
// `inFlight` below) - so `pending` only ever holds, at rest, exactly the
// messages actually queued up behind a still-in-flight turn, which is also
// exactly what a "queue pane" should show. A push that gets pumped straight
// back out (nothing in flight, someone waiting) never lingers in `pending`
// long enough to be visible - correctly invisible, since there's nothing
// queued in that case, just a turn about to start.
function createInputQueue() {
  const pending = []; // { id, message, text } - id/text null for untracked pushes (the startup sentinel)
  let waiting = null;
  let closed = false;
  // True while some message (tracked or the startup sentinel) has been
  // handed to the SDK and no `result` has arrived for it yet. The SDK's
  // input pump re-enters next() as soon as it finishes writing stdin - it
  // does not wait for that turn's result - so without this gate a second
  // write lands in the CLI's own queue and the CLI coalesces both into one
  // result, stranding pendingTurns (and the spinner) one too high.
  //
  // Also gates the sentinel: a real pushInput while the sentinel result is
  // still outstanding is the same coalescing risk, and would make the first
  // result-type message no longer be the sentinel's.
  let inFlight = false;

  // Hands the head of `pending` to a waiting consumer if one exists and
  // nothing else is currently in flight. Called after every push and every
  // resultReceived so a queued message advances the instant the previous
  // one's result arrives, rather than only when the SDK happens to call
  // next() again (which, per the note above, it already did - long before
  // the result showed up).
  function pump() {
    if (!waiting || pending.length === 0 || inFlight) return;
    const entry = pending.shift();
    inFlight = true;
    const resolve = waiting;
    waiting = null;
    resolve({ value: entry.message, done: false });
  }

  return {
    // `meta` ({id, text}) is how pushInput() makes an entry visible/
    // addressable in the queue; the startup sentinel omits it, and since
    // it's always the very first thing pushed (nothing else can be in
    // flight yet), pump() dispatches it immediately - it never lingers in
    // `pending` long enough to appear tracked or untracked in practice.
    push(userMessage, meta) {
      if (closed) return { queued: false };
      const entry = { id: meta?.id ?? null, message: userMessage, text: meta?.text ?? null };
      pending.push(entry);
      pump();
      return { queued: pending.includes(entry) };
    },
    // Clears the in-flight slot so the next queued message (or the next
    // push) can dispatch. Called on every `result` and from forceIdle
    // (which assumes no result is coming for the current in-flight turn).
    resultReceived() {
      inFlight = false;
      pump();
    },
    close() {
      if (closed) return;
      closed = true;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: undefined, done: true });
      }
    },
    // pushInput needs this BEFORE it decides whether to push - push()
    // already no-ops on a closed queue, but by then pushInput has already
    // committed to returning a queueId and incrementing pendingTurns,
    // which is exactly the desync result-epoch.js's turn ordering relies on
    // not happening (see session-registry.js's pushTurn comment).
    isClosed() {
      return closed;
    },
    // Tracked entries only (id !== null) - what the client's queue panel
    // renders. Order is the order they'll actually run in.
    list() {
      return pending.filter((e) => e.id).map((e) => ({ id: e.id, text: e.text }));
    },
    remove(id) {
      const i = pending.findIndex((e) => e.id === id);
      if (i === -1) return false;
      pending.splice(i, 1);
      return true;
    },
    // "Send now" - moves one queued entry to the front so it's
    // what the SDK pulls next. Doesn't interrupt anything itself; the caller
    // (session.js's sendNow) still has to abort whatever's currently running
    // or this just becomes "runs next after the current turn" instead.
    moveToFront(id) {
      const i = pending.findIndex((e) => e.id === id);
      if (i === -1) return false;
      if (i === 0) return true;
      const [entry] = pending.splice(i, 1);
      pending.unshift(entry);
      return true;
    },
    // `ids` is the desired order for the tracked entries it names; any
    // tracked entry it omits, or any untracked entry, keeps its original
    // relative position and is appended after the ones that were reordered.
    reorder(ids) {
      const byId = new Map(pending.filter((e) => e.id).map((e) => [e.id, e]));
      const used = new Set();
      const ordered = [];
      for (const id of ids) {
        const e = byId.get(id);
        if (e && !used.has(id)) {
          ordered.push(e);
          used.add(id);
        }
      }
      for (const e of pending) {
        if (!e.id || !used.has(e.id)) ordered.push(e);
      }
      pending.length = 0;
      pending.push(...ordered);
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          // Checked before the pending-dispatch branch below so close()
          // (called with turns still queued behind an in-flight one) is
          // unconditionally terminal - otherwise a `next()` call landing
          // between close() and actual teardown could still dispatch a
          // queued message the caller was told would never be read again.
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
          }
          if (pending.length > 0 && !inFlight) {
            const entry = pending.shift();
            inFlight = true;
            return Promise.resolve({ value: entry.message, done: false });
          }
          return new Promise((resolve) => {
            waiting = resolve;
          });
        },
      };
    },
  };
}

/**
 * Start a session. Returns a handle with `pushInput(text)`, `close()`,
 * `interrupt()`, `setMode(mode)`, `resolveApproval(requestId, decision)`,
 * and the queue-pane operations `listQueue()`/`removeQueued(queueId)`/
 * `reorderQueue(queueIds)`/`sendNow(queueId)`. `onMessage`
 * fires for every SDK message, `onStateChange` for coarse
 * idle/running/closed/error transitions, `onApprovalRequest` when any tool
 * needs a one-off client-side decision (default/plan mode, any tool the
 * CLI doesn't resolve itself - not just ExitPlanMode), `onQueueChange` with
 * the current queue snapshot whenever it changes.
 */
export function startSession({ cwd, resume, model, effort, permissionMode, turnIndexOffset = 0, onMessage, onStateChange, onError, onApprovalRequest, onQueueChange, onMcpAuthRequest, onMcpAuthResolved, queryImpl = query }) {
  const inputQueue = createInputQueue();
  let currentMode = permissionMode || 'default';
  const resultEpoch = createResultEpochTracker();
  const pendingApprovals = new Map(); // requestId -> { resolve(PermissionResult), toolName }
  // MCP "needs-auth" badge - serverName -> { url, message,
  // elicitationId }. Populated by onElicitation below when an MCP server
  // asks for URL-mode auth; drained when the matching `elicitation_complete`
  // system message arrives (see the for-await loop below). Exposed via
  // getMcpAuthPending() so session-registry.js's getMcpServerStatus can
  // merge an `authUrl` into the SDK's own status list, which has no
  // equivalent field of its own - McpServerStatus only carries
  // name/status/error, not how to actually resolve 'needs-auth'.
  const mcpAuthPending = new Map();
  // Permission "always allow this tool", per-tool-name only
  // (no input/cwd pattern matching - still flagged as needing its own
  // design call, unattempted here). Two scopes share this same in-memory
  // set so *this* session gets the immediate effect either way: 'session'
  // lives only as long as this process does; 'project' additionally gets
  // persisted to settings.local.json's `permissions.allow` by server.js
  // (src/permission-rules.js) once resolveApproval() reports which scope
  // was chosen - cwd-scoping for free, since that file is already one per
  // project. Checked in canUseTool right alongside AUTO_ALLOW_MODES below.
  const alwaysAllowTools = new Set();
  // Real pushInput() calls only - the priming sentinel below bypasses this.
  // Seeded with `turnIndexOffset` (the registry counts real user turns
  // already in the resumed transcript - session-history.js's
  // countRealUserTurns) so a live turnIndex here keeps lining up with
  // rewind.js's resolveTurnUuid, which indexes into the *whole* persisted
  // transcript, not just this process's turns. A plain `let turnCounter = 0`
  // on every resume is exactly the bug that made rewind target the wrong
  // message on any session with prior history.
  let turnCounter = turnIndexOffset;
  // Counts turns pushed but not yet resulted, so `idle` only fires once
  // every queued turn is actually done - a second pushInput() while the
  // first turn is still running used to get overwritten by the first
  // turn's `result` flipping state back to idle underneath it.
  let pendingTurns = 0;
  // Flips true once the priming sentinel's own `result` (always num_turns:0)
  // has been seen and swallowed. Because createInputQueue now serializes
  // strictly - nothing else can ever reach the CLI before the sentinel's own
  // result comes back - the first result-type message this session can
  // possibly receive IS the sentinel's, unconditionally. That makes this a
  // real identity check instead of the old pendingTurns===0 proxy, which a
  // delayed sentinel result arriving after the user's first pushInput() had
  // already incremented pendingTurns could defeat, misreading the sentinel's
  // result as the real turn's and flipping to 'idle' mid-turn.
  let sentinelResolved = false;

  const handle = queryImpl({
    prompt: inputQueue,
    options: {
      cwd,
      resume,
      model,
      // Reasoning-effort level ('low'|'medium'|'high'|'xhigh'|'max') - a
      // distinct dial from `thinking` below: effort controls thinking depth
      // AND overall response thoroughness (fewer/more consolidated tool
      // calls), thinking controls whether/how reasoning happens at all.
      // Undefined (not sent) leaves the SDK/model default in place.
      effort: effort || undefined,
      permissionMode: currentMode,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ASK_SYSTEM_PROMPT_APPEND },
      enableFileCheckpointing: true,
      // 'bypassPermissions' rejects at setPermissionMode() time without
      // this - confirmed live: cycling into it otherwise throws "Cannot
      // set permission mode to bypassPermissions because the session was
      // not launched with --dangerously-skip-permissions", which the
      // client silently swallowed, looking exactly like the mode button
      // "getting stuck". Needed unconditionally since mode cycling must
      // reach all six PermissionMode values and this can only
      // be granted at session start, not mid-session.
      allowDangerouslySkipPermissions: true,
      // Confirmed live against a real session:
      //   - no canUseTool configured at all: the CLI auto-denies any tool
      //     that needs a decision (no hang, no prompt - safe by default,
      //     which is how earlier versions of this handled every tool call).
      //   - permissionMode 'acceptEdits'/'bypassPermissions': the CLI
      //     resolves permission itself and never calls this callback.
      //   - permissionMode 'default'/'plan': every gated tool call routes
      //     through this callback (safe, cheap commands like `echo` skip
      //     it entirely and never reach here at all).
      // Every gated call gets a real one-off decision - the terminal's own
      // "Do you want to proceed? y/n", not a mode change. `AUTO_ALLOW_MODES`
      // is still consulted first so acceptEdits/bypassPermissions/etc. stay
      // silent as designed.
      canUseTool: async (toolName, input, opts) => {
        // AskUserQuestion always needs a real human answer, regardless of
        // mode - auto-allowing it the way acceptEdits/bypassPermissions/etc.
        // auto-allow everything else just passes `input` straight back
        // unmodified, which the tool reads as "the user did not answer the
        // questions" (its `answers` field stays empty). Confirmed live: this
        // was the actual root cause of the tool "not working at all" -
        // nothing was suppressing it, the client just never rendered
        // anything for the human to answer, so calls either parked forever
        // (no click ever came) or resolved to an empty answer (a click on
        // the old generic allow/deny banner, which set no updatedInput).
        if (toolName !== 'AskUserQuestion' && (AUTO_ALLOW_MODES.has(currentMode) || alwaysAllowTools.has(toolName))) {
          return { behavior: 'allow', updatedInput: input };
        }
        return new Promise((resolve) => {
          const requestId = randomUUID();
          pendingApprovals.set(requestId, { resolve, toolName });
          onApprovalRequest?.({ requestId, toolName, input, title: opts.title, displayName: opts.displayName });
        });
      },
      // MCP "needs-auth" badge. Two elicitation modes exist;
      // only 'url' (the OAuth-style "open this link to authorize" case) is
      // handled - 'form' would need real dynamic-schema form rendering the
      // panel doesn't have, so it's declined outright rather than left to
      // hang until the server's own timeout. `{action:'accept'}` on 'url'
      // is deliberately fire-and-forget per the SDK's own doc example: it
      // means "I'll show this to the user", not "the user finished" - actual
      // completion arrives later as a separate `elicitation_complete` system
      // message (handled in the for-await loop below), since the human still
      // has to visit the URL and authorize out-of-band in their browser.
      onElicitation: async (request) => {
        if (request.mode !== 'url' || !request.url) {
          return { action: 'decline' };
        }
        mcpAuthPending.set(request.serverName, {
          url: request.url,
          message: request.message,
          elicitationId: request.elicitationId,
        });
        onMcpAuthRequest?.({ serverName: request.serverName, url: request.url, message: request.message });
        return { action: 'accept' };
      },
      // Deliberately a PreToolUse hook, not another canUseTool check: the
      // SDK skips canUseTool entirely in acceptEdits/bypassPermissions/
      // dontAsk/auto modes (see AUTO_ALLOW_MODES above), so a guard living
      // there would silently stop applying the moment someone cycles modes.
      // Hooks run on every tool call regardless of permission mode - the
      // actual auto-deny surface for this. Reads gitCommitGuard fresh from
      // settings.local.json on every Bash call (cheap - it's a small JSON
      // file) rather than once at session start, so a mode change in the
      // settings panel takes effect on this session's very next Bash call
      // instead of requiring a restart (unlike plugin-settings.js's
      // enabledPlugins, which the SDK only reads at session start).
      hooks: {
        PreToolUse: [
          {
            matcher: 'Bash',
            hooks: [
              async (hookInput) => {
                const mode = await readGitGuardMode(cwd).catch(() => 'all');
                const command = hookInput.tool_input?.command;
                if (!commandTripsGuard(command, mode)) return { continue: true };
                return {
                  continue: true,
                  hookSpecificOutput: {
                    hookEventName: 'PreToolUse',
                    permissionDecision: 'deny',
                    permissionDecisionReason: mode === 'all'
                      ? 'Blocked by this project\'s git commit guard: this command contains a Co-Authored-By trailer or a "Generated with Claude Code" line. Retry without it - do not try to route around this (e.g. writing the message to a file first). This is a project policy set by the human user; only they can change or disable it, in Settings > General > Git commit guard.'
                      : 'Blocked by this project\'s git commit guard: this commit/PR includes a Co-Authored-By trailer or a "Generated with Claude Code" line. Retry without it - do not try to route around this (e.g. writing the message to a file first). This is a project policy set by the human user; only they can change or disable it, in Settings > General > Git commit guard.',
                  },
                };
              },
            ],
          },
        ],
      },
    },
  });

  // In streaming-input mode the CLI's first read from our AsyncIterable
  // gates everything downstream, including `system/init` - confirmed by
  // isolation test: with nothing pushed, init never arrives even though a
  // plain string prompt inits in ~1.3s. A `shouldQuery:false` sentinel
  // (from SDKUserMessage - "appended to the transcript without triggering
  // an assistant turn") unblocks it without spending a real turn. It comes
  // back as a `result` with `num_turns:0`, which we swallow below rather
  // than surface as a finished turn.
  inputQueue.push({
    type: 'user',
    message: { role: 'user', content: '' },
    parent_tool_use_id: null,
    shouldQuery: false,
    isSynthetic: true,
  });

  onStateChange('starting');

  (async () => {
    try {
      for await (const message of handle) {
        // The SDK forwards a spawned subagent's own tool_use/tool_result
        // blocks onto this same iterator by default (parent_tool_use_id set -
        // "enough for a heartbeat counter", per its own doc comment), even
        // though forwardSubagentText is off. Left unfiltered, these get
        // broadcast and rendered as if they were this session's own top-level
        // tool calls, interleaving a spawned Agent's internal activity with
        // real work in the transcript. A subagent's own transcript is only
        // meant to be visible via the detail pane's Agent tab
        // (public/detail-pane.js, reading from disk) - so bail before any
        // bookkeeping (result/mode tracking, resultEpoch, onMessage) sees it.
        if (message.parent_tool_use_id) continue;
        // First result-type message is the priming sentinel (num_turns:0):
        // the input-queue gate blocks every later write until this arrives.
        // A real turn interrupted before producing anything can also report
        // num_turns:0; sentinelResolved keeps that from being swallowed too.
        if (!sentinelResolved && message.type === 'result' && message.num_turns === 0) {
          sentinelResolved = true;
          inputQueue.resultReceived();
          // Same reasoning as the real-result branch below: if a pushInput
          // landed in `pending` before the sentinel cleared (fast enough to
          // beat startup), resultReceived()'s pump() just dispatched it -
          // broadcast so the queue panel doesn't show a phantom entry for a
          // turn that's actually already running.
          onQueueChange?.(inputQueue.list());
          continue; // priming-sentinel artifact, not a real turn
        }
        if (message.type === 'system' && message.subtype === 'init') {
          currentMode = message.permissionMode; // resumed sessions may not start in `default`
          onStateChange(pendingTurns > 0 ? 'running' : 'idle');
        } else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
          // The CLI can move itself out of the mode we started/set it to
          // (e.g. accepting a plan exits `plan`) without any setMode() call
          // from us - `init` alone missed that, leaving the mode button and
          // Shift+Tab's next-mode target stale after the first ExitPlanMode
          // approval. This is the SDK's own authoritative signal for it.
          currentMode = message.permissionMode;
        } else if (message.type === 'result') {
          // resultReceived() clears the in-flight gate and, if anything was
          // waiting, immediately hands the next queued entry to the SDK
          // (createInputQueue's pump()) - shrinking `pending` right here,
          // not just when the queue pane itself causes a mutation
          // (removeQueued/reorderQueue/sendNow below all broadcast their
          // own edits). Without this, a queued turn that starts running the
          // ordinary way - its predecessor just finished - never tells the
          // client, so the queue panel keeps showing it as still queued
          // (Drop does nothing useful on it either, since by the time the
          // click lands there's nothing left in `pending` to remove) until
          // some unrelated queue edit happens to trigger a fresh broadcast.
          inputQueue.resultReceived();
          onQueueChange?.(inputQueue.list());
          const consumed = resultEpoch.consumeFifo();
          resultEpoch.applyResultStamp(message, consumed);
          // A stale result belongs to a force-idled generation - pendingTurns
          // was already zeroed there. Decrementing it here would also drop a
          // turn pushed AFTER forceIdle, which is the same steal as claiming
          // the new turn's delegation tag.
          if (!consumed.stale) {
            pendingTurns = Math.max(0, pendingTurns - 1);
          }
          // onMessage() before onStateChange(), not after (unlike every other
          // branch here that falls through to the generic onMessage() call
          // below) - confirmed live: consumeFifo() above is what drops this
          // turn from result-epoch.js's pending list (which the state
          // broadcast's pendingTurnsCount badge reads off), but setState()
          // (wired to onStateChange) broadcasts immediately and synchronously.
          // Calling onStateChange first shipped a summary with the corrected
          // 'idle' state but a stale pendingTurnsCount still showing the
          // finished turn - and nothing ever re-broadcasts to fix it up, so
          // the badge was stuck showing a phantom pending turn until some
          // unrelated event happened to trigger another summary. Mirrors the
          // order grok-session.js's own result handling already used.
          onMessage(message);
          onStateChange(pendingTurns > 0 ? 'running' : 'idle');
          continue; // already delivered above - skip the generic onMessage(message) below
        } else if (message.type === 'system' && message.subtype === 'elicitation_complete') {
          // The MCP server confirms the human finished (or abandoned) the
          // URL-mode auth flow from onElicitation above - clear the pending
          // entry either way so the panel stops offering a stale link. The
          // SDK's own mcpServerStatus() is what actually reports whether
          // auth succeeded (status flips off 'needs-auth' on the next poll);
          // this event only tells us the flow is over, not its outcome.
          mcpAuthPending.delete(message.mcp_server_name);
          onMcpAuthResolved?.(message.mcp_server_name);
        } else if (message.type === 'conversation_reset') {
          // /clear starts a fresh conversation - turnCounter has to restart
          // with it (back to 0 real turns so far), or every rewind button
          // minted after this indexes turnIndex N against a transcript
          // read that (see rewind.js's resolveTurnUuid) may no longer agree
          // on what turn N is. Not independently live-verified whether
          // resolveTurnUuid's transcript read is itself scoped to the new
          // conversation or still spans pre-clear history too - if rewind
          // right after a /clear ever misbehaves, check that first.
          turnCounter = 0;
        }
        resultEpoch.stamp(message);
        onMessage(message);
      }
      inputQueue.close(); // nothing will ever read pushInput() input again past this point
      onStateChange('closed');
    } catch (err) {
      inputQueue.close(); // same - a pushInput() after this silently no-ops instead of piling up unread
      onStateChange('error');
      onError(err);
    }
  })();

  function pushInput(text) {
    // A push after the queue is closed (turn loop already exited, see the
    // inputQueue.close() calls above) would never be consumed - no `result`
    // will ever come for it. Returning null here (instead of proceeding to
    // mint a queueId, echo it, and increment pendingTurns as if it were
    // live) is what lets session-registry.js's pushTurn avoid registering a
    // delegation tag nothing will ever answer - see finding #2 in the
    // 2026-08-24 review: this used to fall through and leave a permanent
    // FIFO entry nothing would ever match correctly.
    if (inputQueue.isClosed()) return null;
    // The wire message stays exactly this shape - nothing extra. Confirmed
    // live (reproducibly) that adding a client-supplied `uuid` makes the
    // CLI treat the message as non-user-sourced: the model refused it
    // outright ("I received a message marked as from a non-user source").
    // `result.user_message_uuid` turned out to be undefined in this SDK
    // build too, so rewind targeting can't come from the wire message or
    // its result at all - see resolveTurnUuid() in rewind.js, which looks
    // it up lazily from the persisted transcript only when a rewind is
    // actually requested.
    const wireMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    // Tracked so a turn queued up behind a still-running one is addressable
    // from the queue pane - listQueue/removeQueued/reorderQueue/
    // sendNow below all key off this id, not the wire message (which has no
    // stable id of its own - see the comment on user_message_uuid above).
    const queueId = randomUUID();
    const meta = resultEpoch.push(queueId);
    const { queued } = inputQueue.push(wireMessage, { id: queueId, text });

    // The CLI never echoes the prompt back on the output stream (confirmed
    // live) - so without a local echo, the transcript pane never shows
    // what was sent. `turnIndex` (1-based, counting only real pushInput
    // calls) is local bookkeeping only, safe to attach here since it never
    // touches the wire message above. Echoed unconditionally, queued or not
    // - removeQueued() below only ever un-queues it, it doesn't retract this
    // echo (the transcript keeps showing what you typed, same as any chat
    // app would once it's rendered locally).
    turnCounter += 1;
    pendingTurns += 1;
    onMessage({ ...wireMessage, turnIndex: turnCounter, queueId, _cockpitEpoch: meta.epoch, _cockpitQueueId: queueId });
    onStateChange('running');
    if (queued) onQueueChange?.(inputQueue.list());
    // Cross-session delegation: the registry needs this to
    // correlate a specific pushed turn with its eventual `result` message
    // (and with later queue-remove/-reorder/-send-now calls) - positional
    // FIFO alone breaks the moment removeQueued/reorderQueue touch a queue
    // that has a delegated turn sitting in it. Purely additive - every
    // existing caller that ignores the return value keeps working.
    return queueId;
  }

  // Queue pane operations - all no-ops (false/[]) once the
  // queueId in question has already been dequeued and started running,
  // which is the normal race a slow double-click loses to; nothing more to
  // do about it, the turn is just already underway.
  function listQueue() {
    return inputQueue.list();
  }

  function removeQueued(queueId) {
    const removed = inputQueue.remove(queueId);
    if (removed) {
      resultEpoch.remove(queueId);
      // This turn will never produce a `result` now - same bookkeeping the
      // normal result-handling path in the for-await loop above does, just
      // triggered here instead since there's no SDK message coming for it.
      pendingTurns = Math.max(0, pendingTurns - 1);
      onStateChange(pendingTurns > 0 ? 'running' : 'idle');
      onQueueChange?.(inputQueue.list());
    }
    return removed;
  }

  function reorderQueue(queueIds) {
    inputQueue.reorder(queueIds);
    resultEpoch.reorderTail(queueIds);
    onQueueChange?.(inputQueue.list());
  }

  // Moves `queueId` to the front, then interrupts whatever's currently
  // running so the SDK's next pull grabs it - matches Grok CLI's
  // Ctrl+Enter/empty-Enter "send now". If nothing is actually
  // running (queue can only be non-empty while something is - see
  // createInputQueue's module comment), the interrupt is a documented no-op
  // and this just reorders, safe either way.
  async function sendNow(queueId) {
    const moved = inputQueue.moveToFront(queueId);
    if (!moved) return false;
    resultEpoch.reorderTail([queueId]);
    onQueueChange?.(inputQueue.list());
    // Matches close()/forceIdle()'s own handling of this same call below -
    // an interrupt racing session teardown shouldn't surface as an unhandled
    // rejection here just because this caller didn't wrap it.
    await handle.interrupt().catch(() => {});
    return true;
  }

  function close() {
    // Same reasoning as interrupt() below: anything still sitting in
    // `pending` was never sent to the CLI, so draining it locally (resultEpoch,
    // pendingTurns, onQueueChange) is the only cleanup it needs - without
    // this, a turn queued behind an in-flight one would vanish with no
    // result and no queue-panel update if close() is ever called from a path
    // that doesn't immediately tear down the whole registry row.
    drainLocalQueue();
    inputQueue.close();
    handle.interrupt?.().catch(() => {});
  }

  // Cancel the turn(s) currently in flight without tearing down the session
  // - the queue stays open and future pushInput() calls keep working, unlike
  // close(). handle.interrupt() resolves once the abort is issued; the SDK
  // then emits the interrupted turn's own `result` message through the
  // normal for-await loop above, which is what actually flips pendingTurns
  // back down and fires onStateChange('idle') - nothing extra to do here.
  // Safe to call while idle (no-op turn to interrupt); the SDK just answers
  // with an empty receipt.
  //
  // This is the client's Stop button (session-actions.js's 'interrupt'
  // route, mirroring Grok CLI's Esc/Ctrl+C) - "stop now" means stop
  // everything, not just the active turn and then run whatever got typed in
  // the meantime anyway. With createInputQueue's gate (see its comment), the
  // CLI itself never holds more than the one in-flight turn - anything else
  // pushed while busy is sitting in `pending`, never yet sent to the CLI -
  // so draining it locally via removeQueued (same bookkeeping a manual
  // per-item queue-pane removal would do: resultEpoch, pendingTurns,
  // onQueueChange) is enough; there's no separate SDK-side queued backlog
  // left to cancel.
  function drainLocalQueue() {
    for (const { id } of listQueue()) removeQueued(id);
  }

  async function interrupt() {
    drainLocalQueue();
    return handle.interrupt();
  }

  async function setMode(mode) {
    await handle.setPermissionMode(mode);
    currentMode = mode;
  }

  // Mid-session reasoning-effort change. No dedicated Query method exists
  // for this the way setModel/setMaxThinkingTokens have their own -
  // `effortLevel` rides the SDK's generic flag-settings layer instead
  // (applyFlagSettings). Attached directly onto `handle` (not the wrapper
  // returned below) so `row.handle.query.setEffort(...)` in
  // session-registry.js's setEffort() resolves the same way for both
  // providers - grok-session.js's own handle nests a real `setEffort`
  // under `query` too, by the same convention.
  handle.setEffort = async (effort) => {
    await handle.applyFlagSettings({ effortLevel: effort });
  };

  // Called by the registry once a client responds to an onApprovalRequest.
  // `decision` is a PermissionResult plus an optional cockpit-only
  // `alwaysAllow` flag (server.js's /approval-decision route): {behavior:
  // 'allow', updatedInput?, alwaysAllow?} or {behavior:'deny', message?}.
  // `alwaysAllow` is a scope string, `'session'` or `'project'` - `true` is
  // also accepted and coerced to `'session'` for compatibility with the
  // plain-boolean version this replaces. Either scope takes effect in this
  // session's own alwaysAllowTools immediately; `'project'` additionally
  // tells the caller (via the returned `scope`) to persist it, since this
  // module has no filesystem knowledge of its own (session-registry.js's
  // boundary - see permission-rules.js).
  // Returns `{ resolved: true, toolName, scope }` normally, or `false` if
  // the request already resolved or never existed (stale UI, double-click).
  function resolveApproval(requestId, decision) {
    const entry = pendingApprovals.get(requestId);
    if (!entry) return false;
    pendingApprovals.delete(requestId);
    const scope = decision?.alwaysAllow === true ? 'session' : decision?.alwaysAllow;
    if ((scope === 'session' || scope === 'project') && decision.behavior === 'allow') {
      alwaysAllowTools.add(entry.toolName);
    }
    // Stripped before it reaches the SDK - alwaysAllow is cockpit-only
    // bookkeeping, not part of the real PermissionResult shape.
    const { alwaysAllow, ...sdkDecision } = decision || {};
    entry.resolve(sdkDecision);
    return { resolved: true, toolName: entry.toolName, scope: scope || null };
  }

  // Debug capture (backlog: "spinner spins, nothing running" reports with
  // no way to catch the live internal state that would explain them).
  // `pendingTurns` is the actual counter onStateChange's running/idle flip
  // is computed from - session-registry.js's row.state is just its last
  // reported value, so exposing this raw is what lets a stuck-idle report
  // be told apart from a stuck-pendingTurns-not-zero one instead of
  // guessing from the outside.
  function debugSnapshot() {
    return {
      pendingTurns,
      turnCounter,
      currentMode,
      queueLength: inputQueue.list().length,
      mcpAuthPendingCount: mcpAuthPending.size,
      ...resultEpoch.snapshot(),
    };
  }

  // Last-resort unstick when pendingTurns is stuck above 0 with no result
  // coming. Drain the local queue first (those turns were never sent to
  // the CLI; same as Stop) so result-epoch only abandons the in-flight
  // head. Then bump epoch, best-effort interrupt the CLI turn, and clear
  // the in-flight gate so the next pushInput can dispatch. Does not wait
  // on the CLI; only call once you've confirmed nothing is actually
  // running CLI-side.
  function forceIdle() {
    drainLocalQueue();
    resultEpoch.forceIdle();
    handle.interrupt?.().catch(() => {});
    inputQueue.resultReceived();
    pendingTurns = 0;
    onStateChange('idle');
  }

  return {
    query: handle,
    // The single owner of this session's turn identity (result-epoch.js):
    // FIFO order plus the delegation tags session-registry.js attaches to a
    // pushed turn. Exposed so the registry has no parallel copy to keep in
    // lockstep - see that module's comment for the bugs that caused.
    turns: resultEpoch,
    pushInput,
    close,
    interrupt,
    forceIdle,
    setMode,
    resolveApproval,
    getMode: () => currentMode,
    listQueue,
    removeQueued,
    reorderQueue,
    sendNow,
    // [{ name, url, message }] - session-registry.js's getMcpServerStatus
    // merges this into the SDK's mcpServerStatus() list by server name.
    getMcpAuthPending: () => [...mcpAuthPending.entries()].map(([name, entry]) => ({ name, url: entry.url, message: entry.message })),
    debugSnapshot,
  };
}
