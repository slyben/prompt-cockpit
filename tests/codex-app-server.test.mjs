import { EventEmitter } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createCodexAppServerManager,
  createCodexRpcClient,
  getCodexAppServerManager,
  isCodexAvailable,
  resolveCodexBin,
  resolveCodexBinAsync,
  unwrapCodexShim,
  unwrapCodexShimAsync,
  _resetCodexAppServerManager,
} from '../src/codex-app-server.js';

function fakeConnection() {
  const proc = new EventEmitter();
  let rejectPending;
  const client = {
    request(method) {
      if (method === 'initialize') return Promise.resolve({});
      return new Promise((_resolve, reject) => { rejectPending = reject; });
    },
    notify: () => {},
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    rejectAll: (err) => rejectPending?.(err),
  };
  return { proc, client, getStderr: () => '' };
}

test('Codex binary discovery honors CODEX_BIN before PATH and the user install folder', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-codex-'));
  const pathDir = path.join(root, 'path-bin');
  const home = path.join(root, 'home');
  await mkdir(pathDir, { recursive: true });
  await mkdir(path.join(home, '.codex', 'bin'), { recursive: true });
  const pathBin = path.join(pathDir, 'codex');
  const homeBin = path.join(home, '.codex', 'bin', 'codex');
  await writeFile(pathBin, '');
  await writeFile(homeBin, '');

  assert.equal(resolveCodexBin({ platform: 'linux', pathVar: pathDir, home }), pathBin);
  assert.equal(resolveCodexBin({ platform: 'linux', pathVar: '', home }), homeBin);
  assert.equal(resolveCodexBin({ envBin: '/custom/codex', platform: 'linux', pathVar: pathDir, home }), '/custom/codex');
  assert.equal(await resolveCodexBinAsync({ platform: 'linux', pathVar: pathDir, home }), pathBin);
  assert.equal(await resolveCodexBinAsync({ platform: 'linux', pathVar: '', home }), homeBin);
});

test('Windows CODEX_BIN accepts npm\'s extensionless shim path', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'cockpit-codex-'));
  const envBin = path.join(root, 'codex');
  const cmdBin = `${envBin}.cmd`;
  await writeFile(envBin, '#!/bin/sh\n');
  await writeFile(cmdBin, '@echo off\n');

  assert.equal(resolveCodexBin({ envBin, platform: 'win32' }), cmdBin);
  assert.equal(await resolveCodexBinAsync({ envBin, platform: 'win32' }), cmdBin);
});

test('Windows npm shims are unwrapped without enabling a command shell', async () => {
  const shim = String.raw`C:\tools\codex.cmd`;
  const entry = String.raw`C:\tools\node_modules\codex\bin\codex.js`;
  const result = unwrapCodexShim(shim, {
    readFileSyncImpl: () => `@\"%~dp0\\node_modules\\codex\\bin\\codex.js\" %*`,
    existsSyncImpl: (candidate) => candidate === entry,
    nodeBin: String.raw`C:\node\node.exe`,
  });
  assert.deepEqual(result, { command: String.raw`C:\node\node.exe`, prefixArgs: [entry] });

  const asyncResult = await unwrapCodexShimAsync(shim, {
    readFileImpl: async () => `@"%~dp0\\node_modules\\codex\\bin\\codex.js" %*`,
    accessImpl: async (candidate) => {
      if (candidate !== entry) throw new Error('missing');
    },
    nodeBin: String.raw`C:\node\node.exe`,
  });
  assert.deepEqual(asyncResult, { command: String.raw`C:\node\node.exe`, prefixArgs: [entry] });
});

test('availability probing is asynchronous and missing Codex is non-fatal', async () => {
  const proc = new EventEmitter();
  proc.kill = () => {};
  let spawnOptions;
  const available = isCodexAvailable({
    resolveSpawn: () => ({ command: 'missing-codex', prefixArgs: [] }),
    spawnImpl: (_command, _args, options) => {
      spawnOptions = options;
      queueMicrotask(() => proc.emit('error', Object.assign(new Error('ENOENT'), { code: 'ENOENT' })));
      return proc;
    },
  });

  assert.ok(available instanceof Promise);
  assert.equal(await available, false);
  assert.equal(spawnOptions.shell, false);
  assert.equal(spawnOptions.windowsHide, true);
});

test('JSON-RPC client correlates responses, notifications, and server requests', async () => {
  const writes = [];
  let receive;
  const client = createCodexRpcClient({
    writeLine: (line) => writes.push(JSON.parse(line)),
    subscribeLine: (handler) => { receive = handler; },
  });

  const notifications = [];
  client.onNotification((method, params) => notifications.push([method, params]));
  client.onServerRequest(async (method) => method === 'approve'
    ? { handled: true, result: { decision: 'accept' } }
    : { handled: false });

  const pending = client.request('thread/list', { limit: 1 });
  assert.deepEqual(writes[0], { method: 'thread/list', id: 1, params: { limit: 1 } });
  receive(JSON.stringify({ id: 1, result: { data: [] } }));
  assert.deepEqual(await pending, { data: [] });

  receive(JSON.stringify({ method: 'turn/started', params: { turn: { id: 'turn-1' } } }));
  assert.deepEqual(notifications, [['turn/started', { turn: { id: 'turn-1' } }]]);

  receive(JSON.stringify({ method: 'approve', id: 9, params: {} }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(writes.at(-1), { id: 9, result: { decision: 'accept' } });
});

test('JSON-RPC client suppresses a late response after serverRequest/resolved', async () => {
  const writes = [];
  let receive;
  let release;
  const client = createCodexRpcClient({
    writeLine: (line) => writes.push(JSON.parse(line)),
    subscribeLine: (handler) => { receive = handler; },
  });
  client.onServerRequest(() => new Promise((resolve) => { release = resolve; }));

  receive(JSON.stringify({ method: 'approve', id: 12, params: { threadId: 'thread-1' } }));
  await new Promise((resolve) => setImmediate(resolve));
  receive(JSON.stringify({ method: 'serverRequest/resolved', params: { threadId: 'thread-1', requestId: 12 } }));
  release({ handled: true, result: { decision: 'cancel' } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(writes, []);
});

test('manager initializes once and turns a missing executable into a rejected readiness promise', async () => {
  const proc = new EventEmitter();
  const requests = [];
  const notifications = [];
  let rejectPending;
  const client = {
    request(method, params) {
      requests.push([method, params]);
      return new Promise((_resolve, reject) => { rejectPending = reject; });
    },
    notify: (method, params) => notifications.push([method, params]),
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    rejectAll: (err) => rejectPending?.(err),
  };
  const manager = createCodexAppServerManager({
    connectImpl: () => ({ proc, client, getStderr: () => '' }),
  });

  assert.equal(requests[0][0], 'initialize');
  const packageVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(requests[0][1].clientInfo.version, packageVersion);
  proc.emit('error', Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }));
  await assert.rejects(manager.ready(), /Unable to start codex app-server.*ENOENT/);
  assert.deepEqual(notifications, []);
});

test('manager retires itself when the initialize handshake is rejected', async () => {
  const proc = new EventEmitter();
  let killCalls = 0;
  proc.kill = () => { killCalls += 1; };
  const client = {
    request(method) {
      if (method === 'initialize') return Promise.reject(new Error('initialize rejected: incompatible client'));
      return Promise.reject(new Error('unexpected request'));
    },
    notify: () => {},
    onNotification: () => () => {},
    onServerRequest: () => () => {},
    rejectAll: () => {},
  };
  const manager = createCodexAppServerManager({
    connectImpl: () => ({ proc, client, getStderr: () => '' }),
  });

  await assert.rejects(manager.ready(), /initialize rejected/);
  assert.equal(manager.isClosed(), true);
  assert.equal(killCalls, 1, 'a rejected handshake must terminate its child process');
  await assert.rejects(manager.request('thread/list'), /codex app-server is closed/);
});

test('manager notifies onClose subscribers when the app-server process exits, not just rejectAll', async () => {
  const connection = fakeConnection();
  const manager = createCodexAppServerManager({ connectImpl: () => connection });
  await manager.ready();

  const closedErrors = [];
  manager.onClose((err) => closedErrors.push(err));
  assert.equal(manager.isClosed(), false);

  connection.proc.emit('exit', 1);
  assert.equal(manager.isClosed(), true);
  assert.equal(closedErrors.length, 1);
  assert.match(closedErrors[0].message, /codex app-server exited 1/);
  // request() must fail fast afterward rather than hanging on a dead process
  await assert.rejects(manager.request('thread/list'), /codex app-server is closed/);
});

test('manager notifies onClose subscribers on an explicit close() too', async () => {
  const connection = fakeConnection();
  connection.proc.kill = () => {};
  const manager = createCodexAppServerManager({ connectImpl: () => connection });
  await manager.ready();

  const closedErrors = [];
  manager.onClose((err) => closedErrors.push(err));
  manager.close();
  assert.equal(manager.isClosed(), true);
  assert.equal(closedErrors.length, 1);
  assert.match(closedErrors[0].message, /codex app-server closed/);
});

test('getCodexAppServerManager recreates the singleton once the current one has died', async () => {
  _resetCodexAppServerManager();
  const connections = [];
  const connectImpl = () => {
    const connection = fakeConnection();
    connection.proc.kill = () => {};
    connections.push(connection);
    return connection;
  };

  const first = getCodexAppServerManager({ connectImpl });
  assert.equal(getCodexAppServerManager({ connectImpl }), first, 'same instance while alive');

  connections[0].proc.emit('exit', 1);
  assert.equal(first.isClosed(), true);

  const second = getCodexAppServerManager({ connectImpl });
  assert.notEqual(second, first, 'a closed manager must not be handed out again');
  assert.equal(second.isClosed(), false);
  _resetCodexAppServerManager();
});

test('retainThread/releaseThread ref-count a thread instead of an unconditional unsubscribe', async () => {
  const connection = fakeConnection();
  connection.proc.kill = () => {};
  const manager = createCodexAppServerManager({ connectImpl: () => connection });
  await manager.ready();

  manager.retainThread('thread-1');
  manager.retainThread('thread-1');
  assert.equal(manager.releaseThread('thread-1'), false, 'still one reference left');
  assert.equal(manager.releaseThread('thread-1'), true, 'last reference released');
  // Releasing a thread nothing ever retained is a no-op, not an underflow -
  // a session that never successfully started shouldn't be able to send a
  // still-referenced thread's count negative.
  assert.equal(manager.releaseThread('thread-1'), true);
});
