import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createAcpClient,
  resolveGrokBin,
  unwrapWindowsShim,
  killGrokProcess,
  spawnGrokAgent,
  isSafeGrokArg,
  assertSafeGrokArgs,
} from '../src/grok-acp.js';

function fakeTransport() {
  const written = [];
  let lineHandler = null;
  const client = createAcpClient({
    writeLine: (line) => written.push(line),
    subscribeLine: (handler) => { lineHandler = handler; },
  });
  return {
    client,
    written,
    incoming(obj) {
      lineHandler(JSON.stringify(obj));
    },
  };
}

test('request writes a JSON-RPC line and resolves with the matching result', async () => {
  const { client, written, incoming } = fakeTransport();
  const pending = client.request('initialize', { protocolVersion: 1 });
  const sent = JSON.parse(written[0]);
  assert.equal(sent.method, 'initialize');
  assert.equal(sent.params.protocolVersion, 1);
  incoming({ jsonrpc: '2.0', id: sent.id, result: { protocolVersion: 1 } });
  assert.deepEqual(await pending, { protocolVersion: 1 });
});

test('request rejects on a JSON-RPC error', async () => {
  const { client, written, incoming } = fakeTransport();
  const pending = client.request('session/new', {});
  const sent = JSON.parse(written[0]);
  incoming({ jsonrpc: '2.0', id: sent.id, error: { message: 'nope' } });
  await assert.rejects(pending, /nope/);
});

test('incoming request is answered by onRequest', async () => {
  const { client, written, incoming } = fakeTransport();
  client.onRequest('session/request_permission', async () => ({ outcome: { outcome: 'cancelled' } }));
  incoming({ jsonrpc: '2.0', id: 7, method: 'session/request_permission', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = JSON.parse(written.at(-1));
  assert.equal(reply.id, 7);
  assert.equal(reply.result.outcome.outcome, 'cancelled');
});

test('request times out if no response arrives', async () => {
  const { client } = fakeTransport();
  await assert.rejects(client.request('initialize', {}, { timeoutMs: 20 }), /timed out/);
});

// Every case pins pathVar/home/grokHome so the result never depends on
// whether the machine running the tests happens to have grok installed.
const NO_INSTALL = { pathVar: '', home: path.join(tmpdir(), 'grok-no-home'), grokHome: undefined, envBin: undefined };

test('resolveGrokBin prefers GROK_BIN, then grok.exe over grok.cmd on PATH', async () => {
  assert.equal(resolveGrokBin({ ...NO_INSTALL, envBin: 'D:\\custom\\grok.exe' }), 'D:\\custom\\grok.exe');
  assert.equal(resolveGrokBin({ ...NO_INSTALL, platform: 'linux' }), 'grok');
  assert.equal(resolveGrokBin({ ...NO_INSTALL, platform: 'win32' }), 'grok.exe');

  const dir = await mkdtemp(path.join(tmpdir(), 'grok-bin-'));
  try {
    await writeFile(path.join(dir, 'grok.exe'), '');
    await writeFile(path.join(dir, 'grok.cmd'), '');
    const found = resolveGrokBin({ ...NO_INSTALL, platform: 'win32', pathVar: dir });
    assert.equal(found, path.join(dir, 'grok.exe'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }

  const cmdOnly = await mkdtemp(path.join(tmpdir(), 'grok-cmd-'));
  try {
    await writeFile(path.join(cmdOnly, 'grok.cmd'), '');
    const found = resolveGrokBin({ ...NO_INSTALL, platform: 'win32', pathVar: cmdOnly });
    assert.equal(found, path.join(cmdOnly, 'grok.cmd'));
  } finally {
    await rm(cmdOnly, { recursive: true, force: true });
  }
});

// The installer does not put its own bin dir on PATH, so this is the path
// a stock install actually takes.
test('resolveGrokBin falls back to <GROK_HOME|~/.grok>/bin when PATH has no grok', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'grok-home-'));
  try {
    await mkdir(path.join(home, '.grok', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.grok', 'bin', 'grok.exe'), '');
    assert.equal(
      resolveGrokBin({ platform: 'win32', pathVar: '', envBin: undefined, grokHome: undefined, home }),
      path.join(home, '.grok', 'bin', 'grok.exe'),
    );

    // GROK_HOME wins over ~/.grok, and posix installs use the bare name
    const custom = path.join(home, 'elsewhere');
    await mkdir(path.join(custom, 'bin'), { recursive: true });
    await writeFile(path.join(custom, 'bin', 'grok'), '');
    assert.equal(
      resolveGrokBin({ platform: 'linux', pathVar: '', envBin: undefined, grokHome: custom, home }),
      path.join(custom, 'bin', 'grok'),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// PATH is searched first: a user-managed grok beats the bundled install.
test('resolveGrokBin prefers a PATH hit over the install dir', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'grok-both-'));
  try {
    await mkdir(path.join(home, '.grok', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.grok', 'bin', 'grok.exe'), '');
    const onPath = path.join(home, 'bin');
    await mkdir(onPath, { recursive: true });
    await writeFile(path.join(onPath, 'grok.exe'), '');
    assert.equal(
      resolveGrokBin({ platform: 'win32', pathVar: onPath, envBin: undefined, grokHome: undefined, home }),
      path.join(onPath, 'grok.exe'),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

// An npm grok.cmd on PATH must not beat the official grok.exe sitting in
// ~/.grok/bin. Same-dir .exe-before-.cmd is not enough: the documented npm
// install puts only the shim on PATH.
test('resolveGrokBin prefers install-dir grok.exe over a PATH grok.cmd', async () => {
  const home = await mkdtemp(path.join(tmpdir(), 'grok-exe-vs-cmd-'));
  try {
    await mkdir(path.join(home, '.grok', 'bin'), { recursive: true });
    await writeFile(path.join(home, '.grok', 'bin', 'grok.exe'), '');
    const onPath = path.join(home, 'npm');
    await mkdir(onPath);
    await writeFile(path.join(onPath, 'grok.cmd'), '');
    assert.equal(
      resolveGrokBin({ platform: 'win32', pathVar: onPath, envBin: undefined, grokHome: undefined, home }),
      path.join(home, '.grok', 'bin', 'grok.exe'),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test('isSafeGrokArg / assertSafeGrokArgs reject cmd metacharacters', () => {
  assert.equal(isSafeGrokArg('grok-4.6'), true);
  assert.equal(isSafeGrokArg('grok-4.6-build'), true);
  assert.equal(isSafeGrokArg('sonnet'), true);
  assert.equal(isSafeGrokArg('grok-4.5 & calc'), false);
  assert.equal(isSafeGrokArg('x|whoami'), false);
  assert.equal(isSafeGrokArg(''), false);
  assert.doesNotThrow(() => assertSafeGrokArgs(['inspect', '--json', 'mcp', 'enable', 'ffind']));
  assert.throws(() => assertSafeGrokArgs(['mcp', 'disable', 'name & calc']), /invalid grok argument/);
});

test('unwrapWindowsShim prefers a sibling grok.exe, then a quoted js target', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'grok-shim-'));
  try {
    const cmd = path.join(dir, 'grok.cmd');
    await writeFile(cmd, '@echo off\n');
    assert.equal(unwrapWindowsShim(cmd), null);

    const exe = path.join(dir, 'grok.exe');
    await writeFile(exe, '');
    assert.deepEqual(unwrapWindowsShim(cmd), { command: exe, prefixArgs: [] });

    const jsDir = await mkdtemp(path.join(tmpdir(), 'grok-shim-js-'));
    try {
      const js = path.join(jsDir, 'grok.js');
      const shim = path.join(jsDir, 'grok.cmd');
      await writeFile(js, '');
      await writeFile(shim, `endLocal & "%_prog%"  "${js}" %*\n`);
      assert.deepEqual(
        unwrapWindowsShim(shim, { nodeBin: 'node.exe' }),
        { command: 'node.exe', prefixArgs: [js] },
      );
    } finally {
      await rm(jsDir, { recursive: true, force: true });
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('killGrokProcess uses taskkill /T /F on Windows and proc.kill elsewhere', () => {
  const calls = [];
  killGrokProcess({ pid: 1234, killed: false, exitCode: null }, {
    platform: 'win32',
    spawnSyncImpl: (cmd, args, opts) => { calls.push({ cmd, args, opts }); },
  });
  assert.equal(calls[0].cmd, 'taskkill');
  assert.deepEqual(calls[0].args, ['/pid', '1234', '/t', '/f']);

  let killed = false;
  killGrokProcess({ pid: 9, kill: () => { killed = true; } }, {
    platform: 'linux',
    spawnSyncImpl: () => { throw new Error('should not spawn'); },
  });
  assert.equal(killed, true);
});

test('spawnGrokAgent rejects an unsafe model and always sets shell:false', () => {
  assert.throws(
    () => spawnGrokAgent({ model: 'x & calc', spawnImpl: () => { throw new Error('spawned'); } }),
    /invalid model/,
  );
  const seen = [];
  const fakeProc = { on() {}, stdin: { on() {} }, stderr: { on() {} } };
  spawnGrokAgent({
    model: 'grok-4.6',
    spawnImpl: (command, args, opts) => {
      seen.push({ command, args, opts });
      return fakeProc;
    },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.shell, false);
  assert.ok(seen[0].args.includes('grok-4.6'));
});

test('notifications reach onNotification and unknown methods return -32601', async () => {
  const { client, written, incoming } = fakeTransport();
  const seen = [];
  client.onNotification((method, params) => seen.push({ method, params }));
  incoming({ jsonrpc: '2.0', method: 'session/update', params: { update: { sessionUpdate: 'plan' } } });
  assert.equal(seen[0].method, 'session/update');
  incoming({ jsonrpc: '2.0', id: 3, method: 'fs/read_text_file', params: {} });
  await new Promise((resolve) => setImmediate(resolve));
  const reply = JSON.parse(written.at(-1));
  assert.equal(reply.error.code, -32601);
});
