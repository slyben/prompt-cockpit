import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commandTripsGuard, GIT_GUARD_MODES } from '../src/git-commit-guard.js';

test('GIT_GUARD_MODES lists the three supported modes', () => {
  assert.deepEqual(GIT_GUARD_MODES, ['commit', 'all', 'off']);
});

test('mode off never trips regardless of content', () => {
  assert.equal(commandTripsGuard('git commit -m "x\n\nCo-Authored-By: y"', 'off'), false);
  assert.equal(commandTripsGuard('gh pr create --body "Generated with Claude Code"', 'off'), false);
});

test('mode all trips on a Co-Authored-By trailer anywhere', () => {
  assert.equal(commandTripsGuard('echo "Co-Authored-By: foo"', 'all'), true);
  assert.equal(commandTripsGuard('echo "co-authored-by: foo"', 'all'), true);
});

test('mode all trips on a Generated with Claude Code line anywhere', () => {
  assert.equal(commandTripsGuard('echo "Generated with Claude Code"', 'all'), true);
  assert.equal(commandTripsGuard('echo "generated   with   claude   code"', 'all'), true);
});

test('mode all ignores commands with neither phrase', () => {
  assert.equal(commandTripsGuard('git commit -m "fix bug"', 'all'), false);
});

test('mode commit only trips on git commit / gh pr create/edit shapes', () => {
  assert.equal(commandTripsGuard('git commit -m "x\n\nCo-Authored-By: y"', 'commit'), true);
  assert.equal(commandTripsGuard('gh pr create --body "Generated with Claude Code"', 'commit'), true);
  assert.equal(commandTripsGuard('gh pr edit 12 --body "Generated with Claude Code"', 'commit'), true);
});

test('mode commit ignores the phrase in unrelated commands', () => {
  assert.equal(commandTripsGuard('grep -r "Co-Authored-By" .', 'commit'), false);
  assert.equal(commandTripsGuard('echo "Generated with Claude Code"', 'commit'), false);
});

test('non-string command never trips', () => {
  assert.equal(commandTripsGuard(undefined, 'all'), false);
  assert.equal(commandTripsGuard(null, 'commit'), false);
});
