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
// `withMcpAuthPending`, when true, gives the stub's handle a
// getMcpAuthPending() (mirrors session.js's own real one) so
// getMcpServerStatus's authUrl-merge logic has something to merge -
// omitted (the default) mimics grok-session.js's handle, which has no such
// method at all (session-registry.js's typeof guard is what this is for).
function fakeStartSession({ rejectModes = new Set(), usageExperimental, mcpStatus, reloadPluginsResult, withMcpAuthPending = false } = {}) {
  let callbacks;
  let mode = 'default';
  const resolvers = new Map();
  let mcpAuthPending = [];
  const impl = (opts) => {
    callbacks = opts;
    impl.lastOpts = opts;
    mode = opts.permissionMode || 'default';
    return {
      ...(withMcpAuthPending ? { getMcpAuthPending: () => mcpAuthPending } : {}),
      pushInput: (text) => {
        impl.lastInput = text;
        impl.allInputs = impl.allInputs || [];
        impl.allInputs.push(text);
        // MVP5: mirrors session.js's pushInput now returning a queueId so
        // registry.js's pendingResultTags/removeQueued/reorderQueue/sendNow
        // mirroring logic has something real to key off in tests.
        impl.allQueueIds = impl.allQueueIds || [];
        const queueId = `q-${impl.allQueueIds.length}`;
        impl.allQueueIds.push(queueId);
        return queueId;
      },
      close: () => {
        impl.closed = true;
      },
      interrupt: async () => {
        impl.interrupted = (impl.interrupted || 0) + 1;
      },
      // Mirrors session.js's real forceIdle: pure local bookkeeping reset,
      // no CLI call, but it does fire onStateChange('idle') same as the
      // real one so a test can assert the row.state flip that rides in on
      // it (registry.forceIdle's own comment).
      forceIdle: () => {
        impl.forceIdleCalls = (impl.forceIdleCalls || 0) + 1;
        callbacks.onStateChange('idle');
      },
      listQueue: () => impl.queue || [],
      removeQueued: (queueId) => {
        impl.lastRemoveQueued = queueId;
        return impl.removeQueuedResult ?? true;
      },
      reorderQueue: (queueIds) => {
        impl.lastReorderQueue = queueIds;
      },
      sendNow: async (queueId) => {
        impl.lastSendNow = queueId;
        return impl.sendNowResult ?? true;
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
      forkAt: async (promptIndex) => {
        impl.lastForkAt = promptIndex;
        return { newSessionId: impl.forkedSessionId || 'grok-fork-1' };
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
  // Mirrors session.js's onElicitation/elicitation_complete handling
  // (mcpAuthPending Map -> getMcpAuthPending()) without going through a
  // real onElicitation call - same "call the callback directly" shape as
  // emitApprovalRequest above.
  impl.emitMcpAuthRequest = ({ serverName, url, message }) => {
    mcpAuthPending = [...mcpAuthPending.filter((p) => p.name !== serverName), { name: serverName, url, message }];
    callbacks.onMcpAuthRequest?.({ serverName, url, message });
  };
  impl.emitMcpAuthResolved = (serverName) => {
    mcpAuthPending = mcpAuthPending.filter((p) => p.name !== serverName);
    callbacks.onMcpAuthResolved?.(serverName);
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

test('interruptTurn delegates to the session handle and broadcasts', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  await registry.interruptTurn(row.id);
  assert.equal(startSessionImpl.interrupted, 1);
});

test('interruptTurn on an unknown session id rejects instead of throwing synchronously', async () => {
  registry._reset();
  await assert.rejects(() => registry.interruptTurn('does-not-exist'));
});

test('forceIdle resets the handle and flips row.state back to idle even with no real result coming', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  await registry.sendInput(row.id, 'hello'); // real handle stub doesn't drive onStateChange itself - set directly, same as toSummary's pendingTurnsCount comment describes
  row.state = 'running';
  await registry.forceIdle(row.id);
  assert.equal(startSessionImpl.forceIdleCalls, 1);
  assert.equal(row.state, 'idle');
});

test('forceIdle clears pendingResultTags and fails any delegation still waiting on this row, same as closeSession does', async () => {
  registry._reset();
  const originImpl = fakeStartSession();
  const origin = registry.createSession({ cwd: '/tmp', startSessionImpl: originImpl });
  const targetImpl = fakeStartSession();
  const target = registry.createSession({ cwd: '/tmp', name: 'Target', startSessionImpl: targetImpl });
  registry.delegateTask(origin.id, 'Target', 'do the thing');
  assert.equal(target.pendingResultTags.length, 1);
  await registry.forceIdle(target.id);
  assert.equal(target.pendingResultTags.length, 0);
  const relayed = originImpl.allInputs.find((t) => t.includes('ERROR:') && t.includes('was manually unstuck'));
  assert.ok(relayed, 'origin should have received a failure relay instead of waiting forever');
});

test('forceIdle on an unknown session id rejects instead of throwing synchronously', async () => {
  registry._reset();
  await assert.rejects(() => registry.forceIdle('does-not-exist'));
});

test('listQueue/removeQueued/reorderQueue/sendNow all delegate to the session handle', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });

  assert.deepEqual(registry.listQueue(row.id), []);

  assert.equal(await registry.removeQueued(row.id, 'q1'), true);
  assert.equal(startSessionImpl.lastRemoveQueued, 'q1');

  await registry.reorderQueue(row.id, ['q2', 'q1']);
  assert.deepEqual(startSessionImpl.lastReorderQueue, ['q2', 'q1']);

  assert.equal(await registry.sendNow(row.id, 'q2'), true);
  assert.equal(startSessionImpl.lastSendNow, 'q2');

  assert.throws(() => registry.listQueue('does-not-exist'));
  await assert.rejects(() => registry.removeQueued('does-not-exist', 'q1'));
  await assert.rejects(() => registry.reorderQueue('does-not-exist', []));
  await assert.rejects(() => registry.sendNow('does-not-exist', 'q1'));
});

test('a live onQueueChange push broadcasts cockpit:queue to attached clients', async () => {
  registry._reset();
  const startSessionImpl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);
  ws.sent.length = 0; // clear the initial hello/replay/usage/tasks/queue burst

  startSessionImpl.lastOpts.onQueueChange([{ id: 'q1', text: 'queued turn' }]);
  const queueMsg = ws.sent.find((m) => m.type === 'cockpit:queue');
  assert.ok(queueMsg);
  assert.deepEqual(queueMsg.queue, [{ id: 'q1', text: 'queued turn' }]);
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
  const grokCaps = registry.toSummary(grok).capabilities;
  const claudeCaps = registry.toSummary(claude).capabilities;
  assert.equal(claudeCaps.fileRewind, true);
  assert.equal(claudeCaps.thinkingBudget, true);
  assert.equal(claudeCaps.effort, false);
  assert.equal(claudeCaps.autoContinue, true);
  assert.equal(claudeCaps.mcpToggle, true);
  assert.equal(grokCaps.fileRewind, false);
  assert.equal(grokCaps.thinkingBudget, false);
  assert.equal(grokCaps.effort, true);
  assert.equal(grokCaps.autoContinue, false);
  assert.equal(grokCaps.mcpToggle, true);
});

test('rewind() on grok forks a new session and leaves the original running', async () => {
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
  assert.equal(impl.lastForkAt, undefined);

  const live = await registry.rewind(row.id, 2);
  assert.equal(impl.lastForkAt, 2);
  assert.equal(live.forkedSessionId, 'grok-fork-1');
  assert.equal(live.filesResult.conversationOnly, true);
  assert.equal(impl.closed, undefined);
  assert.equal(registry.get(row.id), row);
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

test('loadEarlierHistory fetches grok history for grok sessions and Claude history otherwise', async () => {
  registry._reset();
  const grokCalls = [];
  const grok = registry.createSession({
    cwd: '/tmp',
    provider: 'grok',
    resume: 'grok-sess',
    history: [{ type: 'user', message: { role: 'user', content: 'tail' } }],
    startSessionImpl: fakeStartSession(),
  });
  const earlier = await registry.loadEarlierHistory(grok.id, async (sessionId, cwd) => {
    grokCalls.push({ sessionId, cwd });
    return [
      { type: 'user', message: { role: 'user', content: 'old' } },
      { type: 'user', message: { role: 'user', content: 'tail' } },
    ];
  });
  assert.deepEqual(grokCalls, [{ sessionId: 'grok-sess', cwd: '/tmp' }]);
  assert.equal(earlier.length, 1);
  assert.equal(earlier[0].message.content, 'old');

  const claudeCalls = [];
  const claude = registry.createSession({
    cwd: '/tmp',
    resume: 'claude-sess',
    history: [{ type: 'user', message: { role: 'user', content: 'tail' } }],
    startSessionImpl: fakeStartSession(),
  });
  await registry.loadEarlierHistory(claude.id, async (sessionId, cwd) => {
    claudeCalls.push({ sessionId, cwd });
    return [{ type: 'user', message: { role: 'user', content: 'tail' } }];
  });
  assert.deepEqual(claudeCalls, [{ sessionId: 'claude-sess', cwd: '/tmp' }]);
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

// MCP "needs-auth" badge (backlog.md).
test('getMcpServerStatus merges authUrl/authMessage from session.js\'s onElicitation into the matching server, leaving others untouched', async () => {
  registry._reset();
  const mcpStatus = [
    { name: 'github', status: 'needs-auth' },
    { name: 'other-server', status: 'connected' },
  ];
  const startSessionImpl = fakeStartSession({ mcpStatus, withMcpAuthPending: true });
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });

  startSessionImpl.emitMcpAuthRequest({ serverName: 'github', url: 'https://example.com/authorize', message: 'Please authorize' });

  const result = await registry.getMcpServerStatus(row.id);
  assert.deepEqual(result, [
    { name: 'github', status: 'needs-auth', authUrl: 'https://example.com/authorize', authMessage: 'Please authorize' },
    { name: 'other-server', status: 'connected' },
  ]);
});

test('getMcpServerStatus on a Grok session (no getMcpAuthPending) still passes through cleanly, unmerged', async () => {
  registry._reset();
  const mcpStatus = [{ name: 'my-server', status: 'needs-auth' }];
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession({ mcpStatus }) }); // withMcpAuthPending defaults false
  const result = await registry.getMcpServerStatus(row.id);
  assert.deepEqual(result, mcpStatus); // no authUrl - nothing to merge in
});

test('onMcpAuthRequest and onMcpAuthResolved each push a fresh cockpit:mcp-auth to attached clients', async () => {
  registry._reset();
  const mcpStatus = [{ name: 'github', status: 'needs-auth' }];
  const startSessionImpl = fakeStartSession({ mcpStatus, withMcpAuthPending: true });
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl });
  const ws = fakeWs();
  registry.attachClient(row.id, ws);

  startSessionImpl.emitMcpAuthRequest({ serverName: 'github', url: 'https://example.com/authorize', message: 'Please authorize' });
  await new Promise((resolve) => setTimeout(resolve, 0)); // broadcastMcpAuth awaits getMcpServerStatus before sending

  let pushed = ws.sent.filter((m) => m.type === 'cockpit:mcp-auth');
  assert.equal(pushed.length, 1);
  assert.equal(pushed[0].servers[0].authUrl, 'https://example.com/authorize');

  startSessionImpl.emitMcpAuthResolved('github');
  await new Promise((resolve) => setTimeout(resolve, 0));

  pushed = ws.sent.filter((m) => m.type === 'cockpit:mcp-auth');
  assert.equal(pushed.length, 2);
  assert.equal(pushed[1].servers[0].authUrl, undefined); // cleared - pending auth resolved
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

// MVP5 cross-session delegation (backlog.md) - findByName is the addressing
// primitive `/ask <Name>: ...` resolves against: case-insensitive within a
// cwd, never matches across cwds or against an unnamed row.
test('findByName matches case-insensitively within a cwd, and never across cwds or against an unnamed row', () => {
  registry._reset();
  registry.createSession({ cwd: '/tmp/a', name: 'Grok', startSessionImpl: fakeStartSession() });
  registry.createSession({ cwd: '/tmp/a', startSessionImpl: fakeStartSession() }); // unnamed
  registry.createSession({ cwd: '/tmp/b', name: 'Grok', startSessionImpl: fakeStartSession() });

  const found = registry.findByName('/tmp/a', 'grok');
  assert.ok(found, 'lookup must be case-insensitive');
  assert.equal(found.cwd, '/tmp/a');

  assert.equal(registry.findByName('/tmp/a', 'GROK'), found, 'must match regardless of case on either side');
  assert.equal(registry.findByName('/tmp/does-not-exist', 'Grok'), null, 'must not match across cwds');
  assert.equal(registry.findByName('/tmp/a', ''), null, 'an empty name must never match');
  assert.equal(registry.findByName('/tmp/a', '   '), null, 'a whitespace-only name must never match');
});

test('delegateTask pushes the task into the named target session and throws on unknown name, self-delegation, or a cross-cwd target', () => {
  registry._reset();
  const claude = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  const grokImpl = fakeStartSession();
  const grok = registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });
  registry.createSession({ cwd: '/tmp/other', name: 'Other', startSessionImpl: fakeStartSession() });

  const result = registry.delegateTask(claude.id, 'Grok', 'summarize main.py');
  assert.equal(result.targetId, grok.id);
  assert.match(
    grokImpl.lastInput,
    /^\[Prompt Cockpit\] Relayed task from "Claude"\n\n[\s\S]*\n---\nsummarize main\.py$/,
    'the task text pushed into the target session must self-identify its origin via the prose header, symmetric with the relayed-reply header on the response'
  );
  assert.equal(grok.pendingResultTags.length, 1);
  assert.equal(grok.pendingResultTags[0].tag.fromId, claude.id);
  assert.equal(grok.pendingResultTags[0].tag.fromName, 'Claude');

  assert.throws(() => registry.delegateTask(claude.id, 'NoSuchName', 'hi'), /no session named/);
  assert.throws(() => registry.delegateTask(claude.id, 'Claude', 'hi'), /cannot delegate to the same session/);
  assert.throws(() => registry.delegateTask(claude.id, 'Other', 'hi'), /no session named/, 'a same-named session in a different cwd must not be reachable (same-cwd-only v1 scope)');
});

test('delegateTask appends a durable cockpit:delegate-sent marker to the ORIGIN eventLog and broadcasts it, so a reconnecting origin tab sees it', () => {
  registry._reset();
  const claude = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: fakeStartSession() });

  registry.delegateTask(claude.id, 'Grok', 'summarize main.py');

  // Attach a fresh client AFTER the delegation - proves it survives via
  // eventLog replay, not just an in-flight broadcast the caller happened to
  // catch live.
  const ws = fakeWs();
  registry.attachClient(claude.id, ws);
  const marker = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-sent');
  assert.ok(marker, 'the sent-marker must replay to a newly attached client');
  assert.equal(marker.message.targetName, 'Grok');
  assert.equal(marker.message.text, 'summarize main.py');
});

test('a delegated task result relays back into the origin session as a wrapped queued turn, text-only', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'list the files here');

  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here are the files: a.js, b.js' }] } });
  grokImpl.emitMessage({ type: 'result' });

  assert.match(claudeImpl.lastInput, /^\[Prompt Cockpit\] Relayed reply from "Grok"\n\n[\s\S]*\n---\nHere are the files: a\.js, b\.js$/);
});

// 2026-08-20 follow-up: the origin model must only see the final answer, not
// every buffered narration block - the full trace is relayed separately, out
// of the model's context, as a cockpit:delegate-full-trace marker.
test('a multi-block delegated reply relays only the final answer into the origin turn, and ships the full narration as a separate out-of-band marker', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'run the tests and report back');

  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me run the test suite first.' }] } });
  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'All 311 tests pass.' }] } });
  grokImpl.emitMessage({ type: 'result' }); // no result.result field (test stub) - falls back to the last buffered block

  assert.match(claudeImpl.lastInput, /\n---\nAll 311 tests pass\.$/, 'the origin turn must carry only the last block, not the narration before it');
  assert.doesNotMatch(claudeImpl.lastInput, /Let me run the test suite first\./, 'narration must not leak into the origin model\'s own context');

  const ws = fakeWs();
  registry.attachClient(claudeRow.id, ws);
  const trace = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-full-trace');
  assert.ok(trace, 'a full-trace marker must be sent when there is more than just the final answer');
  assert.match(trace.message.text, /Let me run the test suite first\.[\s\S]*All 311 tests pass\./, 'the marker carries the whole narration, in order');
  assert.equal(typeof trace.message.queueId, 'string');
});

test('a one-shot delegated reply (no narration) does not emit a full-trace marker - nothing extra to show', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'what is 2+2');
  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '4' }] } });
  grokImpl.emitMessage({ type: 'result' });

  const ws = fakeWs();
  registry.attachClient(claudeRow.id, ws);
  const trace = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-full-trace');
  assert.equal(trace, undefined, 'a single-block reply has nothing extra beyond the final answer, so no marker should be sent');
});

test('two concurrent delegations to the same target route their results back to the correct distinct origins, in FIFO order', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const cImpl = fakeStartSession();
  const c = registry.createSession({ cwd: '/tmp/proj', name: 'C', startSessionImpl: cImpl });
  const bImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A');
  registry.delegateTask(c.id, 'B', 'task from C');

  // First delegated turn finishes first (FIFO) - its result must go to A, not C.
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(aImpl.lastInput, /reply to A/);
  assert.equal(cImpl.lastInput, undefined, 'C must not receive A\'s reply');

  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to C' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(cImpl.lastInput, /reply to C/);
});

// Regression test for the FIFO-desync bug found in review: a plain human
// message typed directly into the target session, interleaved with a
// pending delegation, used to desync row.pendingResultTags from actual
// turn order (only delegateTask's own push was tagged) - the human's own
// reply could get relayed to the WRONG origin, or a real delegation's reply
// could get silently dropped. Fixed via pushTurn() tagging every push
// (sendInput included) with a queueId-keyed entry, tag or not.
test('a human message typed directly into the target session, interleaved with a pending delegation, does not desync the relay', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const cImpl = fakeStartSession();
  const c = registry.createSession({ cwd: '/tmp/proj', name: 'C', startSessionImpl: cImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A'); // tag 1: delegation from A
  registry.sendInput(b.id, 'a human typed this directly into B'); // tag 2: plain, no delegation
  registry.delegateTask(c.id, 'B', 'task from C'); // tag 3: delegation from C

  // Turn 1 (A's delegated task) finishes.
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(aImpl.lastInput, /reply to A/);

  // Turn 2 (the human's own message) finishes - NOT a delegation, so this
  // must not relay anywhere. Before the fix, shift() would have popped
  // tag 3 (C's) here and relayed B's answer to the human's own message
  // into C's session, mislabeled as C's delegated reply.
  cImpl.lastInput = undefined;
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to the human' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.equal(cImpl.lastInput, undefined, 'a non-delegated turn finishing must not relay anything to C');

  // Turn 3 (C's delegated task) finishes - must now correctly reach C.
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to C' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(cImpl.lastInput, /reply to C/);
});

// Regression test for the second FIFO-desync trigger found in review:
// removeQueued/reorderQueue mutate session.js's real queue but used to
// leave row.pendingResultTags untouched, so a removed/reordered turn threw
// off every later shift(). Only meaningfully exercisable when a turn is
// actually queued behind a running one - the fake handle's removeQueued/
// reorderQueue are simple recorders (no real queue semantics), so this
// drives registry.js's own mirroring logic directly against the queueIds
// pushInput handed back.
test('removeQueued drops the matching pendingResultTags entry and relays a cancellation notice if it was a delegation', async () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A');
  const queueId = b.pendingResultTags[0].queueId;
  assert.equal(b.pendingResultTags.length, 1);

  await registry.removeQueued(b.id, queueId);

  assert.equal(b.pendingResultTags.length, 0, 'the tag must be dropped so a later unrelated result cannot be mismatched against it');
  assert.match(aImpl.lastInput, /ERROR: the delegated task was removed from the queue before it ran/);
});

// Follow-up finding while fixing sendNow above: reorderQueue's own mirror
// had the identical defect. The real frontend's queueIds (public/queue-
// panel.js's reorderBySwap, sourced from listQueue()) can never name the
// in-flight turn - it never appears in the visible queue at all - so the
// old "named ids first, everything unlisted appended after" algorithm
// always pushed the in-flight entry's tag to the BACK the moment any two
// queued items were reordered while a delegated turn was running. Proven
// live via a probe before this fix: pendingResultTags [A(in-flight), C, B]
// reordered with queueIds [B, C] (realistically excluding A) produced
// [B, C, A] - A's own result would then have been shift()'d off as B's.
test('reorderQueue reorders only the still-queued tail; the in-flight entry never moves', async () => {
  registry._reset();
  const dAImpl = fakeStartSession();
  const dA = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorA', startSessionImpl: dAImpl });
  const dCImpl = fakeStartSession();
  const dC = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorC', startSessionImpl: dCImpl });
  const dBImpl = fakeStartSession();
  const dB = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorB', startSessionImpl: dBImpl });
  const tImpl = fakeStartSession();
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'Target', startSessionImpl: tImpl });

  registry.delegateTask(dA.id, 'Target', 'task from A'); // in-flight (pushed first)
  registry.delegateTask(dC.id, 'Target', 'task from C'); // queued
  registry.delegateTask(dB.id, 'Target', 'task from B'); // queued
  const [idA, idC, idB] = target.pendingResultTags.map((e) => e.queueId);

  // Realistic frontend call: queueIds is only the visible (queued) entries,
  // reordered so B runs before C - never names idA.
  await registry.reorderQueue(target.id, [idB, idC]);
  assert.deepEqual(
    target.pendingResultTags.map((e) => e.queueId),
    [idA, idB, idC],
    'A must stay pinned first; only the queued tail (C, B) reorders',
  );

  // A's own (still in-flight) result must go to A's origin, not B's just
  // because the queue panel reordered B ahead of C.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dAImpl.lastInput, /reply to A/);
  assert.equal(dBImpl.lastInput, undefined, 'B must not receive A\'s reply just because the queue was reordered');

  // B runs next, per the reordered tail.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to B' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dBImpl.lastInput, /reply to B/);
  assert.equal(dCImpl.lastInput, undefined, 'C must still be waiting behind B');
});

// A caller naming the in-flight entry's id explicitly (not something the
// real frontend does, but defense in depth) must not be able to move it
// either - pinning by position, not by whether the id happens to appear in
// queueIds.
test('reorderQueue ignores the in-flight entry even if a caller explicitly names its id', async () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const cImpl = fakeStartSession();
  const c = registry.createSession({ cwd: '/tmp/proj', name: 'C', startSessionImpl: cImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A'); // in-flight
  registry.delegateTask(c.id, 'B', 'task from C'); // queued
  const [idA, idC] = b.pendingResultTags.map((e) => e.queueId);

  await registry.reorderQueue(b.id, [idC, idA]); // asks to put C ahead of A
  assert.deepEqual(
    b.pendingResultTags.map((e) => e.queueId),
    [idA, idC],
    'naming the in-flight id in queueIds must not move it out of position 0',
  );
});

// Review finding: sendNow used to unshift the target tag all the way to
// absolute index 0 of pendingResultTags, but index 0 is always the
// currently in-flight turn (handle.sendNow only reorders the NOT-yet-
// started sub-queue behind it, per session.js's moveToFront - it can't
// make a queued turn's result arrive before the already-running turn's
// own interrupted result does). With A running and B/C queued, sending B
// now used to produce [B, A, C] - so A's own interrupted result got
// shifted off as if it were B's answer, and B's real answer would later
// get mismatched against C. The tag must land right after the in-flight
// entry instead: [A, B, C].
test('sendNow inserts the target tag after the in-flight entry, not ahead of it', async () => {
  registry._reset();
  const dAImpl = fakeStartSession();
  const dA = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorA', startSessionImpl: dAImpl });
  const dCImpl = fakeStartSession();
  const dC = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorC', startSessionImpl: dCImpl });
  const dBImpl = fakeStartSession();
  const dB = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorB', startSessionImpl: dBImpl });
  const tImpl = fakeStartSession();
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'Target', startSessionImpl: tImpl });

  registry.delegateTask(dA.id, 'Target', 'task from A'); // in-flight (pushed first)
  registry.delegateTask(dC.id, 'Target', 'task from C'); // queued
  registry.delegateTask(dB.id, 'Target', 'task from B'); // queued
  const [idA, idC, idB] = target.pendingResultTags.map((e) => e.queueId);

  assert.equal(await registry.sendNow(target.id, idB), true);
  assert.deepEqual(
    target.pendingResultTags.map((e) => e.queueId),
    [idA, idB, idC],
    'B must land right after the in-flight A, not ahead of it',
  );

  // A's (interrupted) result still arrives first - it must go to A's
  // origin, never to B's just because B was sent-now'd.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dAImpl.lastInput, /reply to A/);
  assert.equal(dBImpl.lastInput, undefined, 'B must not receive A\'s interrupted reply just because it was sent now');

  // B runs next, per the reordered queue.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to B' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dBImpl.lastInput, /reply to B/);
  assert.equal(dCImpl.lastInput, undefined, 'C must still be waiting behind B');
});

// Regression test for the closeSession stranding bug found in review:
// closing a session that's currently the target of a pending delegation
// used to delete the row with no notice to the origin at all (unlike a
// crash, which handleError already relayed as an ERROR:).
test('closing a session that is the target of a pending delegation relays a failure notice to the origin instead of stranding it', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: fakeStartSession() });

  registry.delegateTask(a.id, 'B', 'do something');
  registry.closeSession(registry.findByName('/tmp/proj', 'B').id);

  assert.match(aImpl.lastInput, /ERROR: the target session was closed before it replied/);
});

// 2026-08-20: the wrapper moved from an XML-ish `<delegated_result from=
// "...">` tag to a prose header + `\n---\n` separator specifically because
// receiving models were pattern-matching the tag shape as a spoofed
// tool-scaffolding tag and refusing legitimate delegations outright (see
// backlog.md). There is no closing-tag boundary left for a reply body to
// spoof, so the body is no longer escaped - it goes through verbatim, same
// as any other plain-text turn.
test('a delegated reply body is inserted verbatim after the separator, unescaped', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const bImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'say something with special chars');
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'x < y && y > z' }] } });
  bImpl.emitMessage({ type: 'result' });

  assert.ok(aImpl.lastInput.endsWith('\n---\nx < y && y > z'), 'the body must appear verbatim after the separator, with no HTML-style escaping');
});

// Regression test for the TOCTOU fix found in review: registry.createSession
// and registry.setSessionName are now the authoritative, synchronous
// uniqueness gate (server.js's own pre-checks are fast-fail only).
test('createSession and setSessionName throw ERR_NAME_TAKEN synchronously on a same-cwd name collision', async () => {
  registry._reset();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: fakeStartSession() });

  assert.throws(
    () => registry.createSession({ cwd: '/tmp/proj', name: 'grok', startSessionImpl: fakeStartSession() }),
    (err) => err.code === 'ERR_NAME_TAKEN',
  );

  const other = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  await assert.rejects(
    () => registry.setSessionName(other.id, 'GROK'),
    (err) => err.code === 'ERR_NAME_TAKEN',
  );
});

test('a target session erroring mid-delegated-turn relays an ERROR-tagged notice back to the origin instead of stranding it', () => {
  registry._reset();
  const originImpl = fakeStartSession();
  const origin = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: originImpl });
  const targetImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: targetImpl });

  registry.delegateTask(origin.id, 'Grok', 'do something that will fail');
  targetImpl.emitError(new Error('CLI crashed'));

  assert.ok(originImpl.lastInput.startsWith('[Prompt Cockpit] Relayed reply from "Grok"'));
  assert.match(originImpl.lastInput, /ERROR: CLI crashed/);
});

// Review finding: handleError used to leave scheduleAutoContinue's timer
// armed. If a rate-limit hit had armed it before the CLI died, the timer
// fired later, pushTurn'd 'Continue' into a now-dead handle, and broadcast
// a live-looking 'running' state for an errored session - a ghost turn
// with nothing behind it. handleError must clear the timer synchronously,
// same as closeSession already does.
test('a crash after a rate-limit hit disarms auto-continue instead of resurrecting the session later', async () => {
  registry._reset();
  const impl = fakeStartSession();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: impl });

  // Arm auto-continue on a rate limit due to resolve very soon.
  row.rateLimitHit = { resetsAt: Date.now() + 10, rateLimitType: 'session_limit_text' };
  await registry.setAutoContinue(row.id, true);
  assert.equal(row.autoContinueTimer !== null, true);

  // CLI dies before the timer fires.
  impl.emitError(new Error('CLI crashed'));
  assert.equal(row.state, 'error');
  assert.equal(row.autoContinueTimer, null);

  const inputsBefore = (impl.allInputs || []).length;
  // Wait past the original resetsAt - if the timer had survived, its
  // callback would have pushTurn'd 'Continue' by now.
  await new Promise((resolve) => setTimeout(resolve, 30));

  assert.equal((impl.allInputs || []).length, inputsBefore);
  assert.equal(row.state, 'error');
});

// MVP6 seed (backlog.md): the per-process delegation handshake secret -
// see session-registry.js's own module-level comment for the full
// rationale. Deliberately NOT calling registry._reset() at the top of every
// test in this block the way the rest of the file does where it would wipe
// state the test needs to observe across regenerateHandshakeSecret calls -
// each test still resets the session map, just not in a way that assumes
// anything about the secret's own value (never asserted verbatim, only
// compared against itself via getHandshakeSecret()).
test('a locally-created session is trusted by default; getHandshakeSecret returns a stable non-empty value until rotated', () => {
  registry._reset();
  const secret = registry.getHandshakeSecret();
  assert.ok(secret && secret.length >= 16, 'must be a real random-looking value, not empty/short');
  assert.equal(registry.getHandshakeSecret(), secret, 'must stay stable across calls until explicitly rotated');

  const row = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(row).handshakeTrusted, true);
});

test('delegateTask throws if either the origin or the target has a mismatched handshake', () => {
  registry._reset();
  const origin = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: fakeStartSession() });
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: fakeStartSession() });

  registry.setSessionHandshake(target.id, 'garbage-does-not-match');
  assert.throws(() => registry.delegateTask(origin.id, 'B', 'hi'), /does not have a matching handshake/);

  // Re-sync the target, then break the origin instead.
  registry.setSessionHandshake(target.id, registry.getHandshakeSecret());
  registry.setSessionHandshake(origin.id, 'also-garbage');
  assert.throws(() => registry.delegateTask(origin.id, 'B', 'hi'), /cannot delegate to other sessions/);

  // Re-sync the origin too - now it should go through.
  registry.setSessionHandshake(origin.id, registry.getHandshakeSecret());
  const result = registry.delegateTask(origin.id, 'B', 'hi');
  assert.equal(result.targetId, target.id);
});

test('setSessionHandshake trims the pasted value and reports whether it now matches', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: fakeStartSession() });
  const secret = registry.getHandshakeSecret();

  assert.equal(registry.setSessionHandshake(row.id, `  ${secret}  `), true, 'surrounding whitespace from a copy-paste must not break the match');
  assert.equal(registry.setSessionHandshake(row.id, 'wrong'), false);
  assert.throws(() => registry.setSessionHandshake('does-not-exist', secret), /unknown session/);
});

test('regenerateHandshakeSecret revokes trust for existing rows but not for rows created afterward', () => {
  registry._reset();
  const before = registry.createSession({ cwd: '/tmp/proj', name: 'Before', startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(before).handshakeTrusted, true);

  const rotated = registry.regenerateHandshakeSecret();
  assert.notEqual(rotated, undefined);
  assert.equal(registry.toSummary(before).handshakeTrusted, false, 'a row stamped with the OLD secret must no longer match');

  const after = registry.createSession({ cwd: '/tmp/proj', name: 'After', startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(after).handshakeTrusted, true, 'a row created after rotation gets the NEW secret automatically');
});
