import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PERMISSION_MODES, nextMode, AUTO_ALLOW_MODES } from '../src/permissions.js';

test('nextMode cycles through all six modes and wraps around', () => {
  let mode = PERMISSION_MODES[0];
  const seen = [mode];
  for (let i = 0; i < PERMISSION_MODES.length - 1; i += 1) {
    mode = nextMode(mode);
    seen.push(mode);
  }
  assert.deepEqual(seen, PERMISSION_MODES);
  assert.equal(nextMode(PERMISSION_MODES.at(-1)), PERMISSION_MODES[0]);
});

test('nextMode falls back to the first mode for an unknown current mode', () => {
  assert.equal(nextMode('not-a-real-mode'), PERMISSION_MODES[0]);
});

test('AUTO_ALLOW_MODES excludes default and plan (both need a client decision)', () => {
  assert.equal(AUTO_ALLOW_MODES.has('default'), false);
  assert.equal(AUTO_ALLOW_MODES.has('plan'), false);
  assert.equal(AUTO_ALLOW_MODES.has('acceptEdits'), true);
  assert.equal(AUTO_ALLOW_MODES.has('bypassPermissions'), true);
});
