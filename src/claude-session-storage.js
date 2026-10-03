import { Worker } from 'node:worker_threads';
import { getSessionMessages, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { claudeSubscriptionEnv, isDefaultClaudeSubscription } from './claude-subscriptions.js';

// SDK filesystem helpers read CLAUDE_CONFIG_DIR from process.env and offer
// no per-call config override. Give each operation its own environment so
// concurrent accounts never change the server's environment or SDK caches.
export function claudeStorageOperation(operation, sessionId, options, subscription, { workerUrl = new URL('./claude-session-storage-worker.js', import.meta.url), timeoutMs = 60_000, env: envOverride } = {}) {
  // The default account is the server's own environment, so no isolation
  // (and no per-call SDK re-import) is needed.
  if (isDefaultClaudeSubscription(subscription)) {
    if (operation === 'messages') return getSessionMessages(sessionId, options);
    if (operation === 'fork') return forkSession(sessionId, options);
    return Promise.reject(new Error('unknown Claude session storage operation'));
  }
  const env = envOverride ?? claudeSubscriptionEnv(subscription);
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerUrl, {
      env, workerData: { operation, sessionId, options }, execArgv: [],
    });
    const timer = setTimeout(() => finish(new Error('Claude session storage operation timed out')), timeoutMs);
    let settled = false;
    function finish(error, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.on('error', () => {}); // a late crash after our reply must not become an unhandled 'error'
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    }
    worker.once('message', (result) => finish(result.error ? new Error(result.error) : null, result.value));
    worker.once('error', (error) => finish(error));
    // 'message' and 'exit' are unordered; a clean exit may precede delivery of the reply, so only a crash is fatal here (the timer covers a silent clean exit).
    worker.once('exit', (code) => { if (code !== 0) finish(new Error(`Claude session storage worker exited before replying (${code})`)); });
  });
}
