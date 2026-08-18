import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { startGrokSession, rewindGrokSession } from '../src/grok-session.js';

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function fakeConnect({ failInit = false, sessionId = 'grok-sess-1', hangPrompt = null, promptResult = { stopReason: 'end_turn' } } = {}) {
  const proc = new EventEmitter();
  const requests = [];
  const permissionHandler = { fn: null };
  const notificationHandler = { fn: null };
  const client = {
    request: async (method, params) => {
      requests.push({ method, params });
      if (failInit && method === 'initialize') throw new Error('auth failed');
      if (method === 'session/prompt' && hangPrompt && hangPrompt.hold !== false) {
        return new Promise((resolve) => {
          hangPrompt.resolve = (result) => {
            hangPrompt.hold = false;
            resolve(result || { stopReason: 'end_turn' });
          };
        });
      }
      if (method === 'session/new') {
        return {
          sessionId,
          models: {
            currentModelId: 'grok-4.5',
            availableModels: [{ modelId: 'grok-4.5', name: 'Grok 4.5' }, { modelId: 'grok-4.6', name: 'Grok 4.6' }],
          },
        };
      }
      if (method === 'session/prompt') return promptResult;
      if (method === '_x.ai/rewind/points') return { rewind_points: [{ prompt_index: 0 }, { prompt_index: 2 }] };
      if (method === '_x.ai/rewind/execute') return { success: true, target_prompt_index: params.target_prompt_index };
      if (method === 'session/set_model' || method === '_x.ai/session/set_model') return { modelId: params.modelId };
      if (method === 'session/set_mode') return { modeId: params.modeId };
      if (method === '_x.ai/session/fork') {
        return {
          newSessionId: params.newSessionId,
          parentSessionId: params.sourceSessionId,
          newCwd: params.newCwd,
          chatMessagesCopied: 0,
          updatesCopied: 0,
          planStateCopied: false,
        };
      }
      if (method === 'session/set_config_option' || method === 'session/set_effort' || method === '_x.ai/session/set_effort') {
        return { effort: params.effort || (params.configOption && params.configOption.value) };
      }
      return {};
    },
    notify: (method, params) => { requests.push({ method, params, notify: true }); },
    onRequest: (method, fn) => { if (method === 'session/request_permission') permissionHandler.fn = fn; },
    onNotification: (fn) => { notificationHandler.fn = fn; },
    rejectAll: () => {},
  };
  return {
    connection: { client, proc, getStderr: () => '' },
    requests,
    permissionHandler,
    notificationHandler,
    proc,
  };
}

function startFake(overrides = {}, connectOpts = {}) {
  const fake = fakeConnect(connectOpts);
  const messages = [];
  const states = [];
  const errors = [];
  const approvals = [];
  const session = startGrokSession({
    cwd: 'D:\\tmp',
    onMessage: (msg) => messages.push(msg),
    onStateChange: (s) => states.push(s),
    onError: (err) => errors.push(err),
    onApprovalRequest: (req) => approvals.push(req),
    connectImpl: () => fake.connection,
    ...overrides,
  });
  return { session, messages, states, errors, approvals, fake };
}

test('startGrokSession inits, creates a session, and emits system/init', async () => {
  const { messages, states, errors, fake } = startFake();
  await flush();
  await flush();
  assert.deepEqual(errors, []);
  assert.ok(states.includes('idle'));
  assert.equal(fake.requests[0].method, 'initialize');
  assert.equal(fake.requests[1].method, 'session/new');
  const init = messages.find((m) => m.type === 'system' && m.subtype === 'init');
  assert.ok(init);
  assert.equal(init.session_id, 'grok-sess-1');
});

test('pushInput echoes the user turn and sends session/prompt', async () => {
  const { session, messages, fake } = startFake();
  await flush();
  await flush();
  session.pushInput('hello grok');
  await flush();
  await flush();
  const user = messages.find((m) => m.turnIndex === 1);
  assert.equal(user.message.content, 'hello grok');
  const prompt = fake.requests.find((r) => r.method === 'session/prompt');
  assert.ok(prompt);
  assert.equal(prompt.params.prompt[0].text, 'hello grok');
  assert.ok(messages.some((m) => m.type === 'result' && m.subtype === 'success'));
});

test('ACP tool updates are forwarded as sdk messages', async () => {
  const { messages, fake } = startFake();
  await flush();
  await flush();
  fake.notificationHandler.fn('session/update', {
    update: { sessionUpdate: 'agent_message_chunk', content: { text: 'hi' } },
  });
  assert.equal(messages.at(-1).type, 'assistant');
  assert.equal(messages.at(-1).message.content[0].text, 'hi');
});

test('turn_completed on _x.ai/session/update is forwarded with usage', async () => {
  const { messages, fake } = startFake();
  await flush();
  await flush();
  fake.notificationHandler.fn('_x.ai/session/update', {
    update: {
      sessionUpdate: 'turn_completed',
      usage: { inputTokens: 101544, outputTokens: 1128, costUsdTicks: 210854400 },
    },
  });
  const billed = messages.find((m) => m.type === 'assistant' && m.message && m.message.usage);
  assert.ok(billed, 'updates.jsonl rewrites the bill as _x.ai/session/update');
  assert.equal(billed.message.usage.input_tokens, 101544);
  assert.equal(billed.message.usage.output_tokens, 1128);
  assert.equal(billed.message.usage.cost_usd_ticks, 210854400);
});

test('turn_completed on _x.ai/session_notification is forwarded with usage', async () => {
  const { messages, fake } = startFake();
  await flush();
  await flush();
  // Live stdio shape (confirmed against grok agent stdio): method is
  // `_x.ai/session_notification`, params may be the update itself.
  fake.notificationHandler.fn('_x.ai/session_notification', {
    sessionUpdate: 'turn_completed',
    usage: { inputTokens: 16666, outputTokens: 41, cachedReadTokens: 1408, costUsdTicks: 53492200 },
  });
  const billed = messages.find((m) => m.type === 'assistant' && m.message && m.message.usage);
  assert.ok(billed, 'live Grok bills arrive on _x.ai/session_notification');
  assert.equal(billed.message.usage.input_tokens, 16666);
  assert.equal(billed.message.usage.output_tokens, 41);
  assert.equal(billed.message.usage.cache_read_input_tokens, 1408);
  assert.equal(billed.message.usage.cost_usd_ticks, 53492200);
});

test('session/prompt _meta.usage bills the turn when no notification arrives', async () => {
  const { session, messages } = startFake({}, {
    promptResult: {
      stopReason: 'end_turn',
      _meta: {
        usage: { inputTokens: 16666, outputTokens: 41, costUsdTicks: 53492200, cachedReadTokens: 1408 },
      },
    },
  });
  await flush();
  await flush();
  session.pushInput('hello grok');
  await flush();
  await flush();
  const billed = messages.filter((m) => m.type === 'assistant' && m.message && m.message.usage);
  assert.equal(billed.length, 1, 'prompt-result usage is the fallback when the notification is missing');
  assert.equal(billed[0].message.usage.input_tokens, 16666);
  assert.equal(billed[0].message.usage.output_tokens, 41);
  assert.equal(billed[0].message.usage.cost_usd_ticks, 53492200);
});

test('session/prompt _meta.usage is not double-counted after a turn_completed notification', async () => {
  const hangPrompt = {};
  const { session, messages, fake } = startFake({}, { hangPrompt });
  await flush();
  await flush();
  session.pushInput('hello grok');
  await flush();
  await flush();
  fake.notificationHandler.fn('_x.ai/session_notification', {
    sessionUpdate: 'turn_completed',
    usage: { inputTokens: 16666, outputTokens: 41, costUsdTicks: 53492200 },
  });
  hangPrompt.resolve({
    stopReason: 'end_turn',
    _meta: { usage: { inputTokens: 16666, outputTokens: 41, costUsdTicks: 53492200 } },
  });
  await flush();
  await flush();
  const billed = messages.filter((m) => m.type === 'assistant' && m.message && m.message.usage);
  assert.equal(billed.length, 1, 'one turn, one bill');
});

test('unrelated ACP notifications are ignored', async () => {
  const { messages, fake } = startFake();
  await flush();
  await flush();
  const before = messages.length;
  fake.notificationHandler.fn('session/cancel', {
    update: { sessionUpdate: 'turn_completed', usage: { inputTokens: 1, outputTokens: 1 } },
  });
  assert.equal(messages.length, before);
});

test('live user_message_chunk is dropped because pushInput already echoed it', async () => {
  const { session, messages, fake } = startFake();
  await flush();
  await flush();
  session.pushInput('hello grok');
  await flush();
  await flush();
  const usersBefore = messages.filter((m) => m.type === 'user');
  fake.notificationHandler.fn('session/update', {
    update: { sessionUpdate: 'user_message_chunk', content: { text: 'hello grok' } },
  });
  const usersAfter = messages.filter((m) => m.type === 'user');
  assert.equal(usersBefore.length, 1);
  assert.equal(usersAfter.length, 1);
});

test('duplicate pushInput while a prompt is in flight is dropped', async () => {
  const hangPrompt = {};
  const { session, messages, fake } = startFake({}, { hangPrompt });
  await flush();
  await flush();
  session.pushInput('same text');
  await flush();
  await flush();
  session.pushInput('same text');
  await flush();
  await flush();
  const prompts = fake.requests.filter((r) => r.method === 'session/prompt');
  assert.equal(prompts.length, 1);
  assert.equal(messages.filter((m) => m.type === 'user').length, 1);
  hangPrompt.resolve();
  await flush();
  await flush();
});

test('a new pushInput while a prompt is in flight cancels the current turn', async () => {
  const hangPrompt = {};
  const { session, fake } = startFake({}, { hangPrompt });
  await flush();
  await flush();
  session.pushInput('first');
  await flush();
  await flush();
  session.pushInput('second');
  await flush();
  await flush();
  assert.ok(fake.requests.some((r) => r.notify && r.method === 'session/cancel'));
  hangPrompt.resolve({ stopReason: 'cancelled' });
  await flush();
  await flush();
  const prompts = fake.requests.filter((r) => r.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].params.prompt[0].text, 'first');
  assert.equal(prompts[1].params.prompt[0].text, 'second');
});

test('resume uses session/load instead of session/new', async () => {
  const { fake } = startFake({ resume: 'old-id' });
  await flush();
  await flush();
  assert.ok(fake.requests.some((r) => r.method === 'session/load' && r.params.sessionId === 'old-id'));
  assert.ok(!fake.requests.some((r) => r.method === 'session/new'));
});

test('default mode routes permission requests to the client', async () => {
  const { approvals, fake } = startFake();
  await flush();
  await flush();
  const pending = fake.permissionHandler.fn({
    toolCall: { toolCallId: 'c1', toolName: 'read_file', rawInput: { path: 'a' }, title: 'Read' },
    options: [
      { optionId: 'allow-once', kind: 'allow_once' },
      { optionId: 'reject-once', kind: 'reject_once' },
    ],
  });
  await flush();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'read_file');
  // leave it hanging - just proving it asked
  assert.equal(typeof pending.then, 'function');
});

test('bypassPermissions auto-allows without asking the client', async () => {
  const { approvals, fake } = startFake({ permissionMode: 'bypassPermissions' });
  await flush();
  await flush();
  const result = await fake.permissionHandler.fn({
    toolCall: { toolCallId: 'c1', title: 'Edit' },
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  });
  assert.equal(approvals.length, 0);
  assert.equal(result.outcome.optionId, 'allow-once');
});

test('acceptEdits auto-allows edits only; bash is asked', async () => {
  const { approvals, fake } = startFake({ permissionMode: 'acceptEdits' });
  await flush();
  await flush();
  const edit = await fake.permissionHandler.fn({
    toolCall: { toolCallId: 'e1', kind: 'edit' },
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  });
  assert.equal(edit.outcome.optionId, 'allow-once');
  assert.equal(approvals.length, 0);
  fake.permissionHandler.fn({
    toolCall: { toolCallId: 'b1', kind: 'execute', toolName: 'run_terminal_command' },
    options: [{ optionId: 'allow-once', kind: 'allow_once' }],
  });
  await flush();
  assert.equal(approvals.length, 1);
  assert.equal(approvals[0].toolName, 'run_terminal_command');
});

test('plan mode denies non-read tools without asking', async () => {
  const { approvals, fake } = startFake({ permissionMode: 'plan' });
  await flush();
  await flush();
  const denied = await fake.permissionHandler.fn({
    toolCall: { toolCallId: 'e1', kind: 'edit' },
    options: [{ optionId: 'reject-once', kind: 'reject_once' }],
  });
  assert.equal(approvals.length, 0);
  assert.equal(denied.outcome.optionId, 'reject-once');
});

test('spawn error is reported instead of becoming an unhandled crash', async () => {
  const { errors, states, fake } = startFake();
  await flush();
  await flush();
  fake.proc.emit('error', new Error('spawn grok ENOENT'));
  await flush();
  assert.ok(states.includes('error'));
  assert.match(String(errors.at(-1)), /ENOENT/);
});

test('MCP and plugin query methods go through the injected Grok extensions', async () => {
  const calls = [];
  const { session } = startFake({
    grokExtensionsImpl: {
      mcpServerStatus: async () => {
        calls.push('status');
        return [{ name: 'ffind', status: 'pending', canReconnect: false }];
      },
      toggleMcpServer: async (name, enabled) => { calls.push(['toggle', name, enabled]); },
      reloadPlugins: async () => {
        calls.push('reload');
        return { plugins: [{ name: 'playwright', source: 'user', enabled: true }] };
      },
      setPluginEnabled: async (pluginKey, enabled) => { calls.push(['plugin', pluginKey, enabled]); },
      supportedCommands: async () => {
        calls.push('commands');
        return [{ name: 'caveman', description: 'talk like caveman' }];
      },
      supportedAgents: async () => {
        calls.push('agents');
        return [{ name: 'explore', description: 'read-only explorer' }];
      },
    },
  });
  await flush();
  await flush();
  const commands = await session.query.supportedCommands();
  assert.equal(commands[0].name, 'caveman');
  const agents = await session.query.supportedAgents();
  assert.equal(agents[0].name, 'explore');
  const servers = await session.query.mcpServerStatus();
  assert.equal(servers[0].name, 'ffind');
  await session.query.toggleMcpServer('ffind', false);
  const plugins = await session.query.reloadPlugins();
  assert.equal(plugins.plugins[0].name, 'playwright');
  await session.query.setPluginEnabled('playwright@user', true);
  await assert.rejects(session.query.reconnectMcpServer('ffind'), /not supported/);
  assert.deepEqual(calls, ['commands', 'agents', 'status', ['toggle', 'ffind', false], 'reload', ['plugin', 'playwright@user', true]]);
});

test('supportedModels comes from session/new; setModel and setEffort hit ACP', async () => {
  const { session, fake } = startFake();
  await flush();
  await flush();
  const models = await session.query.supportedModels();
  assert.equal(models[0].value, 'grok-4.5');
  await session.query.setModel('grok-4.6');
  await session.query.setEffort('low');
  assert.ok(fake.requests.some((r) => r.method === 'session/set_model' && r.params.modelId === 'grok-4.6'));
  assert.ok(fake.requests.some((r) => r.method === 'session/set_mode' && r.params.modeId === 'low'));
});

test('forkAt copies via _x.ai/session/fork then rewinds the child', async () => {
  const rewindCalls = [];
  const { session, fake } = startFake({
    rewindExistingImpl: async (opts) => {
      rewindCalls.push(opts);
      return { success: true, target_prompt_index: opts.promptIndex };
    },
  });
  await flush();
  await flush();
  const forked = await session.forkAt(2);
  const forkReq = fake.requests.find((r) => r.method === '_x.ai/session/fork');
  assert.ok(forkReq);
  assert.equal(forkReq.params.sourceSessionId, 'grok-sess-1');
  assert.equal(forkReq.params.sourceCwd, 'D:\\tmp');
  assert.equal(forkReq.params.newCwd, 'D:\\tmp');
  assert.equal(typeof forkReq.params.newSessionId, 'string');
  assert.equal(forked.newSessionId, forkReq.params.newSessionId);
  assert.equal(rewindCalls.length, 1);
  assert.equal(rewindCalls[0].sessionId, forked.newSessionId);
  assert.equal(rewindCalls[0].promptIndex, 2);
  assert.equal(rewindCalls[0].cwd, 'D:\\tmp');
});

test('rewindGrokSession loads the target id then executes rewind', async () => {
  const fake = fakeConnect({ sessionId: 'child-1' });
  const result = await rewindGrokSession({
    cwd: 'D:\\tmp',
    sessionId: 'child-1',
    promptIndex: 2,
    connectImpl: () => fake.connection,
  });
  assert.equal(result.target_prompt_index, 2);
  assert.equal(fake.requests[0].method, 'initialize');
  assert.equal(fake.requests[1].method, 'session/load');
  assert.equal(fake.requests[1].params.sessionId, 'child-1');
  assert.equal(fake.requests[2].method, '_x.ai/rewind/execute');
  assert.equal(fake.requests[2].params.target_prompt_index, 2);
});

test('listRewindPoints and rewindTo call the underscore ACP methods', async () => {
  const { session, fake } = startFake();
  await flush();
  await flush();
  const points = await session.listRewindPoints();
  assert.equal(points[1].prompt_index, 2);
  const exec = await session.rewindTo(2);
  assert.equal(exec.target_prompt_index, 2);
  assert.ok(fake.requests.some((r) => r.method === '_x.ai/rewind/points'));
  assert.ok(fake.requests.some((r) => r.method === '_x.ai/rewind/execute' && r.params.target_prompt_index === 2));
});

test('init failure goes to error state', async () => {
  const { states, errors } = startFake({}, { failInit: true });
  await flush();
  await flush();
  assert.ok(states.includes('error'));
  assert.match(String(errors[0]), /auth failed/);
});
