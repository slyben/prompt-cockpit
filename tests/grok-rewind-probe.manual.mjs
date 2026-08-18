// Probe the live Grok ACP methods the cockpit uses. Not run by npm test.
// node tests/grok-rewind-probe.manual.mjs
import { randomUUID } from 'node:crypto';
import { spawnGrokAgent, killGrokProcess } from '../src/grok-acp.js';

const cwd = process.cwd();
const { client, proc, getStderr } = spawnGrokAgent({ cwd });

try {
  await client.request('initialize', {
    protocolVersion: 1,
    clientCapabilities: { _meta: { 'x.ai/rewind': true, 'x.ai/session': true } },
    clientInfo: { name: 'cockpit-probe', version: '0.1.0' },
  });
  const created = await client.request('session/new', { cwd, mcpServers: [] });
  const sessionId = created.sessionId;
  const newSessionId = randomUUID();

  const checks = [
    ['session/set_mode', { sessionId, modeId: 'low' }],
    ['session/set_model', { sessionId, modelId: 'grok-4.6' }],
    ['_x.ai/rewind/points', { sessionId }],
    ['_x.ai/session/fork', { sourceSessionId: sessionId, sourceCwd: cwd, newCwd: cwd, newSessionId }],
  ];
  for (const [method, params] of checks) {
    try {
      const result = await client.request(method, params, { timeoutMs: 15000 });
      console.log('OK', method, JSON.stringify(result).slice(0, 400));
    } catch (err) {
      console.log('ERR', method, String(err.message || err));
    }
  }
} finally {
  killGrokProcess(proc);
  if (getStderr()) console.log('stderr', getStderr().slice(-400));
}
