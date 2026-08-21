// Provider descriptors are the boundary between Cockpit's shared session
// lifecycle and a provider's native transport/storage.  Adding a provider
// means adding one descriptor here, rather than teaching every route that
// Claude is the fallback for every non-Grok value.
import { startSession } from './session.js';
import { startGrokSession } from './grok-session.js';
import { listResumableSessions } from './session-launcher.js';
import { listGrokSessions } from './grok-launcher.js';
import { fetchSessionHistory } from './session-history.js';
import { fetchGrokSessionHistory } from './grok-history.js';
import { isGrokAvailable } from './grok-cli.js';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
export const GROK_EFFORTS = ['low', 'medium', 'high', 'xhigh'];

const PROVIDERS = Object.freeze({
  claude: Object.freeze({
    id: 'claude',
    label: 'Claude',
    isAvailable: async () => true,
    startSession: startSession,
    listResumableSessions,
    fetchHistory: fetchSessionHistory,
    efforts: CLAUDE_EFFORTS,
    capabilities: Object.freeze({
      fileRewind: true,
      thinkingBudget: true,
      effort: true,
      autoContinue: true,
      mcpToggle: true,
      pluginToggleViaHandle: false,
    }),
  }),
  grok: Object.freeze({
    id: 'grok',
    label: 'Grok',
    isAvailable: isGrokAvailable,
    startSession: startGrokSession,
    listResumableSessions: listGrokSessions,
    fetchHistory: fetchGrokSessionHistory,
    efforts: GROK_EFFORTS,
    capabilities: Object.freeze({
      fileRewind: false,
      thinkingBudget: false,
      effort: true,
      autoContinue: false,
      mcpToggle: true,
      pluginToggleViaHandle: true,
    }),
  }),
});

export class InvalidProviderError extends Error {
  constructor(provider) {
    super(`unknown provider: ${String(provider)}`);
    this.name = 'InvalidProviderError';
    this.code = 'ERR_INVALID_PROVIDER';
  }
}

// Missing provider remains Claude for old clients. Any supplied, unknown
// value is rejected; callers should turn InvalidProviderError into HTTP 400.
export function parseProvider(provider) {
  if (provider === undefined || provider === null) return PROVIDERS.claude;
  if (typeof provider === 'string' && Object.hasOwn(PROVIDERS, provider)) return PROVIDERS[provider];
  throw new InvalidProviderError(provider);
}

export function getProvider(id) {
  return parseProvider(id);
}

export function listProviders() {
  return Object.values(PROVIDERS);
}

export function providerDetails(provider) {
  const descriptor = typeof provider === 'string' ? getProvider(provider) : provider;
  return {
    id: descriptor.id,
    label: descriptor.label,
    capabilities: { ...descriptor.capabilities },
    launch: {
      efforts: [...descriptor.efforts],
    },
  };
}

export async function listAvailableProviders() {
  const checks = await Promise.all(listProviders().map(async (descriptor) => {
    try {
      return [descriptor, await descriptor.isAvailable()];
    } catch {
      return [descriptor, false];
    }
  }));
  return checks.filter(([, available]) => available).map(([descriptor]) => descriptor);
}
