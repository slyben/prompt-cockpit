// Unit tests for the registry against a stubbed startSession, so no real
// CLI process gets spawned - fast, free, deterministic. session.js itself
// is covered by the manual integration script (see tests/README.md).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../src/session-registry.js';

function fakeWs() {
  return {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(data) {
      this.sent.push(JSON.parse(data));
    },
  };
}

// Mimics session.js's startSession() signature/contract without touching
// the SDK: captures the callbacks so a test can drive them directly.
// `rejectModes` mimics the real SDK rejecting setPermissionMode for modes
// that need session-start-only flags (e.g. bypassPermissions needs
// allowDangerouslySkipPermissions) - see the bug this covers below.
// `usageExperimental`, when provided, is a function stood in for the SDK's
// `Query.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET()` -
// omitted (the default) mimics an SDK build that lacks the method entirely,
// same as `getContextUsage` below it, both of which live under `.query` on
// the real handle (session.js's `{ query: handle, ... }`), not on the
// stubbed handle's own top level.
// `mcpStatus`/`reloadPluginsResult`, when provided, stand in for the real
// SDK responses of the same-named Query methods - omitted (the default)
// still returns a sane empty-ish value rather than throwing, since most
// tests here don't care about MCP/plugin state at all.
function fakeStartSession({ rejectModes = new Set(), usageExperimental, mcpStatus, reloadPluginsResult } = {}) {
  let callbacks;
  let mode = 'default';
  const resolvers = new Map();
  const impl = (opts) => {
    callbacks = opts;
    impl.lastOpts = opts;
    mode = opts.permissionMode || 'default';
    return {
      pushInput: (text) => {
        impl.lastInput = text;
      },
      close: () => {
        impl.closed = true;
      },
      setMode: async (m) => {
        if (rejectModes.has(m)) {
          throw new Error(`Cannot set permission mode to ${m} because the session was not launched with the required flag`);
        }
        mode = m;
        impl.lastSetMode = m;
      },
      getMode: () => mode,
      resolveApproval: (requestId, decision) => {
        const resolve = resolvers.get(requestId);
        if (!resolve) return false;
        resolvers.delete(requestId);
        resolve(decision);
        return true;
      },
      listRewindPoints: async () => impl.rewindPoints || [],
      rewindTo: async (promptIndex) => {
        impl.lastRewindTo = promptIndex;
        return { success: true, target_prompt_index: promptIndex };
      },
      // Every stubbed Query method the registry calls through `handle.query`,
      // regardless of whether a given test cares about it - mirrors the real
      // handle's `{ query: handle, ... }` shape (session.js) so registry
      // functions that reach through `.query` don't need per-test opt-in.
      query: {
        setModel: async (model) => { impl.lastSetModel = model; },
        setEffort: async (effort) => { impl.lastSetEffort = effort; },
        supportedModels: async () => [],
        setMaxThinkingTokens: async (maxThinkingTokens, thinkingDisplay) => { impl.lastSetMaxThinkingTokens = { maxThinkingTokens, thinkingDisplay }; },
        supportedCommands: async () => [],
        supportedAgents: async () => [],
        mcpServerStatus: async () => mcpStatus || [],
        toggleMcpServer: async (name, enabled) => {
          impl.lastMcpToggle = { name, enabled };
        },
        reconnectMcpServer: async (name) => {
          impl.lastMcpReconnect = name;
        },
        reloadPlugins: async () => reloadPluginsResult || { commands: [], agents: [], plugins: [], mcpServers: [], error_count: 0 },
        setPluginEnabled: async (pluginKey, enabled) => {
          impl.lastPluginEnabled = { pluginKey, enabled };
        },
        ...(usageExperimental
          ? { usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: (...args) => { impl.usageExperimentalCalls = (impl.usageExperimentalCalls || 0) + 1; return usageExperimental(...args); } }
          : {}),
      },
    };
  };
  impl.emitMessage = (msg) => callbacks.onMessage(msg);
  impl.emitState = (state) => callbacks.onStateChange(state);
  impl.emitError = (err) => callbacks.onError(err);
  // Mirrors session.js's canUseTool routing for ExitPlanMode: registers a
  // pending resolver and fires onApprovalRequest, same as the real thing.
  impl.emitApprovalRequest = (input) => {
    const requestId = `req-${resolvers.size}`;
    const decision = new Promise((resolve) => resolvers.set(requestId, resolve));
    callbacks.onApprovalRequest({ requestId, toolName: 'ExitPlanMode', input, title: 'Exit plan mode?' });
    return decision;
  };
  return impl;
}

test('createSession issues a token that checkToken accepts, and only that token', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  assert.equal(registry.checkToken(row.id, row.token), true);
  assert.equal(registry.checkToken(row.id, 'wrong-token'), false);
  assert.equal(registry.checkToken('unknown-id', row.token), false);
});

test('attachClient sends hello then replays buffered messages', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  startSessionImpl.emitMessage({ type: 'system', subtype: 'init', session_id: 'abc' });

  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  assert.equal(ws.sent[0].type, 'cockpit:hello');
  assert.equal(ws.sent[1].type, 'sdk:message');
  assert.equal(ws.sent[1].message.subtype, 'init');
});

test('claudeSessionId on the row tracks message.session_id as messages arrive', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  startSessionImpl.emitMessage({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  assert.equal(registry.get(row.id).claudeSessionId, 'sess-1');
});

test('an assistant message with usage broadcasts cockpit:usage with running cost/token totals', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  startSessionImpl.emitMessage({
    type: 'assistant',
    message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } },
  });

  const usageMsgs = ws.sent.filter((m) => m.type === 'cockpit:usage');
  assert.ok(usageMsgs.length >= 1);
  const last = usageMsgs.at(-1);
  assert.equal(last.usage.inputTokens, 1000);
  assert.equal(last.usage.outputTokens, 500);
  assert.ok(last.usage.costUsd > 0);
});

test('attachClient sends a zeroed cockpit:usage snapshot even before any assistant message arrives', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const usageMsg = ws.sent.find((m) => m.type === 'cockpit:usage');
  assert.ok(usageMsg);
  assert.equal(usageMsg.usage.costUsd, 0);
  assert.equal(usageMsg.context, null);
});

test('a finished turn fetches plan rate limits via the experimental usage API and broadcasts them', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession({
    usageExperimental: async () => ({
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 42, resets_at: '2026-08-14T20:00:00Z' } },
    }),
  });
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  startSessionImpl.emitMessage({ type: 'result', num_turns: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0)); // refreshRateLimits is fire-and-forget from handleMessage

  const last = ws.sent.filter((m) => m.type === 'cockpit:usage').at(-1);
  assert.equal(last.rateLimits.five_hour.utilization, 42);
  assert.equal(startSessionImpl.usageExperimentalCalls, 1);
});

// This one must run after the success case above and not be followed by
// another test relying on a fresh rate-limits fetch - the "broken" flag it
// trips is process-wide (module-level in session-registry.js, not reset by
// registry._reset()), same as the real thing: the experimental method
// either exists on this SDK build or it doesn't, so one failure means every
// session's calls fail identically for the rest of this process's life.
test('a rejected rate-limits call is flagged broken permanently, and does not affect cost/token tracking', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession({
    usageExperimental: async () => {
      throw new Error('method renamed in a newer SDK build');
    },
  });
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  startSessionImpl.emitMessage({ type: 'result', num_turns: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startSessionImpl.usageExperimentalCalls, 1);
  assert.equal(ws.sent.filter((m) => m.type === 'cockpit:usage').at(-1).rateLimits, null);

  // A second finished turn must not retry the now-known-broken API.
  startSessionImpl.emitMessage({ type: 'result', num_turns: 1 });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(startSessionImpl.usageExperimentalCalls, 1); // still 1 - short-circuited, not retried

  // Cost/token tracking is a separate code path (usage.js's accumulator,
  // fed directly off the message stream) and keeps working regardless.
  startSessionImpl.emitMessage({
    type: 'assistant',
    message: { model: 'claude-sonnet-5', usage: { input_tokens: 200, output_tokens: 100 } },
  });
  const last = ws.sent.filter((m) => m.type === 'cockpit:usage').at(-1);
  assert.equal(last.usage.inputTokens, 200);
  assert.equal(last.rateLimits, null);
});

test('an unpriced model accumulates tokens but is flagged rather than silently costed at $0', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  startSessionImpl.emitMessage({
    type: 'assistant',
    message: { model: 'some-future-model', usage: { input_tokens: 10, output_tokens: 5 } },
  });

  const last = ws.sent.filter((m) => m.type === 'cockpit:usage').at(-1);
  assert.equal(last.usage.costUsd, 0);
  assert.deepEqual(last.usage.unpriced, ['some-future-model']);
});

test('sendInput delegates to the session handle', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  await registry.sendInput(row.id, 'hello there');
  assert.equal(startSessionImpl.lastInput, 'hello there');
});

test('sendInput on an unknown session id rejects instead of throwing synchronously', async () => {
  registry._reset();
  await assert.rejects(() => registry.sendInput('does-not-exist', 'hi'));
});

test('a fresh attach replays every buffered message (event-log.js\'s own tests cover the byte cap/eviction)', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  for (let i = 0; i < 20; i += 1) {
    startSessionImpl.emitMessage({ type: 'result', subtype: 'success', i });
  }
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  const buffered = ws.sent.filter((m) => m.type === 'sdk:message');
  assert.equal(buffered.length, 20);
  assert.equal(buffered[0].message.i, 0);
  assert.equal(buffered[19].message.i, 19);
  // Every replayed event carries a seq the client can echo back as `since`.
  assert.ok(buffered.every((m) => typeof m.seq === 'number'));
});

test('attachClient with `since` replays only the delta, not the whole log again', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  startSessionImpl.emitMessage({ type: 'result', subtype: 'success', i: 0 });
  const firstAttach = fakeWs();
  registry.attachClient(row.id, firstAttach);
  const lastSeq = firstAttach.sent.find((m) => m.type === 'sdk:message').seq;

  startSessionImpl.emitMessage({ type: 'result', subtype: 'success', i: 1 });
  startSessionImpl.emitMessage({ type: 'result', subtype: 'success', i: 2 });

  const reconnect = fakeWs();
  registry.attachClient(row.id, reconnect, lastSeq);
  const replayed = reconnect.sent.filter((m) => m.type === 'sdk:message');
  assert.equal(replayed.length, 2);
  assert.deepEqual(replayed.map((m) => m.message.i), [1, 2]);
  assert.equal(reconnect.sent.some((m) => m.type === 'cockpit:gap'), false);
});

test('detachClient stops further broadcasts to that socket', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  registry.detachClient(row.id, ws);
  const before = ws.sent.length;
  startSessionImpl.emitMessage({ type: 'result', subtype: 'success' });
  assert.equal(ws.sent.length, before);
});

test('list() and toSummary() never leak internal fields (token, ws handles)', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  const [summary] = registry.list();
  assert.equal(summary.id, row.id);
  assert.equal('token' in summary, false);
  assert.equal('clients' in summary, false);
  assert.equal('handle' in summary, false);
});

test('createSession defaults mode to "default" and reflects a requested starting mode', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  assert.equal(row.mode, 'default');

  const row2 = registry.createSession({ cwd: '/tmp', permissionMode: 'plan', startSessionImpl: fakeStartSession() });
  assert.equal(row2.mode, 'plan');
});

test('hasFileCheckpointing is true only for a freshly-started session, not a resumed one', () => {
  registry._reset();
  const fresh = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  assert.equal(fresh.hasFileCheckpointing, true);

  // enableFileCheckpointing can't be turned on retroactively (plan
  // Decisions) - a resumed session (terminal-started or a prior cockpit
  // run) has no snapshots for its earlier turns, so this must be false
  // regardless of what the live process is passed.
  const resumed = registry.createSession({ cwd: '/tmp', resume: 'some-claude-session-id', startSessionImpl: fakeStartSession() });
  assert.equal(resumed.hasFileCheckpointing, false);
});

test('createSession defaults provider to claude; grok disables file checkpointing', () => {
  registry._reset();
  const claude = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  assert.equal(claude.provider, 'claude');
  assert.equal(registry.toSummary(claude).provider, 'claude');

  const grok = registry.createSession({ cwd: '/tmp', provider: 'grok', startSessionImpl: fakeStartSession() });
  assert.equal(grok.provider, 'grok');
  assert.equal(grok.hasFileCheckpointing, false);
  assert.equal(registry.toSummary(grok).provider, 'grok');
  assert.equal(registry.toSummary(grok).capabilities.mcpToggle, true);
  assert.equal(registry.toSummary(claude).capabilities.mcpToggle, true);
});

test('rewind() on grok maps turnIndex to a rewind point and does not call Claude fork', async () => {
  registry._reset();
  const impl = fakeStartSession();
  impl.rewindPoints = [
    { prompt_index: 0 },
    { prompt_index: 2 },
  ];
  const row = registry.createSession({ cwd: '/tmp', provider: 'grok', resume: 'grok-sess', history: [], startSessionImpl: impl });
  const dry = await registry.rewind(row.id, 2, { dryRun: true });
  assert.equal(dry.filesResult.promptIndex, 2);
  assert.equal(dry.forkedSessionId, null);
  assert.equal(impl.lastRewindTo, undefined);

  const live = await registry.rewind(row.id, 2);
  assert.equal(impl.lastRewindTo, 2);
  assert.equal(live.forkedSessionId, 'grok-sess');
  assert.equal(live.filesResult.conversationOnly, true);
  assert.equal(impl.closed, true);
  assert.equal(registry.get(row.id), undefined);
});

test('setHandlePluginEnabled passes through to the grok handle', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', provider: 'grok', startSessionImpl: impl });
  await registry.setHandlePluginEnabled(row.id, 'playwright@user', false);
  assert.deepEqual(impl.lastPluginEnabled, { pluginKey: 'playwright@user', enabled: false });
});

test('turnIndexOffset passed to the session handle matches the real user turns already in history', () => {
  // Regression test for the rewind wrong-turn bug: turnCounter (session.js)
  // used to reset to 0 on every resume, so a live turnIndex stopped lining
  // up with rewind.js's resolveTurnUuid, which indexes into the whole
  // persisted transcript. createSession must seed the offset from
  // countRealUserTurns(history), not default to 0 whenever there's a
  // transcript to count.
  registry._reset();
  const fresh = fakeStartSession();
  registry.createSession({ cwd: '/tmp', startSessionImpl: fresh });
  assert.equal(fresh.lastOpts.turnIndexOffset, 0);

  const history = [
    { type: 'user', message: { role: 'user', content: '[MESSAGE FROM NON-USER SOURCE - priming]' } },
    { type: 'user', message: { role: 'user', content: 'turn one' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
    { type: 'user', message: { role: 'user', content: 'turn two' } },
  ];
  const resumed = fakeStartSession();
  registry.createSession({ cwd: '/tmp', resume: 'some-claude-session-id', history, startSessionImpl: resumed });
  assert.equal(resumed.lastOpts.turnIndexOffset, 2);
});

test('turnIndexUnreliable is set only when a resume was requested and history came back null (fetch failed), not on a genuinely empty transcript', () => {
  registry._reset();

  // No resume at all: turnIndexOffset really is 0, nothing unreliable.
  const fresh = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  assert.equal(fresh.turnIndexUnreliable, false);

  // Resumed, and the transcript fetch failed (server.js's `.catch(() => null)`
  // path) - history is null. This is the dangerous case: without this flag,
  // turnIndexOffset silently defaults to 0 and rewind mistargets with no
  // error surfaced.
  const failedFetch = registry.createSession({ cwd: '/tmp', resume: 'some-id', history: null, startSessionImpl: fakeStartSession() });
  assert.equal(failedFetch.turnIndexUnreliable, true);

  // Resumed, but the fetch succeeded and genuinely came back empty (a
  // session that only ever had the priming sentinel) - offset 0 here is
  // correct, not a failure, so this must NOT be flagged.
  const genuinelyEmpty = registry.createSession({ cwd: '/tmp', resume: 'some-id', history: [], startSessionImpl: fakeStartSession() });
  assert.equal(genuinelyEmpty.turnIndexUnreliable, false);
});

test('rewind() refuses to run on a session flagged turnIndexUnreliable, rather than mistargeting silently', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', resume: 'some-id', history: null, startSessionImpl: impl });
  impl.emitMessage({ type: 'system', subtype: 'init', session_id: 'some-id' }); // sets row.claudeSessionId, same as a real init would
  assert.equal(row.turnIndexUnreliable, true);

  await assert.rejects(() => registry.rewind(row.id, 1), /turn numbering cannot be trusted/);
});

test('a system/status message with a new permissionMode updates row.mode and broadcasts it, not just session.js\'s private state', () => {
  // Regression test: the CLI can leave the mode it was started/set in (e.g.
  // accepting a plan exits `plan`) without any setPermissionMode() call
  // from the cockpit. Previously only session.js's own currentMode learned
  // this - row.mode (and every client's mode button) stayed stale, so the
  // next Shift+Tab computed its target off the wrong mode.
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', permissionMode: 'plan', startSessionImpl: impl });
  assert.equal(row.mode, 'plan');

  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent = [];

  impl.emitMessage({ type: 'system', subtype: 'status', status: null, permissionMode: 'default' });

  assert.equal(row.mode, 'default');
  const stateMsg = ws.sent.find((m) => m.type === 'cockpit:state');
  assert.ok(stateMsg, 'expected a cockpit:state broadcast');
  assert.equal(stateMsg.session.mode, 'default');
});

test('setPermissionMode updates the row and broadcasts the new mode', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  await registry.setPermissionMode(row.id, 'acceptEdits');

  assert.equal(registry.get(row.id).mode, 'acceptEdits');
  const last = ws.sent.at(-1);
  assert.equal(last.type, 'cockpit:state');
  assert.equal(last.session.mode, 'acceptEdits');
});

test('setPermissionMode on an unknown session id rejects', async () => {
  registry._reset();
  await assert.rejects(() => registry.setPermissionMode('does-not-exist', 'plan'));
});

// Regression test: bypassPermissions rejected server-side (real cause -
// SDK needs allowDangerouslySkipPermissions set at session start, only
// fixed by always passing it in session.js) while the row's mode silently
// stayed put and no broadcast went out - exactly what "the mode button
// looks stuck" turned out to be, compounded by the client swallowing the
// fetch error. This locks down the registry half of that contract: a
// rejected mode change must never appear to have succeeded.
test('a rejected mode change leaves the row and clients on the prior mode, not silently corrupted', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession({ rejectModes: new Set(['bypassPermissions']) });
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  await assert.rejects(() => registry.setPermissionMode(row.id, 'bypassPermissions'));

  assert.equal(registry.get(row.id).mode, 'default');
  assert.ok(!ws.sent.some((m) => m.type === 'cockpit:state' && m.session.mode === 'bypassPermissions'));
});

test('a plan-mode approval request reaches clients, and accepting it resolves the pending tool call', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const decisionPromise = startSessionImpl.emitApprovalRequest({ plan: 'do the thing' });

  const requestMsg = ws.sent.find((m) => m.type === 'cockpit:approval-request');
  assert.ok(requestMsg, 'client should have received cockpit:approval-request');
  assert.equal(requestMsg.request.toolName, 'ExitPlanMode');
  assert.equal(requestMsg.request.input.plan, 'do the thing');

  const resolved = registry.resolveApproval(row.id, requestMsg.request.requestId, { behavior: 'allow' });
  assert.equal(resolved, true);
  assert.deepEqual(await decisionPromise, { behavior: 'allow' });
});

test('resolveApproval on an unknown request id or session returns false rather than throwing', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  assert.equal(registry.resolveApproval(row.id, 'no-such-request', { behavior: 'deny' }), false);
  assert.equal(registry.resolveApproval('no-such-session', 'no-such-request', { behavior: 'deny' }), false);
});

test('createSession with no history: hasEarlierHistory is false and the buffer starts empty', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  assert.equal(ws.sent.find((m) => m.type === 'cockpit:hello').session.hasEarlierHistory, false);
  assert.equal(ws.sent.filter((m) => m.type === 'sdk:message').length, 0);
});

test('createSession with a small history seeds the whole thing and reports no earlier history left', () => {
  registry._reset();
  const history = [
    { type: 'user', message: { role: 'user', content: 'first' } },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'reply' }] } },
  ];
  const row = registry.createSession({ cwd: '/tmp', history, startSessionImpl: fakeStartSession() });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const buffered = ws.sent.filter((m) => m.type === 'sdk:message');
  assert.equal(buffered.length, 2);
  assert.equal(buffered[0].message.message.content, 'first');
  assert.equal(ws.sent.find((m) => m.type === 'cockpit:hello').session.hasEarlierHistory, false);
});

test('createSession with history exceeding the token budget seeds only the tail and reports earlier history available', () => {
  registry._reset();
  // Each entry is comfortably over 1M estimated tokens on its own (chars/4),
  // so only the single most recent one fits the initial tail.
  const big = (n) => ({ type: 'user', message: { role: 'user', content: 'x'.repeat(n) } });
  const history = [big(6_000_000), big(6_000_000)];
  const row = registry.createSession({ cwd: '/tmp', history, startSessionImpl: fakeStartSession() });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const buffered = ws.sent.filter((m) => m.type === 'sdk:message');
  assert.equal(buffered.length, 1); // only the tail (most recent) message shown initially
  assert.equal(ws.sent.find((m) => m.type === 'cockpit:hello').session.hasEarlierHistory, true);
});

test('getMcpServerStatus passes through the SDK\'s server list', async () => {
  registry._reset();
  const mcpStatus = [{ name: 'my-server', status: 'connected' }];
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession({ mcpStatus }) });
  const result = await registry.getMcpServerStatus(row.id);
  assert.deepEqual(result, mcpStatus);
});

test('getMcpServerStatus on an unknown session id rejects instead of throwing synchronously', async () => {
  registry._reset();
  await assert.rejects(() => registry.getMcpServerStatus('does-not-exist'));
});

test('setMaxThinkingTokens calls through to the SDK, updates the row, and broadcasts to connected tabs', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent = []; // drop the initial hello/state noise

  await registry.setMaxThinkingTokens(row.id, 10000, 'summarized');
  assert.deepEqual(startSessionImpl.lastSetMaxThinkingTokens, { maxThinkingTokens: 10000, thinkingDisplay: 'summarized' });
  const broadcast = ws.sent.find((m) => m.type === 'cockpit:state');
  assert.ok(broadcast, 'expected a cockpit:state broadcast after setting the thinking budget');
  assert.equal(broadcast.session.maxThinkingTokens, 10000);
  assert.equal(broadcast.session.thinkingDisplay, 'summarized');

  // Clearing back to null (off) round-trips the same way.
  ws.sent = [];
  await registry.setMaxThinkingTokens(row.id, null, null);
  assert.deepEqual(startSessionImpl.lastSetMaxThinkingTokens, { maxThinkingTokens: null, thinkingDisplay: null });
  assert.equal(ws.sent.find((m) => m.type === 'cockpit:state').session.maxThinkingTokens, null);
});

test('toggleMcpServer calls through to the SDK and broadcasts to connected tabs', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent = []; // drop the initial hello/state noise

  await registry.toggleMcpServer(row.id, 'my-server', false);
  assert.deepEqual(startSessionImpl.lastMcpToggle, { name: 'my-server', enabled: false });
  assert.ok(ws.sent.some((m) => m.type === 'cockpit:state'), 'expected a cockpit:state broadcast after toggle');
});

test('reconnectMcpServer calls through to the SDK and broadcasts to connected tabs', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent = [];

  await registry.reconnectMcpServer(row.id, 'my-server');
  assert.equal(startSessionImpl.lastMcpReconnect, 'my-server');
  assert.ok(ws.sent.some((m) => m.type === 'cockpit:state'), 'expected a cockpit:state broadcast after reconnect');
});

test('reloadPlugins passes through the SDK\'s refreshed components', async () => {
  registry._reset();
  const reloadPluginsResult = { commands: [], agents: [], plugins: [{ name: 'formatter', source: 'anthropic-tools' }], mcpServers: [], error_count: 0 };
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession({ reloadPluginsResult }) });
  const result = await registry.reloadPlugins(row.id);
  assert.deepEqual(result, reloadPluginsResult);
});

// Task list reconstruction (TaskCreate/TaskUpdate/TaskList tool calls) -
// there's no SDK query for this, so it's rebuilt purely from watching the
// same tool_use/tool_result messages already flowing through handleMessage.
// A TaskCreate/TaskUpdate/TaskList call is always: an assistant message
// with a tool_use block, followed by a user message with the matching
// tool_result (tool_use_id) - these tests emit both, in that order, same as
// the real SDK would.
function emitToolUse(startSessionImpl, id, name, input) {
  startSessionImpl.emitMessage({
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}
function emitToolResult(startSessionImpl, toolUseId, output, { isError = false } = {}) {
  startSessionImpl.emitMessage({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: JSON.stringify(output) }] },
  });
}
// Mirrors the real CLI wire shape for Task* results (confirmed by pulling
// the literal template strings out of the installed claude-agent-sdk CLI
// binary): `content` is always a human-readable summary string ("Task #1
// created successfully: <subject>"), never JSON - the structured payload
// applyTaskOp actually needs rides on the sibling `toolUseResult` field of
// the 'user' message instead. emitToolResult above (JSON.stringify'd into
// `content`) does NOT match this and only exercises the fallback path.
function emitRealToolResult(startSessionImpl, toolUseId, summaryText, toolUseResult, { isError = false } = {}) {
  startSessionImpl.emitMessage({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, is_error: isError, content: summaryText }] },
    toolUseResult,
  });
}

test('todo_write resyncs the task list from its input', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  emitToolUse(startSessionImpl, 'td1', 'todo_write', {
    todos: [
      { id: 'a', content: 'Write tests', status: 'in_progress' },
      { id: 'b', content: 'Ship it', status: 'pending' },
    ],
  });
  emitToolResult(startSessionImpl, 'td1', { ok: true });
  const last = ws.sent.filter((m) => m.type === 'cockpit:tasks').at(-1);
  assert.equal(last.tasks.length, 2);
  assert.equal(last.tasks.find((t) => t.id === 'a').status, 'in_progress');
  assert.equal(last.tasks.find((t) => t.id === 'b').subject, 'Ship it');
});

test('attachClient sends an empty cockpit:tasks snapshot before any task activity', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession() });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const tasksMsg = ws.sent.find((m) => m.type === 'cockpit:tasks');
  assert.ok(tasksMsg);
  assert.deepEqual(tasksMsg.tasks, []);
});

test('TaskCreate broadcasts the new task once its tool_result confirms the id', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent = [];

  emitToolUse(startSessionImpl, 'tu-1', 'TaskCreate', { subject: 'Write tests' });
  assert.equal(ws.sent.filter((m) => m.type === 'cockpit:tasks').length, 0, 'no broadcast until the result lands');

  emitToolResult(startSessionImpl, 'tu-1', { task: { id: 'task-1', subject: 'Write tests' } });

  const last = ws.sent.filter((m) => m.type === 'cockpit:tasks').at(-1);
  assert.ok(last);
  assert.deepEqual(last.tasks, [{ id: 'task-1', subject: 'Write tests', status: 'pending', owner: null, blockedBy: [] }]);
});

test('TaskCreate is picked up from the real CLI wire shape (plain-text content, structured toolUseResult)', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent = [];

  emitToolUse(startSessionImpl, 'tu-1', 'TaskCreate', { subject: 'Write tests' });
  emitRealToolResult(startSessionImpl, 'tu-1', 'Task #task-1 created successfully: Write tests', { task: { id: 'task-1', subject: 'Write tests' } });

  const last = ws.sent.filter((m) => m.type === 'cockpit:tasks').at(-1);
  assert.ok(last, 'toolUseResult must be read even though content is plain text, not JSON');
  assert.deepEqual(last.tasks, [{ id: 'task-1', subject: 'Write tests', status: 'pending', owner: null, blockedBy: [] }]);
});

test('TaskUpdate applies the tool_use input\'s new values, not the result payload', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  emitToolUse(startSessionImpl, 'tu-1', 'TaskCreate', { subject: 'Write tests' });
  emitToolResult(startSessionImpl, 'tu-1', { task: { id: 'task-1', subject: 'Write tests' } });

  emitToolUse(startSessionImpl, 'tu-2', 'TaskUpdate', { taskId: 'task-1', status: 'in_progress', owner: 'agent-a' });
  // TaskUpdateOutput deliberately omits the new field values (only
  // updatedFields, the names) - applyTaskOp has to read them from the
  // tool_use input above, not from this result.
  emitToolResult(startSessionImpl, 'tu-2', { success: true, taskId: 'task-1', updatedFields: ['status', 'owner'] });

  const last = ws.sent.filter((m) => m.type === 'cockpit:tasks').at(-1);
  assert.deepEqual(last.tasks, [{ id: 'task-1', subject: 'Write tests', status: 'in_progress', owner: 'agent-a', blockedBy: [] }]);
});

test('TaskUpdate with status "deleted" removes the task', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  emitToolUse(startSessionImpl, 'tu-1', 'TaskCreate', { subject: 'Scrap this' });
  emitToolResult(startSessionImpl, 'tu-1', { task: { id: 'task-1', subject: 'Scrap this' } });

  emitToolUse(startSessionImpl, 'tu-2', 'TaskUpdate', { taskId: 'task-1', status: 'deleted' });
  emitToolResult(startSessionImpl, 'tu-2', { success: true, taskId: 'task-1', updatedFields: ['status'] });

  const last = ws.sent.filter((m) => m.type === 'cockpit:tasks').at(-1);
  assert.deepEqual(last.tasks, []);
});

test('a failed TaskUpdate (is_error) leaves the task state untouched', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  emitToolUse(startSessionImpl, 'tu-1', 'TaskCreate', { subject: 'Original' });
  emitToolResult(startSessionImpl, 'tu-1', { task: { id: 'task-1', subject: 'Original' } });
  ws.sent = [];

  emitToolUse(startSessionImpl, 'tu-2', 'TaskUpdate', { taskId: 'task-1', status: 'completed' });
  emitToolResult(startSessionImpl, 'tu-2', { success: false, taskId: 'task-1', error: 'boom' }, { isError: true });

  assert.equal(ws.sent.filter((m) => m.type === 'cockpit:tasks').length, 0, 'a failed update should not broadcast a change');
});

test('TaskList result fully resyncs the task list, including dropping a task that no longer appears (deleted elsewhere)', () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  emitToolUse(startSessionImpl, 'tu-1', 'TaskCreate', { subject: 'Stale task' });
  emitToolResult(startSessionImpl, 'tu-1', { task: { id: 'task-1', subject: 'Stale task' } });

  emitToolUse(startSessionImpl, 'tu-2', 'TaskList', {});
  emitToolResult(startSessionImpl, 'tu-2', {
    tasks: [{ id: 'task-2', subject: 'Fresh from resync', status: 'in_progress', owner: null, blockedBy: ['task-3'] }],
  });

  const last = ws.sent.filter((m) => m.type === 'cockpit:tasks').at(-1);
  assert.deepEqual(last.tasks, [{ id: 'task-2', subject: 'Fresh from resync', status: 'in_progress', owner: null, blockedBy: ['task-3'] }]);
});

// B10: a resumed session's replayed history is only ever appendEvent'd
// straight into the event log for display (createSession's `tail` loop) -
// it never went through handleMessage, so a TaskCreate/TaskUpdate from
// before the current browser attach used to leave row.tasks empty and the
// toggle button never appeared, even though the calls are right there in
// the transcript. createSession must reconstruct row.tasks from the full
// `history` it's handed, same as it reconstructs turnIndexOffset.
test('resuming a session seeds row.tasks from history, not just live tool calls', () => {
  registry._reset();
  const history = [
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-1', name: 'TaskCreate', input: { subject: 'From before this attach' } }] } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-1', is_error: false, content: 'Task #task-1 created successfully: From before this attach' }] },
      toolUseResult: { task: { id: 'task-1', subject: 'From before this attach' } },
    },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id: 'tu-2', name: 'TaskUpdate', input: { taskId: 'task-1', status: 'completed' } }] } },
    {
      type: 'user',
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu-2', is_error: false, content: 'Updated task #task-1 status' }] },
      toolUseResult: { success: true, taskId: 'task-1', updatedFields: ['status'] },
    },
  ];

  const row = registry.createSession({ cwd: '/tmp', resume: 'some-claude-session-id', history, startSessionImpl: fakeStartSession() });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const tasksMsg = ws.sent.find((m) => m.type === 'cockpit:tasks');
  assert.ok(tasksMsg, 'attachClient must send a cockpit:tasks snapshot even for a resumed session');
  assert.deepEqual(tasksMsg.tasks, [{ id: 'task-1', subject: 'From before this attach', status: 'completed', owner: null, blockedBy: [] }]);
});

// Same B10 shape as the task-seeding test above, for usage: a resumed
// session's replayed history used to leave row.usageAcc at zero and every
// historical message's _usageInfo unset, so the header's running cost total
// under-reported and turn-chart.js's cost graph showed no bars for anything
// before the current attach - reported as "the cost graph is not updated"
// on resume.
test('resuming a session seeds usage totals and per-message _usageInfo from history, not just live messages', () => {
  registry._reset();
  const history = [
    { type: 'assistant', message: { model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } } },
  ];

  const row = registry.createSession({ cwd: '/tmp', resume: 'some-claude-session-id', history, startSessionImpl: fakeStartSession() });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  const usageMsg = ws.sent.find((m) => m.type === 'cockpit:usage');
  assert.ok(usageMsg, 'attachClient must send a cockpit:usage snapshot even for a resumed session');
  assert.equal(usageMsg.usage.inputTokens, 1000);
  assert.equal(usageMsg.usage.outputTokens, 500);
  assert.ok(usageMsg.usage.costUsd > 0);

  // The replayed sdk:message itself must carry _usageInfo too, or the client
  // never calls turnChart.addPoint for it (app.js's hasUsagePoint check) -
  // the header total being right isn't enough on its own to fix the graph.
  const replayed = ws.sent.find((m) => m.type === 'sdk:message');
  assert.ok(replayed, 'the tail must still be replayed to a fresh attach');
  assert.ok(replayed.message._usageInfo, 'the replayed message must carry the same _usageInfo a live message would get');
  assert.equal(replayed.message._usageInfo.inputTokens, 1000);
});
