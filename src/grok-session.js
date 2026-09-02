// Long-lived Grok session via `grok agent stdio` (ACP). Same handle shape
// as session.js so the registry can treat both providers the same.
import { randomUUID } from 'node:crypto';
import { spawnGrokAgent, killGrokProcess } from './grok-acp.js';
import { acpUpdateToMessages, turnResultMessage, pickPermissionOption, grokPermissionAction } from './grok-messages.js';
import { createGrokExtensions } from './grok-extensions.js';
import { createResultEpochTracker } from './result-epoch.js';

const CLIENT_INFO = { name: 'claude-prompt-cockpit', version: '0.1.5' }; // keep in sync with package.json's version

// Fork copies the parent onto disk; the child is not loaded in the parent
// agent process (`_x.ai/rewind/points` on the new id returns Resource not
// found). Rewind the child in a short-lived ACP connection so
// fetchGrokSessionHistory sees the truncated transcript before the new
// cockpit row is created.
export async function rewindGrokSession({
  cwd,
  sessionId,
  promptIndex,
  connectImpl = spawnGrokAgent,
}) {
  if (!sessionId) throw new Error('grok session id required');
  const connection = connectImpl({ cwd });
  try {
    await connection.client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {},
      clientInfo: CLIENT_INFO,
    });
    await connection.client.request('session/load', { sessionId, cwd, mcpServers: [] });
    return await connection.client.request('_x.ai/rewind/execute', {
      sessionId,
      target_prompt_index: promptIndex,
    });
  } finally {
    connection.client.rejectAll(new Error('rewind helper closed'));
    try {
      killGrokProcess(connection.proc);
    } catch {
      // already dead
    }
  }
}

function unsupported(name) {
  return async () => {
    throw new Error(`${name} is not supported on grok sessions yet`);
  };
}

function isSessionUpdateNotification(method) {
  return method === 'session/update'
    || method === 'x.ai/session/update'
    || method === '_x.ai/session/update'
    // Live stdio stamps turn_completed here (confirmed against a real
    // grok agent stdio dump). updates.jsonl rewrites the same event as
    // `_x.ai/session/update`, which is why history already worked and
    // the live stats strip did not.
    || method === 'x.ai/session_notification'
    || method === '_x.ai/session_notification';
}

/**
 * Start a Grok session. Returns the same handle as startSession():
 * pushInput, close, interrupt, setMode, resolveApproval, getMode, query.
 */
export function startGrokSession({
  cwd,
  resume,
  model,
  effort,
  permissionMode,
  turnIndexOffset = 0,
  onMessage,
  onStateChange,
  onError,
  onApprovalRequest,
  connectImpl = spawnGrokAgent,
  grokExtensionsImpl,
  rewindExistingImpl = rewindGrokSession,
}) {
  const grokExtensions = grokExtensionsImpl || createGrokExtensions({ cwd });
  let currentMode = permissionMode || 'default';
  let currentEffort = effort || null;
  let availableModels = [];
  let sessionId = resume || null;
  let turnCounter = turnIndexOffset;
  let pendingTurns = 0;
  let closed = false;
  let connection = null;
  const pendingApprovals = new Map();
  let approvalSeq = 0;
  let promptTail = Promise.resolve();
  let promptInFlight = false;
  // Last text accepted by pushInput that has not yet finished its
  // session/prompt. Used to drop a duplicate Enter while that turn is
  // still queued or running - mid-turn that minted two promptIndexes
  // for one message (promptIndex 2 and 3, same body, ~4s apart).
  let openPromptText = null;
  // queueId -> text for a turn pushInput() has minted but runPrompt()
  // hasn't started yet (i.e. queued behind promptTail, not the one
  // currently in flight - removed the instant its own runPrompt begins,
  // same "shift on start" convention createInputQueue and
  // codex-session.js's pending array use). Backs listQueue().
  const queuedEntries = new Map();
  const resultEpoch = createResultEpochTracker();
  // A turn's bill can arrive twice: `_x.ai/session_notification`
  // (turn_completed) during the prompt, and again on the prompt result's
  // `_meta.usage`. Count it once.
  let billedThisTurn = false;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  ready.catch(() => {}); // onError already reports this; don't leak a rejection if nobody is waiting to prompt

  onStateChange('starting');

  (async () => {
    try {
      connection = connectImpl({ cwd, model, effort: currentEffort });
      const { client, proc } = connection;

      function fail(err) {
        if (closed) return;
        closed = true;
        client.rejectAll(err);
        onStateChange('error');
        onError(err);
      }

      proc?.on('exit', (code) => {
        fail(new Error(`grok agent exited ${code}${connection.getStderr?.() ? `: ${connection.getStderr()}` : ''}`));
      });
      proc?.on('error', (err) => {
        fail(err);
      });

      client.onNotification((method, params) => {
        const update = params.update || (params.sessionUpdate ? params : null);
        if (!update) return;
        // Chunks (text/tools) arrive as session/update. The live bill does
        // not: grok agent stdio stamps turn_completed on
        // `_x.ai/session_notification`. The on-disk updates.jsonl rewrites
        // that same event as `_x.ai/session/update`. Accept both.
        if (!isSessionUpdateNotification(method)) return;
        // Claude never streams the prompt back (session.js local-echoes it).
        // Grok emits user_message_chunk for the same turn pushInput already
        // echoed - forwarding it paints a duplicate "You" bubble. History
        // still reads the chunk from disk via grok-history.js; this is
        // live-only.
        if (update.sessionUpdate === 'user_message_chunk') return;
        for (const message of acpUpdateToMessages(update, sessionId, { model })) {
          if (message.message && message.message.usage) {
            if (billedThisTurn) continue;
            billedThisTurn = true;
          }
          resultEpoch.stamp(message);
          onMessage(message);
        }
      });

      client.onRequest('session/request_permission', (params) => handlePermission(params));

      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: CLIENT_INFO,
      });

      if (resume) {
        const loaded = await client.request('session/load', { sessionId: resume, cwd, mcpServers: [] });
        sessionId = resume;
        applyModelCatalog(loaded);
      } else {
        const created = await client.request('session/new', { cwd, mcpServers: [] });
        sessionId = created && created.sessionId ? created.sessionId : sessionId;
        applyModelCatalog(created);
      }

      onMessage({
        type: 'system',
        subtype: 'init',
        session_id: sessionId,
        model: model || null,
        cwd,
        permissionMode: currentMode,
      });
      onStateChange(pendingTurns > 0 ? 'running' : 'idle');
      resolveReady();
    } catch (err) {
      closed = true;
      rejectReady(err);
      onStateChange('error');
      onError(err);
    }
  })();

  function applyModelCatalog(payload) {
    const models = payload && payload.models;
    if (!models) return;
    if (Array.isArray(models.availableModels)) availableModels = models.availableModels;
    if (models.currentModelId) model = models.currentModelId;
  }

  async function tryAcp(methods, params) {
    let lastErr;
    for (const method of methods) {
      try {
        return await connection.client.request(method, params);
      } catch (err) {
        lastErr = err;
        const msg = String((err && err.message) || err);
        if (!/not found|Invalid params/i.test(msg)) throw err;
      }
    }
    throw lastErr || new Error('ACP method failed');
  }

  async function handlePermission(params) {
    const toolCall = params.toolCall || {};
    const options = params.options || [];
    const action = grokPermissionAction(currentMode, toolCall);
    if (action === 'allow' || action === 'deny') {
      const optionId = pickPermissionOption(options, action === 'allow');
      return { outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } };
    }
    return new Promise((resolve) => {
      approvalSeq += 1;
      const requestId = toolCall.toolCallId || `perm-${approvalSeq}`;
      pendingApprovals.set(requestId, { resolve, options });
      onApprovalRequest?.({
        requestId,
        toolName: toolCall.toolName || toolCall.title || 'tool',
        input: toolCall.rawInput || toolCall,
        title: toolCall.title,
        displayName: toolCall.toolName || toolCall.title,
      });
    });
  }

  function emitUsageFromPromptResult(result) {
    if (billedThisTurn || !result || !result._meta || !result._meta.usage) return;
    for (const message of acpUpdateToMessages({
      sessionUpdate: 'turn_completed',
      usage: result._meta.usage,
    }, sessionId, { model })) {
      if (message.message && message.message.usage) billedThisTurn = true;
      resultEpoch.stamp(message);
      onMessage(message);
    }
  }

  async function runPrompt(text, meta) {
    await ready;
    // No longer "queued" the instant it actually starts - same convention
    // as codex-session.js's pending.shift() and session.js's
    // createInputQueue's pump(), both of which drop an entry from their own
    // queue the moment it stops waiting and starts running.
    queuedEntries.delete(meta.queueId);
    let didConsume = false;
    const consume = () => {
      if (didConsume) return { meta: null, stale: false };
      didConsume = true;
      return resultEpoch.consume(meta);
    };
    // Abandoned before it started (interrupt/forceIdle while this was
    // queued on promptTail): do not send session/prompt, but still consume
    // so a later live turn's result cannot FIFO-match this slot.
    if (closed || !connection || meta.epoch !== resultEpoch.epoch) {
      consume();
      return;
    }
    promptInFlight = true;
    billedThisTurn = false;
    try {
      const result = await connection.client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      // Live stdio also stamps the bill on session/prompt's `_meta.usage`
      // (confirmed against a real result). Used only when the
      // turn_completed notification was missing, so a method-name change
      // cannot zero the stats strip again.
      emitUsageFromPromptResult(result);
      const consumed = consume();
      const stopReason = (result && result.stopReason) || 'end_turn';
      const message = turnResultMessage(sessionId, stopReason);
      resultEpoch.applyResultStamp(message, consumed);
      if (consumed.stale) {
        onMessage(message);
        return;
      }
      pendingTurns = Math.max(0, pendingTurns - 1);
      if (openPromptText === text && pendingTurns === 0) openPromptText = null;
      onMessage(message);
      onStateChange(pendingTurns > 0 ? 'running' : 'idle');
    } catch (err) {
      consume();
      throw err;
    } finally {
      promptInFlight = false;
    }
  }

  function pushInput(text) {
    // `null` means nothing was enqueued - no result will ever come for
    // this call. session-registry.js's pushTurn checks for this exact
    // sentinel to decide whether to register a delegation tag for the
    // turn. Success returns a queueId so registry matching isn't
    // positional-only.
    if (closed) return null;
    // Same body already queued or running: a second Enter (or Grok treating
    // mid-turn session/prompt as queue+send-now plus our chained retry)
    // must not mint another user turn.
    if (openPromptText === text && pendingTurns > 0) return null;
    const queueId = randomUUID();
    const meta = resultEpoch.push(queueId);
    queuedEntries.set(queueId, text);
    const wireMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    turnCounter += 1;
    pendingTurns += 1;
    openPromptText = text;
    onMessage({ ...wireMessage, turnIndex: turnCounter, queueId, _cockpitEpoch: meta.epoch, _cockpitQueueId: queueId });
    onStateChange('running');
    // Cancel the in-flight prompt so the next session/prompt doesn't land
    // on top of a still-running turn (that path double-recorded the new
    // text). Uses cancelInFlight(), not interrupt() - the full-drain
    // version would wrongly invalidate the very turn this call is about
    // to chain on promptTail.
    if (promptInFlight) cancelInFlight();
    promptTail = promptTail.then(() => runPrompt(text, meta)).catch((err) => {
      if (closed) return;
      pendingTurns = Math.max(0, pendingTurns - 1);
      if (pendingTurns === 0) openPromptText = null;
      onStateChange('error');
      onError(err);
    });
    return queueId;
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const pending of pendingApprovals.values()) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
    }
    pendingApprovals.clear();
    try {
      if (sessionId && connection) connection.client.notify('session/cancel', { sessionId });
    } catch {
      // process may already be gone
    }
    connection?.client.rejectAll(new Error('session closed'));
    try {
      killGrokProcess(connection?.proc);
    } catch {
      // already dead
    }
    onStateChange('closed');
  }

  // Fire-and-forget cancel notify only - no epoch bump, no queue drain.
  // The new turn's meta is stamped with the CURRENT epoch just before
  // this runs, so bumping the epoch here would mark that brand-new turn
  // stale too. Kept private - the Stop button needs interrupt()'s
  // fuller drain instead.
  function cancelInFlight() {
    if (closed || !sessionId || !connection) return;
    try {
      connection.client.notify('session/cancel', { sessionId });
    } catch {
      // process may already be gone
    }
  }

  // Stop means stop everything, not just the turn actively running.
  // Grok has no real pull queue: pushInput() chains queued messages
  // straight onto promptTail as already-attached `.then()`
  // continuations, which would still fire if only the in-flight turn
  // were cancelled. Bumping the epoch via forceIdle() skips them all.
  async function interrupt() {
    if (closed) return;
    resultEpoch.forceIdle();
    queuedEntries.clear();
    pendingTurns = 0;
    openPromptText = null;
    cancelInFlight();
    onStateChange('idle');
  }

  async function setMode(mode) {
    currentMode = mode;
  }

  function resolveApproval(requestId, decision) {
    const pending = pendingApprovals.get(requestId);
    if (!pending) return false;
    pendingApprovals.delete(requestId);
    const allow = decision && decision.behavior === 'allow';
    const optionId = pickPermissionOption(pending.options, allow);
    pending.resolve(optionId
      ? { outcome: { outcome: 'selected', optionId } }
      : { outcome: { outcome: 'cancelled' } });
    return true;
  }

  async function listRewindPoints() {
    await ready;
    if (closed || !connection || !sessionId) throw new Error('grok session is not ready');
    const result = await connection.client.request('_x.ai/rewind/points', { sessionId });
    return (result && result.rewind_points) || [];
  }

  async function rewindTo(promptIndex) {
    await ready;
    if (closed || !connection || !sessionId) throw new Error('grok session is not ready');
    return connection.client.request('_x.ai/rewind/execute', {
      sessionId,
      target_prompt_index: promptIndex,
    });
  }

  // Conversation-only fork: copy this session to a new id, then truncate
  // the copy at `promptIndex`. The parent session is left intact.
  async function forkAt(promptIndex) {
    await ready;
    if (closed || !connection || !sessionId) throw new Error('grok session is not ready');
    const newSessionId = randomUUID();
    const result = await connection.client.request('_x.ai/session/fork', {
      sourceSessionId: sessionId,
      sourceCwd: cwd,
      newCwd: cwd,
      newSessionId,
    });
    const childId = (result && result.newSessionId) || newSessionId;
    await rewindExistingImpl({
      cwd,
      sessionId: childId,
      promptIndex,
      connectImpl,
    });
    return { ...result, newSessionId: childId };
  }

  // queuedEntries tracks every turn pushInput() has minted that
  // runPrompt() hasn't started yet. Order is insertion order, i.e. the
  // order they'll actually run in - same guarantee session.js's own
  // list() makes.
  function listQueue() {
    return [...queuedEntries.entries()].map(([id, text]) => ({ id, text }));
  }

  // Same debug capture as session.js's own debugSnapshot. `promptTail`
  // itself isn't inspectable (a plain Promise chain), but
  // `promptInFlight`/`openPromptText` are the two fields that matter for
  // telling "a real turn is running" apart from "the chain is stuck
  // behind an interrupt that never resolved its session/prompt request".
  function debugSnapshot() {
    return {
      pendingTurns,
      turnCounter,
      currentMode,
      promptInFlight,
      openPromptText: openPromptText != null,
      ...resultEpoch.snapshot(),
    };
  }

  // Same manual recovery as session.js's own forceIdle. Identical to
  // interrupt() above - both mean "give up on everything in flight or
  // queued, go idle now".
  function forceIdle() {
    interrupt();
  }

  return {
    // See session.js's own `turns` comment - result-epoch.js owns turn
    // identity for every provider, the registry keeps no copy.
    turns: resultEpoch,
    pushInput,
    close,
    interrupt,
    forceIdle,
    listQueue,
    removeQueued: () => false,
    reorderQueue: () => {},
    sendNow: async () => false,
    setMode,
    resolveApproval,
    listRewindPoints,
    rewindTo,
    forkAt,
    getMode: () => currentMode,
    debugSnapshot,
    query: {
      supportedModels: async () => availableModels.map((m) => ({
        value: m.modelId || m.value,
        displayName: m.name || m.modelId || m.value,
        description: m.description || '',
        resolvedModel: m.modelId || m.value,
      })),
      setModel: async (next) => {
        await ready;
        await tryAcp([
          'session/set_model',
          '_x.ai/session/set_model',
        ], { sessionId, modelId: next });
        model = next;
      },
      setEffort: async (next) => {
        await ready;
        // Grok advertises effort tiers as sessionConfig options with
        // category "mode" (low/medium/high/xhigh). session/set_mode is
        // the live ACP call; set_config_option rejects these ids.
        await connection.client.request('session/set_mode', { sessionId, modeId: next });
        currentEffort = next;
      },
      setMaxThinkingTokens: unsupported('setMaxThinkingTokens'),
      supportedCommands: () => grokExtensions.supportedCommands(),
      supportedAgents: () => grokExtensions.supportedAgents(),
      mcpServerStatus: () => grokExtensions.mcpServerStatus(),
      toggleMcpServer: (name, enabled) => grokExtensions.toggleMcpServer(name, enabled),
      reconnectMcpServer: unsupported('reconnectMcpServer'),
      reloadPlugins: () => grokExtensions.reloadPlugins(),
      setPluginEnabled: (pluginKey, enabled) => grokExtensions.setPluginEnabled(pluginKey, enabled),
    },
  };
}
