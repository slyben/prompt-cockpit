// Launcher's Claude model catalog: no standalone "list models" RPC exists in
// the Agent SDK (unlike Codex's app-server model/list), so this spawns a
// throwaway CLI process the same way session.js's real sessions do - push
// the priming sentinel to unblock system/init without spending a real turn
// (see .claude/memory/sdk-streaming-input-gotchas.md), then read
// Query.supportedModels() off it and tear the process down. Confirmed live
// (2026-09-23) that this returns only the current-generation aliases
// (default/opus/sonnet/haiku/fable), not older pinned snapshots - hence
// LEGACY_MODELS below to cover the ones a user might explicitly want.
import { query } from '@anthropic-ai/claude-agent-sdk';

// Pinned older models the live alias catalog never surfaces (aliases always
// resolve to the current generation). IDs and descriptions from Anthropic's
// published model table. Update this list by hand when a model here is
// retired or a new "one generation back" pin becomes worth offering.
const LEGACY_MODELS = [
  { value: 'claude-opus-5', displayName: 'Opus 5', description: 'Previous-generation Opus, pinned' },
  { value: 'claude-opus-4-8', displayName: 'Opus 4.8', description: 'Pinned older model' },
  { value: 'claude-opus-4-7', displayName: 'Opus 4.7', description: 'Pinned older model' },
  { value: 'claude-opus-4-6', displayName: 'Opus 4.6', description: 'Pinned older model' },
  { value: 'claude-sonnet-4-6', displayName: 'Sonnet 4.6', description: 'Pinned older model' },
];

// Cached for the life of the process - a fresh CLI spawn per launcher open
// would add real latency for no benefit; a server restart (or picking up a
// new CLI version) is the natural point to re-discover.
let cachedModels = null;

function primingSentinelIterable() {
  let sent = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (sent) return new Promise(() => {}); // nothing more to send; hang until interrupt() tears the process down
          sent = true;
          return Promise.resolve({
            done: false,
            value: {
              type: 'user',
              message: { role: 'user', content: '' },
              parent_tool_use_id: null,
              shouldQuery: false,
              isSynthetic: true,
            },
          });
        },
      };
    },
  };
}

async function discoverLiveModels(queryImpl) {
  const handle = queryImpl({ prompt: primingSentinelIterable(), options: {} });
  try {
    for await (const message of handle) {
      if (message.type === 'result' && message.num_turns === 0) {
        return await handle.supportedModels();
      }
    }
    throw new Error('Claude CLI closed before completing its init handshake');
  } finally {
    await handle.interrupt?.().catch(() => {});
  }
}

export async function listClaudeModels({ queryImpl = query } = {}) {
  if (cachedModels) return cachedModels;
  const live = await discoverLiveModels(queryImpl);
  const known = new Set(live.map((m) => m.resolvedModel || m.value));
  const legacy = LEGACY_MODELS
    .filter((m) => !known.has(m.value))
    .map((m) => ({ ...m, resolvedModel: m.value }));
  cachedModels = [...live, ...legacy];
  return cachedModels;
}

// Test-only: the in-memory cache is intentional for real usage (a CLI spawn
// per launcher open would be wasteful), but tests need to exercise more than
// one queryImpl per process.
export function _resetCacheForTests() {
  cachedModels = null;
}
