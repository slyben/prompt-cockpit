// Long-lived Grok session via `grok agent stdio` (ACP). Same handle shape
// as session.js so the registry can treat both providers the same.
import { randomUUID } from 'node:crypto';
import { spawnGrokAgent, killGrokProcess } from './grok-acp.js';
import { acpUpdateToMessages, turnResultMessage, pickPermissionOption, grokPermissionAction } from './grok-messages.js';
import { createGrokExtensions } from './grok-extensions.js';

const CLIENT_INFO = { name: 'claude-prompt-cockpit', version: '0.1.0' };

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
        if (method !== 'session/update' && method !== 'x.ai/session/update') return;
        // Claude never streams the prompt back, so session.js local-echoes.
        // Grok does emit user_message_chunk for the same turn pushInput
        // already echoed. Forwarding it painted a second "You" bubble on
        // every Enter (confirmed against this session's updates.jsonl:
        // one promptIndex, two bubbles). History still reads the chunk
        // from disk via grok-history.js - this is live-only.
        if (update.sessionUpdate === 'user_message_chunk') return;
        for (const message of acpUpdateToMessages(update, sessionId, { model })) onMessage(message);
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

  async function runPrompt(text) {
    await ready;
    if (closed || !connection) return;
    promptInFlight = true;
    try {
      const result = await connection.client.request('session/prompt', {
        sessionId,
        prompt: [{ type: 'text', text }],
      });
      const stopReason = (result && result.stopReason) || 'end_turn';
      pendingTurns = Math.max(0, pendingTurns - 1);
      if (openPromptText === text && pendingTurns === 0) openPromptText = null;
      onMessage(turnResultMessage(sessionId, stopReason));
      onStateChange(pendingTurns > 0 ? 'running' : 'idle');
    } finally {
      promptInFlight = false;
    }
  }

  function pushInput(text) {
    if (closed) return;
    // Same body already queued or running: a second Enter (or Grok treating
    // mid-turn session/prompt as queue+send-now plus our chained retry)
    // must not mint another user turn.
    if (openPromptText === text && pendingTurns > 0) return;
    const wireMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    turnCounter += 1;
    pendingTurns += 1;
    openPromptText = text;
    onMessage({ ...wireMessage, turnIndex: turnCounter });
    onStateChange('running');
    // Cancel the in-flight prompt so the next session/prompt is not
    // delivered on top of a still-running turn (that path cancelled the
    // old turn and then recorded the new text twice).
    if (promptInFlight) interrupt();
    promptTail = promptTail.then(() => runPrompt(text)).catch((err) => {
      if (closed) return;
      pendingTurns = Math.max(0, pendingTurns - 1);
      if (pendingTurns === 0) openPromptText = null;
      onStateChange('error');
      onError(err);
    });
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

  // Cancels the in-flight prompt without tearing down the connection/process
  // - same `session/cancel` notify close() already sends, minus the process
  // kill and pendingApprovals wipe. runPrompt()'s `session/prompt` request
  // resolves with stopReason 'cancelled' once the agent acts on it (already
  // a recognized outcome - see turnResultMessage above), which drives
  // pendingTurns/onStateChange back down through the normal path; nothing
  // extra to do here.
  async function interrupt() {
    if (closed || !sessionId || !connection) return;
    try {
      connection.client.notify('session/cancel', { sessionId });
    } catch {
      // process may already be gone
    }
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

  // Queue-pane operations (backlog.md) aren't meaningful here yet: grok
  // sessions serialize pushInput() calls through `promptTail` (a plain
  // promise chain), not a pull-based queue a turn can sit "in" and be
  // inspected/reordered - there's nothing to list. Stubbed rather than
  // omitted so registry callers get an empty-but-valid response instead of
  // a thrown "not a function".
  function listQueue() {
    return [];
  }

  return {
    pushInput,
    close,
    interrupt,
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
