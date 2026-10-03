import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { fetchClaudeRateLimits, _resetCacheForTests } from '../src/claude-rate-limits.js';
import { resolveClaudeSubscription } from '../src/claude-subscriptions.js';
import { useTestSubscriptionSettings } from './helpers/subscription-settings.mjs';

useTestSubscriptionSettings([{ id: 'gmail', configDir: '~/.claudegmail' }]);
beforeEach(_resetCacheForTests);

function fakeQuery({ readUsage, messages, onClose = () => {}, onSpawn = () => {} } = {}) {
  return ({ prompt, options }) => {
    onSpawn(options);
    return {
      async *[Symbol.asyncIterator]() {
        const { value } = await prompt[Symbol.asyncIterator]().next();
        assert.equal(value.shouldQuery, false);
        assert.equal(value.isSynthetic, true);
        assert.equal(value.message.content, '');
        yield* messages || [{ type: 'system', subtype: 'init' }, { type: 'result', num_turns: 0 }];
      },
      usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET: readUsage,
      close: onClose,
    };
  };
}

test('landing-page usage waits for the zero-turn handshake, skips local scans and closes the CLI', async () => {
  let options;
  let closed = false;
  const limits = { five_hour: { utilization: 42, resets_at: '2026-10-07T10:00:00Z' } };
  const result = await fetchClaudeRateLimits({
    queryImpl: fakeQuery({
      onSpawn: (value) => { options = value; },
      onClose: () => { closed = true; },
      readUsage: async (args) => {
        assert.deepEqual(args, { skipBehaviors: true });
        return { rate_limits_available: true, rate_limits: limits };
      },
    }),
  });
  assert.deepEqual(result.rateLimits, limits);
  assert.equal(typeof result.fetchedAtMs, 'number');
  assert.equal(options.cwd, tmpdir());
  assert.equal(options.persistSession, false);
  assert.deepEqual(options.settingSources, []);
  assert.equal(options.abortController.signal.aborted, true);
  assert.equal(closed, true);
});

test('each subscription gets its own credentials and quota cache; concurrent calls share one CLI', async () => {
  const dirs = [];
  let calls = 0;
  const queryImpl = fakeQuery({
    onSpawn: (options) => { dirs.push(options.env.CLAUDE_CONFIG_DIR); },
    readUsage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: ++calls } } }),
  });
  const [defaults, gmail, gmailAgain] = await Promise.all([
    fetchClaudeRateLimits({ queryImpl, subscription: 'default' }),
    fetchClaudeRateLimits({ queryImpl, subscription: 'gmail' }),
    fetchClaudeRateLimits({ queryImpl, subscription: 'gmail' }),
  ]);
  assert.equal(calls, 2);
  assert.notEqual(dirs[0], dirs[1]);
  assert.equal(dirs[1], resolveClaudeSubscription('gmail').configDir);
  assert.notDeepEqual(defaults.rateLimits, gmail.rateLimits);
  assert.equal(gmail, gmailAgain);
  assert.equal(await fetchClaudeRateLimits({ queryImpl, subscription: 'default' }), defaults);
  assert.equal(calls, 2);
});

test('expired quota snapshots are fetched again', async () => {
  const now = Date.now;
  let time = now();
  Date.now = () => time;
  let calls = 0;
  try {
    const queryImpl = fakeQuery({ readUsage: async () => ({ rate_limits_available: true, rate_limits: { five_hour: { utilization: ++calls } } }) });
    await fetchClaudeRateLimits({ queryImpl });
    time += 60_001;
    const refreshed = await fetchClaudeRateLimits({ queryImpl });
    assert.equal(refreshed.rateLimits.five_hour.utilization, 2);
  } finally {
    Date.now = now;
  }
});

test('accounts without plan quotas and older SDKs return unavailable usage', async () => {
  let closed = 0;
  const unsupported = await fetchClaudeRateLimits({
    queryImpl: fakeQuery({ onClose: () => { closed++; } }),
  });
  const apiAccount = await fetchClaudeRateLimits({
    subscription: 'gmail',
    queryImpl: fakeQuery({
      readUsage: async () => ({ rate_limits_available: false, rate_limits: { five_hour: { utilization: 99 } } }),
      onClose: () => { closed++; },
    }),
  });
  assert.equal(unsupported.rateLimits, null);
  assert.equal(apiAccount.rateLimits, null);
  assert.equal(closed, 2);
});

test('a failing account closes its CLI and cannot repeatedly spawn during the cache window', async () => {
  let spawns = 0;
  let closed = 0;
  const queryImpl = fakeQuery({
    onSpawn: () => { spawns++; },
    onClose: () => { closed++; },
    readUsage: async () => { throw new Error('usage unavailable'); },
  });
  await assert.rejects(fetchClaudeRateLimits({ queryImpl }), /usage unavailable/);
  await assert.rejects(fetchClaudeRateLimits({ queryImpl }), /usage unavailable/);
  assert.equal(spawns, 1);
  assert.equal(closed, 1);
});

test('a hung usage lookup times out and terminates the CLI', async () => {
  let closed = false;
  let controller;
  await assert.rejects(fetchClaudeRateLimits({
    timeoutMs: 10,
    queryImpl: fakeQuery({
      onSpawn: (options) => { controller = options.abortController; },
      readUsage: () => new Promise(() => {}),
      onClose: () => { closed = true; },
    }),
  }), /timed out/);
  assert.equal(closed, true);
  assert.equal(controller.signal.aborted, true);
});

test('unknown subscriptions fail before starting any CLI', async () => {
  let spawned = false;
  await assert.rejects(fetchClaudeRateLimits({
    subscription: 'unknown',
    queryImpl: () => { spawned = true; },
  }), /unknown Claude subscription/);
  assert.equal(spawned, false);
});

test('Claude turns reuse fresh account quota, then refresh it after 60 seconds', async (t) => {
  const originalNow = Date.now;
  let time = originalNow();
  Date.now = () => time;
  t.after(() => { Date.now = originalNow; });
  let reads = 0;
  const queryHandle = { async usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET(args) {
    assert.deepEqual(args, { skipBehaviors: true });
    return { rate_limits_available: true, rate_limits: { five_hour: { utilization: ++reads } } };
  } };
  const first = await fetchClaudeRateLimits({ subscription: 'gmail', queryHandle, refresh: true });
  time += 59_999;
  assert.equal(await fetchClaudeRateLimits({ subscription: 'gmail', queryHandle, refresh: true }), first);
  assert.equal(reads, 1);
  time += 1;
  const updated = await fetchClaudeRateLimits({ subscription: 'gmail', queryHandle, refresh: true });
  assert.equal(updated.rateLimits.five_hour.utilization, 2);
  const launcher = await fetchClaudeRateLimits({ subscription: 'gmail', queryImpl() { throw new Error('must reuse the live account cache'); } });
  assert.equal(launcher, updated);
  assert.equal(reads, 2);
});
