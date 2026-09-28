import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  thinkingRulesFor,
  offBlockedReason,
  effortBlockedByOffReason,
} from '../src/thinking-rules.js';

test('rules by model family', () => {
  const cases = [
    ['claude-sonnet-5-5', 'atMostHigh', false],
    ['claude-opus-5', 'atMostHigh', false],
    ['claude-opus-5-5', 'never', false],
    ['claude-fable-5-1', 'never', false],
    ['claude-fable-5', 'never', false],
    ['claude-mythos-5-1', 'never', false],
    ['claude-sonnet-5', 'always', false],
    ['claude-opus-4-8', 'always', false],
    ['claude-opus-4-7', 'always', false],
    ['claude-opus-4-6', 'always', true],
    ['claude-sonnet-4-6', 'always', true],
    ['claude-haiku-4-5-20251001', 'always', true],
  ];
  for (const [model, off, sized] of cases) {
    const rules = thinkingRulesFor(model);
    assert.equal(rules.off, off, `${model} off`);
    assert.equal(rules.sizedBudgets, sized, `${model} sizedBudgets`);
  }
});

test('id decorations do not change the family', () => {
  assert.equal(thinkingRulesFor('anthropic.claude-sonnet-5-5').off, 'atMostHigh');
  assert.equal(thinkingRulesFor('claude-sonnet-5-5[1m]').off, 'atMostHigh');
  assert.equal(thinkingRulesFor('CLAUDE-OPUS-5-5').off, 'never');
  // claude-opus-5 must not swallow claude-opus-5-5.
  assert.equal(thinkingRulesFor('claude-opus-5').off, 'atMostHigh');
  assert.equal(thinkingRulesFor('claude-opus-5-5').off, 'never');
});

test('unknown or unresolved models stay permissive', () => {
  for (const model of [null, undefined, '', 'default', 'sonnet', 'claude-future-9']) {
    assert.deepEqual({ ...thinkingRulesFor(model) }, { off: 'always', sizedBudgets: true }, String(model));
    assert.equal(offBlockedReason(model, 'max'), null);
  }
});

test('offBlockedReason: Sonnet 5.5 blocks Off only at xhigh/max (unset effort = high)', () => {
  assert.equal(offBlockedReason('claude-sonnet-5-5', null), null);
  assert.equal(offBlockedReason('claude-sonnet-5-5', 'low'), null);
  assert.equal(offBlockedReason('claude-sonnet-5-5', 'high'), null);
  assert.match(offBlockedReason('claude-sonnet-5-5', 'xhigh'), /Extra high \/ Max/);
  assert.match(offBlockedReason('claude-sonnet-5-5', 'max'), /Extra high \/ Max/);
});

test('offBlockedReason: never-off models block Off at every effort; always models never', () => {
  assert.match(offBlockedReason('claude-opus-5-5', 'low'), /always thinks/);
  assert.match(offBlockedReason('claude-fable-5-1', null), /always thinks/);
  assert.equal(offBlockedReason('claude-sonnet-5', 'max'), null);
  assert.equal(offBlockedReason('claude-haiku-4-5-20251001', 'xhigh'), null);
});

test('effortBlockedByOffReason only fires with Off set on an atMostHigh model', () => {
  const m = 'claude-sonnet-5-5';
  assert.match(effortBlockedByOffReason(m, 'xhigh', 0), /Default first/);
  assert.match(effortBlockedByOffReason(m, 'max', 0), /Default first/);
  assert.equal(effortBlockedByOffReason(m, 'high', 0), null);
  assert.equal(effortBlockedByOffReason(m, 'xhigh', null), null);
  assert.equal(effortBlockedByOffReason(m, 'xhigh', 10000), null);
  // never-off models can't be blocked by Off - Off was never honored there.
  assert.equal(effortBlockedByOffReason('claude-opus-5-5', 'xhigh', 0), null);
  assert.equal(effortBlockedByOffReason('claude-sonnet-5', 'xhigh', 0), null);
});
