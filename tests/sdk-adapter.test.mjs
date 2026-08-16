// Both functions here ARE the fallback path for MVP2 (file_suggestions and
// get_workspace_diff are protocol-only, not public - see plan Spike B), so
// these tests exercise the real behavior, not a degraded mode of it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileSuggestions, workspaceDiff } from '../src/sdk-adapter.js';

const execFileAsync = promisify(execFile);

async function makeFixtureProject() {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-adapter-'));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, 'node_modules', 'whatever'), { recursive: true });
  await mkdir(path.join(root, '.git'), { recursive: true });
  await writeFile(path.join(root, 'src', 'session.js'), '// x');
  await writeFile(path.join(root, 'src', 'session-registry.js'), '// x');
  await writeFile(path.join(root, 'README.md'), '# x');
  await writeFile(path.join(root, 'node_modules', 'whatever', 'index.js'), '// should be ignored');
  await writeFile(path.join(root, '.git', 'config'), '# should be ignored');
  return root;
}

test('fileSuggestions matches on relative path, case-insensitively, tagged source: cwd', async () => {
  const root = await makeFixtureProject();
  try {
    const results = await fileSuggestions(root, 'SESSION');
    const paths = results.map((r) => r.path);
    assert.ok(paths.includes(path.join('src', 'session.js')));
    assert.ok(paths.includes(path.join('src', 'session-registry.js')));
    assert.ok(!paths.some((p) => p.includes('node_modules')));
    assert.ok(!paths.some((p) => p.includes('.git')));
    assert.ok(results.every((r) => r.source === 'cwd'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fileSuggestions with no query returns files up to the cap, still excluding ignored dirs', async () => {
  const root = await makeFixtureProject();
  try {
    const results = await fileSuggestions(root, '');
    assert.ok(results.length > 0);
    assert.ok(!results.some((r) => r.path.includes('node_modules')));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('fileSuggestions merges an extra folder outside cwd, tagging its results with that folder\'s id', async () => {
  const root = await makeFixtureProject();
  const screenshotDir = await mkdtemp(path.join(tmpdir(), 'cockpit-screenshots-'));
  try {
    await writeFile(path.join(screenshotDir, 'Screenshot 2026-08-15.png'), 'x');
    const results = await fileSuggestions(root, '', [{ id: 'screenshots', path: screenshotDir }]);
    const cwdResults = results.filter((r) => r.source === 'cwd');
    const screenshotResults = results.filter((r) => r.source === 'screenshots');
    assert.ok(cwdResults.some((r) => r.path === 'README.md'));
    assert.ok(screenshotResults.some((r) => r.path.endsWith('Screenshot 2026-08-15.png')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(screenshotDir, { recursive: true, force: true });
  }
});

test('fileSuggestions sorts an extra folder\'s files newest-first by mtime, not filesystem/alphabetical order', async () => {
  const root = await makeFixtureProject();
  const screenshotDir = await mkdtemp(path.join(tmpdir(), 'cockpit-screenshots-'));
  try {
    // Deliberately named so alphabetical order is the reverse of mtime
    // order - "a-oldest.png" would sort first alphabetically but is the
    // oldest file, "c-newest.png" would sort last alphabetically but is
    // the newest.
    await writeFile(path.join(screenshotDir, 'a-oldest.png'), 'x');
    await writeFile(path.join(screenshotDir, 'b-middle.png'), 'x');
    await writeFile(path.join(screenshotDir, 'c-newest.png'), 'x');
    const now = new Date();
    await utimes(path.join(screenshotDir, 'a-oldest.png'), now, new Date(now.getTime() - 3 * 60_000));
    await utimes(path.join(screenshotDir, 'b-middle.png'), now, new Date(now.getTime() - 2 * 60_000));
    await utimes(path.join(screenshotDir, 'c-newest.png'), now, new Date(now.getTime() - 1 * 60_000));

    const results = await fileSuggestions(root, '', [{ id: 'screenshots', path: screenshotDir }]);
    const names = results.filter((r) => r.source === 'screenshots').map((r) => path.basename(r.path));
    assert.deepEqual(names, ['c-newest.png', 'b-middle.png', 'a-oldest.png']);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(screenshotDir, { recursive: true, force: true });
  }
});

test('fileSuggestions does not recurse into an extra folder\'s subdirectories, so a large nested archive dir cannot crowd out the folder\'s own files', async () => {
  const root = await makeFixtureProject();
  const screenshotDir = await mkdtemp(path.join(tmpdir(), 'cockpit-screenshots-'));
  try {
    // "old" sorts before "Screenshot ..." alphabetically (case-insensitive),
    // so a naive depth-first walk visits it first and, with enough files,
    // can fill the whole per-folder result cap before ever reaching the
    // folder's own top-level files - reproduces the real ~/Screenshots/old/
    // bug where recent screenshots never appeared in the "@" picker.
    const oldDir = path.join(screenshotDir, 'old');
    await mkdir(oldDir, { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      await writeFile(path.join(oldDir, `archived-${i}.png`), 'x');
    }
    await writeFile(path.join(screenshotDir, 'Screenshot 2026-08-17.png'), 'x');

    const results = await fileSuggestions(root, '', [{ id: 'screenshots', path: screenshotDir }]);
    const screenshotResults = results.filter((r) => r.source === 'screenshots');
    assert.ok(
      screenshotResults.some((r) => r.path.endsWith('Screenshot 2026-08-17.png')),
      'the folder\'s own recent file must appear even when a nested subfolder has more files'
    );
    assert.ok(
      !screenshotResults.some((r) => r.path.includes(path.join('old', 'archived'))),
      'nested subfolder contents should be skipped entirely, not walked'
    );
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(screenshotDir, { recursive: true, force: true });
  }
});

test('fileSuggestions merges multiple extra folders, each tagged with its own id', async () => {
  const root = await makeFixtureProject();
  const dirA = await mkdtemp(path.join(tmpdir(), 'cockpit-extra-a-'));
  const dirB = await mkdtemp(path.join(tmpdir(), 'cockpit-extra-b-'));
  try {
    await writeFile(path.join(dirA, 'from-a.png'), 'x');
    await writeFile(path.join(dirB, 'from-b.png'), 'x');
    const results = await fileSuggestions(root, '', [
      { id: 'folder-a', path: dirA },
      { id: 'folder-b', path: dirB },
    ]);
    assert.ok(results.some((r) => r.source === 'folder-a' && r.path.endsWith('from-a.png')));
    assert.ok(results.some((r) => r.source === 'folder-b' && r.path.endsWith('from-b.png')));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(dirA, { recursive: true, force: true });
    await rm(dirB, { recursive: true, force: true });
  }
});

test('fileSuggestions skips an extra folder\'s walk when it is already inside cwd', async () => {
  const root = await makeFixtureProject();
  try {
    const nestedDir = path.join(root, 'src');
    const results = await fileSuggestions(root, '', [{ id: 'nested', path: nestedDir }]);
    // src/session.js should show up exactly once (from the cwd walk), not
    // duplicated by a redundant second walk of the same subtree.
    const matches = results.filter((r) => r.path === path.join('src', 'session.js'));
    assert.equal(matches.length, 1);
    assert.equal(matches[0].source, 'cwd');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspaceDiff returns real `git diff` output for a modified tracked file', async () => {
  const root = await makeFixtureProject();
  try {
    await execFileAsync('git', ['init', '-q'], { cwd: root });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    await execFileAsync('git', ['config', 'user.name', 'Test'], { cwd: root });
    await execFileAsync('git', ['add', '-A'], { cwd: root });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: root });

    await writeFile(path.join(root, 'README.md'), '# x\nchanged\n');
    const result = await workspaceDiff(root);
    assert.equal(result.source, 'git');
    assert.match(result.diff, /README\.md/);
    assert.match(result.diff, /\+changed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('workspaceDiff on a non-git directory reports the error instead of throwing', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-adapter-nogit-'));
  try {
    const result = await workspaceDiff(root);
    assert.equal(result.diff, '');
    assert.ok(result.error);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
