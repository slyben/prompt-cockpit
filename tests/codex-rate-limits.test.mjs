import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { accountUsageCache } from '../src/account-usage-cache.js';
import { fetchCodexRateLimits } from '../src/codex-rate-limits.js';

beforeEach(() => accountUsageCache.clear());

test('Codex launcher usage normalizes native windows and shares concurrent/cached reads', async () => {
  let calls = 0;
  const manager = { async request(method, params) {
    calls++;
    assert.equal(method, 'account/rateLimits/read');
    assert.equal(params, null);
    return { rateLimits: { primary: { usedPercent: 14, resetsAt: 1788796894 }, secondary: { usedPercent: 18, resetsAt: 1789335920 } } };
  } };
  const [first, second] = await Promise.all([fetchCodexRateLimits({ manager }), fetchCodexRateLimits({ manager })]);
  assert.equal(first, second);
  assert.deepEqual(first.rateLimits, {
    five_hour: { utilization: 14, resets_at: 1788796894000 },
    seven_day: { utilization: 18, resets_at: 1789335920000 },
  });
  assert.equal(await fetchCodexRateLimits({ manager }), first);
  assert.equal(calls, 1);
});

test('Codex turns reuse fresh account quota, then refresh it after 60 seconds', async (t) => {
  const originalNow = Date.now;
  let time = originalNow();
  Date.now = () => time;
  t.after(() => { Date.now = originalNow; });
  let calls = 0;
  const queryHandle = { async codexRateLimits() { calls++; return { five_hour: { utilization: calls } }; } };
  const first = await fetchCodexRateLimits({ queryHandle, refresh: true });
  time += 59_999;
  assert.equal(await fetchCodexRateLimits({ queryHandle, refresh: true }), first);
  assert.equal(calls, 1);
  time += 1;
  const updated = await fetchCodexRateLimits({ queryHandle, refresh: true });
  assert.equal(updated.rateLimits.five_hour.utilization, 2);
  const fromLauncher = await fetchCodexRateLimits({ manager: { request() { throw new Error('must reuse live cache'); } } });
  assert.equal(fromLauncher, updated);
});
