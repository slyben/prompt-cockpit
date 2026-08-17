// HTTP + ws, bound to 127.0.0.1. Origin validation and a per-session token
// are both required from the first commit (see plan Decisions: a websocket
// does not enforce same-origin, so 127.0.0.1 binding alone is not auth).
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';

import * as registry from './session-registry.js';
import { listResumableSessions, isValidCwd, listDirectory } from './session-launcher.js';
import { listGrokSessions } from './grok-launcher.js';
import { fileSuggestions, workspaceDiff } from './sdk-adapter.js';
import { PERMISSION_MODES } from './permissions.js';
import { fetchSessionHistory } from './session-history.js';
import { fetchGrokSessionHistory } from './grok-history.js';
import { isSafeGrokArg } from './grok-acp.js';
import { defaultScreenshotDir } from './os-defaults.js';
import { setPluginEnabled, readEnabledPlugins } from './plugin-settings.js';
import { readSessionDefaults, setSessionDefaults } from './session-defaults.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
// permissions.js has no Node-specific imports and is shared verbatim with
// the browser (mode-cycle order) rather than duplicated into public/.
const SHARED_SRC_FILES = new Set(['permissions.js']);

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 4317;
const ALLOWED_ORIGINS = new Set([`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`]);
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const server = createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
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

// Applies this cwd's persisted thinking-budget/auto-continue defaults
// (session-defaults.js) to a freshly created row - both the plain "new
// session" path and the fork path in the rewind route below go through
// this, so a forked session inherits the same defaults a brand-new session
// in the same cwd would, instead of the fork route hand-carrying the
// origin session's live values (the B6 workaround this replaces). Routes
// through the same registry setters a user's own toggle would, so it
// broadcasts and re-persists identically - redundant but harmless when the
// value being applied is already what's on disk.
// `defaults`, when passed, overrides the cwd-level persisted lookup - the
// rewind/fork route below passes the origin row's own live values here
// instead, since two sessions sharing a cwd means the persisted
// session-defaults.js store reflects whichever of them wrote most
// recently, not necessarily the one actually being forked. Reading that
// shared store for a fork used to silently apply session B's thinking
// budget/auto-continue to a fork of session A whenever B was the last
// writer for their shared cwd.
export async function seedSessionDefaults(row, defaults) {
  const d = defaults || (await readSessionDefaults(row.cwd).catch(() => null));
  if (!d) return;
  if (d.maxThinkingTokens != null || d.thinkingDisplay != null) {
    await registry.setMaxThinkingTokens(row.id, d.maxThinkingTokens, d.thinkingDisplay).catch(() => {});
  }
  if (d.autoContinue) {
    await registry.setAutoContinue(row.id, true).catch(() => {});
  }
}

async function handleRequest(req, res) {
  if (isSpoofedRequest(req)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/api/resumable' && req.method === 'GET') {
    const provider = url.searchParams.get('provider') === 'grok' ? 'grok' : 'claude';
    const sessions = provider === 'grok' ? await listGrokSessions() : await listResumableSessions();
    return respondJson(res, 200, sessions);
  }

  if (url.pathname === '/api/sessions' && req.method === 'GET') {
    return respondJson(res, 200, registry.list());
  }

  if (url.pathname === '/api/sessions' && req.method === 'POST') {
    const body = await readJsonBody(req);
    const cwd = typeof body.cwd === 'string' ? body.cwd : process.cwd();
    if (!isValidCwd(cwd)) {
      return respondJson(res, 400, { error: `not a directory: ${cwd}` });
    }
    // Best-effort: a resume id that turns out to be stale/unreadable
    // shouldn't block starting the session - query() itself is the
    // authority on whether resume actually works, this is just the
    // transcript backfill for the client's initial view.
    const provider = body.provider === 'grok' ? 'grok' : 'claude';
    const history = body.resume
      ? await (provider === 'grok'
        ? fetchGrokSessionHistory(body.resume, cwd)
        : fetchSessionHistory(body.resume, cwd)).catch(() => null)
      : null;
    const model = typeof body.model === 'string' && body.model ? body.model : undefined;
    if (model && !isSafeGrokArg(model)) {
      return respondJson(res, 400, { error: `invalid model: ${model}` });
    }
    let effort;
    if (provider === 'grok' && typeof body.effort === 'string' && body.effort) {
      if (!registry.GROK_EFFORTS.includes(body.effort)) {
        return respondJson(res, 400, { error: `invalid effort: ${body.effort}` });
      }
      effort = body.effort;
    }
    const row = registry.createSession({ cwd, resume: body.resume, name: body.name, model, provider, effort, history });
    await seedSessionDefaults(row); // thinking budget/auto-continue carried forward from this cwd's last-used values (session-defaults.js)
    return respondJson(res, 201, {
      id: row.id,
      token: row.token,
      cwd: row.cwd,
      state: row.state,
    });
  }

  const bareSessionRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
  if (bareSessionRoute && req.method === 'GET') {
    // MVP3 reconnect: lets a reopened tab (app.js's localStorage-remembered
    // session) check whether the session it last had open is still live
    // before trying to rejoin it, rather than assuming and failing loudly
    // on the websocket upgrade instead.
    const id = bareSessionRoute[1];
    const row = registry.get(id);
    if (!row) return respondJson(res, 404, { error: `unknown session: ${id}` });
    if (!registry.checkToken(id, extractToken(req, url))) {
      return respondJson(res, 401, { error: 'invalid or missing session token' });
    }
    return respondJson(res, 200, registry.toSummary(row));
  }

  if (bareSessionRoute && req.method === 'DELETE') {
    const id = bareSessionRoute[1];
    const row = registry.get(id);
    if (!row) return respondJson(res, 404, { error: `unknown session: ${id}` });
    if (!registry.checkToken(id, extractToken(req, url))) {
      return respondJson(res, 401, { error: 'invalid or missing session token' });
    }
    // Wired to the header's "Close session" button (app.js's closeSessionBtn)
    // - without this, every session's live query() process runs for the
    // cockpit process's whole lifetime, start or rewind, with no way to end
    // one early.
    registry.closeSession(id);
    return respondJson(res, 200, { closed: true });
  }

  const historyRoute = url.pathname.match(/^\/api\/history\/([^/]+)$/);
  if (historyRoute && req.method === 'GET') {
    // Read-only transcript view for any session, live or past (plan MVP4's
    // "history pane... via getSessionMessages()") - no per-session token
    // like the live-session routes below, since there's no registry row to
    // hold one for a session this cockpit process never started. Same auth
    // boundary as /api/resumable and /api/browse: Origin/Host only, checked
    // once for every request at the top of handleRequest - not token-gated
    // (see session-launcher.js's listDirectory comment for why that matters
    // more for /api/browse, which can enumerate the whole filesystem).
    const cwd = url.searchParams.get('cwd') || process.cwd();
    const provider = url.searchParams.get('provider') === 'grok' ? 'grok' : 'claude';
    try {
      const messages = provider === 'grok'
        ? await fetchGrokSessionHistory(historyRoute[1], cwd)
        : await fetchSessionHistory(historyRoute[1], cwd);
      return respondJson(res, 200, { messages });
    } catch (err) {
      return respondJson(res, 404, { error: String(err.message || err) });
    }
  }

  if (url.pathname === '/api/os-defaults' && req.method === 'GET') {
    return respondJson(res, 200, { screenshotDir: defaultScreenshotDir() });
  }

  if (url.pathname === '/api/browse' && req.method === 'GET') {
    try {
      return respondJson(res, 200, await listDirectory(url.searchParams.get('path')));
    } catch (err) {
      return respondJson(res, 400, { error: String(err.message || err) });
    }
  }

  const sessionRoute = url.pathname.match(/^\/api\/sessions\/([^/]+)\/([a-z-]+)$/);
  if (sessionRoute) {
    return handleSessionRoute(req, res, url, sessionRoute[1], sessionRoute[2]);
  }

  return serveStatic(req, res, url);
}

// `Authorization: Bearer <token>` is the primary path (what app.js sends);
// a `?token=` query param is accepted too, matching the ws upgrade's own
// convention, in case a future caller can't easily set headers.
function extractToken(req, url) {
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) return auth.slice('Bearer '.length);
  return url.searchParams.get('token');
}

async function handleSessionRoute(req, res, url, id, action) {
  const row = registry.get(id);
  if (!row) return respondJson(res, 404, { error: `unknown session: ${id}` });

  // Every session-scoped route needs the session's own token now, same as
  // the websocket already required - the session id alone (a UUID, but
  // never actually a secret check) used to be enough to hit any of these.
  if (!registry.checkToken(id, extractToken(req, url))) {
    return respondJson(res, 401, { error: 'invalid or missing session token' });
  }

  if (action === 'mode' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!PERMISSION_MODES.includes(body.mode)) {
      return respondJson(res, 400, { error: `invalid mode: ${body.mode}` });
    }
    try {
      await registry.setPermissionMode(id, body.mode);
      return respondJson(res, 200, { mode: body.mode });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  // Cancel the turn(s) currently in flight - keeps the session and its
  // websocket connections alive, unlike closing it. No body: there is
  // nothing to choose, just "stop now" (mirrors Grok CLI's Esc / Ctrl+C).
  if (action === 'interrupt' && req.method === 'POST') {
    try {
      await registry.interruptTurn(id);
      return respondJson(res, 200, {});
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'models' && req.method === 'GET') {
    // Same shape as the 'commands' route above (Query.supportedCommands) -
    // Query.supportedModels is the SDK's own list, no cockpit-side hardcoded
    // model table to keep in sync as new models ship.
    try {
      const models = await row.handle.query.supportedModels();
      return respondJson(res, 200, models);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'agents' && req.method === 'GET') {
    // Same shape again - Query.supportedAgents() lists the subagents
    // available via the Task tool. Read-only: there's nothing to switch or
    // configure here, just a roster the client shows or hides a button for.
    try {
      const agents = await row.handle.query.supportedAgents();
      return respondJson(res, 200, agents);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'mcp' && req.method === 'GET') {
    // Status list for the settings modal's MCP panel.
    try {
      const servers = await registry.getMcpServerStatus(id);
      return respondJson(res, 200, servers);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  // Server name rides in the body rather than a 3rd path segment - matches
  // the plain 2-segment shape every other session route uses instead of
  // needing its own regex + extra dispatch param (used to be
  // /mcp/:name/toggle via a second routing branch in handleRequest).
  if (action === 'mcp-toggle' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.name) return respondJson(res, 400, { error: 'name required' });
    try {
      await registry.toggleMcpServer(id, body.name, Boolean(body.enabled));
      return respondJson(res, 200, { enabled: Boolean(body.enabled) });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'mcp-reconnect' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.name) return respondJson(res, 400, { error: 'name required' });
    try {
      await registry.reconnectMcpServer(id, body.name);
      return respondJson(res, 200, { reconnected: true });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'reload-plugins' && req.method === 'POST') {
    try {
      const result = await registry.reloadPlugins(id);
      // The SDK's plugin list has no notion of the on-disk enabledPlugins
      // override (settings.local.json) - it just reports what's currently
      // loaded, which is true regardless of what was last saved (B3). Merge
      // the saved map in here so the panel's toggle reflects what a restart
      // would actually pick up, not just "it's loaded right now".
      if (row.provider !== 'grok' && Array.isArray(result.plugins)) {
        const enabledMap = await readEnabledPlugins(row.cwd).catch(() => ({}));
        result.plugins = result.plugins.map((plugin) => {
          if (!plugin.source) return plugin;
          const pluginKey = `${plugin.name}@${plugin.source}`;
          const enabled = Object.prototype.hasOwnProperty.call(enabledMap, pluginKey) ? Boolean(enabledMap[pluginKey]) : true;
          return { ...plugin, enabled };
        });
      }
      return respondJson(res, 200, result);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'plugin-enabled' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!body.pluginKey) return respondJson(res, 400, { error: 'pluginKey required' });
    try {
      if (row.provider === 'grok') {
        await registry.setHandlePluginEnabled(id, body.pluginKey, Boolean(body.enabled));
      } else {
        await setPluginEnabled(row.cwd, body.pluginKey, Boolean(body.enabled));
      }
      return respondJson(res, 200, { enabled: Boolean(body.enabled) });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'model' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      await registry.setModel(id, body.model);
      return respondJson(res, 200, { model: body.model });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'effort' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!registry.GROK_EFFORTS.includes(body.effort)) {
      return respondJson(res, 400, { error: `invalid effort: ${body.effort}` });
    }
    try {
      await registry.setEffort(id, body.effort);
      return respondJson(res, 200, { effort: body.effort });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'thinking' && req.method === 'POST') {
    // Same shape as the 'model' route above: one Query method
    // (setMaxThinkingTokens), two row fields to keep in sync
    // (session-registry.js), one broadcast. `maxThinkingTokens` is a number
    // of tokens or null (off); `thinkingDisplay` is 'summarized'/'omitted'/
    // null (SDK default).
    const body = await readJsonBody(req);
    const maxThinkingTokens = body.maxThinkingTokens ?? null;
    const thinkingDisplay = body.thinkingDisplay ?? null;
    // Same shape as the 'mode'/'rewind' routes' own validation above -
    // malformed JSON (readJsonBody's catch returns `{}`) or a bad value used
    // to silently land as "thinking off" instead of a 400 (B11).
    if (maxThinkingTokens !== null && (!Number.isFinite(maxThinkingTokens) || maxThinkingTokens < 0)) {
      return respondJson(res, 400, { error: 'maxThinkingTokens must be a non-negative number or null' });
    }
    if (thinkingDisplay !== null && !['summarized', 'omitted'].includes(thinkingDisplay)) {
      return respondJson(res, 400, { error: `invalid thinkingDisplay: ${thinkingDisplay}` });
    }
    try {
      await registry.setMaxThinkingTokens(id, maxThinkingTokens, thinkingDisplay);
      // Best-effort but awaited: persisted to session-defaults.js so the
      // next session started or forked in this cwd inherits it
      // (seedSessionDefaults above). Awaiting (rather than firing and
      // forgetting) closes the narrow race where an immediate rewind/fork
      // right after this request could read the settings file before this
      // write landed. Still wrapped in try/catch, not the outer route's
      // try: a failed write here (disk full, permissions) shouldn't fail
      // the request - the live SDK call already succeeded and the client
      // already has what it asked for, it just won't carry forward.
      try {
        await setSessionDefaults(row.cwd, { maxThinkingTokens, thinkingDisplay });
      } catch {
        // ignore - see comment above
      }
      return respondJson(res, 200, { maxThinkingTokens, thinkingDisplay });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'auto-continue' && req.method === 'POST') {
    const body = await readJsonBody(req);
    try {
      await registry.setAutoContinue(id, Boolean(body.enabled));
      // Awaited, same reasoning as the 'thinking' route above.
      try {
        await setSessionDefaults(row.cwd, { autoContinue: Boolean(body.enabled) });
      } catch {
        // ignore - best-effort persistence, see 'thinking' route above
      }
      return respondJson(res, 200, { enabled: Boolean(body.enabled) });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'approval-decision' && req.method === 'POST') {
    const body = await readJsonBody(req);
    // `alwaysAllow` (backlog.md's permission "always allow this pattern",
    // scoped to per-tool-name/this-session-only) rides along on the same
    // decision object session.js's resolveApproval already receives -
    // stripped back off before it's ever handed to the SDK as the actual
    // PermissionResult (see that function).
    const decision = body.decision === 'allow'
      ? { behavior: 'allow', updatedInput: body.updatedInput, alwaysAllow: Boolean(body.alwaysAllow) }
      : { behavior: 'deny', message: body.message || 'Not approved by user.' };
    const resolved = registry.resolveApproval(id, body.requestId, decision);
    return respondJson(res, resolved ? 200 : 404, { resolved });
  }

  if (action === 'rewind' && req.method === 'POST') {
    const body = await readJsonBody(req);
    if (!Number.isInteger(body.turnIndex) || body.turnIndex < 1) {
      return respondJson(res, 400, { error: 'turnIndex (1-based integer) required' });
    }
    try {
      const result = await registry.rewind(id, body.turnIndex, { dryRun: Boolean(body.dryRun) });
      if (result.forkedSessionId) {
        // Same as the plain resume path above: fetch the fork's transcript
        // so createSession can seed turnIndexOffset correctly. A fork is a
        // resume like any other - skipping this left the forked session's
        // own future rewinds targeting the wrong turn.
        const forkedHistory = row.provider === 'grok'
          ? await fetchGrokSessionHistory(result.forkedSessionId, row.cwd).catch(() => null)
          : await fetchSessionHistory(result.forkedSessionId, row.cwd).catch(() => null);
        const forked = registry.createSession({
          cwd: row.cwd,
          resume: result.forkedSessionId,
          model: row.model,
          permissionMode: row.mode,
          provider: row.provider,
          history: forkedHistory,
        });
        // Model carries forward via createSession above. Thinking budget and
        // auto-continue don't have createSession params (they're only ever
        // set live via their own setters) - seedSessionDefaults() applies
        // them explicitly here from `row`'s own live in-memory state, not
        // the cwd-level persisted store: that store only reflects whichever
        // session in this cwd wrote to it *last*, which isn't necessarily
        // `row` when another session shares the same cwd. Passing row's
        // live values directly keeps a fork's seeding tied to the session
        // actually being forked, regardless of what else has touched this
        // cwd in the meantime.
        await seedSessionDefaults(forked, {
          maxThinkingTokens: row.maxThinkingTokens,
          thinkingDisplay: row.thinkingDisplay,
          autoContinue: row.autoContinue,
        });
        return respondJson(res, 200, { ...result, newSession: { id: forked.id, token: forked.token } });
      }
      return respondJson(res, 200, result);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'file-suggestions' && req.method === 'GET') {
    // 'folders' is JSON from file-picker.js: [{ id, path }, ...] for Screenshots
    // plus whatever else Settings has added (settings.js's customFolders).
    // Malformed/absent just means "cwd only" - an autocomplete request
    // shouldn't 400 over a bad param, it should degrade quietly.
    let extraFolders = [];
    const foldersParam = url.searchParams.get('folders');
    if (foldersParam) {
      try {
        const parsed = JSON.parse(foldersParam);
        if (Array.isArray(parsed)) extraFolders = parsed;
      } catch {
        // ignore - fileSuggestions treats [] the same as "none configured"
      }
    }
    const suggestions = await fileSuggestions(row.cwd, url.searchParams.get('q'), extraFolders);
    return respondJson(res, 200, suggestions);
  }

  if (action === 'commands' && req.method === 'GET') {
    // Public Query method (plan Spike C) - no adapter/fallback needed like
    // file_suggestions/get_workspace_diff. Cheap to call fresh each time:
    // supportedCommands() already tracks the latest commands_changed push
    // internally, so this never returns stale data after one.
    try {
      const commands = await row.handle.query.supportedCommands();
      return respondJson(res, 200, commands);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  if (action === 'diff' && req.method === 'GET') {
    return respondJson(res, 200, await workspaceDiff(row.cwd));
  }

  if (action === 'earlier-history' && req.method === 'GET') {
    try {
      const messages = await registry.loadEarlierHistory(id);
      return respondJson(res, 200, { messages });
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  }

  return respondJson(res, 404, { error: 'not found' });
}

async function serveStatic(req, res, url) {
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

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

function respondJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

// --- websocket -------------------------------------------------------------

const wss = new WebSocketServer({ noServer: true });

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

  const id = url.searchParams.get('id');
  const token = url.searchParams.get('token');
  if (!id || !registry.checkToken(id, token)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }
  // Reconnect (MVP3): a client that already rendered up to some seq sends
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
    // Queue pane mutations (backlog.md) - same ws channel as 'input' rather
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
  });

  ws.on('close', () => {
    registry.detachClient(id, ws);
  });
});

export { server, PORT, HOST };

// Only auto-listen when run directly (`node src/server.js`), not when
// imported by tests - lets tests bind an ephemeral port and drive the same
// Origin/token checks without a second process.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  server.listen(PORT, HOST, () => {
    console.log(`claude-prompt-cockpit listening on http://${HOST}:${PORT}`);
  });
}
