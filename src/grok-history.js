// Read a Grok session's updates.jsonl and turn it into the same sdk:message
// list fetchSessionHistory() returns for Claude.
import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { grokSessionsRoot } from './grok-launcher.js';
import { acpUpdateToMessages, coalesceAssistantMessages } from './grok-messages.js';

const MAX_LINES = 5000;

export async function fetchGrokSessionHistory(sessionId, cwd, sessionsDir = grokSessionsRoot()) {
  const sessionDir = findSessionDir(sessionId, cwd, sessionsDir);
  if (!sessionDir) throw new Error(`unknown grok session: ${sessionId}`);
  const updatesPath = path.join(sessionDir, 'updates.jsonl');
  if (!existsSync(updatesPath)) return [];

  const messages = [];
  const rl = createInterface({ input: createReadStream(updatesPath, { encoding: 'utf8' }) });
  let lines = 0;
  for await (const line of rl) {
    lines += 1;
    if (lines > MAX_LINES) break;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const update = entry.params && entry.params.update;
    if (!update) continue;
    messages.push(...acpUpdateToMessages(update, sessionId));
  }
  rl.close();
  return coalesceAssistantMessages(messages);
}

// Session ids are directory names under ~/.grok/sessions/<cwd>/. Reject
// anything that is not a single path segment so a crafted resume/history
// id cannot walk out of the sessions root.
export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) return false;
  if (sessionId === '.' || sessionId === '..') return false;
  return sessionId === path.basename(sessionId);
}

export function findSessionDir(sessionId, cwd, sessionsDir = grokSessionsRoot()) {
  if (!isSafeSessionId(sessionId)) return null;
  if (cwd) {
    for (const encoded of encodeCwdCandidates(cwd)) {
      const direct = path.join(sessionsDir, encoded, sessionId);
      if (existsSync(path.join(direct, 'summary.json'))) return direct;
    }
  }
  if (!existsSync(sessionsDir)) return null;
  let groups;
  try {
    groups = readdirSync(sessionsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const group of groups) {
    if (!group.isDirectory()) continue;
    const candidate = path.join(sessionsDir, group.name, sessionId);
    if (existsSync(path.join(candidate, 'summary.json'))) return candidate;
  }
  return null;
}

function encodeCwdCandidates(cwd) {
  const variants = [cwd];
  if (cwd.includes('/')) variants.push(cwd.replace(/\//g, '\\'));
  if (cwd.includes('\\')) variants.push(cwd.replace(/\\/g, '/'));
  return [...new Set(variants.map((v) => encodeURIComponent(v)))];
}
