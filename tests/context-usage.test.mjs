import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeAutoCompactThreshold,
  contextPayload,
  DEFAULT_COMPACT_WARN_PERCENT,
  _resetWarnedOnceForTests,
} from '../src/context-usage.js';

beforeEach(() => {
  _resetWarnedOnceForTests();
});

function noopWarn() {}

test('normalizeAutoCompactThreshold: absent/null contextUsage returns null', () => {
  assert.equal(normalizeAutoCompactThreshold(null, { warn: noopWarn }), null);
  assert.equal(normalizeAutoCompactThreshold({}, { warn: noopWarn }), null);
});

test('normalizeAutoCompactThreshold: fraction encoding (0-1]', () => {
  assert.equal(normalizeAutoCompactThreshold({ autoCompactThreshold: 0.8 }, { warn: noopWarn }), 80);
});

test('normalizeAutoCompactThreshold: percent encoding (1-100]', () => {
  assert.equal(normalizeAutoCompactThreshold({ autoCompactThreshold: 80 }, { warn: noopWarn }), 80);
});

test('normalizeAutoCompactThreshold: absolute token count (>100), converted via maxTokens', () => {
  const pct = normalizeAutoCompactThreshold({ autoCompactThreshold: 160000, maxTokens: 200000 }, { warn: noopWarn });
  assert.equal(pct, 80);
});

test('normalizeAutoCompactThreshold: absolute token count with no usable maxTokens rejects', () => {
  let warned = false;
  const pct = normalizeAutoCompactThreshold(
    { autoCompactThreshold: 160000, maxTokens: 0 },
    { warn: () => { warned = true; } }
  );
  assert.equal(pct, null);
  assert.equal(warned, true);
});

test('normalizeAutoCompactThreshold: negative or non-finite values reject without warning (not a unit-mismatch, just absent/bad data)', () => {
  let warned = false;
  const warn = () => { warned = true; };
  assert.equal(normalizeAutoCompactThreshold({ autoCompactThreshold: -1 }, { warn }), null);
  assert.equal(normalizeAutoCompactThreshold({ autoCompactThreshold: NaN }, { warn }), null);
  assert.equal(warned, false);
});

test('normalizeAutoCompactThreshold: percent below the plausibility band rejects and warns', () => {
  let warned = false;
  const pct = normalizeAutoCompactThreshold({ autoCompactThreshold: 20 }, { warn: () => { warned = true; } });
  assert.equal(pct, null);
  assert.equal(warned, true);
});

test('normalizeAutoCompactThreshold: absolute-token conversion landing out of band rejects and warns', () => {
  let warned = false;
  // 120 tokens against a 1000-token window is 12% - way below the plausible band.
  const pct = normalizeAutoCompactThreshold(
    { autoCompactThreshold: 120, maxTokens: 1000 },
    { warn: () => { warned = true; } }
  );
  assert.equal(pct, null);
  assert.equal(warned, true);
});

test('contextPayload: null contextUsage returns null', () => {
  assert.equal(contextPayload(null), null);
});

test('contextPayload: sdk-confirmed threshold reports source "sdk"', () => {
  const payload = contextPayload({
    totalTokens: 1000,
    maxTokens: 2000,
    percentage: 50,
    isAutoCompactEnabled: true,
    autoCompactThreshold: 0.8,
  });
  assert.deepEqual(payload, {
    totalTokens: 1000,
    maxTokens: 2000,
    percentage: 50,
    autoCompact: { enabled: true, warnPercent: 80, source: 'sdk' },
  });
});

test('contextPayload: rejected/absent threshold falls back to DEFAULT_COMPACT_WARN_PERCENT with source "fallback"', () => {
  const payload = contextPayload({
    totalTokens: 1000,
    maxTokens: 2000,
    percentage: 50,
    isAutoCompactEnabled: false,
  });
  assert.equal(payload.autoCompact.warnPercent, DEFAULT_COMPACT_WARN_PERCENT);
  assert.equal(payload.autoCompact.source, 'fallback');
  assert.equal(payload.autoCompact.enabled, false);
});
