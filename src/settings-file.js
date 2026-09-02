// Shared read/write for a project's .claude/settings.local.json (personal,
// gitignored override file). plugin-settings.js and session-defaults.js
// both store their own top-level key here rather than parsing it
// independently, so concurrent writes don't clobber each other and other
// keys already in the file always round-trip untouched.
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export function settingsPath(cwd) {
  return path.join(cwd, '.claude', 'settings.local.json');
}

export async function readSettingsFile(cwd) {
  const { settings } = await readSettingsFileChecked(cwd);
  return settings;
}

// Like readSettingsFile, but distinguishes "missing" (fine to treat as {})
// from "corrupt" (must not silently overwrite with {} and destroy content
// recoverable by hand). Internal: only updateSettingsFile needs that
// distinction.
async function readSettingsFileChecked(cwd) {
  let raw;
  try {
    raw = await readFile(settingsPath(cwd), 'utf-8');
  } catch {
    return { settings: {}, corrupt: false }; // missing file - not an error
  }
  try {
    return { settings: JSON.parse(raw), corrupt: false };
  } catch {
    return { settings: {}, corrupt: true };
  }
}

async function writeSettingsFile(cwd, settings) {
  const dest = settingsPath(cwd);
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  const payload = JSON.stringify(settings, null, 2) + '\n';
  try {
    await writeFile(tmp, payload, 'utf-8');
    try {
      await rename(tmp, dest);
    } catch (err) {
      // Windows cannot rename over an existing file. Replace dest then
      // retry - a crash in that window leaves dest gone but tmp intact,
      // which is recoverable, unlike a half-written dest.
      if (process.platform === 'win32') {
        await unlink(dest);
        await rename(tmp, dest);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try { await unlink(tmp); } catch { /* tmp may not exist */ }
    throw err;
  }
}

// One in-flight read-modify-write chain per resolved cwd, so writes
// landing in the same tick queue up instead of clobbering each other's
// key. Chains are removed once drained, so this map stays small.
const writeQueues = new Map();

// `mutator(settings)` is called with the freshly-read settings object and
// may mutate it in place and/or return a value; whatever it returns is
// this function's return value. The read, mutate, and write all happen
// while holding this cwd's queue slot, so no other updateSettingsFile
// call for the same cwd can interleave a read in between.
export async function updateSettingsFile(cwd, mutator) {
  const key = path.resolve(cwd);
  const prev = writeQueues.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(async () => {
    const { settings, corrupt } = await readSettingsFileChecked(cwd);
    if (corrupt) {
      // Refuse to proceed rather than silently writing `{}` (i.e. the rest
      // of readSettingsFile's lenient fallback) back over a file that's
      // corrupt-but-possibly-recoverable-by-hand - that would permanently
      // destroy whatever hooks/permissions/etc. were in it.
      throw new Error(`${settingsPath(cwd)} contains invalid JSON - refusing to overwrite it. Fix or remove the file by hand, then retry.`);
    }
    const result = await mutator(settings);
    await writeSettingsFile(cwd, settings);
    return result;
  });
  writeQueues.set(key, run);
  // run.finally(...) creates a derived promise that also rejects when run
  // does; if left unhandled, Node kills the process on any write failure.
  // This just swallows that derived rejection - run itself still carries
  // the failure to whoever awaits updateSettingsFile's return value.
  run.finally(() => {
    if (writeQueues.get(key) === run) writeQueues.delete(key);
  }).catch(() => {});
  return run;
}
