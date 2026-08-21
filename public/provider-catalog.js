// Small, browser-side provider catalog. The server may still return the
// legacy `{ providers: ['claude', 'grok'] }` shape, or enrich it with either
// provider objects, a `providerDetails` array, or a `details` map. Keeping
// that compatibility here means
// the rest of the launcher never needs to treat "not Grok" as Claude.

const BUILT_INS = Object.freeze({
  claude: Object.freeze({ id: 'claude', label: 'Claude' }),
  grok: Object.freeze({ id: 'grok', label: 'Grok' }),
});

function readableLabel(id) {
  return String(id)
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ') || 'Provider';
}

function validId(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function detailFor(id, detail) {
  const builtIn = BUILT_INS[id] || {};
  const source = detail && typeof detail === 'object' ? detail : {};
  return { ...builtIn, ...source, id, label: typeof source.label === 'string' && source.label ? source.label : (builtIn.label || readableLabel(id)) };
}

// Normalizes all supported /api/providers payload variants to provider
// descriptors. Unknown IDs deliberately remain present: a newer server can
// advertise Codex to an older browser without it being mislabeled Claude.
export function normalizeProviderCatalog(payload) {
  const rawProviders = Array.isArray(payload?.providers) ? payload.providers : [];
  const details = payload?.details && typeof payload.details === 'object' ? payload.details : {};
  const providerDetails = Array.isArray(payload?.providerDetails) ? payload.providerDetails : [];
  const entries = rawProviders.length ? rawProviders : (providerDetails.length ? providerDetails : Object.keys(details));
  const byId = new Map();
  for (const entry of entries) {
    const id = typeof entry === 'string' ? entry : entry?.id;
    if (!validId(id)) continue;
    const metadata = typeof entry === 'object'
      ? entry
      : providerDetails.find((detail) => detail?.id === id) || details[id];
    byId.set(id, detailFor(id, metadata));
  }
  return byId;
}

export function createProviderCatalog(payload) {
  const providers = normalizeProviderCatalog(payload);

  function add(provider) {
    const id = typeof provider === 'string' ? provider : provider?.id;
    if (!validId(id)) return null;
    const existing = providers.get(id);
    const details = typeof provider === 'object' ? provider : existing;
    const descriptor = detailFor(id, { ...existing, ...details });
    providers.set(id, descriptor);
    return descriptor;
  }

  function get(id) {
    return validId(id) ? providers.get(id) || null : null;
  }

  function has(id) {
    return Boolean(get(id));
  }

  function list() {
    return [...providers.values()];
  }

  function label(id) {
    return get(id)?.label || (validId(id) ? readableLabel(id) : 'Provider');
  }

  // A missing selection can sensibly fall back to the first available
  // provider. An explicitly invalid ID is never remapped to Claude.
  function validate(id, { fallback = null } = {}) {
    if (has(id)) return id;
    if (id !== undefined && id !== null && id !== '') return null;
    if (fallback && has(fallback)) return fallback;
    return list()[0]?.id || null;
  }

  return { add, get, has, list, label, validate };
}
