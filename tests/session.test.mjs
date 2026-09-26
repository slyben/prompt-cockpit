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

// Drives `handle` through what the real SDK always does at session start:
// `system/init`, then the priming sentinel's own result (always
// num_turns:0). createInputQueue's gate now serializes strictly - nothing
// else can reach the CLI, and no pushInput()'s result can be mistaken for
// the sentinel's, until this result comes back - so tests have to simulate
// it explicitly instead of relying on the old pendingTurns===0 proxy, which
// didn't care whether it ever arrived.
async function initHandle(handle) {
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();
  handle.push({ type: 'result', subtype: 'success', num_turns: 0 });
  await flush();
}

// Same shape as fakeQueryHandle, but ALSO actually pulls from `opts.prompt`
// (session.js's real inputQueue) the way the real SDK's Query.streamInput
// does: eagerly, one write per loop iteration, without ever waiting for a
// response to come back first. fakeQueryHandle above deliberately does not
// do this (see its test file comment), which is exactly why the 2026-08-25
// coalescing bug had no coverage - nothing exercised createInputQueue's own
// dispatch gating. `dispatched` records, in order, every value the pump
// actually handed to "the CLI".
function fakeQueryHandleConsuming(prompt) {
  const pending = [];
  const dispatched = [];
  let waiting = null;
  let closed = false;
  const handle = {
    interrupt: async () => { handle.interruptCalls = (handle.interruptCalls || 0) + 1; },
    setPermissionMode: async () => {},
    dispatched,
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
  (async () => {
    for await (const value of prompt) {
      dispatched.push(value);
    }
  })();
  return handle;
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
  await initHandle(handle);

  session.pushInput('first');
  const turnIndexes = () => messages.filter((m) => 'turnIndex' in m).map((m) => m.turnIndex);
  assert.deepEqual(turnIndexes(), [6]);

  session.pushInput('second');
  assert.deepEqual(turnIndexes(), [6, 7]);
});

test('startSession appends the /ask system-prompt anchor to the claude_code preset', () => {
  const { getOptions } = startFakeSession();
  const systemPrompt = getOptions().systemPrompt;
  assert.equal(systemPrompt.type, 'preset');
  assert.equal(systemPrompt.preset, 'claude_code');
  assert.match(systemPrompt.append, /Prompt Cockpit/);
  assert.match(systemPrompt.append, /\/ask/);
});

test('startSession passes an explicit thinking budget to query creation', () => {
  const { getOptions } = startFakeSession({ maxThinkingTokens: 10000 });
  assert.equal(getOptions().maxThinkingTokens, 10000);
});

test('Claude commit guard rejects a commit message outside the scoped format', async () => {
  const { getOptions } = startFakeSession({
    readGitGuardSettingsImpl: async () => ({ mode: 'all', validateCommitMessage: true }),
    validateCommitCommandImpl: async () => ({
      checked: true,
      valid: false,
      reason: 'the title must use "scope: description" format',
    }),
  });
  const options = getOptions();
  const bashHook = options.hooks.PreToolUse.find((entry) => entry.matcher === 'Bash').hooks[0];
  const direct = await bashHook({ tool_input: { command: 'git commit -m "fix"' } });
  assert.equal(direct.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(direct.hookSpecificOutput.permissionDecisionReason, /scoped format/);
});

test('a conversation_reset message (/clear) resets turnIndex back to 1, not the pre-clear offset', async () => {
  // Regression test for the residual rewind edge: /clear starts a fresh
  // conversation, so turnCounter has to restart with it or every rewind
  // button minted afterward indexes against the wrong transcript position.
  const { handle, session, messages } = startFakeSession({ turnIndexOffset: 3 });
  await initHandle(handle);

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
  await initHandle(handle);

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
  await initHandle(handle);

  await session.interrupt();
  assert.equal(handle.interruptCalls, 1);

  // close() is the one that calls inputQueue.close() - interrupt() must not,
  // or a pushInput() right after cancelling a turn would silently no-op
  // instead of starting the next one (see session.js's pushInput() comment
  // on what a closed queue does to a post-close call).
  session.pushInput('still works');
  assert.ok(messages.some((m) => m.turnIndex === 1 && m.message?.content === 'still works'));
});

// Regression test for the "Stop doesn't cancel queued turns" side-find: Stop
// (session.js's interrupt(), the client's Stop button) used to only abort
// the turn currently in flight, leaving anything queued behind it to still
// run right after - not the "stop everything now" a human clicking Stop
// actually expects (mirrors Grok CLI's Esc/Ctrl+C). It must drain the local
// queue too.
test('interrupt() (the Stop button) drains queued turns too, not just the in-flight one', async () => {
  // Needs the consuming fake, not startFakeSession's plain one: that fake
  // never reads opts.prompt at all, so nothing it drives is ever actually
  // "running" vs "queued" from the input queue's own perspective (see
  // fakeQueryHandle's own test-file comment) - this test specifically needs
  // that distinction to exist.
  const messages = [];
  const states = [];
  let handle;
  const session = startSession({
    cwd: '/tmp',
    queryImpl: (opts) => { handle = fakeQueryHandleConsuming(opts.prompt); return handle; },
    onMessage: (msg) => messages.push(msg),
    onStateChange: (s) => states.push(s),
    onError: () => {},
    onApprovalRequest: () => {},
  });
  await initHandle(handle);

  session.pushInput('running turn');
  const id2 = session.pushInput('queued turn');
  assert.equal(session.listQueue().length, 1);
  assert.deepEqual(session.listQueue().map((e) => e.id), [id2]);

  await session.interrupt();

  assert.equal(handle.interruptCalls, 1);
  assert.equal(session.listQueue().length, 0, 'the queued turn must be dropped, not left to run after the interrupt');

  // Only the running turn's own (now-interrupted) result should still be
  // able to affect state - the queued one was already dropped locally, no
  // result will ever come for it.
  handle.push({ type: 'result', subtype: 'success', num_turns: 0, is_error: true });
  await flush();
  assert.equal(states[states.length - 1], 'idle');
  assert.equal(messages.filter((m) => m.type === 'result').length, 1);
});

// Regression test: a turn interrupted early enough (before the model
// produced anything) can come back with num_turns:0, same as the priming
// sentinel. sentinelResolved (not pendingTurns) is what tells them apart.
test('a late result after forceIdle is marked stale and does not decrement a newly pushed turn', async () => {
  const messages = [];
  const states = [];
  let handle;
  const session = startSession({
    cwd: '/tmp',
    queryImpl: (opts) => { handle = fakeQueryHandleConsuming(opts.prompt); return handle; },
    onMessage: (msg) => messages.push(msg),
    onStateChange: (s) => states.push(s),
    onError: () => {},
    onApprovalRequest: () => {},
  });
  await initHandle(handle);

  session.pushInput('abandoned turn');
  await flush();
  assert.equal(states[states.length - 1], 'running');
  session.forceIdle();
  assert.equal(states[states.length - 1], 'idle');
  assert.equal(handle.interruptCalls, 1);

  const secondId = session.pushInput('new turn');
  await flush();
  assert.equal(typeof secondId, 'string');
  assert.equal(states[states.length - 1], 'running');

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'late A' });
  await flush();
  const late = messages.filter((m) => m.type === 'result').at(-1);
  assert.equal(late._cockpitStale, true);
  assert.equal(states[states.length - 1], 'running', 'the new turn is still in flight');

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'B' });
  await flush();
  const live = messages.filter((m) => m.type === 'result').at(-1);
  assert.equal(live._cockpitStale, undefined);
  assert.equal(states[states.length - 1], 'idle');
});

// forceIdle is last-resort unstick, same product as Stop for the local
// tail: those turns were never sent to the CLI, so drop them rather than
// releasing them into the SDK after abandoning the stuck head.
test('forceIdle drains queued turns and goes idle; a late head result is stale', async () => {
  const messages = [];
  const states = [];
  let handle;
  const session = startSession({
    cwd: '/tmp',
    queryImpl: (opts) => { handle = fakeQueryHandleConsuming(opts.prompt); return handle; },
    onMessage: (msg) => messages.push(msg),
    onStateChange: (s) => states.push(s),
    onError: () => {},
    onApprovalRequest: () => {},
  });
  await initHandle(handle);

  session.pushInput('stuck turn');
  await flush();
  const queuedId = session.pushInput('queued turn');
  await flush();
  assert.equal(session.listQueue().length, 1);
  assert.deepEqual(session.listQueue().map((e) => e.id), [queuedId]);

  session.forceIdle();
  assert.equal(session.listQueue().length, 0);
  assert.equal(states[states.length - 1], 'idle');
  assert.equal(session.debugSnapshot().pendingTurns, 0);

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'late stuck-turn result' });
  await flush();
  const late = messages.filter((m) => m.type === 'result').at(-1);
  assert.equal(late._cockpitStale, true);
  assert.equal(states[states.length - 1], 'idle');
});

// Regression test for the 2026-08-25 stuck-spinner root cause: the real
// SDK's input pump re-enters next() the instant it finishes writing a value
// to the CLI's stdin - it does NOT wait for that turn's result - and the
// pinned SDK's own docs confirm the CLI coalesces multiple queued messages
// into a single turn/result when that happens. That silently stranded
// session.js's pendingTurns counter (and the spinner with it) one too high
// forever. The fix gates createInputQueue so a second tracked message is
// held locally until the first one's result arrives, instead of being
// handed to the pump immediately.
test('a second pushInput is held back from the CLI pump until the first turn results, so the CLI can never coalesce them', async () => {
  const messages = [];
  const states = [];
  let handle;
  const session = startSession({
    cwd: '/tmp',
    queryImpl: (opts) => { handle = fakeQueryHandleConsuming(opts.prompt); return handle; },
    onMessage: (msg) => messages.push(msg),
    onStateChange: (s) => states.push(s),
    onError: () => {},
    onApprovalRequest: () => {},
  });

  await initHandle(handle);

  // Only the untracked startup sentinel (empty content) should have reached
  // "the CLI" so far.
  const trackedDispatched = () => handle.dispatched.filter((m) => m.message?.content !== '');
  assert.equal(trackedDispatched().length, 0);

  session.pushInput('first');
  await flush();
  session.pushInput('second');
  await flush();

  // Without the gate, both would already be sitting in the CLI's own queue
  // here - exactly the state that let it coalesce them into one result.
  assert.equal(trackedDispatched().length, 1);
  assert.equal(trackedDispatched()[0].message.content, 'first');

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'A' });
  await flush();

  // 'first' resolving is what releases 'second' to the pump - not before.
  assert.equal(trackedDispatched().length, 2);
  assert.equal(trackedDispatched()[1].message.content, 'second');
  assert.equal(states[states.length - 1], 'running', 'second turn is still in flight');

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'B' });
  await flush();
  assert.equal(states[states.length - 1], 'idle');
});

// Regression test: bug report was "the queued message never disappears from
// the panel" - it DID start running (the assertions above already cover
// that dispatch), but nothing told onQueueChange, so a client watching the
// queue panel kept showing an entry that was no longer actually queued,
// with no way to tell that apart from one still genuinely waiting (Drop
// looks like it does nothing, because by the time it's clicked there really
// is nothing left in `pending` to remove).
test('a queued turn advancing via the normal result-pump path (not removeQueued) still broadcasts the shrunk queue', async () => {
  const queueSnapshots = [];
  let handle;
  const session = startSession({
    cwd: '/tmp',
    queryImpl: (opts) => { handle = fakeQueryHandleConsuming(opts.prompt); return handle; },
    onMessage: () => {},
    onStateChange: () => {},
    onError: () => {},
    onApprovalRequest: () => {},
    onQueueChange: (queue) => queueSnapshots.push(queue),
  });
  await initHandle(handle);

  session.pushInput('running turn');
  const queuedId = session.pushInput('queued turn');
  await flush();
  assert.deepEqual(queueSnapshots.at(-1).map((e) => e.id), [queuedId], 'push itself must broadcast the queued entry');

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'A' });
  await flush();

  assert.equal(session.listQueue().length, 0, 'the queued turn has already been pumped out and is now running');
  assert.deepEqual(queueSnapshots.at(-1), [], 'onQueueChange must fire again once the result-pump advances the queue, not just on explicit drop/reorder/send-now');
});

// Regression test for the inverse side-find: the OLD sentinel check
// (`num_turns === 0 && pendingTurns === 0`) misread a delayed sentinel
// result as the real turn's own result the instant pendingTurns had already
// gone back to >0 elsewhere - here, simulated by pushing a real turn BEFORE
// the sentinel's own result arrives. That used to flip state to 'idle' (and
// forward the empty sentinel payload via onMessage) while the real turn was
// still genuinely running. `sentinelResolved` is identity-based, not a
// pendingTurns proxy, so it must still recognize and swallow the delayed
// sentinel result no matter what pendingTurns says by the time it shows up.
test('a delayed sentinel result is still swallowed even after a real turn is already pending', async () => {
  const { handle, session, messages, states } = startFakeSession();
  handle.push({ type: 'system', subtype: 'init', permissionMode: 'default', session_id: 's1' });
  await flush();

  session.pushInput('real turn');
  assert.equal(states[states.length - 1], 'running');

  // The sentinel's own result, arriving late - pendingTurns is already 1
  // here, not 0, which is exactly what defeated the old check.
  handle.push({ type: 'result', subtype: 'success', num_turns: 0 });
  await flush();
  assert.equal(states[states.length - 1], 'running', 'must not be mistaken for the real turn finishing');
  assert.equal(messages.filter((m) => m.type === 'result').length, 0);

  handle.push({ type: 'result', subtype: 'success', num_turns: 1, result: 'real' });
  await flush();
  assert.equal(states[states.length - 1], 'idle');
  assert.equal(messages.filter((m) => m.type === 'result').length, 1);
});

test('a real turn interrupted before producing anything (num_turns:0) still settles state back to idle', async () => {
  const { handle, session, messages, states } = startFakeSession();
  await initHandle(handle);

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

// MCP "needs-auth" badge - session.js's onElicitation handler
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
