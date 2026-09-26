// Server-owned settings shared by every project and provider. Unlike
// settings-file.js, this file is kept under ~/.prompt-cockpit and never in a
// provider-specific project directory.
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { readFile, writeFile, mkdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

export function serverSettingsPath() {
  const configured = process.env.COCKPIT_SETTINGS_FILE;
  return configured ? path.resolve(configured) : path.join(homedir(), '.prompt-cockpit', 'settings.json');
}

async function readSettingsChecked() {
  let raw;
  try {
    raw = await readFile(serverSettingsPath(), 'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT') return { settings: {}, corrupt: false };
    throw err;
  }
  try {
    return { settings: JSON.parse(raw), corrupt: false };
  } catch {
    return { settings: {}, corrupt: true };
  }
}

export async function readServerSettings() {
  const { settings, corrupt } = await readSettingsChecked();
  if (corrupt) throw new Error(`${serverSettingsPath()} contains invalid JSON`);
  return settings;
}

async function writeSettings(settings) {
  const dest = serverSettingsPath();
  await mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await writeFile(tmp, `${JSON.stringify(settings, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      await rename(tmp, dest);
    } catch (err) {
      if (process.platform === 'win32') {
        await unlink(dest);
        await rename(tmp, dest);
      } else {
        throw err;
      }
    }
  } catch (err) {
    try { await unlink(tmp); } catch { /* the temporary file may not exist */ }
    throw err;
  }
}

const writeQueues = new Map();

export async function updateServerSettings(mutator) {
  const key = path.resolve(serverSettingsPath());
  const previous = writeQueues.get(key) || Promise.resolve();
  const run = previous.catch(() => {}).then(async () => {
    const { settings, corrupt } = await readSettingsChecked();
    if (corrupt) {
      throw new Error(`${serverSettingsPath()} contains invalid JSON - refusing to overwrite it. Fix or remove the file by hand, then retry.`);
    }
    const result = await mutator(settings);
    await writeSettings(settings);
    return result;
  });
  writeQueues.set(key, run);
  run.finally(() => {
    if (writeQueues.get(key) === run) writeQueues.delete(key);
  }).catch(() => {});
  return run;
}
