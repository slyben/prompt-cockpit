import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readSessionDefaults, setSessionDefaults } from '../src/session-defaults.js';
import { readEnabledPlugins, setPluginEnabled } from '../src/plugin-settings.js';

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

// plugin-settings.test.mjs's own concurrency test only interleaves multiple
// setPluginEnabled calls with each other; settings-file.js's write queue is
// shared across *every* writer of a cwd's settings.local.json, not just
// same-module callers - a plugin toggle and a thinking-budget change landing
// in the same tick is the exact scenario the queue exists to serialize
// (backlog.md: this cross-module interleaving was untested). Fired without
// awaiting between them so both read-modify-write cycles would race on the
// same file if the queue didn't hold.
test('concurrent setSessionDefaults and setPluginEnabled on the same cwd do not clobber each other', async () => {
  const cwd = await makeTmpDir();
  try {
    await Promise.all([
      setSessionDefaults(cwd, { maxThinkingTokens: 4096, thinkingDisplay: 'summarized' }),
      setPluginEnabled(cwd, 'formatter@anthropic-tools', true),
      setSessionDefaults(cwd, { autoContinue: true }),
      setPluginEnabled(cwd, 'linter@anthropic-tools', false),
    ]);
    assert.deepEqual(await readSessionDefaults(cwd), {
      maxThinkingTokens: 4096,
      thinkingDisplay: 'summarized',
      autoContinue: true,
    });
    assert.deepEqual(await readEnabledPlugins(cwd), {
      'formatter@anthropic-tools': true,
      'linter@anthropic-tools': false,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
