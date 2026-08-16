// Long-lived Grok session via `grok agent stdio` (ACP). Same handle shape
// as session.js so the registry can treat both providers the same.
import { spawnGrokAgent, killGrokProcess } from './grok-acp.js';
import { acpUpdateToMessages, turnResultMessage, pickPermissionOption, grokPermissionAction } from './grok-messages.js';
import { createGrokExtensions } from './grok-extensions.js';

function unsupported(name) {
  return async () => {
    throw new Error(`${name} is not supported on grok sessions yet`);
  };
}

/**
 * Start a Grok session. Returns the same handle as startSession():
 * pushInput, close, setMode, resolveApproval, getMode, query.
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
        for (const message of acpUpdateToMessages(update, sessionId, { model })) onMessage(message);
      });

      client.onRequest('session/request_permission', (params) => handlePermission(params));

      await client.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {},
        clientInfo: { name: 'claude-prompt-cockpit', version: '0.1.0' },
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
    const result = await connection.client.request('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text }],
    });
    const stopReason = (result && result.stopReason) || 'end_turn';
    pendingTurns = Math.max(0, pendingTurns - 1);
    onMessage(turnResultMessage(sessionId, stopReason));
    onStateChange(pendingTurns > 0 ? 'running' : 'idle');
  }

  function pushInput(text) {
    if (closed) return;
    const wireMessage = {
      type: 'user',
      message: { role: 'user', content: text },
      parent_tool_use_id: null,
    };
    turnCounter += 1;
    pendingTurns += 1;
    onMessage({ ...wireMessage, turnIndex: turnCounter });
    onStateChange('running');
    promptTail = promptTail.then(() => runPrompt(text)).catch((err) => {
      if (closed) return;
      pendingTurns = Math.max(0, pendingTurns - 1);
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

  return {
    pushInput,
    close,
    setMode,
    resolveApproval,
    listRewindPoints,
    rewindTo,
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
        await tryAcp([
          'session/set_config_option',
          '_x.ai/session/set_effort',
        ], { sessionId, configOption: { id: 'reasoning_effort', value: next }, effort: next });
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
