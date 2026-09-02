// Static file serving for public/ (the frontend's unbundled ES modules) plus
// the src/ files the browser also loads directly - split out of
// server.js unchanged when it was split into a router + route modules.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// No Node-specific imports; shared verbatim with the browser rather than
// duplicated into public/. permissions.js is mode-cycle order;
// stream-join.js is Grok token-join whitespace (also used by grok-messages.js).
const SHARED_SRC_FILES = new Set(['permissions.js', 'stream-join.js']);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

export async function serveStatic(req, res, url) {
  const relPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const bareName = relPath.replace(/^\//, '');
  const filePath = SHARED_SRC_FILES.has(bareName)
    ? path.join(__dirname, bareName)
    : path.normalize(path.join(PUBLIC_DIR, relPath));
  // `startsWith(PUBLIC_DIR)` alone would also match a *sibling* directory
  // that happens to share the prefix (e.g. PUBLIC_DIR + "-evil"), since
  // there's no separator between them - require PUBLIC_DIR + path.sep, or
  // an exact match for the (unlikely) case relPath resolves to PUBLIC_DIR
  // itself.
  const withinPublicDir = filePath === PUBLIC_DIR || filePath.startsWith(PUBLIC_DIR + path.sep);
  if (!withinPublicDir && !SHARED_SRC_FILES.has(bareName)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  try {
    const data = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] || 'application/octet-stream' });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
}
