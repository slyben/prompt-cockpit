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
  assert.equal(codex.capabilities.conversationFork, true);
  assert.equal(claude.capabilities.rewindIncludesSelectedTurn, false);
  assert.equal(grok.capabilities.rewindIncludesSelectedTurn, false);
  assert.equal(codex.capabilities.rewindIncludesSelectedTurn, true);
  assert.equal(typeof codex.rewind, 'function');
  assert.equal(codex.capabilities.mcpToggle, true);
  assert.equal(codex.capabilities.pluginToggleViaHandle, true);
  assert.equal(codex.capabilities.pluginToggleViaFile, false);
  assert.ok(codex.efforts.includes('high'));

  // Only Claude's approval responses can persist an "always allow" choice
  // through Cockpit's project rule store. Codex's app-server plugin/MCP
  // config is separate, and its approval response remains turn/session scoped.
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

  // Codex advertises live model discovery instead of a static catalog.
  assert.deepEqual(providerDetails('codex').launch, { efforts: codex.efforts, dynamicModels: true });
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

  const defaultModel = await codex.resolveEfforts({
    model: null,
    handle: { query: { supportedModels: async () => [
      { value: 'fallback', supportedEfforts: ['high'] },
      { value: 'recommended', isDefault: true, supportedEfforts: ['minimal'] },
    ] } },
  });
  assert.deepEqual(defaultModel, ['minimal']);

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
