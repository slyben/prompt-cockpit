import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAccountUsageCache, ACCOUNT_USAGE_REFRESH_MS } from '../src/account-usage-cache.js';

test('concurrent account reads share one request and fresh launcher reads reuse its snapshot', async () => {
  let time = 100_000;
  const cache = createAccountUsageCache({ now: () => time });
  let reads = 0;
  const read = async () => ({ five_hour: { utilization: ++reads } });
  const [first, second] = await Promise.all([cache.fetch('claude:default', read), cache.fetch('claude:default', read, { refresh: true })]);
  assert.equal(first, second);
  assert.equal(reads, 1);
  assert.equal(await cache.fetch('claude:default', read), first);
  time += ACCOUNT_USAGE_REFRESH_MS - 1;
  assert.equal(await cache.fetch('claude:default', read, { refresh: true }), first);
  assert.equal(reads, 1, 'a completed turn cannot bypass a value less than 60 seconds old');
  time += 1;
  assert.equal((await cache.fetch('claude:default', read, { refresh: true })).rateLimits.five_hour.utilization, 2);
});

test('completed turns update all subscribers; new sessions inherit the cached account quota', async () => {
  let time = 100_000;
  const cache = createAccountUsageCache({ now: () => time });
  const first = [];
  const second = [];
  cache.subscribe('claude:default', (value) => first.push(value));
  const unsubscribe = cache.subscribe('claude:default', (value) => second.push(value));
  await cache.fetch('claude:default', async () => ({ five_hour: { utilization: 12 } }));
  const joined = [];
  cache.subscribe('claude:default', (value) => joined.push(value));
  assert.equal(joined[0], first[0]);
  unsubscribe();
  time += ACCOUNT_USAGE_REFRESH_MS;
  await cache.fetch('claude:default', async () => ({ five_hour: { utilization: 15 } }), { refresh: true });
  assert.equal(first.at(-1).rateLimits.five_hour.utilization, 15);
  assert.equal(joined.at(-1), first.at(-1));
  assert.equal(second.length, 1);
});

test('account and provider keys keep subscription quotas separate', async () => {
  const cache = createAccountUsageCache();
  await cache.fetch('claude:default', async () => ({ five_hour: { utilization: 12 } }));
  await cache.fetch('claude:gmail', async () => ({ five_hour: { utilization: 29 } }));
  await cache.fetch('codex:default', async () => ({ five_hour: { utilization: 68 } }));
  for (const [key, expected] of [['claude:default', 12], ['claude:gmail', 29], ['codex:default', 68]]) {
    const value = await cache.fetch(key, () => { throw new Error('unexpected refresh'); });
    assert.equal(value.rateLimits.five_hour.utilization, expected);
  }
});

test('failed refreshes retain the last quota and back off repeated turn updates', async () => {
  let time = 100_000;
  const cache = createAccountUsageCache({ now: () => time });
  const first = await cache.fetch('account', async () => ({ five_hour: { utilization: 42 } }));
  let failures = 0;
  const failing = async () => { failures++; throw new Error('offline'); };
  time += ACCOUNT_USAGE_REFRESH_MS;
  assert.equal(await cache.fetch('account', failing, { refresh: true }), first);
  assert.equal(await cache.fetch('account', failing, { refresh: true }), first);
  assert.equal(failures, 1);
  time += ACCOUNT_USAGE_REFRESH_MS + 1;
  assert.equal((await cache.fetch('account', async () => ({ five_hour: { utilization: 43 } }), { refresh: true })).rateLimits.five_hour.utilization, 43);
});

test('a hung account read times out, while other accounts can still refresh', async () => {
  const cache = createAccountUsageCache({ timeoutMs: 10 });
  await assert.rejects(cache.fetch('hung', () => new Promise(() => {})), /timed out/);
  assert.equal((await cache.fetch('healthy', async () => null)).rateLimits, null);
});

test('a failed subscriber cannot block other sessions receiving the quota', async () => {
  const cache = createAccountUsageCache();
  cache.subscribe('account', () => { throw new Error('closed websocket'); });
  let received;
  cache.subscribe('account', (value) => { received = value; });
  const result = await cache.fetch('account', async () => ({ five_hour: { utilization: 11 } }));
  assert.equal(received, result);
});

test('launcher refreshes reuse a live account reader, then fall back when that session closes', async () => {
  let time = 100_000;
  const cache = createAccountUsageCache({ now: () => time });
  let liveReads = 0;
  let fallbackReads = 0;
  const unsubscribe = cache.subscribe('account', () => {}, async () => ({ five_hour: { utilization: ++liveReads } }));
  const fallback = async () => { fallbackReads++; return null; };
  assert.equal((await cache.fetch('account', fallback)).rateLimits.five_hour.utilization, 1);
  assert.equal(fallbackReads, 0);
  time += ACCOUNT_USAGE_REFRESH_MS + 1;
  await cache.fetch('account', fallback);
  assert.equal(liveReads, 2);
  unsubscribe();
  time += ACCOUNT_USAGE_REFRESH_MS + 1;
  assert.equal((await cache.fetch('account', fallback)).rateLimits, null);
  assert.equal(fallbackReads, 1);
});
