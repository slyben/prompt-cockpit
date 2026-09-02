// Which providers exist on this machine, checked once at server launch
// (not per-request). The frontend hides a provider's UI entirely when
// it's not in this list (e.g. no Grok dropdown if the `grok` CLI isn't
// installed). Add a future LLM by giving it a descriptor in
// provider-registry.js; Claude is always available (the host CLI).
import { listAvailableProviders } from './provider-registry.js';

let cachedPromise = null;

async function computeAvailableProviders() {
  return (await listAvailableProviders()).map(({ id }) => id);
}

// Cached for the process lifetime - "on launch (only)" per the ask. Pass
// force:true (tests only) to bypass the cache.
export function availableProviders({ force = false } = {}) {
  if (force || !cachedPromise) {
    cachedPromise = computeAvailableProviders();
  }
  return cachedPromise;
}
