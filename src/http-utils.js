// Small request/response helpers shared by every route module - pulled out
// of server.js verbatim when it was split into src/router.js + src/routes/*
// so each route module doesn't need to import server.js itself (that would
// create a circular import, since server.js is what wires the route modules
// together).

export async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
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
