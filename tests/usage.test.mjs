import { test } from 'node:test';
import assert from 'node:assert/strict';
import { costForUsage, createUsageAccumulator } from '../src/usage.js';

test('costForUsage prices input/output/cache-read/cache-write against pricing.json', () => {
  const info = costForUsage('claude-sonnet-5', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 },
  });
  // sonnet-5 rates (src/pricing.json): input 2, output 10, cache_read 0.2, write_5m 2.5, write_1h 4
  assert.equal(info.cost, 2 + 10 + 0.2 + 2.5 + 4);
  assert.equal(info.inputTokens, 1_000_000);
  assert.equal(info.outputTokens, 1_000_000);
  assert.equal(info.readTokens, 1_000_000);
  assert.equal(info.writeTokens, 2_000_000);
});

test('costForUsage supports the legacy cache_creation_input_tokens field (no nested cache_creation object)', () => {
  const info = costForUsage('claude-sonnet-5', { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 1_000_000 });
  assert.equal(info.writeTokens, 1_000_000);
  assert.equal(info.cost, 2.5); // priced as a 5m write
});

test('costForUsage prefers a stamped Grok cost over the rate table', () => {
  const info = costForUsage('grok-4.6', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cost_usd_ticks: 53_465_000,
  });
  assert.equal(info.cost, 53_465_000 / 10_000_000_000);
  assert.equal(info.inputTokens, 1_000_000);
});

test('costForUsage prices grok models from pricing_grok.json, not pricing.json', () => {
  const info = costForUsage('grok-4.6', {
    input_tokens: 1_000_000,
    output_tokens: 1_000_000,
    cache_read_input_tokens: 1_000_000,
    cache_creation: { ephemeral_5m_input_tokens: 1_000_000 },
  });
  // grok-4.6 short-context (src/pricing_grok.json): input 2, output 6, cache_read 0.5, write = input
  assert.equal(info.cost, 2 + 6 + 0.5 + 2);
  assert.equal(info.inputTokens, 1_000_000);
  assert.equal(info.outputTokens, 1_000_000);
  assert.equal(info.readTokens, 1_000_000);
  assert.equal(info.writeTokens, 1_000_000);
});

test('costForUsage returns null for an unpriced model rather than guessing', () => {
  assert.equal(costForUsage('some-future-model', { input_tokens: 100 }), null);
});

test('costForUsage returns null when usage is missing', () => {
  assert.equal(costForUsage('claude-sonnet-5', null), null);
});

test('createUsageAccumulator sums across messages and tracks unpriced models separately', () => {
  const acc = createUsageAccumulator();
  acc.addAssistantMessage({ model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } });
  acc.addAssistantMessage({ model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 2000, output_tokens: 1000 } });
  acc.addAssistantMessage({ model: 'some-future-model', usage: { input_tokens: 999 } });
  acc.addAssistantMessage(null); // no-op, must not throw
  acc.addAssistantMessage({ model: 'claude-sonnet-5', usage: null }); // no-op

  const snap = acc.snapshot();
  assert.equal(snap.inputTokens, 3000);
  assert.equal(snap.outputTokens, 1500);
  assert.deepEqual(snap.unpriced, ['some-future-model']);
  assert.ok(snap.costUsd > 0);
});

test('createUsageAccumulator cacheHitRate is null with no cache activity, else read/(read+write)', () => {
  const acc = createUsageAccumulator();
  assert.equal(acc.snapshot().cacheHitRate, null);
  acc.addAssistantMessage({
    model: 'claude-sonnet-5',
    usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 3, cache_creation: { ephemeral_5m_input_tokens: 1 } },
  });
  assert.equal(acc.snapshot().cacheHitRate, 0.75);
});

test('createUsageAccumulator buckets cost per tool, split evenly across a turn\'s tool_use blocks, summing back to the total', () => {
  const acc = createUsageAccumulator();
  // Turn 1: no tool_use blocks -> lands in the "(no tool call)" bucket.
  acc.addAssistantMessage({ model: 'claude-sonnet-5', usage: { input_tokens: 1000, output_tokens: 500 } });
  // Turn 2: two tool_use blocks (Read, Bash) -> that turn's cost split 50/50.
  acc.addAssistantMessage(
    { model: 'claude-sonnet-5', usage: { input_tokens: 2000, output_tokens: 1000 } },
    ['Read', 'Bash'],
  );
  // Turn 3: Read again -> Read's bucket accumulates across turns.
  acc.addAssistantMessage(
    { model: 'claude-sonnet-5', usage: { input_tokens: 500, output_tokens: 250 } },
    ['Read'],
  );

  const snap = acc.snapshot();
  const byName = Object.fromEntries(snap.perTool.map((t) => [t.name, t]));

  assert.equal(byName['(no tool call)'].calls, 1);
  assert.equal(byName.Read.calls, 2);
  assert.equal(byName.Bash.calls, 1);

  const sumCost = snap.perTool.reduce((s, t) => s + t.costUsd, 0);
  assert.ok(Math.abs(sumCost - snap.costUsd) < 1e-9, 'per-tool costs must sum back to the session total');

  // perTool is sorted by cost descending.
  for (let i = 1; i < snap.perTool.length; i++) {
    assert.ok(snap.perTool[i - 1].costUsd >= snap.perTool[i].costUsd);
  }
});
