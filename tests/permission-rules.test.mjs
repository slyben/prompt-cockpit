import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readAllowRules, addAllowRule, removeAllowRule, formatRule } from '../src/permission-rules.js';
import { setSessionDefaults, readSessionDefaults } from '../src/session-defaults.js';

async function makeTmpDir() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-permission-rules-'));
}

test('formatRule renders a bare tool name with no ruleContent', () => {
  assert.equal(formatRule({ toolName: 'Bash' }), 'Bash');
});

test('formatRule renders a parenthesized rule when ruleContent is given', () => {
  assert.equal(formatRule({ toolName: 'Bash', ruleContent: 'npm run test:*' }), 'Bash(npm run test:*)');
});

test('readAllowRules returns an empty array when settings.local.json does not exist', async () => {
  const cwd = await makeTmpDir();
  try {
    assert.deepEqual(await readAllowRules(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('addAllowRule then readAllowRules round-trips', async () => {
  const cwd = await makeTmpDir();
  try {
    await addAllowRule(cwd, 'Bash');
    assert.deepEqual(await readAllowRules(cwd), ['Bash']);
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.deepEqual(onDisk.permissions.allow, ['Bash']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('addAllowRule dedupes on exact string match', async () => {
  const cwd = await makeTmpDir();
  try {
    await addAllowRule(cwd, 'Bash');
    await addAllowRule(cwd, 'Bash');
    assert.deepEqual(await readAllowRules(cwd), ['Bash']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('removeAllowRule removes an existing rule', async () => {
  const cwd = await makeTmpDir();
  try {
    await addAllowRule(cwd, 'Bash');
    await addAllowRule(cwd, 'Read');
    await removeAllowRule(cwd, 'Bash');
    assert.deepEqual(await readAllowRules(cwd), ['Read']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('removeAllowRule on an unknown rule is a no-op, not an error', async () => {
  const cwd = await makeTmpDir();
  try {
    await addAllowRule(cwd, 'Bash');
    await removeAllowRule(cwd, 'DefinitelyNotThere');
    assert.deepEqual(await readAllowRules(cwd), ['Bash']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('addAllowRule preserves permissions.deny/ask and sessionDefaults already in the file', async () => {
  const cwd = await makeTmpDir();
  try {
    await mkdir(path.join(cwd, '.claude'), { recursive: true });
    await writeFile(
      path.join(cwd, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { deny: ['Write'], ask: ['WebFetch'] }, sessionDefaults: { maxThinkingTokens: 4096 } }),
      'utf-8',
    );
    await addAllowRule(cwd, 'Bash');
    const onDisk = JSON.parse(await readFile(path.join(cwd, '.claude', 'settings.local.json'), 'utf-8'));
    assert.deepEqual(onDisk.permissions.deny, ['Write']);
    assert.deepEqual(onDisk.permissions.ask, ['WebFetch']);
    assert.deepEqual(onDisk.permissions.allow, ['Bash']);
    assert.equal(onDisk.sessionDefaults.maxThinkingTokens, 4096);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Same cross-module concurrency shape as session-defaults.test.mjs/
// session-titles.test.mjs's own tests - settings-file.js's write queue is
// shared across every writer of a cwd's settings.local.json.
test('concurrent addAllowRule and setSessionDefaults on the same cwd do not clobber each other', async () => {
  const cwd = await makeTmpDir();
  try {
    await Promise.all([
      addAllowRule(cwd, 'Bash'),
      setSessionDefaults(cwd, { maxThinkingTokens: 4096, thinkingDisplay: 'summarized' }),
      addAllowRule(cwd, 'Read'),
      setSessionDefaults(cwd, { autoContinue: true }),
    ]);
    assert.deepEqual((await readAllowRules(cwd)).sort(), ['Bash', 'Read']);
    assert.deepEqual(await readSessionDefaults(cwd), {
      maxThinkingTokens: 4096,
      thinkingDisplay: 'summarized',
      autoContinue: true,
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
