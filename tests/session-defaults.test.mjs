import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSessionDefaults, setSessionDefaults } from '../src/session-defaults.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-session-defaults-'));
}

test('readSessionDefaults returns the empty defaults when settings.local.json does not exist', async () => {
  const cwd = await makeTmpDir();
  try {
    assert.deepEqual(await readSessionDefaults(cwd), { maxThinkingTokens: null, thinkingDisplay: null, autoContinue: false });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('readSessionDefaults returns the empty defaults on corrupt JSON rather than throwing', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(path.join(cwd, '.claude', 'settings.local.json'), '{ not json', 'utf-8');
    assert.deepEqual(await readSessionDefaults(cwd), { maxThinkingTokens: null, thinkingDisplay: null, autoContinue: false });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionDefaults creates .claude/settings.local.json when absent', async () => {
  const cwd = await makeTmpDir();
  try {
    const defaults = await setSessionDefaults(cwd, { maxThinkingTokens: 10000, thinkingDisplay: 'summarized' });
    assert.deepEqual(defaults, { maxThinkingTokens: 10000, thinkingDisplay: 'summarized', autoContinue: false });
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.deepEqual(onDisk.sessionDefaults, defaults);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionDefaults shallow-merges over what is already stored', async () => {
  const cwd = await makeTmpDir();
  try {
    await setSessionDefaults(cwd, { maxThinkingTokens: 10000, thinkingDisplay: 'summarized' });
    const defaults = await setSessionDefaults(cwd, { autoContinue: true });
    assert.deepEqual(defaults, { maxThinkingTokens: 10000, thinkingDisplay: 'summarized', autoContinue: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setSessionDefaults preserves unrelated keys already in the file, including enabledPlugins', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ someOtherSetting: 'keep-me', enabledPlugins: { 'a@x': true } }),
      'utf-8',
    );
    await setSessionDefaults(cwd, { autoContinue: true });
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.equal(onDisk.someOtherSetting, 'keep-me');
    assert.deepEqual(onDisk.enabledPlugins, { 'a@x': true });
    assert.equal(onDisk.sessionDefaults.autoContinue, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
