import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatSubscriptionLimits, initSubscriptionLimits } from '../public/subscription-limits.js';

function setup(fetchImpl, subscriptions = [{ id: 'default', label: 'Default' }, { id: 'gmail', label: 'Gmail' }]) {
  let provider = { id: 'claude', label: 'Claude', launch: { accountLimits: true, subscriptions } };
  let visible = true;
  const selectEl = { options: subscriptions.map((account) => ({ value: account.id, textContent: account.label })), value: 'gmail' };
  const timers = [];
  const cleared = [];
  const panel = initSubscriptionLimits({
    selectEl, getProvider: () => provider, fetchImpl,
    shouldRefresh: () => visible,
    setIntervalImpl(callback, ms) { const timer = { callback, ms }; timers.push(timer); return timer; },
    clearIntervalImpl(timer) { cleared.push(timer); },
  });
  return {
    panel, selectEl, timers, cleared,
    setVisible(value) { visible = value; },
    setProvider(value) { provider = value; },
  };
}
const response = (rateLimits) => ({ ok: true, json: async () => ({ rateLimits }) });

test('session and weekly percentages show already used amounts and local reset times', () => {
  const parts = formatSubscriptionLimits({
    five_hour: { utilization: 42.3, resets_at: new Date(2026, 9, 3, 16, 50).toISOString() },
    seven_day: { utilization: 71, resets_at: new Date(2026, 9, 5, 10, 45).toISOString() },
  });
  assert.deepEqual(parts.map((part) => part.text), [
    '42% 5h (resets 04:50PM)',
    '71% 7d (resets 2026-10-05)',
  ]);
  assert.match(parts[0].title, /percentage already used/);
});

test('missing quota windows and reset times never produce invented percentages or invalid dates', () => {
  assert.deepEqual(formatSubscriptionLimits(null), []);
  assert.deepEqual(formatSubscriptionLimits({ five_hour: { utilization: null }, seven_day: { utilization: NaN } }), []);
  assert.deepEqual(formatSubscriptionLimits({
    five_hour: { utilization: 0, resets_at: 'invalid' },
    seven_day: { utilization: 100, resets_at: null },
  }).map((part) => part.text), ['0% 5h', '100% 7d']);
});

test('dropdown options include quotas for every account without changing selection', async () => {
  const requests = [];
  const ui = setup(async (url) => {
    requests.push(url);
    return url.includes('subscription=gmail') ? { ok: false, status: 502 } : response({ five_hour: { utilization: 32 } });
  });
  await ui.panel.refresh();
  assert.deepEqual(requests, [
    '/api/providers/claude/limits?subscription=default',
    '/api/providers/claude/limits?subscription=gmail',
  ]);
  assert.equal(ui.selectEl.options[0].textContent, 'Default - 32% 5h');
  assert.equal(ui.selectEl.options[1].textContent, 'Gmail');
  assert.equal(ui.selectEl.value, 'gmail');
});

test('returning to the launcher and the minute timer read the latest shared server cache', async () => {
  let calls = 0;
  const ui = setup(async () => response({ seven_day: { utilization: ++calls } }), [{ id: 'default', label: 'Default' }]);
  await ui.panel.refresh();
  assert.equal(ui.selectEl.options[0].textContent, 'Default - 1% 7d');
  await ui.panel.refresh();
  assert.equal(calls, 2);
  assert.equal(ui.timers.length, 1);
  assert.equal(ui.timers[0].ms, 60_000);
  await ui.timers[0].callback();
  assert.equal(ui.selectEl.options[0].textContent, 'Default - 3% 7d');
});

test('providers without quota support stop polling without fetching', async () => {
  let calls = 0;
  const ui = setup(async () => { calls++; return response(null); });
  await ui.panel.refresh();
  ui.setProvider({ id: 'grok', launch: {} });
  await ui.panel.refresh();
  assert.equal(calls, 2);
  assert.equal(ui.cleared.length, 1);
});

test('concurrent refreshes reuse one request and a provider switch discards stale display updates', async () => {
  const requests = [];
  const ui = setup(() => new Promise((resolve) => requests.push(resolve)), [{ id: 'default', label: 'Default' }]);
  const first = ui.panel.refresh();
  const second = ui.panel.refresh();
  assert.equal(requests.length, 1);
  ui.setProvider({ id: 'grok', launch: {} });
  await ui.panel.refresh();
  ui.selectEl.options = [{ value: 'default', textContent: 'New option' }];
  requests[0](response({ five_hour: { utilization: 90 } }));
  await Promise.all([first, second]);
  assert.equal(ui.selectEl.options[0].textContent, 'New option');
});

test('Codex quota uses its default account without inventing a subscription ID', async () => {
  let requested;
  const ui = setup(async (url) => { requested = url; return response({ five_hour: { utilization: 9 } }); });
  ui.setProvider({ id: 'codex', label: 'Codex', launch: { accountLimits: true } });
  ui.selectEl.options = [{ value: '', textContent: 'Codex' }];
  await ui.panel.refresh();
  assert.equal(requested, '/api/providers/codex/limits');
  assert.equal(ui.selectEl.options[0].textContent, 'Codex - 9% 5h');
});

test('polling skips hidden/session screens and retains the last quota when refresh fails', async () => {
  let calls = 0;
  const ui = setup(async () => {
    calls++;
    if (calls > 1) throw new Error('offline');
    return response({ five_hour: { utilization: 42 } });
  }, [{ id: 'default', label: 'Default' }]);
  await ui.panel.refresh();
  ui.setVisible(false);
  await ui.timers[0].callback();
  assert.equal(calls, 1);
  ui.setVisible(true);
  await ui.timers[0].callback();
  assert.equal(calls, 2);
  assert.equal(ui.selectEl.options[0].textContent, 'Default - 42% 5h');
  ui.panel.destroy();
  assert.equal(ui.cleared.length, 1);
});
