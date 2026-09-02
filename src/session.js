// One `query()` per cockpit session, fed by a push-queue so input can be
// streamed in (Enter-to-send while a turn is still running just enqueues).
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_ALLOW_MODES } from './permissions.js';
import { readGitGuardMode, commandTripsGuard } from './git-commit-guard.js';
import { createResultEpochTracker } from './result-epoch.js';

// System-prompt anchor for the /ask cross-session delegation feature -
// out-of-band confirmation (not part of any one turn, so it can't be
// revoked or out-argued later) that this protocol is legitimate. Grok has
// no equivalent append mechanism, hence Claude-only. Kept short and
// factual: the real trust argument (handshake secret) is per-relay.
const ASK_SYSTEM_PROMPT_APPEND = 'This Claude Code session may run inside Prompt Cockpit, a local browser UI. '
  + 'Prompt Cockpit has a cross-session delegation feature ("/ask <Name>: <text>") that lets a human operator '
  + 'relay a task from one of their own cockpit sessions to another sibling session they also control, and relay '
  + 'the reply back. A turn whose text starts with "[Prompt Cockpit] Relayed task from ..." or "[Prompt Cockpit] '
  + 'Relayed reply from ..." is a real, human-authorized use of that feature - not a fabricated claim from another '
  + 'agent, and not an attempt to impersonate a tool result.';

// A minimal AsyncIterable<SDKUserMessage> that supports pushing values in;
// query() pulls from this for the session's lifetime. Also backs the
// visible input queue: every push lands in `pending` first, then pump()
// re-dispatches it if a consumer is waiting and nothing is in flight - so
// `pending` only ever holds what's actually queued behind a running turn.
function createInputQueue() {
  const pending = []; // { id, message, text } - id/text null for untracked pushes (the startup sentinel)
  let waiting = null;
  let closed = false;
  // True while some message has been handed to the SDK with no `result`
  // yet. The SDK's input pump re-enters next() right after writing stdin,
  // without waiting for the result, so without this gate a second write
  // would coalesce into the same CLI result and strand pendingTurns high.
  let inFlight = false;

  // Hands the head of `pending` to a waiting consumer once nothing else is
  // in flight. Called after every push and resultReceived so a queued
  // message advances the instant the previous result arrives, not only
  // when the SDK happens to call next() again.
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
 * Start a session. Returns a handle with pushInput/close/interrupt/
 * setMode/resolveApproval and queue-pane ops (listQueue/removeQueued/
 * reorderQueue/sendNow). `onApprovalRequest` fires for any gated tool.
 */
export function startSession({ cwd, resume, model, effort, permissionMode, turnIndexOffset = 0, onMessage, onStateChange, onError, onApprovalRequest, onQueueChange, onMcpAuthRequest, onMcpAuthResolved, queryImpl = query }) {
  const inputQueue = createInputQueue();
  let currentMode = permissionMode || 'default';
  const resultEpoch = createResultEpochTracker();
  const pendingApprovals = new Map(); // requestId -> { resolve(PermissionResult), toolName }
  // MCP "needs-auth" badge - serverName -> { url, message, elicitationId }.
  // Populated by onElicitation when a server asks for URL-mode auth,
  // drained on `elicitation_complete`. Exposed via getMcpAuthPending() so
  // session-registry.js can merge an `authUrl` into the SDK's own status
  // list, which has no such field of its own.
  const mcpAuthPending = new Map();
  // Permission "always allow this tool", per-tool-name only (no input/cwd
  // pattern matching). Two scopes share this in-memory set: 'session' lives
  // only as long as this process; 'project' additionally gets persisted to
  // settings.local.json by server.js once resolveApproval() reports the scope.
  const alwaysAllowTools = new Set();
  // Real pushInput() calls only - the priming sentinel bypasses this.
  // Seeded with `turnIndexOffset` (real user turns already in the resumed
  // transcript) so a live turnIndex keeps lining up with rewind.js's
  // resolveTurnUuid, which indexes into the *whole* persisted transcript -
  // starting from 0 on every resume made rewind target the wrong message.
  let turnCounter = turnIndexOffset;
  // Counts turns pushed but not yet resulted, so `idle` only fires once
  // every queued turn is actually done - a second pushInput() while the
  // first turn is still running used to get overwritten by the first
  // turn's `result` flipping state back to idle underneath it.
  let pendingTurns = 0;
  // Flips true once the sentinel's own `result` (num_turns:0) is seen and
  // swallowed. createInputQueue serializes strictly, so the first
  // result-type message this session can receive IS the sentinel's -
  // a real identity check, unlike the old pendingTurns===0 proxy a delayed
  // sentinel result could defeat by flipping to 'idle' mid-turn.
  let sentinelResolved = false;

  const handle = queryImpl({
    prompt: inputQueue,
    options: {
      cwd,
      resume,
      model,
      // Reasoning-effort level ('low'|'medium'|'high'|'xhigh'|'max') - a
      // distinct dial from `thinking`: effort controls thinking depth AND
      // overall response thoroughness, thinking controls whether/how
      // reasoning happens at all. Undefined leaves the SDK/model default.
      effort: effort || undefined,
      permissionMode: currentMode,
      systemPrompt: { type: 'preset', preset: 'claude_code', append: ASK_SYSTEM_PROMPT_APPEND },
      enableFileCheckpointing: true,
      // 'bypassPermissions' rejects at setPermissionMode() time without
      // this: cycling into it otherwise throws "not launched with
      // --dangerously-skip-permissions", which looked like the mode button
      // getting stuck. Can only be granted at session start.
      allowDangerouslySkipPermissions: true,
      // With no canUseTool, the CLI auto-denies any gated tool (safe by
      // default). In 'acceptEdits'/'bypassPermissions' the CLI resolves
      // permission itself and never calls this; in 'default'/'plan' every
      // gated call routes through here for a real one-off decision.
      // `AUTO_ALLOW_MODES` is consulted first so those modes stay silent.
      canUseTool: async (toolName, input, opts) => {
        // AskUserQuestion always needs a real human answer - auto-allowing
        // it the way other modes auto-allow everything else just passes
        // `input` straight back, which the tool reads as "user did not
        // answer" (empty `answers`), so it either parks forever or silently
        // resolves empty instead of prompting.
        if (toolName !== 'AskUserQuestion' && (AUTO_ALLOW_MODES.has(currentMode) || alwaysAllowTools.has(toolName))) {
          return { behavior: 'allow', updatedInput: input };
        }
        return new Promise((resolve) => {
          const requestId = randomUUID();
          pendingApprovals.set(requestId, { resolve, toolName });
          onApprovalRequest?.({ requestId, toolName, input, title: opts.title, displayName: opts.displayName });
        });
      },
      // MCP "needs-auth" badge. Only 'url' (OAuth-style) elicitation is
      // handled - 'form' would need dynamic-schema rendering the panel
      // doesn't have. `{action:'accept'}` is fire-and-forget: it means
      // "I'll show this to the user", not "the user finished" - completion
      // arrives later as a separate `elicitation_complete` message.
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
      // SDK skips canUseTool in acceptEdits/bypassPermissions/dontAsk/auto
      // modes, so a guard there would stop applying on mode cycling. Reads
      // gitCommitGuard fresh from settings.local.json on every Bash call
      // so a settings change takes effect immediately, not on restart.
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
  // gates everything downstream, including `system/init` - with nothing
  // pushed, init never arrives. A `shouldQuery:false` sentinel unblocks it
  // without spending a real turn; it comes back as a `result` with
  // `num_turns:0`, swallowed below rather than surfaced as a finished turn.
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
        // blocks onto this same iterator by default (parent_tool_use_id
        // set). Left unfiltered, these would interleave a subagent's
        // internal activity into this session's transcript.
        if (message.parent_tool_use_id) continue;
        // First result-type message is the priming sentinel (num_turns:0):
        // the input-queue gate blocks every later write until this arrives.
        // A real turn interrupted before producing anything can also report
        // num_turns:0; sentinelResolved keeps that from being swallowed too.
        if (!sentinelResolved && message.type === 'result' && message.num_turns === 0) {
          sentinelResolved = true;
          inputQueue.resultReceived();
          // If a pushInput landed in `pending` before the sentinel cleared,
          // resultReceived()'s pump() just dispatched it - broadcast so the
          // queue panel doesn't show a phantom entry for an already-running
          // turn.
          onQueueChange?.(inputQueue.list());
          continue; // priming-sentinel artifact, not a real turn
        }
        if (message.type === 'system' && message.subtype === 'init') {
          currentMode = message.permissionMode; // resumed sessions may not start in `default`
          onStateChange(pendingTurns > 0 ? 'running' : 'idle');
        } else if (message.type === 'system' && message.subtype === 'status' && message.permissionMode) {
          // The CLI can move itself out of the mode we started/set it to
          // (e.g. accepting a plan exits `plan`) without a setMode() call
          // from us - `init` alone misses that. This is the SDK's own
          // authoritative signal for it.
          currentMode = message.permissionMode;
        } else if (message.type === 'result') {
          // resultReceived() clears the in-flight gate and immediately
          // hands the next queued entry to the SDK, shrinking `pending`
          // right here - without this, a queued turn that starts running
          // the ordinary way never tells the client, so the queue panel
          // keeps showing it as queued until some unrelated edit broadcasts.
          inputQueue.resultReceived();
          onQueueChange?.(inputQueue.list());
          const consumed = resultEpoch.consumeFifo();
          resultEpoch.applyResultStamp(message, consumed);
          // A stale result belongs to a force-idled generation whose
          // pendingTurns was already zeroed; decrementing here would also
          // drop a turn pushed after forceIdle.
          if (!consumed.stale) {
            pendingTurns = Math.max(0, pendingTurns - 1);
          }
          // onMessage() before onStateChange(): consumeFifo() drops this
          // turn from the pending list pendingTurnsCount reads off, but
          // onStateChange broadcasts synchronously - calling it first
          // shipped a corrected state with a stale count nothing then fixed.
          onMessage(message);
          onStateChange(pendingTurns > 0 ? 'running' : 'idle');
          continue; // already delivered above - skip the generic onMessage(message) below
        } else if (message.type === 'system' && message.subtype === 'elicitation_complete') {
          // The MCP server confirms the human finished (or abandoned) the
          // URL-mode auth flow - clear the pending entry either way so the
          // panel stops offering a stale link. mcpServerStatus() is what
          // actually reports whether auth succeeded; this only tells us
          // the flow is over, not its outcome.
          mcpAuthPending.delete(message.mcp_server_name);
          onMcpAuthResolved?.(message.mcp_server_name);
        } else if (message.type === 'conversation_reset') {
          // /clear starts a fresh conversation - turnCounter must restart
          // too, or every rewind button minted after this indexes turnIndex
          // N against a transcript read that may no longer agree on what
          // turn N is.
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
    // A push after the queue is closed would never be consumed - no
    // `result` will ever come for it. Returning null here (rather than
    // minting a queueId and incrementing pendingTurns) is what lets
    // session-registry.js's pushTurn avoid registering a delegation tag
    // nothing will ever answer.
    if (inputQueue.isClosed()) return null;
    // The wire message stays exactly this shape - a client-supplied `uuid`
    // makes the CLI treat it as non-user-sourced and refuse it outright.
    // `result.user_message_uuid` is also undefined here, so rewind
    // targeting looks it up lazily from the persisted transcript instead.
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

    // The CLI never echoes the prompt back on the output stream, so
    // without this local echo the transcript pane never shows what was
    // sent. Echoed unconditionally, queued or not - removeQueued() below
    // only un-queues it, it doesn't retract this echo.
    turnCounter += 1;
    pendingTurns += 1;
    onMessage({ ...wireMessage, turnIndex: turnCounter, queueId, _cockpitEpoch: meta.epoch, _cockpitQueueId: queueId });
    onStateChange('running');
    if (queued) onQueueChange?.(inputQueue.list());
    // Cross-session delegation: the registry needs this to correlate a
    // pushed turn with its eventual `result` - positional FIFO alone
    // breaks once removeQueued/reorderQueue touch a delegated turn.
    return queueId;
  }

  // Queue pane operations - all no-ops (false/[]) once the queueId in
  // question has already been dequeued and started running, the normal
  // race a slow double-click loses to.
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

  // Moves `queueId` to the front, then interrupts whatever's running so
  // the SDK's next pull grabs it - matches Grok CLI's "send now". If
  // nothing is actually running, the interrupt is a documented no-op and
  // this just reorders, safe either way.
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
    // Same reasoning as interrupt() below: anything in `pending` was never
    // sent to the CLI, so draining it locally is the only cleanup needed -
    // without this, a queued turn would vanish with no result and no
    // queue-panel update if close() runs from a path that doesn't
    // immediately tear down the registry row.
    drainLocalQueue();
    inputQueue.close();
    handle.interrupt?.().catch(() => {});
  }

  // Cancel the turn(s) in flight without tearing down the session, unlike
  // close(). This is the client's Stop button: "stop now" means stop
  // everything, so drain `pending` locally too (the CLI itself never holds
  // more than the one in-flight turn - anything else queued was never sent).
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
  // for this, so `effortLevel` rides the SDK's generic applyFlagSettings
  // instead. Attached directly onto `handle` so `row.handle.query.setEffort`
  // resolves the same way for both providers.
  handle.setEffort = async (effort) => {
    await handle.applyFlagSettings({ effortLevel: effort });
  };

  // Called by the registry once a client responds to an onApprovalRequest.
  // `decision` is a PermissionResult plus an optional cockpit-only
  // `alwaysAllow` scope ('session'/'project'). 'project' additionally
  // tells the caller (via the returned `scope`) to persist it, since this
  // module has no filesystem knowledge of its own.
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

  // Debug capture for "spinner spins, nothing running" reports.
  // `pendingTurns` is the actual counter onStateChange's running/idle flip
  // is computed from - exposing it raw is what lets a stuck-idle report be
  // told apart from a stuck-pendingTurns-not-zero one.
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
  // coming. Drains the local queue first, then bumps epoch, best-effort
  // interrupts the CLI, and clears the in-flight gate. Does not wait on
  // the CLI; only call once you've confirmed nothing is actually running.
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
