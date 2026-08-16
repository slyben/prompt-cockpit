import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readEnabledPlugins, setPluginEnabled } from '../src/plugin-settings.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-plugin-settings-'));
}

test('readEnabledPlugins returns {} when settings.local.json does not exist', async () => {
  const cwd = await makeTmpDir();
  try {
    assert.deepEqual(await readEnabledPlugins(cwd), {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('readEnabledPlugins returns {} on corrupt JSON rather than throwing', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(path.join(cwd, '.claude', 'settings.local.json'), '{ not json', 'utf-8');
    assert.deepEqual(await readEnabledPlugins(cwd), {});
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setPluginEnabled creates .claude/settings.local.json when absent', async () => {
  const cwd = await makeTmpDir();
  try {
    const enabledPlugins = await setPluginEnabled(cwd, 'formatter@anthropic-tools', true);
    assert.deepEqual(enabledPlugins, { 'formatter@anthropic-tools': true });
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.deepEqual(onDisk.enabledPlugins, { 'formatter@anthropic-tools': true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setPluginEnabled preserves unrelated keys already in the file', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ someOtherSetting: 'keep-me', enabledPlugins: { 'a@x': true } }),
      'utf-8',
    );
    await setPluginEnabled(cwd, 'b@y', false);
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.equal(onDisk.someOtherSetting, 'keep-me');
    assert.deepEqual(onDisk.enabledPlugins, { 'a@x': true, 'b@y': false });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('setPluginEnabled toggles an existing key', async () => {
  const cwd = await makeTmpDir();
  try {
    await setPluginEnabled(cwd, 'formatter@anthropic-tools', true);
    await setPluginEnabled(cwd, 'formatter@anthropic-tools', false);
    assert.deepEqual(await readEnabledPlugins(cwd), { 'formatter@anthropic-tools': false });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('concurrent setPluginEnabled calls for different keys do not clobber each other', async () => {
  const cwd = await makeTmpDir();
  try {
    // Fired without awaiting between them, so both read-modify-write cycles
    // would race on the same settings.local.json if writes weren't queued
    // per cwd - see settings-file.js's updateSettingsFile.
    await Promise.all([
      setPluginEnabled(cwd, 'a@x', true),
      setPluginEnabled(cwd, 'b@y', true),
      setPluginEnabled(cwd, 'c@z', true),
    ]);
    assert.deepEqual(await readEnabledPlugins(cwd), { 'a@x': true, 'b@y': true, 'c@z': true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
