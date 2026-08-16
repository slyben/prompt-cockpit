// Regression tests for two backlog fixes in settings-file.js:
// - [C] updateSettingsFile's write-failure path used to leave an untracked
//   derived promise (`run.finally(...)`) that also rejected, which Node's
//   default unhandled-rejection handling turns into a process crash.
// - [H] a corrupt-but-existing settings.local.json used to be silently
//   treated the same as a missing one (`{}`), so the next write through
//   updateSettingsFile replaced the corrupt file with `{}` - destroying
//   whatever hooks/permissions/etc. were in it, unrecoverably.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSettingsFile, updateSettingsFile, settingsPath } from '../src/settings-file.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-settings-file-'));
}

test('readSettingsFile still returns {} on corrupt JSON (unchanged lenient-read behavior)', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(settingsPath(cwd), '{ not json', 'utf-8');
    assert.deepEqual(await readSettingsFile(cwd), {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('updateSettingsFile refuses to write over a corrupt settings file instead of replacing it with {}', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    // Deliberately corrupt but recoverable-by-hand - e.g. a stray trailing
    // comma someone introduced hand-editing the file.
    const corruptContent = '{ "hooks": { "pre-commit": "lint" }, }';
    await writeFile(settingsPath(cwd), corruptContent, 'utf-8');

    await assert.rejects(
      () => updateSettingsFile(cwd, (settings) => { settings.enabledPlugins = { 'a@b': true }; }),
      /invalid JSON/,
    );

    // The corrupt file must survive untouched - not get clobbered with `{}`.
    const onDisk = await readFile(settingsPath(cwd), 'utf-8');
    assert.equal(onDisk, corruptContent);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('updateSettingsFile still works normally once the corrupt file is fixed by hand', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(settingsPath(cwd), '{ not json', 'utf-8');
    await assert.rejects(() => updateSettingsFile(cwd, (s) => { s.x = 1; }));

    // Simulate the user fixing the file by hand, then retrying.
    await writeFile(settingsPath(cwd), '{}', 'utf-8');
    await updateSettingsFile(cwd, (s) => { s.x = 1; });
    assert.deepEqual(await readSettingsFile(cwd), { x: 1 });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('updateSettingsFile replaces an existing file without leaving a tmp sibling', async () => {
  const cwd = await makeTmpDir();
  try {
    await updateSettingsFile(cwd, (s) => { s.x = 1; });
    await updateSettingsFile(cwd, (s) => { s.x = 2; s.y = 'ok'; });
    assert.deepEqual(await readSettingsFile(cwd), { x: 2, y: 'ok' });
    const names = await readdir(path.join(cwd, '.claude'));
    assert.deepEqual(names, ['settings.local.json']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('a write failure inside updateSettingsFile rejects the caller and does not crash the process (no unhandled rejection)', async () => {
  const cwd = await makeTmpDir();
  // Make the settings path itself unwritable: put a *file* where
  // settings-file.js expects to mkdir a directory (.claude), so
  // writeSettingsFile's mkdir(..., { recursive: true }) fails.
  await writeFile(path.join(cwd, '.claude'), 'not a directory', 'utf-8');

  let unhandled = null;
  const onUnhandledRejection = (err) => { unhandled = err; };
  process.on('unhandledRejection', onUnhandledRejection);
  try {
    await assert.rejects(() => updateSettingsFile(cwd, (s) => { s.x = 1; }));
    // Give any stray unhandled-rejection microtask/macrotask a chance to fire
    // before asserting none did - this is exactly the window the old
    // `run.finally(...)` (no .catch) bug would have surfaced in.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(unhandled, null, `expected no unhandledRejection, got: ${unhandled}`);
  } finally {
    process.off('unhandledRejection', onUnhandledRejection);
    await rm(cwd, { recursive: true, force: true });
  }
});
