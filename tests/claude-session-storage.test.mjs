import test from 'node:test';
import assert from 'node:assert/strict';
import { claudeStorageOperation } from '../src/claude-session-storage.js';

const sub = 'named';
const fx = (n) => new URL(`./fixtures/${n}`, import.meta.url);
const run = (n, timeoutMs) => claudeStorageOperation('messages', 's', {}, sub, { workerUrl: fx(n), timeoutMs, env: { ...process.env } });

test('clean exit after a large reply still resolves', async () => {
  assert.equal((await run('storage-worker-ok.mjs')).length, 5_000_000);
});
test('non-zero exit without reply rejects', async () => {
  await assert.rejects(run('storage-worker-crash.mjs'), /exited before replying \(3\)/);
});
test('silent clean exit rejects via timeout', async () => {
  await assert.rejects(run('storage-worker-silent.mjs', 300), /timed out/);
});
