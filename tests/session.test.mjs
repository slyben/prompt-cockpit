// Unit tests for src/session.js itself, via a fake `queryImpl` (mirrors the
// registry's `startSessionImpl` injection point) instead of the real SDK -
// no CLI process spawned. Previously session.js had zero automated
// coverage (see tests/README.md); this file exists specifically to pin the
// /clear -> turnCounter reset behavior (the one residual edge from the
// rewind wrong-turn fix that had no test), plus the turnIndexOffset seeding
// it builds on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startSession } from '../src/session.js';

// A controllable fake for what query() returns: an async-iterable of SDK
// messages the test pushes in from outside, plus the handful of methods
// session.js calls on it (interrupt/setPermissionMode - unused by these
// tests but required to exist so close()/setMode() don't throw if called).
function fakeQueryHandle() {
  const pending = [];
  let waiting = null;
  let closed = false;
  const handle = {
    interrupt: async () => { handle.interruptCalls = (handle.interruptCalls || 0) + 1; },
    setPermissionMode: async () => {},
    push(message) {
      if (closed) return;
      if (waiting) {
        const resolve = waiting;
        waiting = null;
        resolve({ value: message, done: false });
      } else {
        pending.push(message);
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (pending.length > 0) return Promise.resolve({ value: pending.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { waiting = resolve; });
        },
      };
    },
  };
  return handle;
}

// Lets the session.js's internal `for await` loop actually consume what was
// just pushed before the test moves on - it processes on a microtask/macrotask
// boundary, not synchronously with push().
function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function startFakeSession(overrides = {}) {
  const handle = fakeQueryHandle();
  const messages = [];
  const states = [];
  let capturedOptions;
  const session = startSession({
    cwd: '/tmp',
    queryImpl: (opts) => { capturedOptions = opts.options; return handle; },
    onMessage: (msg) => messages.push(msg),
    onStateChange: (s) => states.push(s),
    onError: () => {},
    onApprovalRequest: () => {},
    ...overrides,
  });
  return { handle, session, messages, states, getOptions: () => capturedOptions };
}

test('turnIndex counts pushInput() calls starting from turnIndexOffset', async () => {
  const { handle, session, messages } = startFakeSession({ turnIndexOffset: 5 });
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();

  session.pushInput('first');
  const turnIndexes = () => messages.filter((m) => 'turnIndex' in m).map((m) => m.turnIndex);
  assert.deepEqual(turnIndexes(), [6]);

  session.pushInput('second');
  assert.deepEqual(turnIndexes(), [6, 7]);
});

test('a conversation_reset message (/clear) resets turnIndex back to 1, not the pre-clear offset', async () => {
  // Regression test for the residual rewind edge: /clear starts a fresh
  // conversation, so turnCounter has to restart with it or every rewind
  // button minted afterward indexes against the wrong transcript position.
  const { handle, session, messages } = startFakeSession({ turnIndexOffset: 3 });
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();

  session.pushInput('pre-clear turn');
  const turnIndexes = () => messages.filter((m) => 'turnIndex' in m).map((m) => m.turnIndex);
  assert.deepEqual(turnIndexes(), [4]);

  handle.push({ type: 'conversation_reset', new_conversation_id: 'c2', session_id: 's1', uuid: 'u1' });
  await flush();

  session.pushInput('post-clear turn one');
  session.pushInput('post-clear turn two');
  assert.deepEqual(turnIndexes(), [4, 1, 2]);
});

// The fake handle's queryImpl never actually consumes `opts.prompt`
// (session.js's inputQueue) the way the real SDK does - so nothing here
// ever counts as "already waiting", and every pushInput() lands in
// `pending` and is listQueue()-visible, same as a real turn queued up
// behind a still-running one would be. Good enough to test the queue
// mutations in isolation without wiring a second fake consumer loop.
test('listQueue/removeQueued/reorderQueue/sendNow manage the visible input queue', async () => {
  const { handle, session, messages, states } = startFakeSession();
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();

  session.pushInput('first');
  session.pushInput('second');
  session.pushInput('third');
  const [id1, id2, id3] = messages.filter((m) => 'queueId' in m).map((m) => m.queueId);
  assert.equal(session.listQueue().length, 3);
  assert.deepEqual(session.listQueue().map((e) => e.text), ['first', 'second', 'third']);

  // Drop the middle one - the other two keep their order, and this frees up
  // one pendingTurns slot even though no `result` will ever arrive for it.
  assert.equal(session.removeQueued(id2), true);
  assert.deepEqual(session.listQueue().map((e) => e.id), [id1, id3]);
  assert.equal(session.removeQueued('not-a-real-id'), false);

  // Reorder puts id3 ahead of id1.
  session.reorderQueue([id3, id1]);
  assert.deepEqual(session.listQueue().map((e) => e.id), [id3, id1]);

  // sendNow moves the target to the front (already there) and interrupts
  // whatever's running so the SDK's next pull grabs it.
  assert.equal(await session.sendNow(id1), true);
  assert.deepEqual(session.listQueue().map((e) => e.id), [id1, id3]);
  assert.equal(handle.interruptCalls, 1);

  assert.equal(await session.sendNow('not-a-real-id'), false);

  // Draining the queue via removeQueued eventually settles state back to
  // idle, same as every turn actually finishing would.
  session.removeQueued(id1);
  session.removeQueued(id3);
  assert.equal(states[states.length - 1], 'idle');
});

// Regression test for the "AskUserQuestion doesn't work at all" root cause:
// AUTO_ALLOW_MODES (acceptEdits, bypassPermissions, etc.) used to short-
// circuit every gated tool call, including this one, straight back to the
// model as `updatedInput: input` unmodified - which the tool reads as an
// empty `answers`, i.e. "the user did not answer the questions", with no
// human ever seeing the question. It must always reach onApprovalRequest
// instead, regardless of mode, same as it would in `default`/`plan`.
test('interrupt() calls the SDK handle without closing the input queue - pushInput still works after', async () => {
  const { handle, session, messages } = startFakeSession();
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();

  await session.interrupt();
  assert.equal(handle.interruptCalls, 1);

  // close() is the one that calls inputQueue.close() - interrupt() must not,
  // or a pushInput() right after cancelling a turn would silently no-op
  // instead of starting the next one (see session.js's pushInput() comment
  // on what a closed queue does to a post-close call).
  session.pushInput('still works');
  assert.ok(messages.some((m) => m.turnIndex === 1 && m.message?.content === 'still works'));
});

// Regression test: a turn interrupted early enough (before the model
// produced anything) can come back with num_turns:0, same as the priming
// sentinel session.js pushes at startup - the sentinel's own `continue`
// used to match on num_turns alone, swallowing the interrupted turn's
// result too (skipping both the pendingTurns decrement and onMessage),
// which left state stuck on 'running' forever - the spinner-never-stops
// bug found while testing the Stop button. The two are only
// distinguishable by pendingTurns: the sentinel's result is the only one
// that can ever arrive while pendingTurns is still 0.
test('a real turn interrupted before producing anything (num_turns:0) still settles state back to idle', async () => {
  const { handle, session, messages, states } = startFakeSession();
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();

  session.pushInput('stop before you start');
  assert.equal(states[states.length - 1], 'running');

  handle.push({ type: 'result', subtype: 'error_during_execution', num_turns: 0, is_error: true });
  await flush();

  assert.equal(states[states.length - 1], 'idle');
  assert.ok(messages.some((m) => m.type === 'result' && m.num_turns === 0));
});

test('resolveApproval with alwaysAllow:true (legacy boolean) coerces to scope "session" and auto-allows the same tool for the rest of the session', async () => {
  const approvalRequests = [];
  const { session, getOptions } = startFakeSession({
    onApprovalRequest: (req) => approvalRequests.push(req),
  });

  const first = getOptions().canUseTool('Bash', { command: 'ls' }, {});
  assert.equal(approvalRequests.length, 1);
  const requestId = approvalRequests[0].requestId;

  assert.deepEqual(
    session.resolveApproval(requestId, { behavior: 'allow', updatedInput: { command: 'ls' }, alwaysAllow: true }),
    { resolved: true, toolName: 'Bash', scope: 'session' },
  );
  const firstResult = await first;
  // alwaysAllow must never reach the SDK as part of the real PermissionResult.
  assert.deepEqual(firstResult, { behavior: 'allow', updatedInput: { command: 'ls' } });

  // A second call for the SAME tool now resolves immediately - no second
  // onApprovalRequest - same as AUTO_ALLOW_MODES already does per-mode.
  const second = await getOptions().canUseTool('Bash', { command: 'pwd' }, {});
  assert.equal(approvalRequests.length, 1);
  assert.deepEqual(second, { behavior: 'allow', updatedInput: { command: 'pwd' } });

  // A DIFFERENT tool is unaffected - alwaysAllowTools is keyed per tool
  // name, not a blanket switch.
  const third = getOptions().canUseTool('Write', { path: 'x' }, {});
  assert.equal(approvalRequests.length, 2);
  const denyResult = session.resolveApproval(approvalRequests[1].requestId, { behavior: 'deny', message: 'no' });
  assert.deepEqual(denyResult, { resolved: true, toolName: 'Write', scope: null }); // deny never sets a scope, even if alwaysAllow were passed
  assert.deepEqual(await third, { behavior: 'deny', message: 'no' });
});

test('resolveApproval with alwaysAllow: "project" also auto-allows for the rest of the session (persistence is server.js\'s job, not session.js\'s)', async () => {
  const approvalRequests = [];
  const { session, getOptions } = startFakeSession({
    onApprovalRequest: (req) => approvalRequests.push(req),
  });

  const first = getOptions().canUseTool('Read', { file_path: 'x' }, {});
  const requestId = approvalRequests[0].requestId;
  const result = session.resolveApproval(requestId, { behavior: 'allow', updatedInput: { file_path: 'x' }, alwaysAllow: 'project' });
  assert.deepEqual(result, { resolved: true, toolName: 'Read', scope: 'project' });
  await first;

  const second = await getOptions().canUseTool('Read', { file_path: 'y' }, {});
  assert.equal(approvalRequests.length, 1); // still just the one prompt - project scope also takes immediate in-session effect
  assert.deepEqual(second, { behavior: 'allow', updatedInput: { file_path: 'y' } });
});

test('resolveApproval on an unknown/already-resolved requestId returns false', () => {
  const { session } = startFakeSession({ onApprovalRequest: () => {} });
  assert.equal(session.resolveApproval('nonexistent', { behavior: 'allow', alwaysAllow: 'session' }), false);
});

test('resolveApproval without alwaysAllow does not remember the decision past this one call', async () => {
  const approvalRequests = [];
  const { getOptions, session } = startFakeSession({
    onApprovalRequest: (req) => approvalRequests.push(req),
  });

  const first = getOptions().canUseTool('Bash', { command: 'ls' }, {});
  session.resolveApproval(approvalRequests[0].requestId, { behavior: 'allow', updatedInput: { command: 'ls' } });
  await first;

  getOptions().canUseTool('Bash', { command: 'pwd' }, {});
  assert.equal(approvalRequests.length, 2); // still asked again - no alwaysAllow, nothing remembered
});

test('AskUserQuestion always reaches onApprovalRequest, even in an auto-allow mode', () => {
  const approvalRequests = [];
  const { getOptions } = startFakeSession({
    permissionMode: 'acceptEdits',
    onApprovalRequest: (req) => approvalRequests.push(req),
  });

  // Deliberately not awaited: canUseTool's Promise executor calls
  // onApprovalRequest synchronously before its first await, and this
  // particular call is never resolved (nothing here plays the client's
  // resolveApproval role) - awaiting it would hang the test forever.
  getOptions().canUseTool('AskUserQuestion', { questions: [{ question: 'Which?' }] }, {});
  assert.equal(approvalRequests.length, 1);
  assert.equal(approvalRequests[0].toolName, 'AskUserQuestion');
});

test('a non-AskUserQuestion tool still auto-allows in an auto-allow mode (unchanged behavior)', async () => {
  const approvalRequests = [];
  const { getOptions } = startFakeSession({
    permissionMode: 'acceptEdits',
    onApprovalRequest: (req) => approvalRequests.push(req),
  });

  const result = await getOptions().canUseTool('Bash', { command: 'echo hi' }, {});
  assert.equal(approvalRequests.length, 0);
  assert.deepEqual(result, { behavior: 'allow', updatedInput: { command: 'echo hi' } });
});

// MCP "needs-auth" badge (backlog.md) - session.js's onElicitation handler
// and the elicitation_complete system message that clears it.
test('onElicitation with mode "url" accepts, records the pending auth, and notifies onMcpAuthRequest', async () => {
  const mcpAuthRequests = [];
  const { session, getOptions } = startFakeSession({
    onMcpAuthRequest: (entry) => mcpAuthRequests.push(entry),
  });

  const result = await getOptions().onElicitation({
    serverName: 'github',
    message: 'Please authorize access',
    mode: 'url',
    url: 'https://example.com/oauth/authorize',
    elicitationId: 'elic-1',
  });

  assert.deepEqual(result, { action: 'accept' });
  assert.deepEqual(session.getMcpAuthPending(), [
    { name: 'github', url: 'https://example.com/oauth/authorize', message: 'Please authorize access' },
  ]);
  assert.equal(mcpAuthRequests.length, 1);
  assert.equal(mcpAuthRequests[0].serverName, 'github');
  assert.equal(mcpAuthRequests[0].url, 'https://example.com/oauth/authorize');
});

test('onElicitation declines mode "form" (and any request with no url) rather than hanging - no UI for arbitrary schema forms', async () => {
  const { session, getOptions } = startFakeSession();

  const formResult = await getOptions().onElicitation({
    serverName: 'github',
    message: 'Enter details',
    mode: 'form',
    requestedSchema: { type: 'object' },
  });
  const noUrlResult = await getOptions().onElicitation({
    serverName: 'other',
    message: 'no mode at all',
  });

  assert.deepEqual(formResult, { action: 'decline' });
  assert.deepEqual(noUrlResult, { action: 'decline' });
  assert.deepEqual(session.getMcpAuthPending(), []);
});

test('an elicitation_complete system message clears the matching pending auth and notifies onMcpAuthResolved', async () => {
  const mcpAuthResolved = [];
  const { handle, session, getOptions } = startFakeSession({
    onMcpAuthResolved: (name) => mcpAuthResolved.push(name),
  });

  await getOptions().onElicitation({
    serverName: 'github',
    mode: 'url',
    url: 'https://example.com/oauth/authorize',
    elicitationId: 'elic-1',
  });
  assert.equal(session.getMcpAuthPending().length, 1);

  handle.push({
    type: 'system',
    subtype: 'elicitation_complete',
    mcp_server_name: 'github',
    elicitation_id: 'elic-1',
    session_id: 'sid',
  });
  await flush();

  assert.deepEqual(session.getMcpAuthPending(), []);
  assert.deepEqual(mcpAuthResolved, ['github']);
});
