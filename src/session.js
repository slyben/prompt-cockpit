// One `query()` per cockpit session, fed by a push-queue so input can be
// streamed in (Enter-to-send while a turn is still running just enqueues).
import { randomUUID } from 'node:crypto';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { AUTO_ALLOW_MODES } from './permissions.js';

// A minimal AsyncIterable<SDKUserMessage> that supports pushing values in
// from the outside. query() pulls from this for as long as the session lives.
function createInputQueue() {
  const pending = [];
  let waiting = null;
  let closed = false;

  return {
    push(userMessage) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: userMessage, done: false });
      } else {
        pending.push(userMessage);
      }
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
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length > 0) {
            return Promise.resolve({ value: pending.shift(), done: false });
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
 * `setMode(mode)`, and `resolveApproval(requestId, decision)`. `onMessage`
 * fires for every SDK message, `onStateChange` for coarse
 * idle/running/closed/error transitions, `onApprovalRequest` when any tool
 * needs a one-off client-side decision (default/plan mode, any tool the
 * CLI doesn't resolve itself - not just ExitPlanMode).
 */
export function startSession({ cwd, resume, model, permissionMode, turnIndexOffset = 0, onMessage, onStateChange, onError, onApprovalRequest, queryImpl = query }) {
  const inputQueue = createInputQueue();
  let currentMode = permissionMode || 'default';
  const pendingApprovals = new Map(); // requestId -> resolve(PermissionResult)
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
        if (toolName !== 'AskUserQuestion' && AUTO_ALLOW_MODES.has(currentMode)) {
          return { behavior: 'allow', updatedInput: input };
        }
        return new Promise((resolve) => {
          const requestId = randomUUID();
          pendingApprovals.set(requestId, resolve);
          onApprovalRequest?.({ requestId, toolName, input, title: opts.title, displayName: opts.displayName });
        });
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
        if (message.type === 'result' && message.num_turns === 0) {
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
    inputQueue.push(wireMessage);

    // The CLI never echoes the prompt back on the output stream (confirmed
    // live) - so without a local echo, the transcript pane never shows
    // what was sent. `turnIndex` (1-based, counting only real pushInput
    // calls) is local bookkeeping only, safe to attach here since it never
    // touches the wire message above.
    turnCounter += 1;
    pendingTurns += 1;
    onMessage({ ...wireMessage, turnIndex: turnCounter });
    onStateChange('running');
  }

  function close() {
    inputQueue.close();
    handle.interrupt?.().catch(() => {});
  }

  async function setMode(mode) {
    await handle.setPermissionMode(mode);
    currentMode = mode;
  }

  // Called by the registry once a client responds to an onApprovalRequest.
  // `decision` is a PermissionResult: {behavior:'allow', updatedInput?} or
  // {behavior:'deny', message?}. Returns false if the request already
  // resolved or never existed (stale UI, double-click).
  function resolveApproval(requestId, decision) {
    const resolve = pendingApprovals.get(requestId);
    if (!resolve) return false;
    pendingApprovals.delete(requestId);
    resolve(decision);
    return true;
  }

  return { query: handle, pushInput, close, setMode, resolveApproval, getMode: () => currentMode };
}
