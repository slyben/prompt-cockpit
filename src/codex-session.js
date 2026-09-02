// Long-lived Codex thread backed by the shared app-server manager. Exposes
// the same handle contract as session.js and grok-session.js.
import { randomUUID } from 'node:crypto';
import { getCodexAppServerManager } from './codex-app-server.js';
import { codexNotificationToMessages } from './codex-messages.js';
import { createResultEpochTracker } from './result-epoch.js';

function unsupported(name) {
  return async () => { throw new Error(`${name} is not supported on Codex sessions yet`); };
}

function eventBelongsToTurn(params, threadId, activeTurnId) {
  if (params?.threadId) return params.threadId === threadId;
  const eventTurnId = params?.turnId || params?.turn?.id;
  return Boolean(activeTurnId && eventTurnId === activeTurnId);
}

function approvalAction(mode, method) {
  if (mode === 'bypassPermissions' || mode === 'dontAsk' || mode === 'auto') return 'accept';
  if (mode === 'plan') return 'decline';
  if (mode === 'acceptEdits' && method === 'item/fileChange/requestApproval') return 'accept';
  return 'ask';
}

function turnPermissionParams(mode) {
  if (mode === 'bypassPermissions') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'dangerFullAccess' } };
  }
  if (mode === 'plan') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'readOnly' } };
  }
  if (mode === 'dontAsk') {
    return { approvalPolicy: 'never', sandboxPolicy: { type: 'workspaceWrite' } };
  }
  return { approvalPolicy: 'onRequest', sandboxPolicy: { type: 'workspaceWrite' } };
}

export function startCodexSession({
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
  onQueueChange,
  manager = getCodexAppServerManager(),
}) {
  let threadId = resume || null;
  let currentMode = permissionMode || 'default';
  let currentModel = model || null;
  let currentEffort = effort || null;
  let activeTurnId = null;
  let turnCounter = turnIndexOffset;
  let closed = false;
  let pumping = false;
  const pending = [];
  const resultEpoch = createResultEpochTracker();
  const pendingApprovals = new Map();
  const completedTurns = new Map();
  const completionWaiters = new Map();

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  ready.catch(() => {});

  function queueSnapshot() {
    return pending.map(({ id, text }) => ({ id, text }));
  }

  function emitQueue() {
    onQueueChange?.(queueSnapshot());
  }

  function settleTurn(turnId, params) {
    completedTurns.set(turnId, params);
    const waiter = completionWaiters.get(turnId);
    if (waiter) {
      completionWaiters.delete(turnId);
      waiter.resolve(params);
    }
  }

  function waitForTurn(turnId) {
    if (completedTurns.has(turnId)) return Promise.resolve(completedTurns.get(turnId));
    return new Promise((resolve, reject) => completionWaiters.set(turnId, { resolve, reject }));
  }

  // The app-server is a shared, long-lived process (see codex-app-server.js) -
  // if it crashes or exits mid-turn, rejectAll() only reaches in-flight RPC
  // requests, not a waitForTurn() promise parked with no request behind it.
  // Without this, the session sits in 'running' forever. Mirrors how
  // grok-session.js's own proc 'exit'/'error' handlers fail() a session
  // whose process died out from under it.
  const unsubscribeManagerClose = manager.onClose((err) => {
    if (closed) return;
    closed = true;
    for (const waiter of completionWaiters.values()) waiter.reject(err);
    completionWaiters.clear();
    unsubscribe();
    unsubscribeRequests();
    onStateChange('error');
    onError(err);
  });

  const unsubscribe = manager.subscribe((method, params) => {
    if (closed || !threadId || !eventBelongsToTurn(params, threadId, activeTurnId)) return;
    for (const message of codexNotificationToMessages(method, params, threadId, { model: currentModel })) {
      resultEpoch.stamp(message);
      onMessage(message);
    }
    if (method === 'turn/started' && params.turn?.id) activeTurnId = params.turn.id;
    if (method === 'turn/completed') settleTurn(params.turn?.id || activeTurnId, params);
  });

  const unsubscribeRequests = manager.onServerRequest(async (method, params, requestId) => {
    if (closed || !threadId || params?.threadId !== threadId) return { handled: false };
    if (method === 'item/permissions/requestApproval') {
      const permissions = params.permissions ?? [];
      if (currentMode === 'bypassPermissions' || currentMode === 'dontAsk' || currentMode === 'auto') {
        return { handled: true, result: { permissions, scope: 'turn' } };
      }
      if (currentMode === 'plan') {
        return { handled: true, result: { permissions: [], scope: 'turn' } };
      }
      return new Promise((resolve) => {
        const id = String(requestId);
        pendingApprovals.set(id, {
          resolve,
          kind: 'permissions',
          toolName: 'RequestPermissions',
          permissions,
        });
        onApprovalRequest?.({
          requestId: id,
          toolName: 'RequestPermissions',
          displayName: 'Additional permissions',
          input: params,
          title: params.reason || 'Codex requests additional permissions',
        });
      });
    }
    if (method !== 'item/commandExecution/requestApproval' && method !== 'item/fileChange/requestApproval') {
      return { handled: false };
    }
    const action = approvalAction(currentMode, method);
    if (action !== 'ask') return { handled: true, result: { decision: action } };
    return new Promise((resolve) => {
      const id = String(requestId);
      pendingApprovals.set(id, {
        resolve,
        kind: 'decision',
        toolName: method.includes('fileChange') ? 'Edit' : 'Bash',
      });
      onApprovalRequest?.({
        requestId: id,
        toolName: method.includes('fileChange') ? 'Edit' : 'Bash',
        displayName: method.includes('fileChange') ? 'File change' : 'Command',
        input: params.command ? { command: params.command, cwd: params.cwd } : params,
        title: params.reason || null,
      });
    });
  });

  onStateChange('starting');
  (async () => {
    try {
      await manager.ready();
      const result = resume
        ? await manager.request('thread/resume', { threadId: resume, cwd, model: currentModel || undefined })
        : await manager.request('thread/start', { cwd, model: currentModel || undefined });
      threadId = result?.thread?.id || threadId;
      if (!threadId) throw new Error('Codex app-server did not return a thread id');
      manager.retainThread(threadId);
      currentModel = result?.thread?.model || currentModel;
      onMessage({
        type: 'system', subtype: 'init', session_id: threadId,
        model: currentModel, cwd, permissionMode: currentMode,
      });
      onStateChange('idle');
      resolveReady();
      pump();
    } catch (err) {
      rejectReady(err);
      onStateChange('error');
      onError(err);
    }
  })();

  async function runTurn(entry) {
    await ready;
    if (closed || entry.epoch !== resultEpoch.epoch) {
      resultEpoch.consume(entry.id);
      return;
    }
    onStateChange('running');
    const params = {
      threadId,
      input: [{ type: 'text', text: entry.text }],
      cwd,
      ...turnPermissionParams(currentMode),
    };
    if (currentModel) params.model = currentModel;
    if (currentEffort) params.effort = currentEffort;
    const result = await manager.request('turn/start', params);
    activeTurnId = result?.turn?.id || activeTurnId;
    if (!activeTurnId) throw new Error('Codex app-server did not return a turn id');
    await waitForTurn(activeTurnId);
    completedTurns.delete(activeTurnId);
    activeTurnId = null;
    resultEpoch.consume(entry.id);
  }

  async function pump() {
    if (pumping || closed || !threadId) return;
    pumping = true;
    try {
      while (!closed && pending.length) {
        const entry = pending.shift();
        emitQueue();
        try {
          await runTurn(entry);
        } catch (err) {
          const message = {
            type: 'result', subtype: 'error', is_error: true, session_id: threadId,
            num_turns: 1, stop_reason: 'failed', result: '', error: String(err?.message || err),
          };
          const consumed = resultEpoch.consume(entry.id);
          resultEpoch.applyResultStamp(message, consumed);
          onMessage(message);
          // onError routes to session-registry.js's handleError, which reaps
          // this row - the rest of cockpit now treats this session as dead.
          // `closed` must agree, or this loop (and any later pushInput) keeps
          // driving turn/start RPCs against a session nobody can see or
          // interact with anymore, into the void (2026-09-02 review, finding
          // #2's "Related" note). manager.onClose already sets `closed` for
          // the whole-app-server-died case; this covers the per-turn
          // runTurn() failure case the same way.
          closed = true;
          onError(err);
        }
      }
      if (!closed) onStateChange('idle');
    } finally {
      pumping = false;
      if (!closed && pending.length) pump();
    }
  }

  function pushInput(text) {
    // `null`, not undefined - session-registry.js's pushTurn checks for this
    // exact sentinel ("did not enqueue anything, no result will ever come")
    // to decide whether to register a delegation tag for the turn (see
    // grok-session.js's own pushInput comment on the same contract). Codex
    // returning undefined here let a closed-session push slip past that
    // check and setTag(undefined, tag), stranding a delegation origin
    // waiting on a result that was never going to arrive (2026-09-02 review,
    // finding #2).
    if (closed) return null;
    const id = randomUUID();
    const meta = resultEpoch.push(id);
    turnCounter += 1;
    pending.push({ id, text, epoch: meta.epoch });
    onMessage({
      type: 'user', session_id: threadId,
      message: { role: 'user', content: text }, turnIndex: turnCounter, queueId: id,
      _cockpitEpoch: meta.epoch, _cockpitQueueId: id,
    });
    emitQueue();
    onStateChange('running');
    pump();
    return id;
  }

  function drainQueued() {
    for (const entry of pending) resultEpoch.remove(entry.id);
    pending.length = 0;
    emitQueue();
  }

  async function interrupt() {
    drainQueued();
    if (!threadId || !activeTurnId || closed) return;
    await manager.request('turn/interrupt', { threadId, turnId: activeTurnId });
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const pending of pendingApprovals.values()) {
      const result = pending.kind === 'permissions'
        ? { permissions: [], scope: 'turn' }
        : { decision: 'cancel' };
      pending.resolve({ handled: true, result });
    }
    pendingApprovals.clear();
    unsubscribe();
    unsubscribeRequests();
    unsubscribeManagerClose();
    if (threadId) {
      // Per the Codex app-server protocol, thread/unsubscribe only detaches
      // this connection from the thread - the thread itself (and any turn
      // still running on it) stays alive server-side for up to 30 minutes.
      // That's not cancellation: an active turn's commands/file writes would
      // otherwise keep running invisibly after the cockpit tab is closed.
      // turn/interrupt has to be sent - and given the chance to reach the
      // server - before we unsubscribe. Always sent regardless of ref
      // count: it targets this session's own turn, not the shared
      // subscription.
      const interrupted = activeTurnId
        ? manager.request('turn/interrupt', { threadId, turnId: activeTurnId }).catch(() => {})
        : Promise.resolve();
      // But the unsubscribe itself is connection-scoped, not session-scoped
      // (see manager.releaseThread's own comment) - only actually send it
      // once nothing else still wants this thread's events.
      if (manager.releaseThread(threadId)) {
        interrupted.then(() => manager.request('thread/unsubscribe', { threadId }).catch(() => {}));
      }
    }
    onStateChange('closed');
  }

  function resolveApproval(requestId, decision) {
    const pending = pendingApprovals.get(String(requestId));
    if (!pending) return false;
    pendingApprovals.delete(String(requestId));
    const allow = decision?.behavior === 'allow';
    const result = pending.kind === 'permissions'
      ? {
          permissions: allow ? pending.permissions : [],
          scope: allow && decision?.alwaysAllow ? 'session' : 'turn',
        }
      : {
          decision: allow && decision?.alwaysAllow
            ? 'acceptForSession'
            : allow ? 'accept' : 'decline',
        };
    pending.resolve({ handled: true, result });
    return true;
  }

  function listQueue() { return queueSnapshot(); }
  function removeQueued(id) {
    const index = pending.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    pending.splice(index, 1);
    resultEpoch.remove(id);
    emitQueue();
    return true;
  }
  function reorderQueue(ids) {
    const positions = new Map(ids.map((id, index) => [id, index]));
    pending.sort((a, b) => (positions.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (positions.get(b.id) ?? Number.MAX_SAFE_INTEGER));
    resultEpoch.reorderTail(ids);
    emitQueue();
  }
  async function sendNow(id) {
    const index = pending.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    const [entry] = pending.splice(index, 1);
    pending.unshift(entry);
    resultEpoch.reorderTail([id]);
    emitQueue();
    return true;
  }

  return {
    // See session.js's own `turns` comment - result-epoch.js owns turn
    // identity for every provider, the registry keeps no copy.
    turns: resultEpoch,
    pushInput,
    close,
    interrupt,
    forceIdle: () => {
      drainQueued();
      resultEpoch.forceIdle();
      interrupt().catch(() => {});
      onStateChange('idle');
    },
    setMode: async (mode) => { currentMode = mode; },
    resolveApproval,
    getMode: () => currentMode,
    listQueue,
    removeQueued,
    reorderQueue,
    sendNow,
    debugSnapshot: () => ({ threadId, activeTurnId, queuedTurns: pending.length, currentMode, ...resultEpoch.snapshot() }),
    query: {
      supportedModels: async () => {
        const result = await manager.request('model/list', { limit: 100, includeHidden: false });
        return (result?.data || []).map((entry) => ({
          value: entry.model || entry.id,
          displayName: entry.displayName || entry.model || entry.id,
          description: entry.description || '',
          resolvedModel: entry.model || entry.id,
          // Not every model supports every value in CODEX_EFFORTS
          // (provider-registry.js) - e.g. some models don't support
          // 'none'/'minimal', others don't support 'ultra'. Carried through
          // here so provider-registry.js's resolveEfforts() can validate
          // against what the currently-selected model actually accepts
          // instead of the global advertised list.
          supportedEfforts: Array.isArray(entry.supportedReasoningEfforts) ? entry.supportedReasoningEfforts : null,
        }));
      },
      setModel: async (next) => { currentModel = next || null; },
      setEffort: async (next) => { currentEffort = next || null; },
      setMaxThinkingTokens: unsupported('setMaxThinkingTokens'),
      supportedCommands: async () => [],
      supportedAgents: async () => [],
      mcpServerStatus: async () => [],
      toggleMcpServer: unsupported('toggleMcpServer'),
      reconnectMcpServer: unsupported('reconnectMcpServer'),
      reloadPlugins: async () => ({ plugins: [] }),
      setPluginEnabled: unsupported('setPluginEnabled'),
    },
  };
}
