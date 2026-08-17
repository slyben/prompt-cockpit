import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSessionTitles, getSessionTitle, setSessionTitle, attachTitles } from '../src/session-titles.js';
import { setSessionDefaults, readSessionDefaults } from '../src/session-defaults.js';
import { setPluginEnabled } from '../src/plugin-settings.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-session-titles-'));
}

test('getSessionTitle returns null when settings.local.json does not exist', async () => {
  const cwd = await makeTmpDir();
  try {
    assert.equal(await getSessionTitle(cwd, 'abc'), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionTitle then getSessionTitle round-trips', async () => {
  const cwd = await makeTmpDir();
  try {
    await setSessionTitle(cwd, 'session-1', '  My renamed session  ');
    assert.equal(await getSessionTitle(cwd, 'session-1'), 'My renamed session'); // trimmed
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.ok(onDisk.sessionTitles['session-1'].title === 'My renamed session');
    assert.ok(typeof onDisk.sessionTitles['session-1'].updatedAt === 'number');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionTitle with an empty/whitespace-only title deletes the entry', async () => {
  const cwd = await makeTmpDir();
  try {
    await setSessionTitle(cwd, 'session-1', 'first title');
    await setSessionTitle(cwd, 'session-1', '   ');
    assert.equal(await getSessionTitle(cwd, 'session-1'), null);
    const titles = await readSessionTitles(cwd);
    assert.equal('session-1' in titles, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionTitle caps at 120 characters', async () => {
  const cwd = await makeTmpDir();
  try {
    const long = 'x'.repeat(200);
    await setSessionTitle(cwd, 'session-1', long);
    const title = await getSessionTitle(cwd, 'session-1');
    assert.equal(title.length, 120);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('getSessionTitle on an unknown session id in a cwd with other titles returns null', async () => {
  const cwd = await makeTmpDir();
  try {
    await setSessionTitle(cwd, 'session-1', 'known');
    assert.equal(await getSessionTitle(cwd, 'session-2'), null);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionTitle preserves sessionDefaults and enabledPlugins already in the file', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ sessionDefaults: { maxThinkingTokens: 4096 }, enabledPlugins: { 'a@x': true } }),
      'utf-8',
    );
    await setSessionTitle(cwd, 'session-1', 'a title');
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.equal(onDisk.sessionDefaults.maxThinkingTokens, 4096);
    assert.deepEqual(onDisk.enabledPlugins, { 'a@x': true });
    assert.equal(onDisk.sessionTitles['session-1'].title, 'a title');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Same cross-module concurrency shape as session-defaults.test.mjs's own
// test - settings-file.js's write queue is shared across every writer of a
// cwd's settings.local.json, not just same-module callers.
test('concurrent setSessionTitle and setSessionDefaults/setPluginEnabled on the same cwd do not clobber each other', async () => {
  const cwd = await makeTmpDir();
  try {
    await Promise.all([
      setSessionTitle(cwd, 'session-1', 'title one'),
      setSessionDefaults(cwd, { maxThinkingTokens: 4096, thinkingDisplay: 'summarized' }),
      setPluginEnabled(cwd, 'formatter@anthropic-tools', true),
      setSessionTitle(cwd, 'session-2', 'title two'),
    ]);
    assert.equal(await getSessionTitle(cwd, 'session-1'), 'title one');
    assert.equal(await getSessionTitle(cwd, 'session-2'), 'title two');
    assert.deepEqual(await readSessionDefaults(cwd), {
      maxThinkingTokens: 4096,
      thinkingDisplay: 'summarized',
      autoContinue: false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('attachTitles joins a title onto a matching session by cwd+sessionId', () => {
  const sessions = [{ sessionId: 's1', cwd: '/proj', label: 'hi' }];
  const titlesByCwd = new Map([['/proj', { s1: { title: 'My title' } }]]);
  const result = attachTitles(sessions, titlesByCwd);
  assert.equal(result[0].title, 'My title');
  assert.equal(result[0].label, 'hi'); // original fields untouched
});

test('attachTitles leaves a session untouched when its cwd has no titles map', () => {
  const sessions = [{ sessionId: 's1', cwd: '/proj' }];
  const result = attachTitles(sessions, new Map());
  assert.deepEqual(result[0], { sessionId: 's1', cwd: '/proj' });
  assert.equal('title' in result[0], false);
});

test('attachTitles leaves a session with cwd: null untouched (no crash)', () => {
  const sessions = [{ sessionId: 's1', cwd: null }];
  const result = attachTitles(sessions, new Map([['irrelevant', {}]]));
  assert.equal('title' in result[0], false);
});

test('attachTitles leaves a session untouched when its own sessionId has no entry in its cwd\'s titles', () => {
  const sessions = [{ sessionId: 's1', cwd: '/proj' }];
  const titlesByCwd = new Map([['/proj', { 'some-other-id': { title: 'not this one' } }]]);
  const result = attachTitles(sessions, titlesByCwd);
  assert.equal('title' in result[0], false);
});
