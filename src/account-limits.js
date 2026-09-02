// Runs `claude -p "/usage" --output-format json` as a one-off headless
// query for the CLI's own /usage table. Not a billed model turn but a
// real subprocess spawn, so this stays on-demand (dashboard's "Refresh
// limits" button) rather than polled. Shells out instead of reading
// local transcripts: quota is tracked server-side across every device.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tmpdir } from 'node:os';

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 20_000;
// /api/account-limits has no session token, only Origin/Host allowlisting -
// and unlike other token-free routes it spawns a real subprocess per GET.
// This single-flight+TTL cache collapses rapid/concurrent requests (a buggy
// client retry, or any other caller on 127.0.0.1) into at most one
// `claude -p` spawn per window.
const CACHE_TTL_MS = 30_000;
let cached = null; // { result, atMs }
let inFlight = null; // Promise, shared by concurrent callers while one spawn is running

// Test-only: clears the module-level cache/in-flight state between test
// cases (same pattern as session-registry.js's own `_reset`) - without it,
// a cached result from one test's fake `claudeBin` would leak into the
// next test's assertions, since the cache isn't (and in production doesn't
// need to be) keyed by claudeBin.
export function _resetCacheForTests() {
  cached = null;
  inFlight = null;
}

// execFileImpl is injectable so tests stub it instead of spawning a real
// subprocess - a fake `claude` shell script can't be exec'd cross-platform
// without `shell: true` (Windows blocks bare .bat/.cmd post-CVE-2024-27980),
// and the thing under test is the cache logic above, not the OS spawn.
export async function fetchAccountLimits(claudeBin = 'claude', execFileImpl = execFileAsync) {
  if (cached && Date.now() - cached.atMs < CACHE_TTL_MS) return cached.result;
  if (inFlight) return inFlight;
  inFlight = doFetch(claudeBin, execFileImpl).then((result) => {
    cached = { result, atMs: Date.now() };
    return result;
  }).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doFetch(claudeBin, execFileImpl) {
  let stdout;
  try {
    ({ stdout } = await execFileImpl(
      claudeBin,
      ['-p', '/usage', '--output-format', 'json'],
      // tmpdir, not process.cwd() - this is an account-level query, not
      // project-scoped, and running it from a real project dir would pull
      // in that project's CLAUDE.md/hooks for no benefit, just latency.
      { cwd: tmpdir(), timeout: TIMEOUT_MS, maxBuffer: 1024 * 1024 },
    ));
  } catch (err) {
    // execFile throws on non-zero exit or timeout - surface stderr (or the
    // timeout) rather than a bare "Command failed" that named nothing.
    throw new Error(err.stderr?.trim() || err.message || String(err));
  }
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error('unexpected output from claude -p "/usage" (not JSON)');
  }
  if (parsed.is_error) throw new Error(parsed.result || 'claude -p "/usage" reported an error');
  return { text: parsed.result || '', fetchedAtMs: Date.now() };
}
