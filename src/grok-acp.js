// Minimal JSON-RPC 2.0 client for `grok agent stdio`. One object per line.
// Injected write/subscribe so tests do not spawn a process.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

const DEFAULT_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

// Values that land in argv. Windows still routes .cmd/.bat through cmd.exe
// even with shell:false, so metacharacters in --model/--effort (or plugin
// names) would be interpreted by cmd. Keep this tight: letters, digits, and
// the separators real model ids actually use.
const SAFE_GROK_ARG = /^[A-Za-z0-9][A-Za-z0-9._:+-]*$/;
const SAFE_GROK_CLI_ARG = /^[-A-Za-z0-9][-A-Za-z0-9._:+@/]*$/;

export function isSafeGrokArg(value) {
  return typeof value === 'string' && value.length > 0 && value.length < 200 && SAFE_GROK_ARG.test(value);
}

export function assertSafeGrokArgs(args) {
  for (const arg of args) {
    if (typeof arg !== 'string' || !arg || arg.length > 200 || !SAFE_GROK_CLI_ARG.test(arg)) {
      throw new Error(`invalid grok argument: ${arg}`);
    }
  }
}

// Official installer drops grok.exe; an npm shim is grok.cmd. Prefer a real
// .exe anywhere we can see it (PATH or the installer dir) before accepting
// a shim: shell:false is not enough once Windows picks .cmd, because spawn
// still goes through cmd.exe (injection + zombie children on kill).
//
// PATH is searched first so a user-managed grok.exe wins, then the
// installer's own <GROK_HOME|~/.grok>/bin, which it does not add to PATH -
// without that second location a stock install resolves to a bare name and
// dies ENOENT. Shims are last-resort only.
export function resolveGrokBin({
  platform = process.platform,
  pathVar = process.env.PATH,
  envBin = process.env.GROK_BIN,
  grokHome = process.env.GROK_HOME,
  home = homedir(),
} = {}) {
  if (envBin) return envBin;
  const win = platform === 'win32';
  const preferred = win ? ['grok.exe'] : ['grok'];
  const fallbacks = win ? ['grok.cmd', 'grok.bat'] : [];
  const installDir = path.join(grokHome || path.join(home, '.grok'), 'bin');
  const dirs = [...String(pathVar || '').split(path.delimiter), installDir].filter(Boolean);
  for (const name of preferred) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  for (const name of fallbacks) {
    for (const dir of dirs) {
      const candidate = path.join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
  }
  return win ? 'grok.exe' : 'grok';
}

// If we still have to launch a .cmd/.bat (npm-only install), try to spawn
// the real target instead of the wrapper. Sibling grok.exe first; then the
// quoted .js / .exe the npm shim points at.
export function unwrapWindowsShim(command, {
  readFileSyncImpl = readFileSync,
  existsSyncImpl = existsSync,
  nodeBin = process.execPath,
} = {}) {
  if (typeof command !== 'string' || !command) return null;
  const lower = command.toLowerCase();
  if (!lower.endsWith('.cmd') && !lower.endsWith('.bat')) return null;
  const dir = path.dirname(command);
  const sibling = path.join(dir, 'grok.exe');
  if (existsSyncImpl(sibling)) return { command: sibling, prefixArgs: [] };

  let text;
  try {
    text = readFileSyncImpl(command, 'utf8');
  } catch {
    return null;
  }
  const resolved = text
    .replace(/%~dp0\\?/gi, `${dir}${path.sep}`)
    .replace(/%dp0%\\?/gi, `${dir}${path.sep}`);
  const jsMatch = resolved.match(/"([^"\r\n]+\.js)"/i);
  if (jsMatch && existsSyncImpl(jsMatch[1])) {
    return { command: nodeBin, prefixArgs: [jsMatch[1]] };
  }
  const exeMatch = resolved.match(/"([^"\r\n]+\.exe)"/i);
  if (exeMatch && existsSyncImpl(exeMatch[1]) && !/cmd\.exe$/i.test(exeMatch[1])) {
    return { command: exeMatch[1], prefixArgs: [] };
  }
  return null;
}

export function resolveGrokSpawn(resolveBin = resolveGrokBin) {
  const command = resolveBin();
  const unwrapped = unwrapWindowsShim(command);
  if (unwrapped) return unwrapped;
  return { command, prefixArgs: [] };
}

// cmd.exe wrappers survive proc.kill() - the real grok (paid) keeps running.
// taskkill /T walks the tree. On Unix the spawned pid is the agent itself.
export function killGrokProcess(proc, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (!proc || proc.killed || proc.exitCode != null) return;
  if (platform === 'win32' && proc.pid) {
    spawnSyncImpl('taskkill', ['/pid', String(proc.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try { proc.kill(); } catch { /* already gone */ }
}

export function createAcpClient({ writeLine, subscribeLine }) {
  let nextId = 1;
  const pending = new Map(); // id -> { resolve, reject }
  const requestHandlers = new Map(); // method -> async (params) => result
  const notificationHandlers = [];

  function handleLine(line) {
    const trimmed = String(line || '').trim();
    if (!trimmed) return;
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (msg.id != null && msg.method == null && (Object.prototype.hasOwnProperty.call(msg, 'result') || msg.error)) {
      const waiter = pending.get(msg.id);
      if (!waiter) return;
      pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else waiter.resolve(msg.result);
      return;
    }
    if (msg.method) {
      if (msg.id != null) {
        Promise.resolve()
          .then(() => {
            const handler = requestHandlers.get(msg.method);
            if (!handler) {
              const err = { code: -32601, message: `Method not found: ${msg.method}` };
              writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: err }));
              return;
            }
            return handler(msg.params || {}).then((result) => {
              writeLine(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: result ?? null }));
            });
          })
          .catch((err) => {
            writeLine(JSON.stringify({
              jsonrpc: '2.0',
              id: msg.id,
              error: { code: -32000, message: String((err && err.message) || err) },
            }));
          });
        return;
      }
      for (const handler of notificationHandlers) handler(msg.method, msg.params || {});
    }
  }

  subscribeLine(handleLine);

  return {
    request(method, params, { timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS } = {}) {
      const id = nextId;
      nextId += 1;
      const payload = { jsonrpc: '2.0', id, method, params: params || {} };
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
      writeLine(JSON.stringify(payload));
      return promise;
    },
    notify(method, params) {
      writeLine(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }));
    },
    onRequest(method, handler) {
      requestHandlers.set(method, handler);
    },
    onNotification(handler) {
      notificationHandlers.push(handler);
    },
    rejectAll(err) {
      for (const waiter of pending.values()) waiter.reject(err);
      pending.clear();
    },
  };
}

export function spawnGrokAgent({ cwd, model, effort, spawnImpl = spawn } = {}) {
  if (model && !isSafeGrokArg(model)) throw new Error(`invalid model: ${model}`);
  if (effort && !isSafeGrokArg(effort)) throw new Error(`invalid effort: ${effort}`);
  const args = ['agent'];
  if (model) args.push('--model', model);
  if (effort) args.push('--effort', effort);
  args.push('stdio');

  const { command, prefixArgs } = resolveGrokSpawn();
  const proc = spawnImpl(command, [...prefixArgs, ...args], {
    cwd,
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    shell: false,
  });

  // Without these, Node's default 'error' handling kills the whole cockpit
  // (ENOENT, EPIPE) instead of just this session.
  proc.on('error', () => {});
  proc.stdin?.on('error', () => {});
  proc.stdout?.on('error', () => {});
  proc.stderr?.on('error', () => {});

  let stderr = '';
  proc.stderr?.on('data', (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 8000) stderr = stderr.slice(-4000);
  });

  const client = createAcpClient({
    writeLine(line) {
      try {
        if (proc.stdin && !proc.stdin.destroyed) proc.stdin.write(`${line}\n`);
      } catch {
        // EPIPE after the agent dies
      }
    },
    subscribeLine(handler) {
      if (!proc.stdout) return;
      const rl = createInterface({ input: proc.stdout });
      rl.on('line', handler);
    },
  });

  return { client, proc, command, getStderr: () => stderr };
}
