// Session lifecycle routes: list/create/get/delete a live session, plus the
// resumable-sessions list for the launcher. Split out of server.js unchanged
// (behavior-wise) into its own route module.
import * as registry from '../session-registry.js';
import { isValidCwd } from '../session-launcher.js';
import { getSessionTitle, attachTitles, readSessionTitles } from '../session-titles.js';
import { isSafeGrokArg } from '../grok-acp.js';
import { readSessionDefaults } from '../session-defaults.js';
import { respondJson, readJsonBody, extractToken } from '../http-utils.js';
import { parseProvider } from '../provider-registry.js';

// Applies this cwd's persisted thinking-budget/auto-continue defaults to
// a freshly created row - both the "new session" and fork paths go
// through this. `defaults`, when passed, overrides the cwd lookup - the
// fork route passes the origin row's own live values, since the
// persisted store reflects whichever same-cwd session wrote last.
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
    let provider;
    try {
      provider = parseProvider(url.searchParams.get('provider'));
    } catch (err) {
      return respondJson(res, 400, { error: err.message });
    }
    let sessions;
    try {
      sessions = await provider.listResumableSessions();
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
    // Joins in any durable title a past session was given, one settings
    // read per distinct cwd rather than per session. Best-effort: a failed
    // read for one cwd just leaves that cwd's sessions untitled instead of
    // 500ing the whole list.
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
    let provider;
    try {
      provider = parseProvider(body.provider);
    } catch (err) {
      return respondJson(res, 400, { error: err.message });
    }
    const history = body.resume
      ? await provider.fetchHistory(body.resume, cwd).catch(() => null)
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
    // Cross-session delegation addresses sessions by name within a cwd, so
    // names must be unique there. This is a fast-fail only - two
    // concurrent requests could both pass it before either creates a row.
    // createSession itself prevents the collision (no await between its
    // own check and the row being added), caught below via err.code.
    if (name && registry.findByName(cwd, name)) {
      return respondJson(res, 409, { error: `a session named "${name}" already exists in this project` });
    }
    let effort;
    if (typeof body.effort === 'string' && body.effort) {
      const validEfforts = provider.efforts;
      if (!validEfforts.includes(body.effort)) {
        return respondJson(res, 400, { error: `invalid effort: ${body.effort}` });
      }
      effort = body.effort;
    } else {
      // Unlike thinking/auto-continue, effort has no post-creation setter,
      // so it must be resolved from the persisted default here, before
      // createSession, rather than via seedSessionDefaults() after. A
      // genuine fork instead carries row.effort forward directly
      // (session-actions.js's rewind route), bypassing this branch.
      const persisted = await readSessionDefaults(cwd).catch(() => null);
      // `provider` is the resolved provider object here (parseProvider's
      // return, see the branch above), not a string - matches line 115's
      // own `provider.efforts` access. A stray `provider === 'grok'` string
      // check merged in from the pre-refactor branch would always be false
      // here and silently fall back to CLAUDE_EFFORTS for a Grok session.
      if (persisted?.effort && provider.efforts.includes(persisted.effort)) effort = persisted.effort;
    }
    let row;
    try {
      row = registry.createSession({ cwd, resume: body.resume, name, model, provider: provider.id, effort, history });
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
    // Reconnect: lets a reopened tab (app.js's localStorage-remembered
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
