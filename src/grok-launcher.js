// Resume-list discovery from ~/.grok/sessions/<encoded-cwd>/<session-id>/.
// Same job as session-launcher.js, different on-disk layout.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

const MAX_LISTED = 30;

export function grokSessionsRoot() {
  return path.join(process.env.GROK_HOME || path.join(homedir(), '.grok'), 'sessions');
}

export async function listGrokSessions(sessionsDir = grokSessionsRoot()) {
  let groups;
  try {
    groups = await readdir(sessionsDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const found = [];
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessionsDir, group.name);
    let sessionDirs;
    try {
      sessionDirs = await readdir(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessionDirs) {
      if (!entry.isDirectory()) continue;
      const sessionDir = path.join(groupDir, entry.name);
      const summaryPath = path.join(sessionDir, 'summary.json');
      if (!existsSync(summaryPath)) continue;
      let mtimeMs;
      try {
        mtimeMs = statSync(summaryPath).mtimeMs;
      } catch {
        continue;
      }
      found.push({ sessionDir, groupDirName: group.name, sessionId: entry.name, summaryPath, mtimeMs });
    }
  }

  found.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return found.slice(0, MAX_LISTED).map(describeSession);
}

function describeSession({ sessionDir, groupDirName, sessionId, summaryPath, mtimeMs }) {
  const summary = readJson(summaryPath) || {};
  const info = summary.info || {};
  const cwd = info.cwd || readCwdFile(sessionDir) || decodeGroupName(groupDirName);
  const titled = summary.generated_title || summary.session_summary;
  const label = (typeof titled === 'string' && titled.trim())
    ? titled.trim().slice(0, 120)
    : firstUserLabel(sessionDir);
  const updated = Date.parse(summary.last_active_at || summary.updated_at || '') || mtimeMs;
  return {
    sessionId: info.id || sessionId,
    cwd: cwd || null,
    projectDirName: groupDirName,
    label,
    mtimeMs: updated,
    provider: 'grok',
    model: summary.current_model_id || null,
  };
}

function readJson(filePath) {
  try {
    return JSON.parse(readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readCwdFile(sessionDir) {
  const groupCwd = path.join(path.dirname(sessionDir), '.cwd');
  try {
    const text = readFileSync(groupCwd, 'utf8').trim();
    return text || null;
  } catch {
    return null;
  }
}

function firstUserLabel(sessionDir) {
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  if (!existsSync(updatesPath)) return null;
  let text;
  try {
    text = readFileSync(updatesPath, 'utf8').slice(0, 16000);
  } catch {
    return null;
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const update = entry.params && entry.params.update;
    if (update && update.sessionUpdate === 'user_message_chunk') {
      const textChunk = update.content && update.content.text;
      if (typeof textChunk === 'string' && textChunk.trim()) return textChunk.trim().slice(0, 120);
    }
  }
  return null;
}

function decodeGroupName(name) {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}
