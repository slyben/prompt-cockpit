import { test } from 'node:test';
import assert from 'node:assert/strict';
import { niceScaleMax, formatAxisTick } from '../public/turn-chart.js';

test('niceScaleMax: zero / negative / NaN fall back to 1 so the axis is never empty', () => {
  assert.equal(niceScaleMax(0), 1);
  assert.equal(niceScaleMax(-3), 1);
  assert.equal(niceScaleMax(Number.NaN), 1);
});

test('niceScaleMax: rounds up onto 1 / 2 / 2.5 / 5 / 10', () => {
  assert.equal(niceScaleMax(1), 1);
  assert.equal(niceScaleMax(1.1), 2);
  assert.equal(niceScaleMax(2.5), 2.5);
  assert.equal(niceScaleMax(2.6), 5);
  assert.equal(niceScaleMax(5), 5);
  assert.equal(niceScaleMax(6), 10);
  assert.equal(niceScaleMax(10), 10);
  assert.equal(niceScaleMax(12), 20);
});

test('niceScaleMax: fractional dollar amounts stay on round cents', () => {
  assert.equal(niceScaleMax(0.013), 0.02);
  assert.equal(niceScaleMax(0.02), 0.02);
  assert.equal(niceScaleMax(0.021), 0.025);
});

test('niceScaleMax: token-scale thousands', () => {
  assert.equal(niceScaleMax(2500), 2500);
  assert.equal(niceScaleMax(2501), 5000);
  assert.equal(niceScaleMax(12000), 20000);
});

test('formatAxisTick: usd compact labels', () => {
  assert.equal(formatAxisTick('usd', 0), '$0');
  assert.equal(formatAxisTick('usd', 0.005), '$0.005');
  assert.equal(formatAxisTick('usd', 0.02), '$0.02');
  assert.equal(formatAxisTick('usd', 0.025), '$0.025');
  assert.equal(formatAxisTick('usd', 0.1948), '$0.1948');
  assert.equal(formatAxisTick('usd', 1), '$1.00');
  assert.equal(formatAxisTick('usd', 1.5), '$1.50');
  assert.equal(formatAxisTick('usd', 12.5), '$12.50');
});

test('formatAxisTick: token K/M abbreviations', () => {
  assert.equal(formatAxisTick('tokens', 0), '0');
  assert.equal(formatAxisTick('tokens', 500), '500');
  assert.equal(formatAxisTick('tokens', 2500), '2.5K');
  assert.equal(formatAxisTick('tokens', 12000), '12K');
  assert.equal(formatAxisTick('tokens', 1.5e6), '1.5M');
});
