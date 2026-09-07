// Long-lived Codex thread backed by the shared app-server manager. Exposes
// the same handle contract as session.js and grok-session.js.
import { listCodexModels } from './codex-models.js';
import { rewindCodexConversation } from './codex-rewind.js';
import { createCodexExtensions } from './codex-extensions.js';
import { randomUUID } from 'node:crypto';
import { getCodexAppServerManager } from './codex-app-server.js';
import { codexNotificationToMessages } from './codex-messages.js';
import { createResultEpochTracker } from './result-epoch.js';

function unsupported(name) {
  return async () => { throw new Error(`${name} is not supported on Codex sessions yet`); };
}

function eventBelongsToHandle(params, threadId, ownedTurnIds, recentTurnIds, method) {
  if (!params?.threadId || params.threadId !== threadId) return false;
  const eventTurnId = params?.turnId || params?.turn?.id;
  if (!eventTurnId) return true;
  // Token usage is cumulative for the whole thread, including resume/fork
  // replay after the RPC returns and late updates after turn/completed.
  if (method === 'thread/tokenUsage/updated') return true;
  return ownedTurnIds.has(eventTurnId) || recentTurnIds.has(eventTurnId);
}

function requestBelongsToThread(params, threadId) {
  return params?.threadId === threadId || params?.conversationId === threadId;
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
  return { approvalPolicy: 'on-request', sandboxPolicy: { type: 'workspaceWrite' } };
}

const MAX_RECENT_TURN_IDS = 64;
const MAX_RECENT_ITEM_IDS = 256;

function rememberBounded(set, value, maxSize) {
  if (!value) return;
  set.add(value);
  while (set.size > maxSize) set.delete(set.values().next().value);
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
  onApprovalResolved,
  onMcpAuthRequest,
  onMcpAuthResolved,
  onQueueChange,
  manager = getCodexAppServerManager(),
}) {
  let threadId = resume || null;
  let currentMode = permissionMode || 'default';
  let currentModel = model || null;
  let currentEffort = effort || null;
  let activeTurnId = null;
  let startPending = false;
  const ownedTurnIds = new Set();
  // Keep a bounded tail because item/completed and other turn-scoped events
  // can arrive just after turn/completed. Unlike ownedTurnIds, these ids are
  // never allowed to grow with the lifetime of the session.
  const recentTurnIds = new Set();
  let turnCounter = turnIndexOffset;
  let closed = false;
  let pumping = false;
  const pending = [];
  const resultEpoch = createResultEpochTracker();
  const pendingApprovals = new Map();
  const mcpAuthPending = new Map();
  const startedItemIds = new Set();
  const startedItemTurns = new Map();
  const recentStartedItemIds = new Set();
  const completedTurns = new Map();
  const completionWaiters = new Map();
  const extensions = createCodexExtensions({ cwd, manager, getThreadId: () => threadId });

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
    if (turnId) {
      ownedTurnIds.delete(turnId);
      rememberBounded(recentTurnIds, turnId, MAX_RECENT_TURN_IDS);
    }
    // Keep enough item ids to turn a late item/completed into a result-only
    // row, but do not retain every interrupted/pending item forever. Only
    // move items belonging to this turn; a late completion for an older turn
    // must not clear the next turn's still-pending tool rows.
    for (const [itemId, itemTurnId] of startedItemTurns) {
      if (itemTurnId !== turnId) continue;
      startedItemTurns.delete(itemId);
      if (startedItemIds.delete(itemId)) rememberBounded(recentStartedItemIds, itemId, MAX_RECENT_ITEM_IDS);
    }

    const waiter = completionWaiters.get(turnId);
    if (waiter) {
      completedTurns.set(turnId, params);
      completionWaiters.delete(turnId);
      waiter.resolve(params);
    } else if (turnId === activeTurnId) {
      // The notification can beat the turn/start response. Keep the result so
      // waitForTurn() can consume it after the RPC settles. A duplicate/late
      // completion after the turn has already been consumed need not be
      // retained in completedTurns.
      completedTurns.set(turnId, params);
    }
  }

  // Undoes an optimistic turn/started claim that the turn/start response
  // proved wrong. Deliberately not routed through recentTurnIds: that tail
  // exists to keep accepting late events for turns this handle really ran,
  // and a sibling's turn is not one of them.
  function releaseMisclaimedTurn(turnId) {
    ownedTurnIds.delete(turnId);
    completedTurns.delete(turnId);
    for (const [itemId, itemTurnId] of startedItemTurns) {
      if (itemTurnId !== turnId) continue;
      startedItemTurns.delete(itemId);
      startedItemIds.delete(itemId);
    }
  }

  function waitForTurn(turnId) {
    if (completedTurns.has(turnId)) return Promise.resolve(completedTurns.get(turnId));
    return new Promise((resolve, reject) => completionWaiters.set(turnId, { resolve, reject }));
  }

  function clearApproval(requestId) {
    const key = String(requestId);
    const pending = pendingApprovals.get(key);
    if (!pending) return false;
    pendingApprovals.delete(key);
    const result = pending.kind === 'permissions'
      ? { permissions: [], scope: 'turn' }
      : pending.kind === 'userInput'
        ? { answers: {} }
        : pending.kind === 'legacyDecision'
          ? { decision: 'abort' }
          : { decision: 'cancel' };
    pending.resolve({ handled: true, result });
    onApprovalResolved?.(key);
    return true;
  }

  // If the shared app-server crashes mid-turn, rejectAll() only reaches
  // in-flight RPC requests, not a waitForTurn() promise parked with no
  // request behind it - without this the session sits in 'running' forever.
  const unsubscribeManagerClose = manager.onClose((err) => {
    if (closed) return;
    closed = true;
    startPending = false;
    activeTurnId = null;
    ownedTurnIds.clear();
    recentTurnIds.clear();
    startedItemIds.clear();
    startedItemTurns.clear();
    recentStartedItemIds.clear();
    for (const waiter of completionWaiters.values()) waiter.reject(err);
    completionWaiters.clear();
    extensions.dispose();
    unsubscribe();
    unsubscribeRequests();
    onStateChange('error');
    onError(err);
  });

  const unsubscribe = manager.subscribe((method, params) => {
    if (closed || !threadId) return;
    if (method === 'serverRequest/resolved') {
      if (params?.threadId && params.threadId !== threadId) return;
      if (params?.requestId != null) clearApproval(params.requestId);
      return;
    }
    if (method === 'mcpServer/oauthLogin/completed') {
      if (params?.threadId && params.threadId !== threadId) return;
      if (params?.success && params?.name && mcpAuthPending.delete(params.name)) onMcpAuthResolved?.({ serverName: params.name });
      return;
    }
    if (method === 'mcpServer/startupStatus/updated' && params?.threadId && params.threadId !== threadId) return;
    if (method === 'mcpServer/startupStatus/updated' && params?.status === 'ready' && params?.name
      && mcpAuthPending.delete(params.name)) onMcpAuthResolved?.({ serverName: params.name });
    // app-server can publish turn/started before the turn/start response
    // settles. Claim that id while this handle has a start in flight so the
    // event stream and Stop button are live during that window. Other handles
    // on the same thread have no startPending flag and cannot claim it.
    if (method === 'turn/started' && startPending && !activeTurnId
      && params?.threadId === threadId) {
      const startedTurnId = params?.turn?.id || params?.turnId;
      if (startedTurnId) {
        activeTurnId = startedTurnId;
        ownedTurnIds.add(startedTurnId);
      }
    }
    if (!eventBelongsToHandle(params, threadId, ownedTurnIds, recentTurnIds, method)) return;
    // thread/start and thread/resume expose the resolved model at the
    // response's top level, while a later safety reroute is a notification.
    // Keep the model current because token-usage notifications do not carry
    // one of their own and costForUsage needs the effective model id.
    if (method === 'model/rerouted' && params?.toModel) currentModel = params.toModel;
    for (const message of codexNotificationToMessages(method, params, threadId, {
      model: currentModel,
      startedItemIds,
      recentStartedItemIds,
    })) {
      resultEpoch.stamp(message);
      onMessage(message);
    }
    if (method === 'item/started' && params?.item?.id) {
      startedItemTurns.set(params.item.id, params.turnId || params.turn?.id || activeTurnId);
    } else if (method === 'item/completed' && params?.item?.id) {
      startedItemTurns.delete(params.item.id);
    }
    if (method === 'turn/completed') settleTurn(params.turn?.id || params.turnId || activeTurnId, params);
  });

  const unsubscribeRequests = manager.onServerRequest(async (method, params, requestId) => {
    if (closed || !threadId || !requestBelongsToThread(params, threadId)) return { handled: false };
    if (method === 'mcpServer/elicitation/request') {
      if (params.mode !== 'url' || !params.url || !params.serverName) {
        // Form-mode elicitation needs a dynamic schema editor that the
        // settings UI does not provide. Decline it explicitly so the MCP
        // server gets a protocol response instead of a JSON-RPC -32601.
        return { handled: true, result: { action: 'decline' } };
      }
      mcpAuthPending.set(params.serverName, {
        url: params.url,
        message: params.message || '',
        elicitationId: params.elicitationId || null,
      });
      onMcpAuthRequest?.({
        serverName: params.serverName,
        url: params.url,
        message: params.message || '',
      });
      return { handled: true, result: { action: 'accept' } };
    }
    if (method === 'item/tool/requestUserInput') {
      return new Promise((resolve) => {
        const id = String(requestId);
        pendingApprovals.set(id, { resolve, kind: 'userInput', toolName: 'AskUserQuestion' });
        onApprovalRequest?.({
          requestId: id,
          toolName: 'AskUserQuestion',
          displayName: 'Codex asks for input',
          input: { itemId: params.itemId, questions: params.questions || [] },
          answerFormat: 'question-ids',
          title: 'Codex asks for input',
        });
      });
    }
    if (method === 'item/tool/call') {
      return {
        handled: true,
        result: {
          contentItems: [{
            type: 'inputText',
            text: `Prompt Cockpit cannot execute Codex client tool "${params.tool || 'unknown'}"`,
          }],
          success: false,
        },
      };
    }
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
    const legacyApproval = method === 'execCommandApproval' || method === 'applyPatchApproval';
    if (legacyApproval) {
      const approvalMethod = method === 'applyPatchApproval'
        ? 'item/fileChange/requestApproval'
        : 'item/commandExecution/requestApproval';
      const action = approvalAction(currentMode, approvalMethod);
      if (action !== 'ask') {
        return { handled: true, result: { decision: action === 'accept' ? 'approved' : 'denied' } };
      }
      return new Promise((resolve) => {
        const id = String(requestId);
        pendingApprovals.set(id, {
          resolve,
          kind: 'legacyDecision',
          toolName: method === 'applyPatchApproval' ? 'Edit' : 'Bash',
        });
        onApprovalRequest?.({
          requestId: id,
          toolName: method === 'applyPatchApproval' ? 'Edit' : 'Bash',
          displayName: method === 'applyPatchApproval' ? 'File change' : 'Command',
          input: method === 'applyPatchApproval'
            ? { fileChanges: params.fileChanges || [], reason: params.reason }
            : { command: params.command, cwd: params.cwd, reason: params.reason },
          title: params.reason || null,
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
      currentModel = result?.model || result?.thread?.model || currentModel;
      onMessage({
        type: 'system', subtype: 'init', session_id: threadId,
        model: currentModel, cwd, permissionMode: currentMode,
      });
      onStateChange('idle');
      resolveReady();
      pump();
    } catch (err) {
      if (closed) return;
      closed = true;
      extensions.dispose();
      unsubscribe();
      unsubscribeRequests();
      unsubscribeManagerClose();
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
    startPending = true;
    let result;
    try {
      result = await manager.request('turn/start', params);
    } finally {
      startPending = false;
    }
    if (closed) {
      resultEpoch.consume(entry.id);
      return;
    }
    const responseTurnId = result?.turn?.id;
    // Two handles starting a turn on a shared thread in the same instant both
    // see a turn/started they cannot attribute, so the earlier claim can be a
    // sibling's turn. The turn/start response is authoritative: drop the wrong
    // id (and anything attributed to it) and adopt the real one, rather than
    // failing the session over a race neither side could have resolved.
    if (activeTurnId && responseTurnId && activeTurnId !== responseTurnId) {
      releaseMisclaimedTurn(activeTurnId);
      activeTurnId = null;
    }
    activeTurnId = responseTurnId || activeTurnId;
    if (!activeTurnId) throw new Error('Codex app-server did not return a turn id');
    if (!completedTurns.has(activeTurnId)) ownedTurnIds.add(activeTurnId);
    const turnId = activeTurnId;
    await waitForTurn(turnId);
    completedTurns.delete(turnId);
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
          // onError reaps this row elsewhere, so `closed` must agree here too
          // or this loop keeps driving turn/start RPCs against a session
          // nobody can see anymore. manager.onClose covers the whole-app-
          // server-died case; this covers the per-turn failure case.
          closed = true;
          ownedTurnIds.clear();
          recentTurnIds.clear();
          startedItemIds.clear();
          startedItemTurns.clear();
          recentStartedItemIds.clear();
          extensions.dispose();
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
    // `null`, not undefined - pushTurn checks for this exact sentinel
    // ("did not enqueue anything, no result will ever come") to decide
    // whether to register a delegation tag for the turn. Returning undefined
    // instead lets a closed-session push slip past that check and strand a
    // delegation origin waiting on a result that will never arrive.
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
    extensions.dispose();
    for (const pending of pendingApprovals.values()) {
      const result = pending.kind === 'permissions'
        ? { permissions: [], scope: 'turn' }
        : pending.kind === 'userInput'
          ? { answers: {} }
          : pending.kind === 'legacyDecision'
            ? { decision: 'abort' }
            : { decision: 'cancel' };
      pending.resolve({ handled: true, result });
    }
    pendingApprovals.clear();
    ownedTurnIds.clear();
    recentTurnIds.clear();
    startedItemIds.clear();
    startedItemTurns.clear();
    recentStartedItemIds.clear();
    unsubscribe();
    unsubscribeRequests();
    unsubscribeManagerClose();
    if (threadId) {
      // thread/unsubscribe only detaches this connection - the thread (and
      // any running turn) stays alive server-side for up to 30 minutes, so
      // an active turn's commands/file writes would keep running invisibly
      // after the tab closes unless turn/interrupt is sent first. Always
      // sent regardless of ref count: it targets this session's own turn.
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
      : pending.kind === 'userInput'
        ? {
            answers: allow && decision?.updatedInput?.answers && typeof decision.updatedInput.answers === 'object'
              ? decision.updatedInput.answers
              : {},
          }
        : pending.kind === 'legacyDecision'
          ? {
              decision: allow && decision?.alwaysAllow
                ? 'approved_for_session'
                : allow ? 'approved' : 'denied',
            }
          : {
              decision: allow && decision?.alwaysAllow
                ? 'acceptForSession'
                : allow ? 'accept' : 'decline',
            };
    pending.resolve({ handled: true, result });
    onApprovalResolved?.(String(requestId));
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
    getMcpAuthPending: () => [...mcpAuthPending.entries()].map(([name, entry]) => ({
      name, url: entry.url, message: entry.message,
    })),
    rewindConversation: async (turnIndex, options) => {
      await ready;
      if (closed) throw new Error('Codex session is closed');
      return rewindCodexConversation(manager, threadId, cwd, turnIndex, options);
    },
    getMode: () => currentMode,
    listQueue,
    removeQueued,
    reorderQueue,
    sendNow,
    debugSnapshot: () => ({ threadId, activeTurnId, queuedTurns: pending.length, currentMode, ...resultEpoch.snapshot() }),
    query: {
      supportedModels: () => listCodexModels(manager),
      setModel: async (next) => { currentModel = next || null; },
      setEffort: async (next) => { currentEffort = next || null; },
      setMaxThinkingTokens: unsupported('setMaxThinkingTokens'),
      supportedCommands: extensions.supportedCommands,
      supportedAgents: extensions.supportedAgents,
      mcpServerStatus: extensions.mcpServerStatus,
      toggleMcpServer: extensions.toggleMcpServer,
      reconnectMcpServer: extensions.reconnectMcpServer,
      mcpOauthLogin: extensions.mcpOauthLogin,
      reloadPlugins: extensions.reloadPlugins,
      setPluginEnabled: extensions.setPluginEnabled,
      codexRateLimits: extensions.codexRateLimits,
    },
  };
}
