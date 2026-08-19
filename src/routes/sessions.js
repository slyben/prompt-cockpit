// Session lifecycle routes: list/create/get/delete a live session, plus the
// resumable-sessions list for the launcher. Split out of server.js unchanged
// (behavior-wise) into its own route module.
import * as registry from '../session-registry.js';
import { listResumableSessions, isValidCwd } from '../session-launcher.js';
import { listGrokSessions } from '../grok-launcher.js';
import { fetchSessionHistory } from '../session-history.js';
import { fetchGrokSessionHistory } from '../grok-history.js';
import { getSessionTitle, attachTitles, readSessionTitles } from '../session-titles.js';
import { isSafeGrokArg } from '../grok-acp.js';
import { readSessionDefaults } from '../session-defaults.js';
import { respondJson, readJsonBody, extractToken } from '../http-utils.js';

// Applies this cwd's persisted thinking-budget/auto-continue defaults
// (session-defaults.js) to a freshly created row - both the plain "new
// session" path below and the fork path in session-actions.js's rewind
// route go through this, so a forked session inherits the same defaults a
// brand-new session in the same cwd would, instead of the fork route
// hand-carrying the origin session's live values (the B6 workaround this
// replaces). Routes through the same registry setters a user's own toggle
// would, so it broadcasts and re-persists identically - redundant but
// harmless when the value being applied is already what's on disk.
// `defaults`, when passed, overrides the cwd-level persisted lookup - the
// rewind/fork route passes the origin row's own live values here instead,
// since two sessions sharing a cwd means the persisted session-defaults.js
// store reflects whichever of them wrote most recently, not necessarily the
// one actually being forked. Reading that shared store for a fork used to
// silently apply session B's thinking budget/auto-continue to a fork of
// session A whenever B was the last writer for their shared cwd.
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

export function registerSessionRoutes(router) {
  router.get('/api/resumable', async (req, res, url) => {
    const provider = url.searchParams.get('provider') === 'grok' ? 'grok' : 'claude';
    const sessions = provider === 'grok' ? await listGrokSessions() : await listResumableSessions();
    // Joins in any durable title (session-titles.js) a past session was
    // given from the resume list or a prior tab - one settings.local.json
    // read per distinct cwd (capped at listResumableSessions' own 30-session
    // limit, so at most a handful), not one per session. Best-effort: a
    // failed read for one cwd just leaves that cwd's sessions untitled
    // rather than 500ing the whole list.
    const distinctCwds = [...new Set(sessions.map((s) => s.cwd).filter(Boolean))];
    const titlesByCwd = new Map();
    await Promise.all(distinctCwds.map(async (cwd) => {
      titlesByCwd.set(cwd, await readSessionTitles(cwd).catch(() => ({})));
    }));
    return respondJson(res, 200, attachTitles(sessions, titlesByCwd));
  });

  router.get('/api/sessions', async (req, res) => {
    return respondJson(res, 200, registry.list());
  });

  router.post('/api/sessions', async (req, res) => {
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
    // A resume carries forward whatever durable title (session-titles.js)
    // this transcript was given, so the header label/tab title show it
    // immediately instead of waiting on a rename. body.name always wins
    // when given (currently no client path sends it, but the field exists
    // on createSession - see session-registry.js).
    const name = body.name || (body.resume ? await getSessionTitle(cwd, body.resume).catch(() => null) : null);
    // MVP5 cross-session delegation (backlog.md) addresses sessions by name
    // within a cwd, so names must be unique there. This is a fast-fail only
    // - it avoids wasting the effort validation/history fetch on a request
    // that's doomed anyway - NOT the authoritative check: two concurrent
    // requests for the same name could both pass this one (it runs before
    // createSession, with nothing stopping a second request's own check
    // from also running before either has created a row). createSession
    // itself is what actually prevents the collision (session-registry.js -
    // no `await` between its own check and the row being added), caught
    // below via err.code.
    if (name && registry.findByName(cwd, name)) {
      return respondJson(res, 409, { error: `a session named "${name}" already exists in this project` });
    }
    let effort;
    if (provider === 'grok' && typeof body.effort === 'string' && body.effort) {
      if (!registry.GROK_EFFORTS.includes(body.effort)) {
        return respondJson(res, 400, { error: `invalid effort: ${body.effort}` });
      }
      effort = body.effort;
    }
    let row;
    try {
      row = registry.createSession({ cwd, resume: body.resume, name, model, provider, effort, history });
    } catch (err) {
      if (err.code === 'ERR_NAME_TAKEN') return respondJson(res, 409, { error: err.message });
      throw err;
    }
    await seedSessionDefaults(row); // thinking budget/auto-continue carried forward from this cwd's last-used values (session-defaults.js)
    return respondJson(res, 201, {
      id: row.id,
      token: row.token,
      cwd: row.cwd,
      state: row.state,
    });
  });

  router.get('/api/sessions/:id', async (req, res, url, { id }) => {
    // MVP3 reconnect: lets a reopened tab (app.js's localStorage-remembered
    // session) check whether the session it last had open is still live
    // before trying to rejoin it, rather than assuming and failing loudly
    // on the websocket upgrade instead.
    const row = registry.get(id);
    if (!row) return respondJson(res, 404, { error: `unknown session: ${id}` });
    if (!registry.checkToken(id, extractToken(req, url))) {
      return respondJson(res, 401, { error: 'invalid or missing session token' });
    }
    return respondJson(res, 200, registry.toSummary(row));
  });

  router.delete('/api/sessions/:id', async (req, res, url, { id }) => {
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
  });
}
