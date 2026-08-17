// Per-cwd map of transcript-session-id -> user-set title. Stored under the
// `sessionTitles` key in the same `.claude/settings.local.json` file
// session-defaults.js/plugin-settings.js use (settings-file.js), for the
// same reasons: survives a cockpit process restart, shared across every
// browser/tab pointed at this cwd, lives with the project instead of a
// machine-global store.
//
// Keyed by the *transcript* session id (the JSONL filename - session-
// registry.js's row.claudeSessionId, session-launcher.js's sessionId), not
// the cockpit registry's own in-memory randomUUID() - the latter is gone
// the moment a session closes or the process restarts, so a title stored
// against it would never survive to the next resume.
//
// If a project directory is later moved or renamed, this map simply misses
// on lookup (the transcript's recorded cwd still points at the old path)
// and the affected sessions fall back to their usual label - graceful
// degradation, not corruption. Callers never need to know that: this
// module's functions all take `cwd` as an opaque key, so relocating the
// store itself (e.g. to something keyed by an id that survives a move)
// would be a change contained entirely to this file.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

const MAX_TITLE_LENGTH = 120; // matches session-launcher.js's scanTranscript label truncation

export async function readSessionTitles(cwd) {
  const settings = await readSettingsFile(cwd);
  return settings.sessionTitles || {};
}

export async function getSessionTitle(cwd, sessionId) {
  if (!sessionId) return null;
  const titles = await readSessionTitles(cwd);
  return titles[sessionId]?.title ?? null;
}

// Trims and caps `title`; an empty/whitespace-only/null title deletes the
// entry instead of storing an empty string, so a title once set can be
// cleared back to "no title" rather than being stuck as "".
export async function setSessionTitle(cwd, sessionId, title) {
  const trimmed = (title || '').trim().slice(0, MAX_TITLE_LENGTH);
  return updateSettingsFile(cwd, (settings) => {
    const titles = { ...(settings.sessionTitles || {}) };
    if (trimmed) {
      titles[sessionId] = { title: trimmed, updatedAt: Date.now() };
    } else {
      delete titles[sessionId];
    }
    settings.sessionTitles = titles;
    return titles;
  });
}

// Pure join helper for server.js's /api/resumable route - kept separate
// from any I/O so it's unit-testable on its own. `titlesByCwd` is a Map of
// cwd -> the object readSessionTitles(cwd) would return (the caller batches
// one read per distinct cwd rather than one per session).
export function attachTitles(sessions, titlesByCwd) {
  return sessions.map((session) => {
    const titles = session.cwd ? titlesByCwd.get(session.cwd) : null;
    const title = titles?.[session.sessionId]?.title ?? null;
    return title ? { ...session, title } : session;
  });
}
