// One `query()` per cockpit session, fed by a push-queue so input can be
// streamed in (Enter-to-send while a turn is still running just enqueues).
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_ALLOW_MODES } from './permissions.js';
import { readGitGuardMode, commandTripsGuard } from './git-commit-guard.js';

// A minimal AsyncIterable<SDKUserMessage> that supports pushing values in
// from the outside. query() pulls from this for as long as the session lives.
// Also the backing store for the visible input queue (backlog.md): `pending`
// only ever holds entries pushed while nothing was already waiting on
// next() - i.e. exactly the messages queued up behind a still-running turn,
// which is also exactly what a "queue pane" should show. A push that lands
// while the consumer IS already waiting (idle session) is handed straight
// to it and never touches `pending` at all - correctly invisible, since
// there's nothing queued in that case, just a turn about to start.
function createInputQueue() {
  const pending = []; // { id, message, text } - id/text null for untracked pushes (the startup sentinel)
  let waiting = null;
  let closed = false;

  return {
    // `meta` ({id, text}) is how pushInput() makes an entry visible/
    // addressable in the queue; the startup sentinel omits it and is always
    // handed straight to the waiting consumer at session start anyway (see
    // session.js's inputQueue.push() call below), so it never appears
    // tracked or untracked in `pending` in practice.
    push(userMessage, meta) {
      if (closed) return { queued: false };
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: userMessage, done: false });
        return { queued: false };
      }
      pending.push({ id: meta?.id ?? null, message: userMessage, text: meta?.text ?? null });
      return { queued: true };
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
    // "Send now" (backlog.md) - moves one queued entry to the front so it's
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
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift().message, done: false });
          }
          if (closed) {
            return Promise.resolve({ value: undefined, done: true });
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
 * `reorderQueue(queueIds)`/`sendNow(queueId)` (backlog.md). `onMessage`
 * fires for every SDK message, `onStateChange` for coarse
 * idle/running/closed/error transitions, `onApprovalRequest` when any tool
 * needs a one-off client-side decision (default/plan mode, any tool the
 * CLI doesn't resolve itself - not just ExitPlanMode), `onQueueChange` with
 * the current queue snapshot whenever it changes.
 */
export function startSession({ cwd, resume, model, permissionMode, turnIndexOffset = 0, onMessage, onStateChange, onError, onApprovalRequest, onQueueChange, onMcpAuthRequest, onMcpAuthResolved, queryImpl = query }) {
  const inputQueue = createInputQueue();
  let currentMode = permissionMode || 'default';
  const pendingApprovals = new Map(); // requestId -> { resolve(PermissionResult), toolName }
  // MCP "needs-auth" badge (backlog.md) - serverName -> { url, message,
  // elicitationId }. Populated by onElicitation below when an MCP server
  // asks for URL-mode auth; drained when the matching `elicitation_complete`
  // system message arrives (see the for-await loop below). Exposed via
  // getMcpAuthPending() so session-registry.js's getMcpServerStatus can
  // merge an `authUrl` into the SDK's own status list, which has no
  // equivalent field of its own - McpServerStatus only carries
  // name/status/error, not how to actually resolve 'needs-auth'.
  const mcpAuthPending = new Map();
  // Permission "always allow this tool" (backlog.md), per-tool-name only
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

  const handle = queryImpl({
    prompt: inputQueue,
    options: {
      cwd,
      resume,
      model,
      permissionMode: currentMode,
      enableFileCheckpointing: true,
      // 'bypassPermissions' rejects at setPermissionMode() time without
      // this - confirmed live: cycling into it otherwise throws "Cannot
      // set permission mode to bypassPermissions because the session was
      // not launched with --dangerously-skip-permissions", which the
      // client silently swallowed, looking exactly like the mode button
      // "getting stuck". Needed unconditionally since mode cycling must
      // reach all six PermissionMode values (plan MVP2) and this can only
      // be granted at session start, not mid-session.
      allowDangerouslySkipPermissions: true,
      // Confirmed live against a real session while building MVP2:
      //   - no canUseTool configured at all: the CLI auto-denies any tool
      //     that needs a decision (no hang, no prompt - safe by default,
      //     which is what MVP1 ran on for every tool call).
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
      // MCP "needs-auth" badge (backlog.md). Two elicitation modes exist;
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
                      ? 'Blocked by this project\'s git commit guard: this command contains a Co-Authored-By trailer. Retry without it - do not try to route around this (e.g. writing the message to a file first). This is a project policy set by the human user; only they can change or disable it, in Settings > General > Git commit guard.'
                      : 'Blocked by this project\'s git commit guard: this git commit includes a Co-Authored-By trailer. Retry without it - do not try to route around this (e.g. writing the message to a file first). This is a project policy set by the human user; only they can change or disable it, in Settings > General > Git commit guard.',
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
        // Bug (found via the interrupt feature): originally just
        // `num_turns === 0`, on the assumption only the priming sentinel
        // above could ever report zero turns. A real turn interrupted early
        // enough - before the model produced anything - can *also* come
        // back with num_turns:0, and this `continue` skips the pendingTurns
        // decrement AND onMessage() below for it just the same as it does
        // for the sentinel, so pendingTurns never returns to 0 and
        // onStateChange('idle') never fires - the state spinner then runs
        // forever even though nothing is actually in flight. The sentinel
        // is pushed before any pushInput() call, so its result is the only
        // one that can ever arrive while pendingTurns is still 0 - a real
        // turn's pendingTurns was already incremented at push time and
        // isn't decremented until its own result is processed, so checking
        // both conditions together only ever matches the true sentinel.
        if (message.type === 'result' && message.num_turns === 0 && pendingTurns === 0) {
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
          pendingTurns = Math.max(0, pendingTurns - 1);
          onStateChange(pendingTurns > 0 ? 'running' : 'idle');
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
    // from the queue pane (backlog.md) - listQueue/removeQueued/reorderQueue/
    // sendNow below all key off this id, not the wire message (which has no
    // stable id of its own - see the comment on user_message_uuid above).
    const queueId = randomUUID();
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
    onMessage({ ...wireMessage, turnIndex: turnCounter, queueId });
    onStateChange('running');
    if (queued) onQueueChange?.(inputQueue.list());
  }

  // Queue pane operations (backlog.md) - all no-ops (false/[]) once the
  // queueId in question has already been dequeued and started running,
  // which is the normal race a slow double-click loses to; nothing more to
  // do about it, the turn is just already underway.
  function listQueue() {
    return inputQueue.list();
  }

  function removeQueued(queueId) {
    const removed = inputQueue.remove(queueId);
    if (removed) {
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
    onQueueChange?.(inputQueue.list());
  }

  // Moves `queueId` to the front, then interrupts whatever's currently
  // running so the SDK's next pull grabs it - matches Grok CLI's
  // Ctrl+Enter/empty-Enter "send now" (backlog.md). If nothing is actually
  // running (queue can only be non-empty while something is - see
  // createInputQueue's module comment), the interrupt is a documented no-op
  // and this just reorders, safe either way.
  async function sendNow(queueId) {
    const moved = inputQueue.moveToFront(queueId);
    if (!moved) return false;
    onQueueChange?.(inputQueue.list());
    await handle.interrupt();
    return true;
  }

  function close() {
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
  async function interrupt() {
    return handle.interrupt();
  }

  async function setMode(mode) {
    await handle.setPermissionMode(mode);
    currentMode = mode;
  }

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

  return {
    query: handle,
    pushInput,
    close,
    interrupt,
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
  };
}
