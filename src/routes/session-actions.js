// The /api/sessions/:id/:action dispatcher - every route that acts on one
// live session (mode, interrupt, model, thinking budget, MCP/plugin toggles,
// permissions, rewind, etc). Kept as a single handler with its own per-action
// `if (action === ... && req.method === ...)` checks, same as it was inside
// server.js's handleSessionRoute - these routes share one auth gate
// (session token) and don't benefit from being registered as 20-odd separate
// router entries. Split out of server.js unchanged (behavior-wise).
import * as registry from '../session-registry.js';
import { PERMISSION_MODES } from '../permissions.js';
import { fetchSessionHistory } from '../session-history.js';
import { fetchGrokSessionHistory } from '../grok-history.js';
import { readAllowRules, addAllowRule, removeAllowRule, formatRule } from '../permission-rules.js';
import { setSessionTitle } from '../session-titles.js';
import { setPluginEnabled, readEnabledPlugins } from '../plugin-settings.js';
import { readGitGuardMode, setGitGuardMode, GIT_GUARD_MODES } from '../git-commit-guard.js';
import { setSessionDefaults } from '../session-defaults.js';
import { fileSuggestions, workspaceDiff } from '../sdk-adapter.js';
import { respondJson, readJsonBody, extractToken } from '../http-utils.js';
import { seedSessionDefaults } from './sessions.js';

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

    // Manual last-resort unstick (see registry.forceIdle's own comment) -
    // the pendingTurnsCount badge next to the spinner (app.js) posts here
    // when clicked. Unlike interrupt above, this never touches the CLI at
    // all - it's for exactly the case where interrupt already ran (or
    // there's nothing left to interrupt) and the counter is still stuck.
    if (action === 'force-idle' && req.method === 'POST') {
      try {
        await registry.forceIdle(id);
        return respondJson(res, 200, {});
      } catch (err) {
        return respondJson(res, 500, { error: String(err.message || err) });
      }
    }

    if (action === 'models' && req.method === 'GET') {
      // Same shape as the 'commands' route below (Query.supportedCommands) -
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
    // /mcp/:name/toggle via a second routing branch in server.js).
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

    if (action === 'git-guard' && req.method === 'GET') {
      try {
        return respondJson(res, 200, { mode: await readGitGuardMode(row.cwd) });
      } catch (err) {
        return respondJson(res, 500, { error: String(err.message || err) });
      }
    }

    if (action === 'git-guard' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!GIT_GUARD_MODES.includes(body.mode)) return respondJson(res, 400, { error: `mode must be one of ${GIT_GUARD_MODES.join(', ')}` });
      try {
        await setGitGuardMode(row.cwd, body.mode);
        return respondJson(res, 200, { mode: body.mode });
      } catch (err) {
        return respondJson(res, 500, { error: String(err.message || err) });
      }
    }

    // MVP6 seed (backlog.md): pastes a handshake value onto THIS row -
    // "paste from the server's own /api/handshake copy" is the trusted
    // path, but any string is accepted (setSessionHandshake trims it and
    // just compares); a mismatched value is a valid way to explicitly
    // revoke this row's own delegation trust, not an error.
    if (action === 'handshake' && req.method === 'POST') {
      const body = await readJsonBody(req);
      try {
        const trusted = registry.setSessionHandshake(id, body.value);
        return respondJson(res, 200, { trusted });
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

    if (action === 'permissions' && req.method === 'GET') {
      // Backs the Settings modal's "Always-allowed tools in this project"
      // list (public/settings.js) - the durable rules addAllowRule wrote via
      // the approval-decision route below.
      try {
        return respondJson(res, 200, { allow: await readAllowRules(row.cwd) });
      } catch (err) {
        return respondJson(res, 500, { error: String(err.message || err) });
      }
    }

    if (action === 'permissions' && req.method === 'DELETE') {
      // Revoke path for a persisted allow rule - ships in the same increment
      // as the rule ever being writable at all (permission-rules.js's module
      // comment), since a standing security decision with no way to undo it
      // isn't durable, it's just stuck.
      const body = await readJsonBody(req);
      if (typeof body.rule !== 'string' || !body.rule) {
        return respondJson(res, 400, { error: 'rule is required' });
      }
      try {
        await removeAllowRule(row.cwd, body.rule);
        return respondJson(res, 200, { allow: await readAllowRules(row.cwd) });
      } catch (err) {
        return respondJson(res, 500, { error: String(err.message || err) });
      }
    }

    if (action === 'title' && req.method === 'POST') {
      // Renames the live session (header label, tab title via app.js) *and*
      // persists it (session-titles.js) so it survives to the next resume -
      // same "live effect first, best-effort persist" shape as the
      // 'thinking'/'auto-continue' routes below. Needs row.claudeSessionId to
      // persist against (the transcript's own session id, latched once the
      // SDK's first system/init message arrives) - too early to have one is
      // the same "session exists but the CLI hasn't reported in yet" window
      // rewind()/loadEarlierHistory() already guard against, so this uses the
      // same signal (throw a clear error) rather than silently no-op-ing.
      const body = await readJsonBody(req);
      const title = typeof body.title === 'string' ? body.title : '';
      if (!row.claudeSessionId) {
        return respondJson(res, 409, { error: 'session has no claude session id yet - try again once it has started' });
      }
      // Same MVP5 uniqueness requirement as POST /api/sessions - a rename
      // must not collide with another live session's name in the same cwd
      // either. Fast-fail only, same caveat as the create route's own
      // pre-check - registry.setSessionName below is the authoritative,
      // race-free check (err.code === 'ERR_NAME_TAKEN', caught below).
      const trimmedTitle = title.trim() || null;
      if (trimmedTitle) {
        const existing = registry.findByName(row.cwd, trimmedTitle);
        if (existing && existing.id !== id) {
          return respondJson(res, 409, { error: `a session named "${trimmedTitle}" already exists in this project` });
        }
      }
      try {
        await registry.setSessionName(id, title.trim() || null);
        try {
          await setSessionTitle(row.cwd, row.claudeSessionId, title);
        } catch {
          // ignore - best-effort persistence, see 'thinking' route's comment
        }
        return respondJson(res, 200, { title: title.trim() || null });
      } catch (err) {
        if (err.code === 'ERR_NAME_TAKEN') return respondJson(res, 409, { error: err.message });
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
      // Same shape as the 'mode'/'rewind' routes' own validation - malformed
      // JSON (readJsonBody's catch returns `{}`) or a bad value used to
      // silently land as "thinking off" instead of a 400 (B11).
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
        // (seedSessionDefaults). Awaiting (rather than firing and
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
      // `alwaysAllow` (backlog.md's permission "always allow this tool")
      // rides along on the same decision object session.js's resolveApproval
      // already receives - stripped back off before it's ever handed to the
      // SDK as the actual PermissionResult (see that function). `false`/
      // `undefined` means "just this once"; `true` is accepted for backward
      // compatibility and coerced to `'session'`.
      if (![undefined, false, true, 'session', 'project'].includes(body.alwaysAllow)) {
        return respondJson(res, 400, { error: `invalid alwaysAllow: ${body.alwaysAllow}` });
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
      return respondJson(res, result ? 200 : 404, { resolved: Boolean(result) });
    }

    if (action === 'rewind' && req.method === 'POST') {
      const body = await readJsonBody(req);
      if (!Number.isInteger(body.turnIndex) || body.turnIndex < 1) {
        return respondJson(res, 400, { error: 'turnIndex (1-based integer) required' });
      }
      try {
        const result = await registry.rewind(id, body.turnIndex, { dryRun: Boolean(body.dryRun) });
        if (result.forkedSessionId) {
          // Same as the plain resume path (routes/sessions.js): fetch the
          // fork's transcript so createSession can seed turnIndexOffset
          // correctly. A fork is a resume like any other - skipping this
          // left the forked session's own future rewinds targeting the
          // wrong turn.
          const forkedHistory = row.provider === 'grok'
            ? await fetchGrokSessionHistory(result.forkedSessionId, row.cwd).catch(() => null)
            : await fetchSessionHistory(result.forkedSessionId, row.cwd).catch(() => null);
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

    if (action === 'debug' && req.method === 'GET') {
      // Backs the activityBar's debug-capture button (app.js) - a live
      // snapshot of exactly the internal counters a stuck spinner report
      // needs (see session-registry.js's getDebugInfo comment), so a bug
      // report can be gathered in one click instead of asking whoever hit
      // it to open devtools.
      return respondJson(res, 200, registry.getDebugInfo(id));
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
  });
}
