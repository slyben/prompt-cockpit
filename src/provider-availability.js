// Which providers actually exist on this machine, checked once at server
// launch (not per-request - see registerSystemRoutes' /api/providers). The
// frontend hides a provider's UI entirely when it's not in this list (e.g.
// no Grok dropdown if the `grok` CLI isn't installed). Add a future LLM
// here by giving it an entry in PROVIDER_CHECKS; claude is the host CLI
// this app is built into, so it's always available.
import { isGrokAvailable } from './grok-cli.js';

const PROVIDER_CHECKS = {
  claude: async () => true,
  grok: isGrokAvailable,
};

let cachedPromise = null;

async function computeAvailableProviders() {
  const entries = await Promise.all(
    Object.entries(PROVIDER_CHECKS).map(async ([name, check]) => {
      let ok = false;
      try {
        ok = await check();
      } catch {
        ok = false;
      }
      return [name, ok];
    }),
  );
  return entries.filter(([, ok]) => ok).map(([name]) => name);
}

// Cached for the process lifetime - "on launch (only)" per the ask. Pass
// force:true (tests only) to bypass the cache.
export function availableProviders({ force = false } = {}) {
  if (force || !cachedPromise) {
    cachedPromise = computeAvailableProviders();
  }
  return cachedPromise;
}
