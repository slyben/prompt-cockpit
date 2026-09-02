// Shared JSON-RPC client for `codex app-server`. One app-server process can
// host many threads, so Cockpit sessions subscribe to this manager instead of
// spawning one Codex process per browser tab.
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { access, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const REQUEST_TIMEOUT_MS = 20 * 60 * 1000;
const CLIENT_INFO = {
  name: 'prompt_cockpit',
  title: 'Prompt Cockpit',
  version: '0.1.5', // keep in sync with package.json's version
};

function pathCandidates(pathVar, installDir, names) {
  const dirs = [...String(pathVar || '').split(path.delimiter), installDir].filter(Boolean);
  return names.flatMap((name) => dirs.map((dir) => path.join(dir, name)));
}

function explicitBinCandidates(envBin, win) {
  if (!envBin || !win || path.extname(envBin)) return envBin ? [envBin] : [];
  // npm's global bin directory contains an extensionless POSIX shell shim
  // beside the Windows launchers. CODEX_BIN commonly gets copied from
  // `which codex` as that extensionless path, so prefer its executable
  // Windows siblings automatically.
  return [`${envBin}.exe`, `${envBin}.cmd`, `${envBin}.bat`, envBin];
}

async function firstAccessible(candidates, accessImpl = access) {
  for (const candidate of candidates) {
    try {
      await accessImpl(candidate);
      return candidate;
    } catch {
      // Keep looking. Missing candidates are the normal optional-provider case.
    }
  }
  return null;
}

export function resolveCodexBin({
  platform = process.platform,
  pathVar = process.env.PATH,
  envBin = process.env.CODEX_BIN,
  home = homedir(),
} = {}) {
  const win = platform === 'win32';
  if (envBin) return explicitBinCandidates(envBin, win).find((candidate) => existsSync(candidate)) || envBin;
  const installDir = path.join(home, '.codex', 'bin');
  const preferred = pathCandidates(pathVar, installDir, win ? ['codex.exe'] : ['codex']);
  const fallback = win ? pathCandidates(pathVar, installDir, ['codex.cmd', 'codex.bat']) : [];
  return [...preferred, ...fallback].find((candidate) => existsSync(candidate)) || (win ? 'codex.exe' : 'codex');
}

export async function resolveCodexBinAsync({
  platform = process.platform,
  pathVar = process.env.PATH,
  envBin = process.env.CODEX_BIN,
  home = homedir(),
  accessImpl = access,
} = {}) {
  const win = platform === 'win32';
  if (envBin) return await firstAccessible(explicitBinCandidates(envBin, win), accessImpl) || envBin;
  const installDir = path.join(home, '.codex', 'bin');
  const preferred = pathCandidates(pathVar, installDir, win ? ['codex.exe'] : ['codex']);
  const fallback = win ? pathCandidates(pathVar, installDir, ['codex.cmd', 'codex.bat']) : [];
  return await firstAccessible([...preferred, ...fallback], accessImpl) || (win ? 'codex.exe' : 'codex');
}

// npm-installed Windows CLIs are .cmd shims. Avoid shell:true: resolve the
// quoted JS entrypoint and invoke it with this Node executable instead.
export function unwrapCodexShim(command, {
  readFileSyncImpl = readFileSync,
  existsSyncImpl = existsSync,
  nodeBin = process.execPath,
} = {}) {
  if (typeof command !== 'string' || !/\.(cmd|bat)$/i.test(command)) return null;
  let text;
  try {
    text = readFileSyncImpl(command, 'utf8');
  } catch {
    return null;
  }
  // A .cmd/.bat path is Windows syntax even when Cockpit is being tested or
  // packaged from Linux/WSL. Generic `path` follows the host OS and would
  // reduce `C:\\tools\\codex.cmd` to `.`, corrupting %~dp0 expansion.
  const dir = path.win32.dirname(command);
  const resolved = text
    .replace(/%~dp0\\?/gi, `${dir}${path.win32.sep}`)
    .replace(/%dp0%\\?/gi, `${dir}${path.win32.sep}`);
  const jsMatch = resolved.match(/"([^"\r\n]+\.js)"/i);
  if (jsMatch && existsSyncImpl(jsMatch[1])) return { command: nodeBin, prefixArgs: [jsMatch[1]] };
  const exeMatch = resolved.match(/"([^"\r\n]+\.exe)"/i);
  if (exeMatch && existsSyncImpl(exeMatch[1]) && !/cmd\.exe$/i.test(exeMatch[1])) {
    return { command: exeMatch[1], prefixArgs: [] };
  }
  return null;
}

export async function unwrapCodexShimAsync(command, {
  readFileImpl = readFile,
  accessImpl = access,
  nodeBin = process.execPath,
} = {}) {
  if (typeof command !== 'string' || !/\.(cmd|bat)$/i.test(command)) return null;
  let text;
  try {
    text = await readFileImpl(command, 'utf8');
  } catch {
    return null;
  }
  const dir = path.win32.dirname(command);
  const resolved = text
    .replace(/%~dp0\\?/gi, `${dir}${path.win32.sep}`)
    .replace(/%dp0%\\?/gi, `${dir}${path.win32.sep}`);
  const jsMatch = resolved.match(/"([^"\r\n]+\.js)"/i);
  if (jsMatch && await firstAccessible([jsMatch[1]], accessImpl)) {
    return { command: nodeBin, prefixArgs: [jsMatch[1]] };
  }
  const exeMatch = resolved.match(/"([^"\r\n]+\.exe)"/i);
  if (exeMatch && !/cmd\.exe$/i.test(exeMatch[1]) && await firstAccessible([exeMatch[1]], accessImpl)) {
    return { command: exeMatch[1], prefixArgs: [] };
  }
  return null;
}

function resolveCodexSpawn(resolveBin = resolveCodexBin) {
  const command = resolveBin();
  return unwrapCodexShim(command) || { command, prefixArgs: [] };
}

async function resolveCodexSpawnAsync(resolveBin = resolveCodexBinAsync) {
  const command = await resolveBin();
  return await unwrapCodexShimAsync(command) || { command, prefixArgs: [] };
}

export async function isCodexAvailable({ spawnImpl = spawn, resolveSpawn = resolveCodexSpawnAsync, timeoutMs = 5000 } = {}) {
  let command;
  let prefixArgs;
  try {
    ({ command, prefixArgs } = await resolveSpawn());
  } catch {
    return false;
  }
  return await new Promise((resolve) => {
    let proc;
    try {
      proc = spawnImpl(command, [...prefixArgs, '--version'], {
        windowsHide: true,
        shell: false,
        stdio: 'ignore',
      });
    } catch {
      resolve(false);
      return;
    }
    let settled = false;
    let timer;
    const finish = (available) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(available);
    };
    timer = setTimeout(() => {
      try { proc.kill(); } catch { /* already stopped */ }
      finish(false);
    }, timeoutMs);
    proc.once('error', () => finish(false));
    proc.once('exit', (code) => finish(code === 0));
  });
}

export function createCodexRpcClient({ writeLine, subscribeLine }) {
  let nextId = 1;
  const pending = new Map();
  const notificationHandlers = new Set();
  const serverRequestHandlers = new Set();

  function send(payload) {
    writeLine(JSON.stringify(payload));
  }

  async function handleServerRequest(msg) {
    for (const handler of serverRequestHandlers) {
      const handled = await handler(msg.method, msg.params || {}, msg.id);
      if (handled && handled.handled) {
        send({ id: msg.id, result: handled.result ?? null });
        return;
      }
    }
    send({ id: msg.id, error: { code: -32601, message: `Method not handled: ${msg.method}` } });
  }

  function handleLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id != null && !msg.method && (Object.hasOwn(msg, 'result') || msg.error)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (!msg.method) return;
    if (msg.id != null) {
      Promise.resolve(handleServerRequest(msg)).catch((err) => {
        send({ id: msg.id, error: { code: -32000, message: String(err?.message || err) } });
      });
      return;
    }
    for (const handler of notificationHandlers) handler(msg.method, msg.params || {});
  }

  subscribeLine(handleLine);

  return {
    request(method, params = {}, { timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
      const id = nextId++;
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return;
          pending.delete(id);
          reject(new Error(`${method} timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => { clearTimeout(timer); resolve(value); },
          reject: (err) => { clearTimeout(timer); reject(err); },
        });
      });
      send({ method, id, params });
      return promise;
    },
    notify(method, params = {}) {
      send({ method, params });
    },
    onNotification(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onServerRequest(handler) {
      serverRequestHandlers.add(handler);
      return () => serverRequestHandlers.delete(handler);
    },
    rejectAll(err) {
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    },
  };
}

function spawnCodexAppServer({ spawnImpl = spawn, resolveSpawn = resolveCodexSpawn } = {}) {
  const { command, prefixArgs } = resolveSpawn();
  const proc = spawnImpl(command, [...prefixArgs, 'app-server'], {
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });
  proc.on('error', () => {});
  proc.stdin?.on('error', () => {});
  proc.stdout?.on('error', () => {});
  proc.stderr?.on('error', () => {});

  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });
  const client = createCodexRpcClient({
    writeLine(line) {
      if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(`${line}\n`);
    },
    subscribeLine(handler) {
      if (!proc.stdout) return;
      createInterface({ input: proc.stdout }).on('line', handler);
    },
  });
  return { proc, client, command, getStderr: () => stderr };
}

export function createCodexAppServerManager({ connectImpl = spawnCodexAppServer } = {}) {
  const connection = connectImpl();
  const notificationHandlers = new Set();
  const requestHandlers = new Set();
  const closeHandlers = new Set();
  // thread/unsubscribe is scoped to this one shared connection, not to
  // whichever Cockpit session asked for it - if two rows both resumed the
  // same Codex thread (two tabs on the same past session, say), one of them
  // closing and unsubscribing would silently cut the other's live stream
  // too. Ref-count instead: only actually send thread/unsubscribe once
  // nothing still wants that thread.
  const threadRefCounts = new Map();
  let closed = false;

  const offNotification = connection.client.onNotification((method, params) => {
    for (const handler of notificationHandlers) handler(method, params);
  });
  const offRequest = connection.client.onServerRequest(async (method, params, id) => {
    for (const handler of requestHandlers) {
      const result = await handler(method, params, id);
      if (result && result.handled) return result;
    }
    return { handled: false };
  });

  const readyPromise = connection.client.request('initialize', { clientInfo: CLIENT_INFO })
    .then((result) => {
      connection.client.notify('initialized', {});
      return result;
    });
  readyPromise.catch(() => {});

  // Marks the manager dead and tells every subscribed Codex session so
  // (via closeHandlers) - a session's own turn/completed waiter otherwise
  // has no way to learn the app-server is gone: rejectAll() only reaches
  // in-flight RPC requests, not a waitForTurn() promise parked on a
  // completionWaiters map entry with no pending request behind it.
  function fail(err) {
    if (closed) return;
    closed = true;
    connection.client.rejectAll(err);
    for (const handler of closeHandlers) handler(err);
  }

  connection.proc?.on('error', (err) => {
    fail(new Error(`Unable to start codex app-server: ${String(err?.message || err)}`, { cause: err }));
  });
  connection.proc?.on('exit', (code) => {
    fail(new Error(`codex app-server exited ${code}: ${connection.getStderr?.() || ''}`));
  });

  return {
    ready: () => readyPromise,
    isClosed: () => closed,
    async request(method, params = {}, options) {
      if (closed) throw new Error('codex app-server is closed');
      await readyPromise;
      return connection.client.request(method, params, options);
    },
    subscribe(handler) {
      notificationHandlers.add(handler);
      return () => notificationHandlers.delete(handler);
    },
    onServerRequest(handler) {
      requestHandlers.add(handler);
      return () => requestHandlers.delete(handler);
    },
    // Call once a session has (re)subscribed itself to a thread - after a
    // successful thread/start or thread/resume, which is what actually
    // establishes the connection's subscription server-side.
    retainThread(threadId) {
      threadRefCounts.set(threadId, (threadRefCounts.get(threadId) || 0) + 1);
    },
    // Call when a session is done with a thread (closing, or switching to a
    // different one). Returns true when this was the last interested
    // session, meaning the caller should actually send thread/unsubscribe;
    // false means some other session still needs the thread's events, so
    // the caller must not unsubscribe the shared connection out from under
    // it.
    releaseThread(threadId) {
      const count = threadRefCounts.get(threadId) || 0;
      if (count <= 1) {
        threadRefCounts.delete(threadId);
        return true;
      }
      threadRefCounts.set(threadId, count - 1);
      return false;
    },
    // Fires once, when the app-server dies for any reason (crash, exit, or
    // an explicit close() below) - a Codex session subscribes to this to
    // reject its own pending turn waiter and surface an error instead of
    // sitting in 'running' forever. Unlike notificationHandlers/requestHandlers,
    // deliberately not cleared on close(): a handler fired exactly once by
    // fail() has nothing left to unsubscribe from afterward.
    onClose(handler) {
      closeHandlers.add(handler);
      return () => closeHandlers.delete(handler);
    },
    close() {
      if (closed) return;
      offNotification();
      offRequest();
      fail(new Error('codex app-server closed'));
      try { connection.proc?.kill(); } catch { /* already stopped */ }
    },
  };
}

let defaultManager = null;

// A crashed/exited app-server marks itself closed (see fail() above) but
// never recovers on its own - every subsequent request() would otherwise
// throw 'codex app-server is closed' for the life of the Cockpit process.
// Recreate it here instead of returning the dead singleton forever.
export function getCodexAppServerManager(options) {
  if (!defaultManager || defaultManager.isClosed()) defaultManager = createCodexAppServerManager(options);
  return defaultManager;
}

export function _resetCodexAppServerManager() {
  defaultManager?.close();
  defaultManager = null;
}
