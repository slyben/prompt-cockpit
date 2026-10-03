import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { createProviderCatalog, supportedEffortsForModel } from '../public/provider-catalog.js';

const app = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const source = app.slice(app.indexOf('function selectedProvider()'), app.indexOf('let resumableGen ='));
const launcherModels = app.slice(app.indexOf('let startModelsRequest ='), app.indexOf('startProviderSelect.addEventListener'));
function selectStub() {
  return {
    children: [], value: '', hidden: false,
    set innerHTML(_) { this.children = []; this.value = ''; },
    append(option) { this.children.push(option); },
  };
}
function setup(remembered = 'gmail', subscriptions = [{ id: 'default', label: 'Default' }, { id: 'gmail', label: 'Gmail' }], subscriptionsError) {
  const provider = selectStub();
  provider.value = 'claude';
  const subscription = selectStub();
  const control = { hidden: true };
  const model = selectStub();
  const context = vm.createContext({
    URLSearchParams, encodeURIComponent, supportedEffortsForModel,
    startProviderSelect: provider, startSubscriptionSelect: subscription, startSubscriptionControl: control, startSubscriptionError: { hidden: true, textContent: '' },
    startModelSelect: model, startEffortSelect: selectStub(), startClaudeEffortSelect: selectStub(),
    THINKING_BUDGET_PRESETS: [],
    providerCatalog: createProviderCatalog({ providers: [
      { id: 'claude', launch: { dynamicModels: true, subscriptions, subscriptionsError } },
      { id: 'codex' },
    ] }),
    localStorage: { getItem: () => remembered },
    document: { createElement: () => ({}) },
    console,
  });
  context.launchConfig = (id) => context.providerCatalog.get(id)?.launch || {};
  vm.runInContext(source, context);
  return { context, provider, subscription, control, model };
}

test('launcher restores the remembered account and only shows subscriptions for supported providers', () => {
  const ui = setup();
  ui.context.fillStartSubscriptions();
  assert.equal(ui.control.hidden, false);
  assert.equal(ui.context.selectedSubscription(), 'gmail');
  assert.deepEqual(ui.subscription.children.map((option) => option.textContent), ['Default', 'Gmail']);
  ui.provider.value = 'codex';
  ui.context.fillStartSubscriptions();
  assert.equal(ui.control.hidden, true);
  assert.equal(ui.context.selectedSubscription(), undefined);
  ui.provider.value = 'claude';
  ui.context.fillStartSubscriptions();
  assert.equal(ui.context.selectedSubscription(), 'gmail');
});

test('only the default account hides the selector and ignores a remembered extra account', () => {
  const ui = setup('gmail', [{ id: 'default', label: 'Default' }]);
  ui.context.fillStartSubscriptions();
  assert.equal(ui.control.hidden, true);
  assert.equal(ui.context.selectedSubscription(), 'default');
});

test('an obsolete stored subscription falls back to Default', () => {
  const ui = setup('removed-account');
  ui.context.fillStartSubscriptions();
  assert.equal(ui.context.selectedSubscription(), 'default');
});

test('late model discovery from another account cannot overwrite the selected account catalog', async () => {
  const ui = setup('default');
  const requests = [];
  ui.context.launchConfig = () => ui.context.providerCatalog.get('claude').launch;
  ui.context.launchModels = () => [];
  ui.context.fetch = (url) => new Promise((resolve) => requests.push({ url, resolve }));
  vm.runInContext(launcherModels, ui.context);
  ui.context.fillStartSubscriptions();
  const defaults = ui.context.fillStartModels();
  ui.subscription.value = 'gmail';
  const gmail = ui.context.fillStartModels();
  assert.equal(requests[0].url, '/api/providers/claude/models?subscription=default');
  assert.equal(requests[1].url, '/api/providers/claude/models?subscription=gmail');
  requests[1].resolve({ ok: true, json: async () => [{ value: 'gmail-model' }] });
  await gmail;
  requests[0].resolve({ ok: true, json: async () => [{ value: 'default-model' }] });
  await defaults;
  assert.equal(ui.model.children[0].value, 'gmail-model');
});

test('an account config error is shown and keeps the selector visible', () => {
  const { context, control } = setup('gmail', [{ id: 'default', label: 'Default' }], 'bad json');
  context.fillStartSubscriptions();
  assert.equal(control.hidden, false);
  assert.equal(context.startSubscriptionError.hidden, false);
  assert.match(context.startSubscriptionError.textContent, /bad json/);
});
