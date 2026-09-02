import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCodexSession } from '../src/codex-session.js';

function createManager() {
  const calls = [];
  let notify;
  let serverRequest;
  let completeTurns = true;
  const closeHandlers = new Set();
  const manager = {
    calls,
    set completeTurns(value) { completeTurns = value; },
    ready: async () => {},
    subscribe(handler) { notify = handler; return () => {}; },
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
        const result = { turn: { id: 'turn-1', status: 'inProgress' } };
        if (completeTurns) {
          setImmediate(() => notify('turn/completed', {
            threadId: params.threadId,
            turn: { id: 'turn-1', status: 'completed' },
          }));
        }
        return result;
      }
      return {};
    },
    emit(method, params) { notify(method, params); },
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
  assert.equal(turn.approvalPolicy, 'onRequest');
  assert.deepEqual(turn.sandboxPolicy, { type: 'workspaceWrite' });
  assert.ok(messages.some((message) => message.type === 'result' && message.subtype === 'success'));
  handle.close();
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
