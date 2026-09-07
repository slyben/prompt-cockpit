import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCodexSession } from '../src/codex-session.js';

function createManager({ deferTurnStart = false, turnStartId = 'turn-1' } = {}) {
  const calls = [];
  const notificationHandlers = new Set();
  let notify;
  let serverRequest;
  let completeTurns = true;
  let releaseTurnStart;
  const closeHandlers = new Set();
  const manager = {
    calls,
    set completeTurns(value) { completeTurns = value; },
    releaseTurnStart() { releaseTurnStart?.(); },
    ready: async () => {},
    subscribe(handler) {
      notify = handler;
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onServerRequest(handler) { serverRequest = handler; return () => {}; },
    onClose(handler) { closeHandlers.add(handler); return () => closeHandlers.delete(handler); },
    fail(err) { for (const handler of closeHandlers) handler(err); },
    threadRefCounts: new Map(),
    retainThread(threadId) {
      this.threadRefCounts.set(threadId, (this.threadRefCounts.get(threadId) || 0) + 1);
    },
    releaseThread(threadId) {
      const count = this.threadRefCounts.get(threadId) || 0;
      if (count <= 1) { this.threadRefCounts.delete(threadId); return true; }
      this.threadRefCounts.set(threadId, count - 1);
      return false;
    },
    async request(method, params) {
      calls.push([method, params]);
      if (method === 'thread/start' || method === 'thread/resume') {
        return { thread: { id: params.threadId || 'thread-new', model: params.model || 'codex-model' } };
      }
      if (method === 'turn/start') {
        const result = { turn: { id: turnStartId, status: 'inProgress' } };
        const finish = () => {
          if (completeTurns) {
            setImmediate(() => notificationHandlers.forEach((handler) => handler('turn/completed', {
              threadId: params.threadId,
              turn: { id: turnStartId, status: 'completed' },
            })));
          }
          return result;
        };
        if (deferTurnStart) {
          return new Promise((resolve) => { releaseTurnStart = () => resolve(finish()); });
        }
        return finish();
      }
      return {};
    },
    emit(method, params) { notificationHandlers.forEach((handler) => handler(method, params)); },
    requestFromServer(method, params, id = 7) { return serverRequest(method, params, id); },
  };
  return manager;
}

async function waitFor(predicate, message = 'condition') {
  const deadline = Date.now() + 1000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${message}`);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function startOptions(manager, overrides = {}) {
  const messages = [];
  const states = [];
  const errors = [];
  const handle = startCodexSession({
    cwd: '/repo',
    model: 'codex-model',
    effort: 'high',
    permissionMode: 'default',
    manager,
    onMessage: (message) => messages.push(message),
    onStateChange: (state) => states.push(state),
    onError: (error) => errors.push(error),
    ...overrides,
  });
  return { handle, messages, states, errors };
}

test('Codex sessions start a thread, queue a prompt, and finish a streamed turn', async () => {
  const manager = createManager();
  const { handle, messages, states } = startOptions(manager);
  handle.pushInput('Explain this repo');

  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn/start');
  await waitFor(() => states.at(-1) === 'idle', 'idle state');

  assert.equal(manager.calls[0][0], 'thread/start');
  const turn = manager.calls.find(([method]) => method === 'turn/start')[1];
  assert.equal(turn.threadId, 'thread-new');
  assert.equal(turn.input[0].text, 'Explain this repo');
  assert.equal(turn.effort, 'high');
  assert.equal(turn.approvalPolicy, 'on-request');
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite' });
  assert.ok(messages.some((message) => message.type === 'result' && message.subtype === 'success'));
  handle.close();
});

test('Codex claims turn/started before turn/start resolves so events and interrupt are not dropped', async () => {
  const manager = createManager({ deferTurnStart: true });
  const { handle, states } = startOptions(manager);
  handle.pushInput('race the turn start');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn/start request');

  manager.emit('turn/started', {
    threadId: 'thread-new', turn: { id: 'turn-1', status: 'inProgress' },
  });
  await waitFor(() => handle.debugSnapshot().activeTurnId === 'turn-1', 'claimed active turn');

  await handle.interrupt();
  assert.deepEqual(manager.calls.at(-1), ['turn/interrupt', { threadId: 'thread-new', turnId: 'turn-1' }]);

  manager.releaseTurnStart();
  await waitFor(() => states.at(-1) === 'idle', 'idle after raced turn');
  handle.close();
});

test('Codex adopts the turn/start response id when it claimed a sibling turn in the race window', async () => {
  const manager = createManager({ deferTurnStart: true, turnStartId: 'turn-mine' });
  manager.completeTurns = false; // this test drives turn/completed by hand
  const { handle, messages, states } = startOptions(manager);
  handle.pushInput('race a sibling turn start');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn/start request');

  // Neither handle can attribute a turn/started during the window, so this one
  // optimistically claims a turn the app-server actually started for a sibling.
  manager.emit('turn/started', {
    threadId: 'thread-new', turn: { id: 'turn-sibling', status: 'inProgress' },
  });
  await waitFor(() => handle.debugSnapshot().activeTurnId === 'turn-sibling', 'claimed sibling turn');

  manager.releaseTurnStart();
  await waitFor(() => handle.debugSnapshot().activeTurnId === 'turn-mine', 'adopted response turn id');
  assert.ok(!states.includes('error'), 'the race must not fail the session');

  // The mis-claimed id is released outright, not parked in the late-event
  // tail, so the sibling's remaining output stays out of this transcript.
  const before = messages.length;
  manager.emit('item/completed', {
    threadId: 'thread-new', turnId: 'turn-sibling',
    item: { id: 'sibling-item', type: 'commandExecution', command: 'rm -rf /', status: 'completed' },
  });
  assert.equal(messages.length, before, 'sibling turn events must be ignored after release');

  manager.emit('turn/completed', {
    threadId: 'thread-new', turn: { id: 'turn-mine', status: 'completed' },
  });
  await waitFor(() => states.at(-1) === 'idle', 'idle after adopting the real turn');
  handle.close();
});

test('Codex uses the resolved top-level thread model for token pricing', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const originalRequest = manager.request.bind(manager);
  manager.request = async (method, params) => {
    if (method === 'thread/start') {
      manager.calls.push([method, params]);
      return { thread: { id: 'thread-new' }, model: 'gpt-5.3-codex' };
    }
    return originalRequest(method, params);
  };
  const { handle, messages } = startOptions(manager);
  await waitFor(() => manager.calls.some(([method]) => method === 'thread/start'), 'thread start');
  handle.pushInput('model probe');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn start');

  manager.emit('thread/tokenUsage/updated', {
    threadId: 'thread-new', turnId: 'turn-1',
    tokenUsage: {
      last: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 },
      total: { inputTokens: 100, cachedInputTokens: 25, outputTokens: 10, reasoningOutputTokens: 2, totalTokens: 110 },
    },
  });

  const usage = messages.find((message) => message.type === 'assistant' && message.message?.usage);
  assert.ok(usage);
  assert.equal(usage.message.model, 'gpt-5.3-codex');
  assert.equal(usage.message.usage.input_tokens, 75);
  handle.close();
});

// Wire values follow the app-server AskForApproval schema, independently of
// the camelCase SandboxPolicy discriminators and Cockpit's UI mode names.
test('Codex turn policies remain valid when switching permission modes', async () => {
  const manager = createManager();
  const { handle, states, errors } = startOptions(manager);
  try {
    const modes = [
      ['default', 'on-request', 'workspaceWrite'],
      ['acceptEdits', 'on-request', 'workspaceWrite'],
      ['auto', 'on-request', 'workspaceWrite'],
      ['dontAsk', 'never', 'workspaceWrite'],
      ['plan', 'never', 'readOnly'],
      ['bypassPermissions', 'never', 'dangerFullAccess'],
      ['default', 'on-request', 'workspaceWrite'],
    ];
    for (const [mode, approvalPolicy, sandboxType] of modes) {
      await handle.setMode(mode);
      const previousTurns = manager.calls.filter(([method]) => method === 'turn/start').length;
      handle.pushInput(`Check ${mode}`);
      await waitFor(() => manager.calls.filter(([method]) => method === 'turn/start').length > previousTurns, mode);
      await waitFor(() => states.at(-1) === 'idle', `${mode} completion`);
      const turn = manager.calls.filter(([method]) => method === 'turn/start').at(-1)[1];
      assert.equal(turn.approvalPolicy, approvalPolicy, mode);
      assert.deepEqual(turn.sandboxPolicy, { type: sandboxType }, mode);
    }
    assert.deepEqual(errors, []);
  } finally {
    handle.close();
  }
});

test('Codex resume uses thread/resume and command approvals follow permission mode', async () => {
  const manager = createManager();
  const { handle } = startOptions(manager, { resume: 'thread-existing', permissionMode: 'bypassPermissions' });
  await waitFor(() => manager.calls.length > 0, 'thread/resume');
  assert.deepEqual(manager.calls[0], ['thread/resume', {
    threadId: 'thread-existing', cwd: '/repo', model: 'codex-model',
  }]);

  const response = await manager.requestFromServer('item/commandExecution/requestApproval', {
    threadId: 'thread-existing', turnId: 'turn-1', command: 'npm test',
  });
  assert.deepEqual(response, { handled: true, result: { decision: 'accept' } });
  handle.close();
});

test('Codex permission requests reach the client and return only requested grants', async () => {
  const manager = createManager();
  const approvals = [];
  const { handle } = startOptions(manager, { onApprovalRequest: (request) => approvals.push(request) });
  await waitFor(() => manager.calls.length > 0, 'thread start');

  const requested = [{ type: 'network', host: 'registry.npmjs.org' }];
  const responsePromise = manager.requestFromServer('item/permissions/requestApproval', {
    threadId: 'thread-new', turnId: 'turn-1', permissions: requested,
    reason: 'Download a package',
  });
  await waitFor(() => approvals.length === 1, 'permission approval');
  assert.equal(approvals[0].toolName, 'RequestPermissions');
  assert.equal(handle.resolveApproval(approvals[0].requestId, {
    behavior: 'allow', alwaysAllow: 'session',
  }), true);
  assert.deepEqual(await responsePromise, {
    handled: true,
    result: { permissions: requested, scope: 'session' },
  });
  handle.close();
});

test('Codex requestUserInput uses the shared question UI contract and returns Codex answers', async () => {
  const manager = createManager();
  const approvals = [];
  const { handle } = startOptions(manager, { onApprovalRequest: (request) => approvals.push(request) });
  await waitFor(() => manager.calls.length > 0, 'thread start');

  const responsePromise = manager.requestFromServer('item/tool/requestUserInput', {
    threadId: 'thread-new', turnId: 'turn-1', itemId: 'item-1',
    questions: [{ id: 'choice', header: 'Choice', question: 'Pick one', options: [{ label: 'yes', description: 'continue' }] }],
  }, 51);
  await waitFor(() => approvals.length === 1, 'question approval');
  assert.equal(approvals[0].toolName, 'AskUserQuestion');
  assert.equal(approvals[0].answerFormat, 'question-ids');
  assert.equal(handle.resolveApproval(approvals[0].requestId, {
    behavior: 'allow', updatedInput: { answers: { choice: { answers: ['yes'] } } },
  }), true);
  assert.deepEqual(await responsePromise, {
    handled: true,
    result: { answers: { choice: { answers: ['yes'] } } },
  });
  handle.close();
});

test('Codex legacy approval aliases return legacy decisions and client-tool calls fail explicitly', async () => {
  const manager = createManager();
  const approvals = [];
  const { handle } = startOptions(manager, { onApprovalRequest: (request) => approvals.push(request) });
  await waitFor(() => manager.calls.length > 0, 'thread start');

  const commandResponse = manager.requestFromServer('execCommandApproval', {
    conversationId: 'thread-new', command: 'npm test', cwd: '/repo', reason: 'Run tests',
  }, 61);
  await waitFor(() => approvals.length === 1, 'legacy command approval');
  assert.equal(approvals[0].toolName, 'Bash');
  assert.equal(handle.resolveApproval(61, { behavior: 'allow', alwaysAllow: 'session' }), true);
  assert.deepEqual(await commandResponse, {
    handled: true,
    result: { decision: 'approved_for_session' },
  });

  assert.deepEqual(await manager.requestFromServer('item/tool/call', {
    threadId: 'thread-new', tool: 'computer', input: {},
  }, 62), {
    handled: true,
    result: {
      contentItems: [{
        type: 'inputText',
        text: 'Prompt Cockpit cannot execute Codex client tool "computer"',
      }],
      success: false,
    },
  });

  const patchResponse = manager.requestFromServer('applyPatchApproval', {
    conversationId: 'thread-new', fileChanges: [{ path: 'src/app.js' }], reason: 'Edit source',
  }, 63);
  await waitFor(() => approvals.length === 2, 'legacy patch approval');
  handle.close();
  assert.deepEqual(await patchResponse, {
    handled: true,
    result: { decision: 'abort' },
  });
});

test('Codex MCP URL elicitation is accepted and exposes a pending auth link', async () => {
  const manager = createManager();
  const authRequests = [];
  const authResolved = [];
  const { handle } = startOptions(manager, {
    onMcpAuthRequest: (request) => authRequests.push(request),
    onMcpAuthResolved: (request) => authResolved.push(request),
  });
  await waitFor(() => manager.calls.length > 0, 'thread start');

  const response = await manager.requestFromServer('mcpServer/elicitation/request', {
    threadId: 'thread-new', turnId: 'turn-1', serverName: 'github',
    elicitationId: 'elic-1', mode: 'url', url: 'https://example.com/oauth', message: 'Authorize GitHub',
  }, 52);
  assert.deepEqual(response, { handled: true, result: { action: 'accept' } });
  assert.deepEqual(handle.getMcpAuthPending(), [{ name: 'github', url: 'https://example.com/oauth', message: 'Authorize GitHub' }]);
  assert.deepEqual(authRequests, [{ serverName: 'github', url: 'https://example.com/oauth', message: 'Authorize GitHub' }]);

  manager.emit('mcpServer/oauthLogin/completed', { name: 'github', success: true });
  await waitFor(() => handle.getMcpAuthPending().length === 0, 'MCP auth completion');
  assert.deepEqual(authResolved, [{ serverName: 'github' }]);
  handle.close();
});

test('Codex MCP form elicitation is explicitly declined when no schema form UI exists', async () => {
  const manager = createManager();
  const { handle } = startOptions(manager);
  await waitFor(() => manager.calls.length > 0, 'thread start');
  const response = await manager.requestFromServer('mcpServer/elicitation/request', {
    threadId: 'thread-new', serverName: 'github', mode: 'form', message: 'Enter a token', requestedSchema: {},
  });
  assert.deepEqual(response, { handled: true, result: { action: 'decline' } });
  handle.close();
});

test('Codex clears an approval when app-server sends serverRequest/resolved', async () => {
  const manager = createManager();
  const approvals = [];
  const resolved = [];
  const { handle } = startOptions(manager, {
    onApprovalRequest: (request) => approvals.push(request),
    onApprovalResolved: (requestId) => resolved.push(requestId),
  });
  await waitFor(() => manager.calls.length > 0, 'thread start');

  const responsePromise = manager.requestFromServer('item/commandExecution/requestApproval', {
    threadId: 'thread-new', turnId: 'turn-1', command: 'npm test',
  }, 42);
  await waitFor(() => approvals.length === 1, 'command approval');
  manager.emit('serverRequest/resolved', { threadId: 'thread-new', requestId: 42 });

  assert.deepEqual(await responsePromise, { handled: true, result: { decision: 'cancel' } });
  assert.deepEqual(resolved, ['42']);
  assert.equal(handle.resolveApproval('42', { behavior: 'allow' }), false);
  handle.close();
});

test('Codex plan mode denies permission requests without prompting', async () => {
  const manager = createManager();
  const approvals = [];
  const { handle } = startOptions(manager, {
    permissionMode: 'plan', onApprovalRequest: (request) => approvals.push(request),
  });
  await waitFor(() => manager.calls.length > 0, 'thread start');
  const response = await manager.requestFromServer('item/permissions/requestApproval', {
    threadId: 'thread-new', turnId: 'turn-1', permissions: [{ type: 'network', host: 'example.com' }],
  });
  assert.deepEqual(response, { handled: true, result: { permissions: [], scope: 'turn' } });
  assert.deepEqual(approvals, []);

  handle.pushInput('Inspect without changing files');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn start');
  const turn = manager.calls.find(([method]) => method === 'turn/start')[1];
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(turn.sandboxPolicy, { type: 'readOnly' });
  handle.close();
});

test('Codex bypass mode uses the explicit unrestricted turn policy', async () => {
  const manager = createManager();
  const { handle } = startOptions(manager, { permissionMode: 'bypassPermissions' });
  handle.pushInput('Make the requested changes');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn start');
  const turn = manager.calls.find(([method]) => method === 'turn/start')[1];
  assert.equal(turn.approvalPolicy, 'never');
  assert.deepEqual(turn.sandboxPolicy, { type: 'dangerFullAccess' });
  handle.close();
});

test('Codex interrupt targets the active turn without stopping the shared app-server', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const { handle } = startOptions(manager);
  handle.pushInput('Long task');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'active turn');
  handle.pushInput('queued after');
  assert.equal(handle.listQueue().length, 1);

  await handle.interrupt();
  assert.equal(handle.listQueue().length, 0, 'Stop must drop the local queue, not leave it to run after');
  assert.deepEqual(manager.calls.find(([method]) => method === 'turn/interrupt'), [
    'turn/interrupt', { threadId: 'thread-new', turnId: 'turn-1' },
  ]);
  manager.emit('turn/completed', {
    threadId: 'thread-new', turn: { id: 'turn-1', status: 'interrupted' },
  });
  handle.close();
});

test('Codex forceIdle drops queued turns so they cannot run after recovery', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const { handle, states } = startOptions(manager);
  handle.pushInput('stuck');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'active turn');
  handle.pushInput('queued');
  assert.equal(handle.listQueue().length, 1);

  handle.forceIdle();
  assert.equal(handle.listQueue().length, 0);
  assert.equal(states[states.length - 1], 'idle');
  manager.emit('turn/completed', {
    threadId: 'thread-new', turn: { id: 'turn-1', status: 'interrupted' },
  });
  handle.close();
});

test('Codex model listing maps app-server model descriptors', async () => {
  const manager = createManager();
  const originalRequest = manager.request.bind(manager);
  manager.request = async (method, params) => {
    if (method === 'model/list') {
      return { data: [
        { model: 'gpt-codex', displayName: 'GPT Codex', description: 'Agent model', supportedReasoningEfforts: ['low', 'medium', 'high'] },
        { model: 'gpt-codex-mini', displayName: 'GPT Codex Mini' },
      ] };
    }
    return originalRequest(method, params);
  };
  const { handle } = startOptions(manager);
  await waitFor(() => manager.calls.length > 0, 'thread start');
  assert.deepEqual(await handle.query.supportedModels(), [{
    value: 'gpt-codex', displayName: 'GPT Codex', description: 'Agent model', resolvedModel: 'gpt-codex',
    supportedEfforts: ['low', 'medium', 'high'],
  }, {
    value: 'gpt-codex-mini', displayName: 'GPT Codex Mini', description: '', resolvedModel: 'gpt-codex-mini',
    supportedEfforts: null,
  }]);
  handle.close();
});

test('a shared app-server dying mid-turn errors the session instead of leaving it running forever', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const { handle, states, errors } = startOptions(manager);
  handle.pushInput('Long task');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'active turn');
  assert.equal(states.at(-1), 'running');

  manager.fail(new Error('codex app-server exited 1'));
  await waitFor(() => states.at(-1) === 'error', 'session to error out');
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /codex app-server exited 1/);
  // pushInput must not accept more work once the session is dead - `null`,
  // not `undefined` (2026-09-02 review, finding #2): session-registry.js's
  // pushTurn checks for the exact `null` sentinel to decide whether to
  // register a delegation tag, same contract session.js/grok-session.js use.
  // `undefined` slipped past that check and could still setTag(undefined,
  // tag), stranding a delegation origin.
  assert.equal(handle.pushInput('another message'), null);
});

test('a single turn/start failure closes the session so pump() does not keep driving turns into the void', async () => {
  const manager = createManager();
  const originalRequest = manager.request.bind(manager);
  manager.request = async (method, params) => {
    if (method === 'turn/start') throw new Error('turn/start rejected: bad params');
    return originalRequest(method, params);
  };
  const { handle, errors } = startOptions(manager);
  handle.pushInput('first');
  handle.pushInput('second'); // queued behind the first, which will fail
  await waitFor(() => errors.length > 0, 'runTurn failure to surface');
  assert.match(errors[0].message, /turn\/start rejected/);
  // The catch must set `closed`, same as manager.onClose does for a
  // whole-app-server death - otherwise pump()'s own `finally` block sees
  // `pending.length` still has 'second' in it and keeps calling turn/start
  // against a row session-registry.js has already reaped.
  assert.equal(handle.pushInput('third'), null, 'the session must refuse new work once a turn has fatally failed');
});

test('a thread/start failure closes the Codex handle instead of accepting work after the row is reaped', async () => {
  const manager = createManager();
  const originalRequest = manager.request.bind(manager);
  manager.request = async (method, params) => {
    if (method === 'thread/start') throw new Error('thread/start rejected: unavailable');
    return originalRequest(method, params);
  };
  const { handle, errors } = startOptions(manager);
  await waitFor(() => errors.length > 0, 'thread/start failure to surface');
  assert.match(errors[0].message, /thread\/start rejected/);
  assert.equal(handle.pushInput('after startup failure'), null);
});

test('closing a session sends turn/interrupt before thread/unsubscribe, not just unsubscribe', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const { handle } = startOptions(manager);
  handle.pushInput('Long task');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'active turn');

  handle.close();
  await waitFor(() => manager.calls.some(([method]) => method === 'thread/unsubscribe'), 'unsubscribe sent');
  const methods = manager.calls.map(([method]) => method);
  const interruptIndex = methods.indexOf('turn/interrupt');
  const unsubscribeIndex = methods.indexOf('thread/unsubscribe');
  assert.notEqual(interruptIndex, -1, 'close() must send turn/interrupt for an active turn');
  assert.ok(interruptIndex < unsubscribeIndex, 'turn/interrupt must precede thread/unsubscribe');
});

test('closing one of two Cockpit sessions on the same Codex thread does not unsubscribe the other', async () => {
  const manager = createManager();
  const first = startOptions(manager, {}); // both land on 'thread-new' - see createManager's thread/start stub
  await waitFor(() => manager.calls.some(([method]) => method === 'thread/start'), 'first thread start');
  const second = startOptions(manager, {});
  await waitFor(() => manager.calls.filter(([method]) => method === 'thread/start').length === 2, 'second thread start');

  first.handle.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(
    !manager.calls.some(([method]) => method === 'thread/unsubscribe'),
    'the shared thread is still referenced by the second session - must not unsubscribe yet',
  );

  second.handle.close();
  await waitFor(() => manager.calls.some(([method]) => method === 'thread/unsubscribe'), 'unsubscribe sent');
});

test('a passive session on a shared thread does not claim or interrupt another session turn', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const first = startOptions(manager);
  await waitFor(() => manager.calls.filter(([method]) => method === 'thread/start').length === 1, 'first thread start');
  const second = startOptions(manager);
  await waitFor(() => manager.calls.filter(([method]) => method === 'thread/start').length === 2, 'second thread start');

  first.handle.pushInput('owned turn');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'owned turn start');
  manager.emit('turn/started', { threadId: 'thread-new', turn: { id: 'other-session-turn', status: 'inProgress' } });
  assert.equal(second.handle.debugSnapshot().activeTurnId, null);

  const interruptCount = () => manager.calls.filter(([method]) => method === 'turn/interrupt').length;
  second.handle.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(interruptCount(), 0);

  first.handle.close();
  await waitFor(() => interruptCount() === 1, 'owned turn interrupt');
});

test('Codex keeps token usage for a turn after it completes', async () => {
  const manager = createManager();
  const { handle, messages, states } = startOptions(manager);
  handle.pushInput('usage after complete');
  await waitFor(() => states.at(-1) === 'idle', 'idle after turn');
  assert.equal(handle.debugSnapshot().activeTurnId, null);

  manager.emit('thread/tokenUsage/updated', {
    threadId: 'thread-new', turnId: 'turn-1',
    tokenUsage: {
      last: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
      total: { inputTokens: 20, outputTokens: 5, totalTokens: 25 },
    },
  });
  const usage = messages.find((message) => message.type === 'assistant' && message.message?.usage);
  assert.ok(usage);
  assert.equal(usage.message.usage.output_tokens, 5);
  handle.close();
});

test('Codex still applies item/completed after the turn is done', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const { handle, messages, states } = startOptions(manager);
  handle.pushInput('late item');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'turn start');
  manager.emit('item/started', {
    threadId: 'thread-new', turnId: 'turn-1',
    item: { id: 'cmd-late', type: 'commandExecution', command: 'ls', status: 'inProgress' },
  });
  manager.emit('turn/completed', {
    threadId: 'thread-new', turn: { id: 'turn-1', status: 'completed' },
  });
  await waitFor(() => states.at(-1) === 'idle', 'idle after turn');
  manager.emit('item/completed', {
    threadId: 'thread-new', turnId: 'turn-1',
    item: { id: 'cmd-late', type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: 'ok' },
  });
  assert.ok(messages.some((message) => message.message?.content?.[0]?.type === 'tool_result'
    && message.message.content[0].tool_use_id === 'cmd-late'));
  handle.close();
});

test('Codex resume accepts token usage replay before any local turn', async () => {
  const manager = createManager();
  const { handle, messages } = startOptions(manager, { resume: 'thread-existing' });
  await waitFor(() => manager.calls.some(([method]) => method === 'thread/resume'), 'thread/resume');
  assert.equal(handle.debugSnapshot().activeTurnId, null);

  manager.emit('thread/tokenUsage/updated', {
    threadId: 'thread-existing', turnId: 'historical-turn',
    tokenUsage: {
      last: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
      total: { inputTokens: 50, outputTokens: 10, totalTokens: 60 },
    },
  });
  const usage = messages.find((message) => message.type === 'assistant' && message.message?.usage);
  assert.ok(usage);
  assert.equal(usage.message.usage.input_tokens, 50);
  handle.close();
});

test('a passive session ignores another session\'s tool items on the shared thread', async () => {
  const manager = createManager();
  manager.completeTurns = false;
  const first = startOptions(manager);
  await waitFor(() => manager.calls.filter(([method]) => method === 'thread/start').length === 1, 'first thread start');
  const second = startOptions(manager);
  await waitFor(() => manager.calls.filter(([method]) => method === 'thread/start').length === 2, 'second thread start');

  first.handle.pushInput('owned turn');
  await waitFor(() => manager.calls.some(([method]) => method === 'turn/start'), 'owned turn start');
  manager.emit('item/started', {
    threadId: 'thread-new', turnId: 'turn-1',
    item: { id: 'cmd-owned', type: 'commandExecution', command: 'ls', status: 'inProgress' },
  });
  assert.ok(first.messages.some((message) => message.message?.content?.[0]?.type === 'tool_use'));
  assert.equal(second.messages.filter((message) => message.message?.content?.[0]?.type === 'tool_use').length, 0);

  first.handle.close();
  second.handle.close();
});
