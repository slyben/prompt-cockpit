// The /api/sessions/:id/:action dispatcher - every route that acts on one
// live session. Actions are registered in the ACTIONS table below, keyed
// by `${method} ${action}`; the dispatcher does the shared row/token
// lookup once and wraps every handler in one try/catch, so each handler
// just returns its 200 body or throws to signal an error.
import * as registry from '../session-registry.js';
import { PERMISSION_MODES } from '../permissions.js';
import { readAllowRules, addAllowRule, removeAllowRule, formatRule } from '../permission-rules.js';
import { setSessionTitle } from '../session-titles.js';
import { setPluginEnabled, readEnabledPlugins } from '../plugin-settings.js';
import { readGitGuardMode, setGitGuardMode, GIT_GUARD_MODES } from '../git-commit-guard.js';
import { setSessionDefaults } from '../session-defaults.js';
import { fileSuggestions, workspaceDiff } from '../sdk-adapter.js';
import { respondJson, readJsonBody, extractToken } from '../http-utils.js';
import { seedSessionDefaults } from './sessions.js';
import { getProvider } from '../provider-registry.js';

// Thrown by a handler to answer with a specific status code/body instead of
// the dispatcher's generic 500 catch-all (see below) - the couple-dozen
// explicit 400/404/409/503s that used to be their own early `return
// respondJson(...)` calls scattered through the if-chain.
class RouteError extends Error {
  constructor(status, body) {
    super(typeof body?.error === 'string' ? body.error : `route error (${status})`);
    this.status = status;
    this.body = body;
  }
}

// Each handler receives `{ id, row, req, res, url }` and either returns a
// value (JSON-responded as 200) or throws - a RouteError for a specific
// status/body, or anything else for the generic 500 { error } shape.
const ACTIONS = {
  'POST mode': async ({ id, req }) => {
    const body = await readJsonBody(req);
    if (!PERMISSION_MODES.includes(body.mode)) {
      throw new RouteError(400, { error: `invalid mode: ${body.mode}` });
    }
    await registry.setPermissionMode(id, body.mode);
    return { mode: body.mode };
  },

  // Cancel the turn(s) currently in flight - keeps the session and its
  // websocket connections alive, unlike closing it. No body: there is
  // nothing to choose, just "stop now" (mirrors Grok CLI's Esc / Ctrl+C).
  'POST interrupt': async ({ id }) => {
    await registry.interruptTurn(id);
    return {};
  },

  // Manual last-resort unstick (see registry.forceIdle's own comment) -
  // the pendingTurnsCount badge next to the spinner (app.js) posts here
  // when clicked. Unlike interrupt above, this never touches the CLI at
  // all - it's for exactly the case where interrupt already ran (or
  // there's nothing left to interrupt) and the counter is still stuck.
  'POST force-idle': async ({ id }) => {
    await registry.forceIdle(id);
    return {};
  },

  // Same shape as the 'commands' route below (Query.supportedCommands) -
  // Query.supportedModels is the SDK's own list, no cockpit-side hardcoded
  // model table to keep in sync as new models ship.
  'GET models': async ({ row }) => row.handle.query.supportedModels(),

  // Same shape again - Query.supportedAgents() lists the subagents
  // available via the Task tool. Read-only: there's nothing to switch or
  // configure here, just a roster the client shows or hides a button for.
  'GET agents': async ({ row }) => row.handle.query.supportedAgents(),

  // Status list for the settings modal's MCP panel.
  'GET mcp': async ({ id }) => registry.getMcpServerStatus(id),

  // Server name rides in the body rather than a 3rd path segment - matches
  // the plain 2-segment shape every other session route uses instead of
  // needing its own regex + extra dispatch param (used to be
  // /mcp/:name/toggle via a second routing branch in server.js).
  'POST mcp-toggle': async ({ id, req }) => {
    const body = await readJsonBody(req);
    if (!body.name) throw new RouteError(400, { error: 'name required' });
    await registry.toggleMcpServer(id, body.name, Boolean(body.enabled));
    return { enabled: Boolean(body.enabled) };
  },

  'POST mcp-reconnect': async ({ id, req }) => {
    const body = await readJsonBody(req);
    if (!body.name) throw new RouteError(400, { error: 'name required' });
    await registry.reconnectMcpServer(id, body.name);
    return { reconnected: true };
  },

  'POST reload-plugins': async ({ id, row }) => {
    const result = await registry.reloadPlugins(id);
    // The SDK's plugin list has no notion of the on-disk enabledPlugins
    // override - it just reports what's currently loaded. Merge the saved
    // map in here so the panel's toggle reflects what a restart would
    // actually pick up, not just "it's loaded right now".
    if (getProvider(row.provider).capabilities.pluginToggleViaFile && Array.isArray(result.plugins)) {
      const enabledMap = await readEnabledPlugins(row.cwd).catch(() => ({}));
      result.plugins = result.plugins.map((plugin) => {
        if (!plugin.source) return plugin;
        const pluginKey = `${plugin.name}@${plugin.source}`;
        const enabled = Object.prototype.hasOwnProperty.call(enabledMap, pluginKey) ? Boolean(enabledMap[pluginKey]) : true;
        return { ...plugin, enabled };
      });
    }
    return result;
  },

  'POST plugin-enabled': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    if (!body.pluginKey) throw new RouteError(400, { error: 'pluginKey required' });
    const caps = getProvider(row.provider).capabilities;
    if (caps.pluginToggleViaHandle) {
      await registry.setHandlePluginEnabled(id, body.pluginKey, Boolean(body.enabled));
    } else if (caps.pluginToggleViaFile) {
      await setPluginEnabled(row.cwd, body.pluginKey, Boolean(body.enabled));
    } else {
      // Neither toggle path applies - this provider has no plugin
      // concept at all (Codex). Previously fell through to the
      // Claude-only file path, which would have written a Codex plugin
      // key into .claude/settings.local.json.
      throw new RouteError(400, { error: `${row.provider} sessions do not support plugins` });
    }
    return { enabled: Boolean(body.enabled) };
  },

  'GET git-guard': async ({ row }) => ({ mode: await readGitGuardMode(row.cwd) }),

  'POST git-guard': async ({ row, req }) => {
    const body = await readJsonBody(req);
    if (!GIT_GUARD_MODES.includes(body.mode)) {
      throw new RouteError(400, { error: `mode must be one of ${GIT_GUARD_MODES.join(', ')}` });
    }
    await setGitGuardMode(row.cwd, body.mode);
    return { mode: body.mode };
  },

  // Pastes a handshake value onto THIS row -
  // "paste from the server's own /api/handshake copy" is the trusted
  // path, but any string is accepted (setSessionHandshake trims it and
  // just compares); a mismatched value is a valid way to explicitly
  // revoke this row's own delegation trust, not an error.
  'POST handshake': async ({ id, req }) => {
    const body = await readJsonBody(req);
    const trusted = registry.setSessionHandshake(id, body.value);
    return { trusted };
  },

  'POST model': async ({ id, req }) => {
    const body = await readJsonBody(req);
    await registry.setModel(id, body.model);
    return { model: body.model };
  },

  // Backs the Settings modal's "Always-allowed tools in this project"
  // list (public/settings.js) - the durable rules addAllowRule wrote via
  // the approval-decision route below.
  'GET permissions': async ({ row }) => ({ allow: await readAllowRules(row.cwd) }),

  // Revoke path for a persisted allow rule - ships in the same increment
  // as the rule ever being writable at all (permission-rules.js's module
  // comment), since a standing security decision with no way to undo it
  // isn't durable, it's just stuck.
  'DELETE permissions': async ({ row, req }) => {
    const body = await readJsonBody(req);
    if (typeof body.rule !== 'string' || !body.rule) {
      throw new RouteError(400, { error: 'rule is required' });
    }
    await removeAllowRule(row.cwd, body.rule);
    return { allow: await readAllowRules(row.cwd) };
  },

  // Renames the live session *and* persists it so it survives to the next
  // resume - same "live effect first, best-effort persist" shape as the
  // 'thinking'/'auto-continue' routes below. Needs row.providerSessionId
  // to persist against (latched once the SDK's first init arrives); too
  // early to have one throws a clear error instead of a silent no-op.
  'POST title': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    const title = typeof body.title === 'string' ? body.title : '';
    if (!row.providerSessionId) {
      throw new RouteError(409, { error: 'session has no provider session id yet - try again once it has started' });
    }
    // Same delegation-name uniqueness requirement as POST /api/sessions -
    // a rename must not collide with another live session's name in the
    // same cwd either. Fast-fail only, same caveat as the create route's own
    // pre-check - registry.setSessionName below is the authoritative,
    // race-free check (err.code === 'ERR_NAME_TAKEN', caught below).
    const trimmedTitle = title.trim() || null;
    if (trimmedTitle) {
      const existing = registry.findByName(row.cwd, trimmedTitle);
      if (existing && existing.id !== id) {
        throw new RouteError(409, { error: `a session named "${trimmedTitle}" already exists in this project` });
      }
    }
    try {
      await registry.setSessionName(id, title.trim() || null);
    } catch (err) {
      if (err.code === 'ERR_NAME_TAKEN') throw new RouteError(409, { error: err.message });
      throw err;
    }
    try {
      await setSessionTitle(row.cwd, row.providerSessionId, title);
    } catch {
      // ignore - best-effort persistence, see 'thinking' route's comment
    }
    return { title: title.trim() || null };
  },

  'POST effort': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    const provider = getProvider(row.provider);
    // provider.efforts is the advertised superset across every model a
    // provider might use - not every model supports every value in it. A
    // provider that can narrow that down for the session's actual current
    // model does so here, rejecting an unsupported choice now instead of
    // failing when the next turn starts.
    const validEfforts = provider.resolveEfforts ? await provider.resolveEfforts(row) : provider.efforts;
    // null means resolveEfforts couldn't reach the live model catalog
    // (see provider-registry.js's own comment) - fail closed rather than
    // silently accepting anything, since the whole point of asking was to
    // reject a value this model can't actually honor.
    if (validEfforts == null) {
      throw new RouteError(503, { error: 'could not verify supported efforts for the current model - try again' });
    }
    if (!validEfforts.includes(body.effort)) {
      throw new RouteError(400, { error: `invalid effort: ${body.effort}` });
    }
    await registry.setEffort(id, body.effort);
    // Persisted so the next brand-new session in this cwd inherits it - a
    // forked session already inherits effort a different way (the rewind
    // route passes `row.effort` straight into createSession), so this
    // write only matters for the "new session, same cwd" gap.
    try {
      await setSessionDefaults(row.cwd, { effort: body.effort });
    } catch {
      // ignore - see 'thinking' route's comment below
    }
    return { effort: body.effort };
  },

  // Same shape as the 'model' route above: one Query method
  // (setMaxThinkingTokens), two row fields to keep in sync
  // (session-registry.js), one broadcast. `maxThinkingTokens` is a number
  // of tokens or null (off); `thinkingDisplay` is 'summarized'/'omitted'/
  // null (SDK default).
  'POST thinking': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    const maxThinkingTokens = body.maxThinkingTokens ?? null;
    const thinkingDisplay = body.thinkingDisplay ?? null;
    // Malformed JSON (readJsonBody's catch returns `{}`) or a bad value
    // must 400 rather than silently landing as "thinking off".
    if (maxThinkingTokens !== null && (!Number.isFinite(maxThinkingTokens) || maxThinkingTokens < 0)) {
      throw new RouteError(400, { error: 'maxThinkingTokens must be a non-negative number or null' });
    }
    if (thinkingDisplay !== null && !['summarized', 'omitted'].includes(thinkingDisplay)) {
      throw new RouteError(400, { error: `invalid thinkingDisplay: ${thinkingDisplay}` });
    }
    await registry.setMaxThinkingTokens(id, maxThinkingTokens, thinkingDisplay);
    // Best-effort but awaited: persisted so the next session started or
    // forked in this cwd inherits it. Awaiting closes the narrow race
    // where an immediate rewind/fork could read the settings file before
    // this write lands. A failed write here shouldn't fail the request -
    // the live SDK call already succeeded - so it's caught, not rethrown.
    try {
      await setSessionDefaults(row.cwd, { maxThinkingTokens, thinkingDisplay });
    } catch {
      // ignore - see comment above
    }
    return { maxThinkingTokens, thinkingDisplay };
  },

  'POST auto-continue': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    await registry.setAutoContinue(id, Boolean(body.enabled));
    // Awaited, same reasoning as the 'thinking' route above.
    try {
      await setSessionDefaults(row.cwd, { autoContinue: Boolean(body.enabled) });
    } catch {
      // ignore - best-effort persistence, see 'thinking' route above
    }
    return { enabled: Boolean(body.enabled) };
  },

  'POST approval-decision': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    // `alwaysAllow` rides along on the same decision object
    // session.js's resolveApproval receives, stripped back off before it's
    // handed to the SDK as the actual PermissionResult. `false`/undefined
    // means "just this once"; `true` is accepted for backward
    // compatibility and coerced to `'session'`.
    if (![undefined, false, true, 'session', 'project'].includes(body.alwaysAllow)) {
      throw new RouteError(400, { error: `invalid alwaysAllow: ${body.alwaysAllow}` });
    }
    // The UI hides "always in this project" when capabilities.
    // projectPersistentApprovals is false, but defend here too - Grok's
    // and Codex's resolveApproval() have no scope beyond turn/session, so
    // a 'project' choice would otherwise silently collapse to
    // session-scoped with no indication persistence never happened.
    if (body.alwaysAllow === 'project' && !getProvider(row.provider).capabilities.projectPersistentApprovals) {
      throw new RouteError(400, { error: `${row.provider} sessions cannot persist an "always allow" choice across a restart - use "rest of this session" instead` });
    }
    const decision = body.decision === 'allow'
      ? { behavior: 'allow', updatedInput: body.updatedInput, alwaysAllow: body.alwaysAllow }
      : { behavior: 'deny', message: body.message || 'Not approved by user.' };
    const result = registry.resolveApproval(id, body.requestId, decision);
    if (result && result.scope === 'project') {
      // Best-effort, own try/catch: the live allow already took effect
      // (session.js's alwaysAllowTools, above) regardless of whether this
      // write succeeds - same "live effect first, persistence is a bonus"
      // shape as the 'thinking'/'auto-continue' routes.
      try {
        await addAllowRule(row.cwd, formatRule({ toolName: result.toolName }));
      } catch {
        // ignore - see comment above
      }
    }
    if (!result) throw new RouteError(404, { resolved: false });
    return { resolved: true };
  },

  'POST rewind': async ({ id, row, req }) => {
    const body = await readJsonBody(req);
    if (!Number.isInteger(body.turnIndex) || body.turnIndex < 1) {
      throw new RouteError(400, { error: 'turnIndex (1-based integer) required' });
    }
    const result = await registry.rewind(id, body.turnIndex, { dryRun: Boolean(body.dryRun) });
    if (result.forkedSessionId) {
      // Same as the plain resume path (routes/sessions.js): fetch the
      // fork's transcript so createSession can seed turnIndexOffset
      // correctly. A fork is a resume like any other - skipping this
      // left the forked session's own future rewinds targeting the
      // wrong turn.
      const forkedHistory = await getProvider(row.provider)
        .fetchHistory(result.forkedSessionId, row.cwd)
        .catch(() => null);
      const forked = registry.createSession({
        cwd: row.cwd,
        resume: result.forkedSessionId,
        model: row.model,
        effort: row.effort,
        permissionMode: row.mode,
        provider: row.provider,
        history: forkedHistory,
      });
      // Model carries forward via createSession above. Thinking budget and
      // auto-continue have no createSession param, so seedSessionDefaults()
      // applies them explicitly from `row`'s live in-memory state rather
      // than the cwd-level persisted store, which only reflects whichever
      // session in this cwd wrote to it last - not necessarily `row`.
      await seedSessionDefaults(forked, {
        maxThinkingTokens: row.maxThinkingTokens,
        thinkingDisplay: row.thinkingDisplay,
        autoContinue: row.autoContinue,
      });
      return { ...result, newSession: { id: forked.id, token: forked.token } };
    }
    return result;
  },

  // 'folders' is JSON from file-picker.js: [{ id, path }, ...] for Screenshots
  // plus whatever else Settings has added (settings.js's customFolders).
  // Malformed/absent just means "cwd only" - an autocomplete request
  // shouldn't 400 over a bad param, it should degrade quietly.
  'GET file-suggestions': async ({ row, url }) => {
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
    return fileSuggestions(row.cwd, url.searchParams.get('q'), extraFolders);
  },

  // Public Query method, no adapter/fallback needed like
  // file_suggestions/get_workspace_diff. Cheap to call fresh each time:
  // supportedCommands() already tracks the latest commands_changed push
  // internally, so this never returns stale data after one.
  'GET commands': async ({ row }) => row.handle.query.supportedCommands(),

  'GET diff': async ({ row }) => workspaceDiff(row.cwd),

  // Backs the activityBar's debug-capture button (app.js) - a live
  // snapshot of exactly the internal counters a stuck spinner report
  // needs (see session-registry.js's getDebugInfo comment), so a bug
  // report can be gathered in one click instead of asking whoever hit
  // it to open devtools.
  'GET debug': ({ id }) => registry.getDebugInfo(id),

  'GET earlier-history': async ({ id }) => {
    const messages = await registry.loadEarlierHistory(id);
    return { messages };
  },
};

export function registerSessionActionRoutes(router) {
  router.any('/api/sessions/:id/:action', async (req, res, url, { id, action }) => {
    const row = registry.get(id);
    if (!row) return respondJson(res, 404, { error: `unknown session: ${id}` });

    // Every session-scoped route needs the session's own token now, same as
    // the websocket already required - the session id alone (a UUID, but
    // never actually a secret check) used to be enough to hit any of these.
    if (!registry.checkToken(id, extractToken(req, url))) {
      return respondJson(res, 401, { error: 'invalid or missing session token' });
    }

    const handler = ACTIONS[`${req.method} ${action}`];
    if (!handler) return respondJson(res, 404, { error: 'not found' });

    try {
      const body = await handler({ id, row, req, res, url });
      return respondJson(res, 200, body);
    } catch (err) {
      if (err instanceof RouteError) return respondJson(res, err.status, err.body);
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  });
}
