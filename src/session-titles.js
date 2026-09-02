// Per-cwd map of transcript-session-id -> user-set title, stored in
// `.claude/settings.local.json` to survive a restart. Keyed by the
// *transcript* session id, not the registry's in-memory randomUUID()
// (gone once a session closes, so a title stored against it wouldn't
// survive to the next resume). Project-dir moves just miss and fall back.
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
