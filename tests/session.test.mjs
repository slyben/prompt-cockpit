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
    interrupt: async () => {},
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

// Regression test for the "AskUserQuestion doesn't work at all" root cause:
// AUTO_ALLOW_MODES (acceptEdits, bypassPermissions, etc.) used to short-
// circuit every gated tool call, including this one, straight back to the
// model as `updatedInput: input` unmodified - which the tool reads as an
// empty `answers`, i.e. "the user did not answer the questions", with no
// human ever seeing the question. It must always reach onApprovalRequest
// instead, regardless of mode, same as it would in `default`/`plan`.
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
