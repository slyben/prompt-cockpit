// cwd picker plus resume-list discovery from ~/.claude/projects/**/*.jsonl,
// same approach as claude-realtime-usage/live_watcher.py's
// list_available_sessions() (newest first), extended to pull cwd and a
// label out of the transcript instead of guessing from the encoded dirname.
import { createReadStream, existsSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { homedir } from 'node:os';
import path from 'node:path';

const PROJECTS_DIR = path.join(homedir(), '.claude', 'projects');
const MAX_LISTED = 30;
const MAX_LINES_SCANNED = 200; // enough to find cwd + a label without reading huge transcripts

// Unbounded file-list underneath listResumableSessions' 30-file/newest-first
// cap - split out so global-stats.js can walk every session across every
// project (it needs the full set for accurate totals/streaks, not just the
// recent ones this app's own resume list cares about).
export async function listAllSessionFiles(projectsDir = PROJECTS_DIR) {
  let projectDirs;
  try {
    projectDirs = await readdir(projectsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const files = [];
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(projectsDir, entry.name);
    let jsonlNames;
    try {
      jsonlNames = (await readdir(dir)).filter((f) => f.endsWith('.jsonl'));
    } catch {
      continue;
    }
    for (const name of jsonlNames) {
      const filePath = path.join(dir, name);
      let mtimeMs;
      try {
        mtimeMs = statSync(filePath).mtimeMs;
      } catch {
        continue;
      }
      files.push({ filePath, projectDirName: entry.name, sessionId: name.replace(/\.jsonl$/, ''), mtimeMs });
    }
  }
  return files;
}

export async function listResumableSessions(projectsDir = PROJECTS_DIR) {
  const files = await listAllSessionFiles(projectsDir);
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const top = files.slice(0, MAX_LISTED);

  return Promise.all(top.map(describeSession));
}

async function describeSession({ filePath, projectDirName, sessionId, mtimeMs }) {
  const { cwd, label } = await scanTranscript(filePath);
  return {
    sessionId,
    cwd: cwd || null,
    projectDirName,
    label: label || null,
    mtimeMs,
    provider: 'claude',
  };
}

async function scanTranscript(filePath) {
  let cwd = null;
  let label = null;

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf8' }) });
  let lines = 0;
  for await (const line of rl) {
    lines += 1;
    if (lines > MAX_LINES_SCANNED) break;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!cwd && typeof entry.cwd === 'string') cwd = entry.cwd;
    // isMeta marks the CLI's own non-user-sourced entries (our priming
    // sentinel from session.js persists as one, wrapped as "[MESSAGE FROM
    // NON-USER SOURCE...]") - skip them so the resume list shows what was
    // actually typed, not that wrapper text.
    if (!label && !entry.isMeta && entry.type === 'user' && entry.message && typeof entry.message.content === 'string' && entry.message.content.length > 0) {
      label = entry.message.content.slice(0, 120);
    }
    if (cwd && label) break;
  }
  rl.close();

  return { cwd, label };
}

export function isValidCwd(candidate) {
  try {
    return existsSync(candidate) && statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

// Sentinel path that means "show the drive list" instead of a real directory.
// Only reachable (and only useful) on Windows, where path.dirname() of a
// drive root returns itself - so there was previously no way to go "up" past
// C:\ and reach D:\, E:\, etc. On other platforms everything hangs off a
// single root, so drive-switching doesn't apply.
export const DRIVES_SENTINEL = 'drives://';

async function listWindowsDrives() {
  const letters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const candidates = [...letters].map((l) => `${l}:\\`);
  const checks = await Promise.all(
    candidates.map(async (drive) => (existsSync(drive) ? drive : null))
  );
  return checks.filter(Boolean);
}

// Server-side directory browser for the launcher's "Browse" button. Regular
// browsers don't expose real filesystem paths from a file picker (no pty,
// no Electron here), so the client navigates by asking the server to list
// subdirectories instead. NOT token-gated (server.js's /api/browse route
// has no per-session token to check pre-launch) - protected only by the
// Origin/Host spoof check applied to every request, which deliberately
// allows a missing Origin (for curl). Any local process can enumerate the
// filesystem this way, including other drives via DRIVES_SENTINEL. Low
// severity for a local dev tool, but don't overstate the protection here -
// see backlog.md if tightening this is ever prioritized.
export async function listDirectory(dirPath) {
  if (dirPath === DRIVES_SENTINEL) {
    const drives = await listWindowsDrives();
    return {
      path: 'This PC',
      parent: null,
      entries: drives.map((drive) => ({ name: drive, path: drive })),
    };
  }

  const resolved = path.resolve(dirPath || homedir());
  let entries;
  try {
    entries = await readdir(resolved, { withFileTypes: true });
  } catch (err) {
    throw new Error(`cannot read directory: ${resolved} (${err.code || err.message})`);
  }

  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));

  const dirnameParent = path.dirname(resolved);
  const atRoot = dirnameParent === resolved;
  // On Windows, offer the drive list once you hit a drive root (C:\ etc.)
  // instead of dead-ending the Up button there.
  const parent = atRoot ? (process.platform === 'win32' ? DRIVES_SENTINEL : null) : dirnameParent;

  return {
    path: resolved,
    parent,
    entries: dirs.map((name) => ({ name, path: path.join(resolved, name) })),
  };
}
