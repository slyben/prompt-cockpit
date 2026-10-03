function resetLabel(value, weekly) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  if (!weekly) return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }).replace(/\s/g, '');
  const day = String(date.getDate()).padStart(2, '0');
  const month = String(date.getMonth() + 1).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

export function formatSubscriptionLimits(rateLimits) {
  const parts = [];
  for (const [key, label, title, weekly] of [
    ['five_hour', '5h', '5-hour session usage', false],
    ['seven_day', '7d', 'Weekly usage', true],
  ]) {
    const window = rateLimits?.[key];
    if (!Number.isFinite(window?.utilization)) continue;
    const reset = resetLabel(window.resets_at, weekly);
    parts.push({
      text: `${Math.round(window.utilization)}% ${label}${reset ? ` (resets ${reset})` : ''}`,
      title: `${title}: percentage already used${reset ? ' · reset time in your local timezone' : ''}`,
    });
  }
  return parts;
}

export function initSubscriptionLimits({ selectEl, getProvider, shouldRefresh = () => true, fetchImpl = (...args) => fetch(...args), setIntervalImpl = setInterval, clearIntervalImpl = clearInterval }) {
  const refreshMs = 60_000;
  const cached = new Map();
  let generation = 0;
  let timer = null;

  async function load(provider, account) {
    const key = `${provider.id}:${account.id}:${account.configDir || ''}`;
    const previous = cached.get(key);
    if (previous?.pending) return previous.pending;
    // The server serves a snapshot under a minute old and otherwise runs
    // one shared lookup per account, so polling cannot fan out requests.
    const entry = { rateLimits: previous?.rateLimits || null, pending: null };
    entry.pending = (async () => {
      try {
        const params = new URLSearchParams();
        if (account.id) params.set('subscription', account.id);
        const query = params.toString();
        const res = await fetchImpl(`/api/providers/${encodeURIComponent(provider.id)}/limits${query ? `?${query}` : ''}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        entry.rateLimits = data.rateLimits;
      } catch { /* Keep the last known quota if a refresh fails. */ }
      return entry.rateLimits;
    })();
    cached.set(key, entry);
    try { return await entry.pending; } finally { entry.pending = null; }
  }

  async function refresh() {
    const gen = ++generation;
    const provider = getProvider();
    const accounts = provider?.launch?.accountLimits
      ? provider.launch.subscriptions || [{ id: '', label: provider.label }] : [];
    if (!accounts.length) {
      stopTimer();
      return;
    }
    if (timer === null) timer = setIntervalImpl(() => {
      if (shouldRefresh()) return refresh();
    }, refreshMs);
    await Promise.all(accounts.map(async (account) => {
      const rateLimits = await load(provider, account);
      if (gen !== generation) return;
      const option = Array.from(selectEl.options).find((option) => option.value === account.id);
      if (!option) return;
      const parts = formatSubscriptionLimits(rateLimits);
      option.textContent = `${account.label}${parts.length ? ` - ${parts.map((part) => part.text).join(', ')}` : ''}`;
      option.title = [account.configDir, ...parts.map((part) => part.title)].filter(Boolean).join('\n');
    }));
  }

  function stopTimer() {
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
  }

  return { refresh, destroy() { generation++; stopTimer(); } };
}
