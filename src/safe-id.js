// Guards any identifier that gets path.join'd into a directory we read from
// disk. Rejects anything that isn't a single path segment, so a crafted id
// (e.g. `../../../etc`, or a URL-decoded `..%2F..%2F..`) can't walk the join
// outside its intended root. Use this for any new path-joined id.
import path from 'node:path';

export function isSafeSessionId(sessionId) {
  if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 128) return false;
  if (sessionId === '.' || sessionId === '..') return false;
  return sessionId === path.basename(sessionId);
}
