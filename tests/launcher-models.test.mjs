import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { supportedEffortsForModel } from '../public/provider-catalog.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const sourceStart = app.indexOf('let startModelsRequest =');
const source = app.slice(sourceStart, app.indexOf('startProviderSelect.addEventListener', sourceStart));
const settingsSourceStart = app.indexOf('function dynamicModelCatalog');
const settingsSource = app.slice(settingsSourceStart, app.indexOf('async function selectEffort', settingsSourceStart));
function selectStub() {
  return {
    children: [], value: '', disabled: false, hidden: false, title: '',
    set innerHTML(value) { this.children = []; },
    append(option) { this.children.push(option); },
    addEventListener() {},
  };
}
function setup(fetch) {
  let provider = 'codex';
  const select = selectStub();
  const effort = selectStub();
  const context = vm.createContext({
    fetch, encodeURIComponent, startModelSelect: select, startEffortSelect: effort,
    startClaudeEffortSelect: selectStub(),
    selectedProvider: () => provider,
    launchConfig: (id) => ({ dynamicModels: id === 'codex', efforts: ['none', 'low', 'high'] }),
    launchModels: () => [{ value: '', label: 'Default model' }],
    providerCatalog: { get: () => null, label: (id) => id },
    supportedEffortsForModel,
    THINKING_BUDGET_PRESETS: [],
    document: { createElement: () => ({}) },
  });
  vm.runInContext(source, context);
  return {
    select,
    effort,
    fill: () => context.fillStartModels(),
    fillEffort: () => context.fillStartEffort(),
    switchTo: (id) => { provider = id; },
  };
}

function settingsSetup({ models, currentModel }) {
  const effort = selectStub();
  const context = vm.createContext({
    cachedModels: models,
    currentModel,
    startModelCatalog: [],
    startModelCatalogProvider: null,
    settingsEffortModelsPending: false,
    effortBtn: effort,
    launchConfig: (id) => id === 'codex'
      ? { dynamicModels: true, efforts: ['none', 'low', 'high'] }
      : { effortOptions: [{ value: 'low', label: 'Low' }] },
    providerCatalog: { get: () => ({ capabilities: { thinkingBudget: false } }), label: (id) => id },
    supportedEffortsForModel,
    document: { createElement: () => ({}) },
  });
  vm.runInContext(settingsSource, context);
  return {
    effort,
    fill: () => context.fillSettingsEffortSelect('codex'),
  };
}

test('launcher exposes discovered Codex model values for selection', async () => {
  const ui = setup(async (url) => {
    assert.equal(url, '/api/providers/codex/models');
    return { ok: true, json: async () => [{ value: 'available-model', displayName: 'Available model' }] };
  });
  await ui.fill();
  assert.equal(ui.select.disabled, false);
  assert.equal(ui.select.children[0].value, 'available-model');
  assert.equal(ui.select.children[0].textContent, 'Available model');
});

test('launcher narrows Codex effort choices to the selected discovered model', async () => {
  const ui = setup(async () => ({ ok: true, json: async () => [
    { value: 'default-model', displayName: 'Default', isDefault: true, supportedEfforts: ['low'] },
    { value: 'high-model', displayName: 'High', supportedEfforts: ['high'] },
  ] }));
  await ui.fill();
  assert.deepEqual(ui.effort.children.map((option) => option.value), ['', 'low']);
  ui.select.value = 'high-model';
  ui.fillEffort();
  assert.deepEqual(ui.effort.children.map((option) => option.value), ['', 'high']);
});

test('late Codex discovery cannot overwrite another provider selection', async () => {
  let resolve;
  const ui = setup(() => new Promise(r => { resolve = r; }));
  const pending = ui.fill();
  assert.equal(ui.select.disabled, true);
  ui.switchTo('claude');
  await ui.fill();
  resolve({ ok: true, json: async () => [{ value: 'codex-only' }] });
  await pending;
  assert.equal(ui.select.disabled, false);
  assert.equal(ui.select.children.length, 1);
  assert.equal(ui.select.children[0].textContent, 'Default model');
});

test('failed discovery shows the error and permits retry', async () => {
  let fails = true;
  const ui = setup(async () => {
    if (fails) throw new Error('app-server unavailable');
    return { ok: true, json: async () => [{ value: 'recovered' }] };
  });
  await ui.fill();
  assert.match(ui.select.children[0].textContent, /unavailable/);
  assert.match(ui.select.title, /app-server unavailable/);
  fails = false;
  await ui.fill();
  assert.equal(ui.select.children[0].value, 'recovered');
});

test('settings narrows Codex effort choices to the current discovered model', () => {
  const ui = settingsSetup({
    models: [
      { value: 'sol', isDefault: true, supportedEfforts: ['low', 'medium'] },
      { value: 'mini', supportedEfforts: ['minimal'] },
    ],
    currentModel: 'mini',
  });
  ui.fill();
  assert.deepEqual(ui.effort.children.map((option) => option.value), ['', 'minimal']);
});
