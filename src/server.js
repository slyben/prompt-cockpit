// HTTP + ws, bound to 127.0.0.1. Origin validation and a per-session token
// are both required from the first commit (see plan Decisions: a websocket
// does not enforce same-origin, so 127.0.0.1 binding alone is not auth).
//
// Route handlers live in src/routes/* (registered on the router below);
// this file keeps only what genuinely has to sit at the top level: the raw
// http server, the Origin/Host spoof check every request goes through
// first, static file fallback, and the websocket upgrade/message wiring
// (tightly coupled to the http server itself, not worth its own module).
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { WebSocketServer } from 'ws';

import * as registry from './session-registry.js';
import { createRouter } from './router.js';
import { registerSessionRoutes, seedSessionDefaults } from './routes/sessions.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerSystemRoutes } from './routes/system.js';
import { registerSessionActionRoutes } from './routes/session-actions.js';
import { serveStatic } from './static-files.js';
import { checkOperatorToken, getOperatorToken } from './operator-auth.js';
import { BodyTooLargeError, MAX_BODY_BYTES } from './http-utils.js';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const router = createRouter();
registerSessionRoutes(router);
registerHistoryRoutes(router);
registerSystemRoutes(router);
registerSessionActionRoutes(router);

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (err instanceof BodyTooLargeError) {
      if (!res.headersSent) res.writeHead(413, { 'content-type': 'text/plain' });
      return res.end('request body too large');
    }
    console.error('request error:', err);
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });
});

// Only the websocket upgrade checked Origin before this - every plain HTTP
// /api/* route was reachable by any page's cross-origin fetch (a browser
// does not block the request server-side; that's this server's job) with
// nothing but the target session's UUID to guess. Host is checked too and
// required (every HTTP request carries one): Origin alone doesn't survive
// DNS rebinding, where the attacker's own domain is what resolves to
// 127.0.0.1, so the request's Origin is the *page's* origin, not ours -
// but Host would then also read as the attacker's domain, not
// 127.0.0.1:PORT/localhost:PORT, and that's what actually catches it.
// Origin itself is allowed to be absent (curl, direct API use from this
// machine); Host is not.
function isSpoofedRequest(req) {
  if (!ALLOWED_HOSTS.has(req.headers.host)) return true;
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return true;
  return false;
}

// Applied to every response regardless of route/outcome. This app has no
// inline scripts/styles and loads nothing cross-origin (index.html's own
// comment confirms it), so the CSP can be strict rather than a placeholder.
// None of this replaces the Origin/Host check above - a compliant browser
// honors these; isSpoofedRequest is what stops a request from ever reaching
// a handler in the first place.
function applySecurityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws://127.0.0.1:${PORT} ws://localhost:${PORT}; frame-ancestors 'none'`
  );
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

async function handleRequest(req, res) {
  applySecurityHeaders(res);
  if (isSpoofedRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  // Operator token is the process credential (see operator-auth.js).
  // Session tokens still gate /api/sessions/:id/*; this is the layer those
  // token-free routes (browse, spawn, history, handshake) were missing.
  // Static files stay Origin/Host only so the shell can load and then
  // send the header (or `?op=` from the console URL).
  if (url.pathname.startsWith('/api/') && !checkOperatorToken(req, url)) {
    res.writeHead(401, { 'content-type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: 'invalid or missing operator token' }));
  }
  const handled = await router.handle(req, res, url);
  if (handled) return;
  return serveStatic(req, res, url);
}

// --- websocket -------------------------------------------------------------

// maxPayload matches readJsonBody's own HTTP body cap - the ws transport was
// otherwise unbounded (ws's own default is 100 MB) while HTTP already had a
// 1 MB ceiling (2026-09-02 review). A frame over this size closes the
// socket with code 1009 (message too big) rather than buffering it.
const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_BODY_BYTES });

server.on('upgrade', (req, socket, head) => {
  // Host, not just Origin - see isSpoofedRequest's comment on why Origin
  // alone doesn't survive DNS rebinding. A missing Origin is rejected here
  // (unlike the plain-HTTP check), since a real browser's ws handshake
  // always sends one.
  if (!ALLOWED_HOSTS.has(req.headers.host)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.has(origin)) {
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname !== '/ws') {
    socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
    socket.destroy();
    return;
  }

  if (!checkOperatorToken(req, url)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!id || !registry.checkToken(id, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // Reconnect: a client that already rendered up to some seq sends
  // it back here so attachClient() can send just the delta instead of
  // re-rendering the whole visible transcript. Absent/invalid - including
  // the very first connect, which has nothing to resume from - is a full
  // replay, same as always.
  const sinceParam = url.searchParams.get('since');
  const since = sinceParam && Number.isFinite(Number(sinceParam)) ? Number(sinceParam) : 0;

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req, id, since);
  });
});

wss.on('connection', (ws, req, id, since) => {
  registry.attachClient(id, ws, since);

  // Node's EventEmitter throws an 'error' event as an uncaught exception
  // when nothing is listening for it - true of ws's Receiver too, which
  // emits exactly that when a frame exceeds maxPayload (set above). Adding
  // the cap without this listener trades a graceful close for a process-
  // level crash on the very oversized-message case it was meant to guard
  // against (2026-09-02 review, caught by the maxPayload regression test
  // itself). The socket is already gone by the time this fires - nothing
  // to send a reply on - so this only needs to stop it from being fatal.
  ws.on('error', (err) => {
    console.error(`ws error for ${id}:`, err.message || err);
  });

  ws.on('message', (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      return;
    }
    if (payload.type === 'input' && typeof payload.text === 'string' && payload.text.length > 0) {
      registry.sendInput(id, payload.text).catch((err) => {
        console.error(`sendInput failed for ${id}:`, err);
      });
    }
    // Queue pane mutations - same ws channel as 'input' rather
    // than a REST round trip: these are live edits to messages already sent
    // down this same socket, so there's no meaningful "queue-remove before
    // the socket that queued it is even open" case to support.
    if (payload.type === 'queue-remove' && typeof payload.queueId === 'string') {
      registry.removeQueued(id, payload.queueId).catch((err) => {
        console.error(`removeQueued failed for ${id}:`, err);
      });
    }
    if (payload.type === 'queue-reorder' && Array.isArray(payload.queueIds)) {
      registry.reorderQueue(id, payload.queueIds).catch((err) => {
        console.error(`reorderQueue failed for ${id}:`, err);
      });
    }
    if (payload.type === 'queue-send-now' && typeof payload.queueId === 'string') {
      registry.sendNow(id, payload.queueId).catch((err) => {
        console.error(`sendNow failed for ${id}:`, err);
      });
    }
    // Cross-session delegation - `/ask <Name>: <text>`
    // parsed client-side (app.js's onSend) into this payload shape. Errors
    // (unknown name, self-delegation, cross-cwd) are synchronous throws
    // from delegateTask - sent straight back on THIS socket (the origin's
    // own), not broadcast, since only the tab that typed the bad command
    // needs to see it.
    if (payload.type === 'delegate' && typeof payload.targetName === 'string' && typeof payload.text === 'string' && payload.text.length > 0) {
      try {
        registry.delegateTask(id, payload.targetName, payload.text);
      } catch (err) {
        ws.send(JSON.stringify({ type: 'cockpit:delegate-error', targetName: payload.targetName, error: String(err.message || err) }));
      }
    }
  });

  ws.on('close', () => {
    registry.detachClient(id, ws);
  });
});

export { server, PORT, HOST, seedSessionDefaults };

// Only auto-listen when run directly (`node src/server.js`), not when
// imported by tests - lets tests bind an ephemeral port and drive the same
// Origin/token checks without a second process.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
function copyToClipboard(text) {
  const platform = process.platform;
  const cmd =
    platform === 'darwin' ? 'pbcopy' :
    platform === 'win32' ? 'clip' :
    'xclip -selection clipboard';
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, { shell: true, stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', reject);
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}`))));
    child.stdin.end(text);
  });
}

if (isMain) {
  server.listen(PORT, HOST, () => {
    const op = getOperatorToken();
    const url = `http://${HOST}:${PORT}/?op=${op}`;
    console.log(`prompt-cockpit listening on ${url}`);

    if (process.stdin.isTTY) {
      console.log('Press c to copy the URL to clipboard.');
      readline.emitKeypressEvents(process.stdin);
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.on('keypress', (str, key) => {
        if (key && key.ctrl && key.name === 'c') {
          process.exit(0);
        }
        if (str === 'c') {
          copyToClipboard(url)
            .then(() => console.log('Copied!'))
            .catch((err) => console.error(`Could not copy to clipboard: ${err.message}`));
        }
      });
    }
  });
}
