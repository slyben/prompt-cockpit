import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listResumableSessions, isValidCwd, listDirectory, DRIVES_SENTINEL } from '../src/session-launcher.js';

async function makeFixtureProjects() {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-projects-'));

  const older = path.join(root, '-Users-x-older-project');
  await mkdir(older, { recursive: true });
  await writeFile(
    path.join(older, '11111111-1111-1111-1111-111111111111.jsonl'),
    [
      JSON.stringify({ type: 'summary', summary: 'unrelated line' }),
      JSON.stringify({ type: 'user', cwd: '/Users/x/older-project', message: { content: 'fix the older bug' } }),
    ].join('\n') + '\n',
  );

  const newer = path.join(root, '-Users-x-newer-project');
  await mkdir(newer, { recursive: true });
  await writeFile(
    path.join(newer, '22222222-2222-2222-2222-222222222222.jsonl'),
    [
      JSON.stringify({ type: 'user', cwd: '/Users/x/newer-project', message: { content: 'add the new feature' } }),
    ].join('\n') + '\n',
  );

  // Make mtimes unambiguous regardless of write order/fs clock resolution.
  const now = Date.now() / 1000;
  await utimes(path.join(older, '11111111-1111-1111-1111-111111111111.jsonl'), now - 100, now - 100);
  await utimes(path.join(newer, '22222222-2222-2222-2222-222222222222.jsonl'), now, now);

  return root;
}

test('listResumableSessions sorts newest-first and pulls cwd + label from the transcript', async () => {
  const root = await makeFixtureProjects();
  try {
    const sessions = await listResumableSessions(root);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, '22222222-2222-2222-2222-222222222222');
    assert.equal(sessions[0].cwd, '/Users/x/newer-project');
    assert.equal(sessions[0].label, 'add the new feature');
    assert.equal(sessions[1].sessionId, '11111111-1111-1111-1111-111111111111');
    assert.equal(sessions[1].cwd, '/Users/x/older-project');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listResumableSessions skips the priming-sentinel isMeta entry when picking a label', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-projects-meta-'));
  try {
    const dir = path.join(root, '-Users-x-project');
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, '33333333-3333-3333-3333-333333333333.jsonl'),
      [
        // session.js's priming sentinel persists as an isMeta entry with
        // this exact wrapper text - see src/session-launcher.js's comment.
        JSON.stringify({ type: 'user', isMeta: true, cwd: '/Users/x/project', message: { content: '[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]\n(no content)' } }),
        JSON.stringify({ type: 'user', cwd: '/Users/x/project', message: { content: 'the actual first prompt' } }),
      ].join('\n') + '\n',
    );

    const sessions = await listResumableSessions(root);
    assert.equal(sessions[0].label, 'the actual first prompt');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listResumableSessions returns [] when the projects dir does not exist', async () => {
  const sessions = await listResumableSessions('/nonexistent/path/for/cockpit/tests');
  assert.deepEqual(sessions, []);
});

test('isValidCwd rejects files and missing paths, accepts directories', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-cwd-'));
  try {
    const file = path.join(root, 'a-file.txt');
    await writeFile(file, 'x');
    assert.equal(isValidCwd(root), true);
    assert.equal(isValidCwd(file), false);
    assert.equal(isValidCwd(path.join(root, 'missing')), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listDirectory lists subdirectories only, hides dotdirs, and reports a walkable parent', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-browse-'));
  try {
    await mkdir(path.join(root, 'child-b'));
    await mkdir(path.join(root, 'child-a'));
    await mkdir(path.join(root, '.hidden'));
    await writeFile(path.join(root, 'a-file.txt'), 'x');

    const result = await listDirectory(root);
    assert.equal(result.path, root);
    assert.equal(result.parent, path.dirname(root));
    assert.deepEqual(result.entries.map((e) => e.name), ['child-a', 'child-b']);
    assert.equal(result.entries[0].path, path.join(root, 'child-a'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listDirectory on the filesystem root reports no parent (or the drive list, on Windows)', async () => {
  const result = await listDirectory('/');
  assert.equal(result.parent, process.platform === 'win32' ? DRIVES_SENTINEL : null);
});

test('listDirectory on the drives sentinel lists drive roots (Windows only)', { skip: process.platform !== 'win32' }, async () => {
  const result = await listDirectory(DRIVES_SENTINEL);
  assert.equal(result.parent, null);
  assert.ok(result.entries.length > 0);
  assert.ok(result.entries.every((e) => /^[A-Z]:\\$/.test(e.name)));
});

test('listDirectory rejects a path that does not exist', async () => {
  await assert.rejects(() => listDirectory('/nonexistent/path/for/cockpit/tests'));
});
