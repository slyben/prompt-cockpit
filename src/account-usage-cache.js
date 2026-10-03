// Account quota is shared across projects, sessions and launcher tabs.
// All reads, including completed turns, reuse it for at least one minute.
export const ACCOUNT_USAGE_REFRESH_MS = 60_000;

export function createAccountUsageCache({ now = () => Date.now(), timeoutMs = 20_000 } = {}) {
  const entries = new Map();

  function entryFor(key) {
    if (!entries.has(key)) entries.set(key, { result: null, error: null, pending: null, nextReadAtMs: 0, listeners: new Set(), readers: new Set() });
    return entries.get(key);
  }

  async function fetch(key, read, { refresh = false } = {}) {
    const entry = entryFor(key);
    if (entry.pending) return entry.pending;
    if (entry.nextReadAtMs > now()) {
      if (entry.result) return entry.result;
      throw entry.error;
    }
    entry.pending = Promise.resolve().then(async () => {
      let timer;
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            // Launcher refreshes reuse an active session's CLI instead of
            // spawning a throwaway one. A turn uses its own completed query.
            const activeRead = !refresh && Array.from(entry.readers).at(-1);
            return (activeRead || read)();
          }),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Account usage lookup timed out')), timeoutMs);
          }),
        ]);
      } finally { clearTimeout(timer); }
    }).then((rateLimits) => {
      entry.result = { rateLimits, fetchedAtMs: now() };
      entry.error = null;
      entry.nextReadAtMs = entry.result.fetchedAtMs + ACCOUNT_USAGE_REFRESH_MS;
      for (const listener of entry.listeners) {
        try { listener(entry.result); } catch { /* A closed client cannot break shared quota updates. */ }
      }
      return entry.result;
    }).catch((error) => {
      // Retain the last good snapshot and back off failures even when a
      // burst of completed turns asks for refreshes on the same account.
      entry.error = error;
      entry.nextReadAtMs = now() + ACCOUNT_USAGE_REFRESH_MS;
      if (entry.result) return entry.result;
      throw error;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  }

  function subscribe(key, listener, read) {
    const entry = entryFor(key);
    entry.listeners.add(listener);
    if (read) entry.readers.add(read);
    if (entry.result) listener(entry.result);
    return () => {
      entry.listeners.delete(listener);
      if (read) entry.readers.delete(read);
    };
  }

  function clear() {
    for (const entry of entries.values()) {
      entry.listeners.clear();
      entry.readers.clear();
    }
    entries.clear();
  }

  return { fetch, subscribe, clear };
}

export const accountUsageCache = createAccountUsageCache();
