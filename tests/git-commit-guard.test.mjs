import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  commandTripsGuard,
  validateCommitCommand,
  validateScopedCommitMessage,
  GIT_GUARD_MODES,
} from '../src/git-commit-guard.js';

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

test('scoped commit validator accepts the /commit message format', () => {
  assert.deepEqual(validateScopedCommitMessage('session: preserve settings'), { valid: true });
  assert.deepEqual(validateScopedCommitMessage('session: preserve settings\n\n- keep live values\n- add regression coverage'), { valid: true });
});

test('scoped commit validator rejects messages outside the skill format', () => {
  assert.equal(validateScopedCommitMessage('Fix the reset bug').valid, false);
  assert.equal(validateScopedCommitMessage('session: fix\n\nexplanation').valid, false);
  assert.equal(validateScopedCommitMessage('session: fix\n\n- one\n- two\n- three\n- four\n- five').valid, false);
  assert.equal(validateScopedCommitMessage('session: fix\n\n- use — here').valid, false);
});

test('commit command validator inspects -m and rejects opaque messages', async () => {
  assert.equal((await validateCommitCommand('git commit -m "session: preserve settings"', process.cwd())).valid, true);
  assert.equal((await validateCommitCommand('git -C . commit -m "Fix the reset bug"', process.cwd())).valid, false);
  assert.equal((await validateCommitCommand('git commit -am "session: preserve settings"', process.cwd())).valid, true);
  const opaque = await validateCommitCommand('git commit', process.cwd());
  assert.equal(opaque.valid, false);
  assert.match(opaque.reason, /not visible/);
});

test('commit command validator inspects a -F message file', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prompt-cockpit-commit-'));
  const file = path.join(dir, 'message.txt');
  try {
    await writeFile(file, 'session: preserve settings\n\n- validate the final message\n', 'utf8');
    const result = await validateCommitCommand(`git commit -F '${file}'`, dir);
    assert.equal(result.valid, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
