// Spawn `grok <args>` and collect stdout. Same binary resolution as
// grok-acp.js (GROK_BIN, PATH, then ~/.grok/bin). shell:false plus
// assertSafeGrokArgs - names from the MCP/plugin panel land in argv, and
// a .cmd shim still routes through cmd.exe.
import { spawn } from 'node:child_process';
import { resolveGrokSpawn, assertSafeGrokArgs, killGrokProcess } from './grok-acp.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export function parseJsonOutput(text) {
  const trimmed = String(text || '').trim();
  if (!trimmed) throw new Error('grok produced no output');
  try {
    return JSON.parse(trimmed);
  } catch {
    const brace = trimmed.indexOf('{');
    const bracket = trimmed.indexOf('[');
    let start = -1;
    if (brace >= 0 && (bracket < 0 || brace < bracket)) start = brace;
    else if (bracket >= 0) start = bracket;
    if (start < 0) throw new Error('grok produced no JSON');
    return JSON.parse(trimmed.slice(start));
  }
}

export function runGrokCommand(args, {
  cwd,
  spawnImpl = spawn,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resolveBin,
} = {}) {
  return new Promise((resolve, reject) => {
    assertSafeGrokArgs(args);
    const { command, prefixArgs } = resolveGrokSpawn(resolveBin);
    const proc = spawnImpl(command, [...prefixArgs, ...args], {
      cwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      try { killGrokProcess(proc); } catch { /* already gone */ }
      finish(new Error(`grok ${args.join(' ')} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    function finish(err, value) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(value);
    }

    proc.on('error', (err) => finish(err));
    proc.stdout?.on('data', (chunk) => { stdout += String(chunk); });
    proc.stderr?.on('data', (chunk) => { stderr += String(chunk); });
    proc.on('close', (code) => {
      if (code !== 0) {
        const detail = stderr.trim() || stdout.trim() || `exit ${code}`;
        finish(new Error(`grok ${args.join(' ')} failed: ${detail}`));
        return;
      }
      finish(null, stdout);
    });
  });
}
