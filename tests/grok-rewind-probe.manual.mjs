// Probe Grok ACP rewind/fork methods. Not run by npm test.
// node tests/grok-rewind-probe.manual.mjs
import { spawnGrokAgent } from '../src/grok-acp.js';

const cwd = process.cwd();
const { client, proc, getStderr } = spawnGrokAgent({ cwd, model: 'grok-4.5' });

function timeout(ms) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(`timeout ${ms}`)), ms));
}

try {
  const init = await Promise.race([
    client.request('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        _meta: { 'x.ai/rewind': true, 'x.ai/session': true },
      },
      clientInfo: { name: 'cockpit-probe', version: '0.1.0' },
    }),
    timeout(20000),
  ]);
  console.log('initialize keys', Object.keys(init || {}));
  console.log(JSON.stringify(init, null, 2).slice(0, 4000));

  const existing = '01a00b6f-94ca-76a2-853c-3485b37434b9';
  try {
    await client.request('session/load', { sessionId: existing, cwd, mcpServers: [] });
    console.log('loaded', existing);
  } catch (err) {
    console.log('load failed', String(err.message || err));
  }
  const sessionId = existing;

  const attempts = [
    ['session/set_model', { sessionId, modelId: 'grok-4.5' }],
    ['session/set_reasoning_effort', { sessionId, effort: 'low' }],
    ['session/set_effort', { sessionId, effort: 'low' }],
    ['_x.ai/session/reasoning_effort', { sessionId, effort: 'low' }],
    ['session/set_config_option', { sessionId, configOption: { id: 'effort', value: 'low' } }],
    ['session/set_config_option', { sessionId, option: { name: 'effort', value: 'low' } }],
  ];
  for (const [method, params] of attempts) {
    try {
      const result = await Promise.race([
        client.request(method, params),
        timeout(15000),
      ]);
      console.log(method, JSON.stringify(params), 'OK', JSON.stringify(result).slice(0, 800));
    } catch (err) {
      console.log(method, JSON.stringify(params), 'ERR', String(err.message || err));
    }
  }
} finally {
  try { proc.kill(); } catch { /* gone */ }
  if (getStderr()) console.log('stderr', getStderr().slice(-500));
}
