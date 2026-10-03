import { parentPort, workerData } from 'node:worker_threads';
import { getSessionMessages, forkSession } from '@anthropic-ai/claude-agent-sdk';

try {
  const { operation, sessionId, options } = workerData;
  if (!['messages', 'fork'].includes(operation)) throw new Error('unknown Claude session storage operation');
  const value = await (operation === 'messages' ? getSessionMessages : forkSession)(sessionId, options);
  parentPort.postMessage({ value });
} catch (error) {
  parentPort.postMessage({ error: String(error.message || error) });
}
