// Shared guard for any identifier that gets path.join'd into a directory we
// read from disk (session ids, claude session ids, etc). Rejects anything
// that isn't a single path segment, so a crafted id (e.g. `../../../etc`,
// or a URL-decoded `..%2F..%2F..`) can't walk the join outside its intended
// root. Originally lived only in grok-history.js (which still re-exports it
// for backward compat) - the Claude-side history/transcript routes went
// without this check, which is exactly how the /api/history/:id path
// traversal happened. Any new path-joined id should use this.
import path from 'node:path';

export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) return false;
  if (sessionId === '.' || sessionId === '..') return false;
  return sessionId === path.basename(sessionId);
}
