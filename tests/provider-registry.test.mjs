import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InvalidProviderError,
  getProvider,
  listProviders,
  parseProvider,
  providerDetails,
} from '../src/provider-registry.js';

test('provider parsing defaults only when omitted and rejects an explicit unknown value', () => {
  assert.equal(parseProvider().id, 'claude');
  assert.equal(parseProvider(null).id, 'claude');
  assert.equal(parseProvider('grok').id, 'grok');
  assert.throws(() => parseProvider('codex'), InvalidProviderError);
  assert.throws(() => parseProvider(''), InvalidProviderError);
  assert.throws(() => parseProvider({ id: 'claude' }), InvalidProviderError);
});

test('descriptors own launch, history, and capability metadata', () => {
  const ids = listProviders().map(({ id }) => id);
  assert.deepEqual(ids, ['claude', 'grok']);

  const claude = getProvider('claude');
  const grok = getProvider('grok');
  assert.equal(typeof claude.startSession, 'function');
  assert.equal(typeof claude.listResumableSessions, 'function');
  assert.equal(typeof claude.fetchHistory, 'function');
  assert.equal(claude.capabilities.thinkingBudget, true);
  assert.equal(grok.capabilities.thinkingBudget, false);
  assert.equal(claude.capabilities.pluginToggleViaHandle, false);
  assert.equal(grok.capabilities.pluginToggleViaHandle, true);

  assert.deepEqual(providerDetails('grok'), {
    id: 'grok',
    label: 'Grok',
    capabilities: { ...grok.capabilities },
    launch: { efforts: ['low', 'medium', 'high', 'xhigh'] },
  });
});
