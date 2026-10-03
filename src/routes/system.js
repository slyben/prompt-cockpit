// Miscellaneous host-level routes with no session/history concept of their
// own. Split out of server.js unchanged (behavior-wise) into its own route
// module.
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { defaultScreenshotDir } from '../os-defaults.js';
import { listDirectory } from '../session-launcher.js';
import { readJsonBody, respondJson } from '../http-utils.js';
import { availableProviders } from '../provider-availability.js';
import { providerDetails, getProvider, resolveProviderSubscription } from '../provider-registry.js';
import { getHandshakeSecret, regenerateHandshakeSecret, memorySnapshot } from '../session-registry.js';
import { computeGlobalStats } from '../global-stats.js';
import { fetchAccountLimits } from '../account-limits.js';
import { resolveClaudeSubscription } from '../claude-subscriptions.js';
import { readGitGuardSettings, readGitGuardSettingsState, setGitGuardSettings, GIT_GUARD_MODES } from '../git-commit-guard.js';

export function registerSystemRoutes(router) {
  router.get('/api/git-guard', async (req, res, url) => {
    try {
      const state = await readGitGuardSettingsState(url?.searchParams.get('cwd') || undefined);
      return respondJson(res, 200, state);
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  });

  router.post('/api/git-guard', async (req, res) => {
    try {
      const body = await readJsonBody(req);
      const current = await readGitGuardSettings();
      const mode = body.mode ?? current.mode;
      const validateCommitMessage = body.validateCommitMessage ?? current.validateCommitMessage;
      if (!GIT_GUARD_MODES.includes(mode)) {
        return respondJson(res, 400, { error: `mode must be one of ${GIT_GUARD_MODES.join(', ')}` });
      }
      if (typeof validateCommitMessage !== 'boolean') {
        return respondJson(res, 400, { error: 'validateCommitMessage must be a boolean' });
      }
      return respondJson(res, 200, await setGitGuardSettings(null, { mode, validateCommitMessage }));
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  });

  // Liveness only - deliberately outside /api/* so server.js's operator-token
  // check never applies here: a health check has to work before anyone's
  // obtained a token. Origin/Host spoof checking still applies, so this
  // stays localhost-only, just not credential-gated.
  router.get('/healthz', async (req, res) => {
    return respondJson(res, 200, { status: 'ok', pid: process.pid, uptime: process.uptime() });
  });

  // Live view of what each session row's collections are actually holding -
  // see memorySnapshot's own comment for what is/isn't capped today. Gated
  // by the operator token same as every other /api/* route; no per-session
  // token since this spans every row in the process, not one session.
  router.get('/api/system/memory', async (req, res) => {
    return respondJson(res, 200, memorySnapshot());
  });

  // The per-process delegation handshake secret -
  // see session-registry.js's own module-level comment for the full
  // rationale. No session token (there's no one session it belongs to);
  // the process operator token (server.js / operator-auth.js) is required,
  // same as /api/browse.
  router.get('/api/handshake', async (req, res) => {
    return respondJson(res, 200, { secret: getHandshakeSecret() });
  });

  // Rotates the canonical value - every row stamped with the OLD secret
  // (i.e. every session that hasn't been manually re-synced afterward)
  // stops being trusted for delegation the moment this runs. Deliberately a
  // blunt "cut everyone off" control, not scoped to one row - see
  // regenerateHandshakeSecret's own comment.
  router.post('/api/handshake/regenerate', async (req, res) => {
    return respondJson(res, 200, { secret: regenerateHandshakeSecret() });
  });
  router.get('/api/os-defaults', async (req, res) => {
    return respondJson(res, 200, { screenshotDir: defaultScreenshotDir() });
  });

  // Checked once at process launch (see provider-availability.js's cache) -
  // lets the launcher hide a provider's UI (e.g. the Grok dropdown) when
  // its CLI isn't installed on this machine.
  router.get('/api/providers', async (req, res) => {
    const providers = await availableProviders();
    return respondJson(res, 200, {
      providers,
      providerDetails: providers.map(providerDetails),
    });
  });

  // This endpoint intentionally has no session token: it is a launcher-level
  // catalog read like /api/resumable. Dynamic providers may start/reuse a
  // shared child process while discovering models, so keep it behind the
  // router's Origin/Host checks rather than treating it as a side-effect-free
  // public resource.
  router.get('/api/providers/:provider/models', async (req, res, url, { provider }) => {
    let descriptor;
    let account;
    try {
      descriptor = getProvider(provider);
      account = resolveProviderSubscription(descriptor, url.searchParams.get('subscription'));
    } catch (err) {
      return respondJson(res, 400, { error: err.message });
    }
    try {
      const models = descriptor.listModels
        ? await descriptor.listModels({ subscription: account?.id })
        : descriptor.models || [];
      return respondJson(res, 200, models);
    } catch (err) {
      return respondJson(res, 502, { error: String(err.message || err) });
    }
  });

  router.get('/api/browse', async (req, res, url) => {
    try {
      return respondJson(res, 200, await listDirectory(url.searchParams.get('path')));
    } catch (err) {
      return respondJson(res, 400, { error: String(err.message || err) });
    }
  });

  // All-projects usage stats (Settings > Stats tab) - re-scans Claude/Grok
  // transcripts and Codex rollout files plus thread/list fallbacks, rather
  // than reading the CLI's own stats-cache.json. Read-only, same
  // Origin/Host-only gating as /api/browse above.
  router.get('/api/stats', async (req, res, url) => {
    try {
      const range = url.searchParams.get('range') || 'all';
      return respondJson(res, 200, await computeGlobalStats(undefined, { range }));
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  });

  // Account-level plan quota - shells out to `claude -p "/usage"` rather
  // than reading anything local, since this is tracked server-side across
  // every device on the account. On-demand only (its own button), not part
  // of computeGlobalStats' load - a real subprocess spawn, not a free read.
  // Whether the CLI's own promptSuggestionEnabled feature is still on in the
  // user's global settings.json. cockpit's compose box computes its own
  // ghost-text suggestion client-side (see app.js's computePromptSuggestion),
  // so this SDK feature costs a server-side call per turn cockpit never
  // reads - the client uses this to nag the user once to turn it off.
  // Read-only, no session token, same Origin/Host-only gating as /api/browse.
  router.get('/api/prompt-suggestion-status', async (req, res) => {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
    let settings = {};
    try {
      settings = JSON.parse(await readFile(path.join(configDir, 'settings.json'), 'utf-8'));
    } catch {
      // missing/unreadable/corrupt file - fall through, absent means the SDK
      // default (enabled) applies same as if the key were simply unset
    }
    return respondJson(res, 200, { enabled: settings.promptSuggestionEnabled !== false });
  });

  router.get('/api/account-limits', async (req, res, url) => {
    try {
      const account = resolveClaudeSubscription(url.searchParams.get('subscription'));
      return respondJson(res, 200, await fetchAccountLimits('claude', undefined, account.id));
    } catch (err) {
      return respondJson(res, 502, { error: String(err.message || err) });
    }
  });
}
