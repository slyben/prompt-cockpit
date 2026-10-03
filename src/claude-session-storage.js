import { Worker } from 'node:worker_threads';
import { getSessionMessages, forkSession } from '@anthropic-ai/claude-agent-sdk';
import { claudeSubscriptionEnv, isDefaultClaudeSubscription } from './claude-subscriptions.js';

// SDK filesystem helpers read CLAUDE_CONFIG_DIR from process.env and offer
// no per-call config override. Give each operation its own environment so
// concurrent accounts never change the server's environment or SDK caches.
export function claudeStorageOperation(operation, sessionId, options, subscription) {
  // The default account is the server's own environment, so no isolation
  // (and no per-call SDK re-import) is needed.
  if (isDefaultClaudeSubscription(subscription)) {
    if (operation === 'messages') return getSessionMessages(sessionId, options);
    if (operation === 'fork') return forkSession(sessionId, options);
    return Promise.reject(new Error('unknown Claude session storage operation'));
  }
  const env = claudeSubscriptionEnv(subscription);
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./claude-session-storage-worker.js', import.meta.url), {
      env, workerData: { operation, sessionId, options }, execArgv: [],
    });
    const timer = setTimeout(() => finish(new Error('Claude session storage operation timed out')), 60_000);
    function finish(error, value) {
      clearTimeout(timer);
      worker.removeAllListeners();
      worker.on('error', () => {}); // a late crash after our reply must not become an unhandled 'error'
      void worker.terminate();
      if (error) reject(error);
      else resolve(value);
    }
    worker.once('message', (result) => finish(result.error ? new Error(result.error) : null, result.value));
    worker.once('error', (error) => finish(error));
    worker.once('exit', (code) => finish(new Error(`Claude session storage worker exited before replying (${code})`)));
  });
}
