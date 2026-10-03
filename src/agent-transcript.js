// Read-only reader for a subagent's own transcript, written by the Claude
// Agent SDK's Agent (Task) tool under
// <projectDir>/<parentClaudeSessionId>/subagents/agent-<agentId>.jsonl.
// Reads the file directly instead of the SDK's getSessionMessages, an
// undocumented internal with no evidence it resolves nested paths.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isSafeSessionId } from './safe-id.js';
import { resolveClaudeSubscription } from './claude-subscriptions.js';

async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

// The project dir name is itself an SDK-internal encoding of cwd
// (undocumented, same caution as above) - rather than reimplement that
// encoding, find whichever project dir actually contains
// `<claudeSessionId>.jsonl`. claudeSessionId is a UUID, so a false match
// across two different projects isn't a real concern.
async function findProjectDir(claudeSessionId, projectsDir) {
  let entries;
  try {
    entries = await fs.readdir(projectsDir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(projectsDir, entry.name, `${claudeSessionId}.jsonl`);
    if (await exists(candidate)) return path.join(projectsDir, entry.name);
  }
  return null;
}

// Finds the subagent transcript spawned by a given Agent tool_use, matching
// toolUseId against every agent-*.meta.json under the parent session's
// subagents/ dir. Returns null if nothing matches (not an Agent call, or
// predates this harness version writing meta files).
export async function findSubagentTranscript(claudeSessionId, toolUseId, configDir = resolveClaudeSubscription().configDir) {
  // Guard against a crafted id (e.g. `../../../etc/passwd`, or a
  // URL-decoded `..%2F..%2F..`) reaching the path.join below - see
  // safe-id.js's comment for the incident this closed.
  if (!isSafeSessionId(claudeSessionId)) return null;
  const projectDir = await findProjectDir(claudeSessionId, path.join(configDir, 'projects'));
  if (!projectDir) return null;
  const subDir = path.join(projectDir, claudeSessionId, 'subagents');
  let files;
  try {
    files = await fs.readdir(subDir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue;
    let meta;
    try {
      meta = JSON.parse(await fs.readFile(path.join(subDir, file), 'utf8'));
    } catch {
      continue;
    }
    if (meta.toolUseId !== toolUseId) continue;
    const agentId = file.replace(/^agent-/, '').replace(/\.meta\.json$/, '');
    return { meta, transcriptPath: path.join(subDir, `agent-${agentId}.jsonl`) };
  }
  return null;
}

// Line-by-line JSONL parse, silently skipping any line that fails to parse -
// the file can legitimately be read mid-write while the agent is still
// running, so a truncated trailing line is expected, not an error.
export async function readSubagentTranscript(transcriptPath) {
  let raw;
  let mtimeMs = null;
  try {
    raw = await fs.readFile(transcriptPath, 'utf8');
    mtimeMs = (await fs.stat(transcriptPath)).mtimeMs;
  } catch {
    return { messages: [], mtimeMs: null };
  }
  const messages = raw
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
  return { messages, mtimeMs };
}
