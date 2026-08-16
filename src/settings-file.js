// Shared read/write for a project's `.claude/settings.local.json` - the
// personal, gitignored-by-convention override file (per the SDK's own
// settings-precedence note: user < project < local < flag < policy).
// plugin-settings.js and session-defaults.js both store their own top-level
// key in this same file rather than each opening/parsing it independently,
// so a concurrent write from one doesn't clobber a concurrent write from the
// other (see the read-modify-write note below) and every other key already
// in the file (hooks, permissions, whatever the user has in there) always
// round-trips untouched.
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

// Same read as readSettingsFile, but also reports whether the file exists
// AND failed to parse (as opposed to simply not existing) - a missing file
// is fine to treat as `{}`, but a corrupt one is not: updateSettingsFile
// below must not write `{}` back over content a user could otherwise have
// recovered by hand. Kept internal (not exported) since every caller other
// than updateSettingsFile only ever wants the lenient "treat as empty"
// behavior of readSettingsFile.
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

// One in-flight read-modify-write chain per resolved cwd, so a plugin
// toggle and a thinking-budget change landing in the same tick queue up
// instead of both reading the pre-write file and one clobbering the
// other's key. Chains are removed once drained, so this stays a handful
// of entries (one per cwd with a pending write) rather than growing
// unbounded across a long-running process.
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
  // `run.finally(...)` returns a new derived promise that also rejects
  // whenever `run` rejects, and nothing was awaiting or catching that
  // derived promise - Node's default unhandled-rejection handling kills the
  // whole process on any write failure (disk full, permissions, the
  // corrupt-file guard above). `run` itself still carries the rejection
  // forward to whoever awaits updateSettingsFile's return value; this just
  // stops the untracked derived promise from also blowing up the process.
  run.finally(() => {
    if (writeQueues.get(key) === run) writeQueues.delete(key);
  }).catch(() => {});
  return run;
}
