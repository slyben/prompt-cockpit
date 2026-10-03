import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listClaudeSubscriptions, resolveClaudeSubscription, claudeSubscriptionEnv } from '../src/claude-subscriptions.js';
import { getProvider, resolveProviderSubscription } from '../src/provider-registry.js';
import { fetchSessionHistory } from '../src/session-history.js';
import { findSubagentTranscript } from '../src/agent-transcript.js';
import { startSession } from '../src/session.js';
import * as registry from '../src/session-registry.js';
import { fakeStartSession } from './test-helpers.mjs';

let root;
const sessionId = randomUUID();
const firstTurnId = randomUUID();
const secondTurnId = randomUUID();
const previousEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'COCKPIT_SETTINGS_FILE'].map((key) => [key, process.env[key]]));

const accounts = [{ id: 'gmail', label: 'Gmail', configDir: '~/.claudegmail' }];
async function writeAccountConfig(claudeSubscriptions = accounts) {
  await writeFile(process.env.COCKPIT_SETTINGS_FILE, JSON.stringify({ claudeSubscriptions }));
}

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'cockpit-subscriptions-'));
  process.env.HOME = root;
  process.env.USERPROFILE = root;
  process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
  process.env.COCKPIT_SETTINGS_FILE = path.join(root, 'settings.json');
  await writeAccountConfig();
  for (const account of listClaudeSubscriptions()) {
    const dir = path.join(account.configDir, 'projects', '-fixture');
    await mkdir(path.join(dir, sessionId, 'subagents'), { recursive: true });
    const transcript = [
      { type: 'user', uuid: firstTurnId, parentUuid: null, sessionId, cwd: root, message: { role: 'user', content: `${account.id} first turn` } },
      { type: 'user', uuid: secondTurnId, parentUuid: firstTurnId, sessionId, cwd: root, message: { role: 'user', content: `${account.id} second turn` } },
    ];
    await writeFile(path.join(dir, `${sessionId}.jsonl`), transcript.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    await writeFile(path.join(dir, sessionId, 'subagents', 'agent-child.meta.json'), JSON.stringify({ toolUseId: 'tool-1', account: account.id }));
    await writeFile(path.join(dir, sessionId, 'subagents', 'agent-child.jsonl'), '');
  }
});

test('without a config file or extra accounts only the detected default is available', async () => {
  try {
    await rm(process.env.COCKPIT_SETTINGS_FILE);
    assert.deepEqual(listClaudeSubscriptions().map((account) => account.id), ['default']);
    assert.equal(resolveClaudeSubscription().configDir, path.join(root, '.claude'));
    // The second directory exists, but is only offered when configured.
    assert.throws(() => resolveClaudeSubscription('gmail'), /unknown Claude subscription/);
    await writeFile(process.env.COCKPIT_SETTINGS_FILE, '{}');
    assert.equal(listClaudeSubscriptions().length, 1);
    await writeAccountConfig([]);
    assert.equal(listClaudeSubscriptions().length, 1);
    delete process.env.CLAUDE_CONFIG_DIR;
    assert.equal(resolveClaudeSubscription().configDir, path.join(root, '.claude'));
  } finally {
    process.env.CLAUDE_CONFIG_DIR = path.join(root, '.claude');
    await writeAccountConfig();
  }
});

test('config supports arbitrary account names, home-relative, absolute, and config-relative folders', async () => {
  try {
    await writeAccountConfig([
      { id: 'work', label: 'Work account', configDir: '~/.claude-work' },
      { id: 'personal', configDir: '~\\.claude-personal' },
      { id: 'other', configDir: path.join(root, 'other-login') },
      { id: 'relative', configDir: 'logins/extra' },
    ]);
    assert.equal(resolveClaudeSubscription('work').configDir, path.join(root, '.claude-work'));
    assert.equal(resolveClaudeSubscription('personal').configDir, path.join(root, '.claude-personal'));
    assert.equal(resolveClaudeSubscription('personal').label, 'personal');
    assert.equal(resolveClaudeSubscription('other').configDir, path.join(root, 'other-login'));
    assert.equal(resolveClaudeSubscription('relative').configDir, path.join(root, 'logins', 'extra'));
  } finally { await writeAccountConfig(); }
});

test('invalid account configuration is reported instead of silently using another account', async () => {
  try {
    for (const config of [
      { claudeSubscriptions: {} },
      { claudeSubscriptions: [{ id: 'default', configDir: 'other' }] },
      { claudeSubscriptions: [{ id: 'work', configDir: 'one' }, { id: 'work', configDir: 'two' }] },
      { claudeSubscriptions: [{ id: '../work', configDir: 'one' }] },
      { claudeSubscriptions: [{ id: 'work', configDir: '' }] },
      { claudeSubscriptions: [{ id: 'work', configDir: 'one', label: 2 }] },
      { claudeSubscriptions: [null] },
    ]) {
      await writeFile(process.env.COCKPIT_SETTINGS_FILE, JSON.stringify(config));
      assert.throws(() => listClaudeSubscriptions(), /claudeSubscriptions/);
    }
    await writeFile(process.env.COCKPIT_SETTINGS_FILE, '{broken json');
    assert.throws(() => listClaudeSubscriptions(), /invalid JSON/);
    await writeFile(process.env.COCKPIT_SETTINGS_FILE, 'null');
    assert.throws(() => listClaudeSubscriptions(), /JSON object/);
  } finally { await writeAccountConfig(); }
});

after(async () => {
  registry._reset();
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

test('only configured subscription IDs are accepted, with Default for older clients', () => {
  assert.equal(resolveClaudeSubscription().id, 'default');
  assert.equal(resolveClaudeSubscription('gmail').configDir, path.join(root, '.claudegmail'));
  for (const id of ['', '../gmail', 'C:\\secret', {}, 1]) assert.throws(() => resolveClaudeSubscription(id), /unknown Claude subscription/);
  assert.equal(resolveProviderSubscription(getProvider('codex')), null);
  assert.throws(() => resolveProviderSubscription(getProvider('grok'), 'gmail'), /does not support/);
});

test('subscription environments retain inherited settings but remove credentials overriding the saved login', () => {
  const keys = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR'];
  const saved = keys.map((key) => process.env[key]);
  try {
    for (const key of keys) process.env[key] = 'test-override';
    const env = claudeSubscriptionEnv('gmail');
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(root, '.claudegmail'));
    assert.equal(env.PATH, process.env.PATH);
    for (const key of keys) {
      assert.equal(env[key], undefined);
      assert.equal(process.env[key], 'test-override');
    }
    assert.equal(process.env.CLAUDE_CONFIG_DIR, path.join(root, '.claude'));
  } finally {
    keys.forEach((key, index) => {
      if (saved[index] === undefined) delete process.env[key];
      else process.env[key] = saved[index];
    });
  }
});

test('simultaneous Claude starts receive independent environments without changing the server account', async () => {
  const received = [];
  const queryImpl = ({ options }) => {
    received.push(options.env);
    return { async *[Symbol.asyncIterator]() {}, interrupt: async () => {} };
  };
  const handles = ['default', 'gmail'].map((subscription) => startSession({ cwd: root, subscription, queryImpl, onStateChange: () => {}, onMessage: () => {}, onError: () => {} }));
  assert.equal(received[0].CLAUDE_CONFIG_DIR, path.join(root, '.claude'));
  assert.equal(received[1].CLAUDE_CONFIG_DIR, path.join(root, '.claudegmail'));
  assert.notEqual(received[0], received[1]);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, path.join(root, '.claude'));
  for (const handle of handles) await handle.close();
});

test('resume lists and concurrent SDK history reads stay within the selected account', async () => {
  const provider = getProvider('claude');
  const [defaults, gmail] = await Promise.all(['default', 'gmail'].map((subscription) => provider.listResumableSessions({ subscription })));
  assert.equal(defaults[0].label, 'default first turn');
  assert.equal(gmail[0].label, 'gmail first turn');
  // Both directories deliberately contain the same ID to expose any leakage.
  const [defaultHistory, gmailHistory] = await Promise.all(['default', 'gmail'].map((subscription) => fetchSessionHistory(sessionId, undefined, { subscription })));
  assert.deepEqual(defaultHistory.map((entry) => entry.message.content), ['default first turn', 'default second turn']);
  assert.deepEqual(gmailHistory.map((entry) => entry.message.content), ['gmail first turn', 'gmail second turn']);
  assert.equal(process.env.CLAUDE_CONFIG_DIR, path.join(root, '.claude'));
});

test('rewind forks the selected account transcript and leaves the original intact', async () => {
  const result = await getProvider('claude').rewind({ providerSessionId: sessionId, subscription: 'gmail', hasFileCheckpointing: false }, 1);
  assert.ok(result.forkedSessionId);
  const [forked, original, otherAccount] = await Promise.all([
    fetchSessionHistory(result.forkedSessionId, undefined, { subscription: 'gmail' }),
    fetchSessionHistory(sessionId, undefined, { subscription: 'gmail' }),
    fetchSessionHistory(result.forkedSessionId, undefined, { subscription: 'default' }),
  ]);
  assert.equal(forked.length, 1);
  assert.equal(forked[0].message.content, 'gmail first turn');
  assert.equal(original.length, 2);
  assert.deepEqual(otherAccount, []);
});

test('subagent lookup reads the selected subscription directory', async () => {
  const found = await findSubagentTranscript(sessionId, 'tool-1', resolveClaudeSubscription('gmail').configDir);
  assert.equal(found.meta.account, 'gmail');
});

test('registry keeps the account in summaries and when loading earlier history', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: root, resume: sessionId, subscription: 'gmail', history: [], startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(row).subscription, 'gmail');
  assert.equal(registry.toSummary(row).subscriptionLabel, 'Gmail');
  let requested;
  await registry.loadEarlierHistory(row.id, async (id, cwd, options) => { requested = { id, options }; return []; });
  assert.equal(requested.id, sessionId);
  assert.equal(requested.options.subscription, 'gmail');
});

test('default account keeps ambient API-key auth; a named account strips it', async () => {
  const prev = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  process.env.ANTHROPIC_API_KEY = 'sk-test';
  process.env.ANTHROPIC_AUTH_TOKEN = 'tok-test';
  const prevRoute = process.env.CLAUDE_CODE_USE_BEDROCK;
  process.env.CLAUDE_CODE_USE_BEDROCK = '1';
  try {
    await writeAccountConfig();
    assert.equal(claudeSubscriptionEnv().ANTHROPIC_API_KEY, 'sk-test');
    assert.equal(claudeSubscriptionEnv('default').ANTHROPIC_AUTH_TOKEN, 'tok-test');
    const named = claudeSubscriptionEnv('gmail');
    assert.equal(named.ANTHROPIC_API_KEY, undefined);
    assert.equal(named.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(named.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(claudeSubscriptionEnv().CLAUDE_CODE_USE_BEDROCK, '1');
    assert.equal(named.CLAUDE_CONFIG_DIR, resolveClaudeSubscription('gmail').configDir);
  } finally {
    if (prevRoute === undefined) delete process.env.CLAUDE_CODE_USE_BEDROCK; else process.env.CLAUDE_CODE_USE_BEDROCK = prevRoute;
    for (const [name, v] of [['ANTHROPIC_API_KEY', prev.k], ['ANTHROPIC_AUTH_TOKEN', prev.t]]) {
      if (v === undefined) delete process.env[name]; else process.env[name] = v;
    }
  }
});

test('invalid settings file does not break the default account or provider listing', async () => {
  await writeFile(process.env.COCKPIT_SETTINGS_FILE, '{ not json');
  try {
    assert.equal(resolveClaudeSubscription().id, 'default');
    assert.doesNotThrow(() => claudeSubscriptionEnv());
    assert.throws(() => resolveClaudeSubscription('gmail'), /invalid JSON/);
    assert.deepEqual(getProvider('claude').listSubscriptions().subscriptions.map((a) => a.id), ['default']);
    assert.match(getProvider('claude').listSubscriptions().error, /invalid JSON/);
  } finally {
    await writeAccountConfig();
  }
});

test('account limits are fetched and cached per account, with that account\'s config dir', async () => {
  const { fetchAccountLimits, _resetCacheForTests } = await import('../src/account-limits.js');
  _resetCacheForTests();
  await writeAccountConfig();
  const seen = [];
  const impl = async (_bin, _args, options) => { seen.push(options.env.CLAUDE_CONFIG_DIR); return { stdout: JSON.stringify({ result: 'ok' }) }; };
  await fetchAccountLimits('claude', impl);
  await fetchAccountLimits('claude', impl, 'gmail');
  await fetchAccountLimits('claude', impl, 'gmail'); // cached
  assert.deepEqual(seen, [resolveClaudeSubscription().configDir, resolveClaudeSubscription('gmail').configDir]);
  _resetCacheForTests();
});

test('subscription label is hidden when Default is the only account', async () => {
  await writeAccountConfig([]);
  try {
    const row = registry.createSession({ cwd: root, provider: 'claude', startSessionImpl: fakeStartSession() });
    assert.equal(registry.toSummary(row).subscriptionLabel, null);
    registry.closeSession(row.id);
  } finally {
    await writeAccountConfig();
  }
});

test('rewind fails before forking when the row\'s account no longer exists', async () => {
  const row = registry.createSession({ cwd: root, provider: 'claude', subscription: 'gmail', startSessionImpl: fakeStartSession() });
  row.providerSessionId = sessionId;
  await writeAccountConfig([]);
  try {
    await assert.rejects(registry.rewind(row.id, 1), (err) => err.code === 'ERR_INVALID_SUBSCRIPTION');
  } finally {
    await writeAccountConfig();
    registry.closeSession(row.id);
  }
});
