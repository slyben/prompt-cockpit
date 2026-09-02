// Small request/response helpers shared by every route module - pulled out
// of server.js verbatim when it was split into src/router.js + src/routes/*
// so each route module doesn't need to import server.js itself (that would
// create a circular import, since server.js is what wires the route modules
// together).

// 1 MB is generous for this app's actual bodies (session config, chat text,
// file paths) - it exists to stop a runaway or malicious client from
// streaming an unbounded request into memory, not to constrain real usage.
// Exported so server.js's WebSocketServer can cap `maxPayload` at the exact
// same limit (2026-09-02 review) instead of leaving the ws transport
// unbounded while only HTTP bodies were capped.
export const MAX_BODY_BYTES = 1024 * 1024;

export class BodyTooLargeError extends Error {}

export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) {
      req.destroy();
      throw new BodyTooLargeError('request body exceeds 1MB limit');
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

export function respondJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// `Authorization: Bearer <token>` is the primary path (what app.js sends);
// a `?token=` query param is accepted too, matching the ws upgrade's own
// convention, in case a future caller can't easily set headers.
export function extractToken(req, url) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return url.searchParams.get('token');
}
