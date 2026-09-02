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
  assert.equal(parseProvider('codex').id, 'codex');
  assert.throws(() => parseProvider(''), InvalidProviderError);
  assert.throws(() => parseProvider({ id: 'claude' }), InvalidProviderError);
});

test('descriptors own launch, history, and capability metadata', () => {
  const ids = listProviders().map(({ id }) => id);
  assert.deepEqual(ids, ['claude', 'grok', 'codex']);

  const claude = getProvider('claude');
  const grok = getProvider('grok');
  const codex = getProvider('codex');
  assert.equal(typeof claude.startSession, 'function');
  assert.equal(typeof claude.listResumableSessions, 'function');
  assert.equal(typeof claude.fetchHistory, 'function');
  assert.equal(claude.capabilities.thinkingBudget, true);
  assert.equal(grok.capabilities.thinkingBudget, false);
  assert.equal(claude.capabilities.pluginToggleViaHandle, false);
  assert.equal(grok.capabilities.pluginToggleViaHandle, true);
  // pluginToggleViaHandle: false alone used to mean "assume Claude's file
  // fallback" - pluginToggleViaFile makes that explicit so a provider with
  // neither (Codex, below) is distinguishable from "supports plugins, just
  // not live".
  assert.equal(claude.capabilities.pluginToggleViaFile, true);
  assert.equal(grok.capabilities.pluginToggleViaFile, false);
  assert.equal(typeof codex.startSession, 'function');
  assert.equal(typeof codex.listResumableSessions, 'function');
  assert.equal(typeof codex.fetchHistory, 'function');
  assert.equal(codex.capabilities.conversationFork, false);
  assert.equal(codex.capabilities.mcpToggle, false);
  assert.equal(codex.capabilities.pluginToggleViaHandle, false);
  assert.equal(codex.capabilities.pluginToggleViaFile, false);
  assert.ok(codex.efforts.includes('high'));

  // Only Claude's approval responses can persist an "always allow" choice
  // across a restart (permission-rules.js) - Grok's ACP replies and Codex's
  // app-server decisions both only ever carry a turn/session-scoped grant.
  assert.equal(claude.capabilities.projectPersistentApprovals, true);
  assert.equal(grok.capabilities.projectPersistentApprovals, false);
  assert.equal(codex.capabilities.projectPersistentApprovals, false);

  assert.deepEqual(providerDetails('grok'), {
    id: 'grok',
    label: 'Grok',
    capabilities: { ...grok.capabilities },
    launch: {
      efforts: ['low', 'medium', 'high', 'xhigh'],
      models: grok.models,
      effortOptions: grok.effortOptions,
    },
  });

  // Codex defines neither a static model catalog nor effort-option labels
  // (its launcher falls back to the generic value-list rendering) - launch
  // stays exactly `{ efforts }`, no empty models/effortOptions arrays.
  assert.deepEqual(providerDetails('codex').launch, { efforts: codex.efforts });
});

test('codex.resolveEfforts narrows to the current model\'s supported values, falling back to the static list', async () => {
  const codex = getProvider('codex');

  const modelSpecific = await codex.resolveEfforts({
    model: 'gpt-5-codex',
    handle: { query: { supportedModels: async () => [
      { value: 'gpt-5-codex', resolvedModel: 'gpt-5-codex', supportedEfforts: ['low', 'medium'] },
      { value: 'gpt-5-codex-mini', resolvedModel: 'gpt-5-codex-mini', supportedEfforts: ['low'] },
    ] } },
  });
  assert.deepEqual(modelSpecific, ['low', 'medium']);

  // A model the catalog doesn't (yet) annotate with supportedEfforts falls
  // back to the advertised superset rather than rejecting everything.
  const noAnnotation = await codex.resolveEfforts({
    model: 'brand-new-model',
    handle: { query: { supportedModels: async () => [{ value: 'brand-new-model', supportedEfforts: null }] } },
  });
  assert.deepEqual(noAnnotation, codex.efforts);

  // A live catalog fetch failure (app-server hiccup) fails closed (null),
  // rather than falling back to the static superset - that fallback used
  // to let session-actions.js's effort route accept a value the current
  // model can't actually honor during exactly the failure this check
  // exists to catch. See session-actions.js's own null handling.
  const fetchFails = await codex.resolveEfforts({
    model: 'gpt-5-codex',
    handle: { query: { supportedModels: async () => { throw new Error('app-server unreachable'); } } },
  });
  assert.equal(fetchFails, null);
});
