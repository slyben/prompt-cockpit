import test from 'node:test';
import assert from 'node:assert/strict';
import { createProviderCatalog, normalizeProviderCatalog } from '../public/provider-catalog.js';

test('provider catalog preserves the legacy ids-only /api/providers response', () => {
  const catalog = createProviderCatalog({ providers: ['claude', 'grok'] });

  assert.equal(catalog.label('claude'), 'Claude');
  assert.equal(catalog.label('grok'), 'Grok');
  assert.equal(catalog.validate('grok'), 'grok');
  assert.equal(catalog.validate(undefined), 'claude');
});

test('provider catalog uses providerDetails and keeps a future Codex provider distinct', () => {
  const catalog = createProviderCatalog({
    providers: ['claude', 'codex'],
    providerDetails: [
      { id: 'claude', label: 'Claude Code' },
      { id: 'codex', label: 'Codex', capabilities: { interrupt: true }, launch: { models: ['gpt-5.6-codex'] } },
    ],
  });

  assert.equal(catalog.label('codex'), 'Codex');
  assert.deepEqual(catalog.get('codex').launch.models, ['gpt-5.6-codex']);
  assert.equal(catalog.validate('codex'), 'codex');
  assert.equal(catalog.validate('not-a-provider'), null);
});

test('provider catalog accepts a details map and can retain a session provider received before metadata', () => {
  const catalog = createProviderCatalog({ details: { codex: { label: 'Codex app-server' } } });

  assert.deepEqual([...normalizeProviderCatalog({ details: { codex: { label: 'Codex app-server' } } }).keys()], ['codex']);
  assert.equal(catalog.label('codex'), 'Codex app-server');
  catalog.add('local-agent');
  assert.equal(catalog.validate('local-agent'), 'local-agent');
  assert.equal(catalog.label('local-agent'), 'Local Agent');
});
