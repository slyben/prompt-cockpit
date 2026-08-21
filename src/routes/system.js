// Miscellaneous host-level routes with no session/history concept of their
// own. Split out of server.js unchanged (behavior-wise) into its own route
// module.
import { defaultScreenshotDir } from '../os-defaults.js';
import { listDirectory } from '../session-launcher.js';
import { respondJson } from '../http-utils.js';
import { availableProviders } from '../provider-availability.js';
import { providerDetails } from '../provider-registry.js';
import { getHandshakeSecret, regenerateHandshakeSecret } from '../session-registry.js';
import { computeGlobalStats } from '../global-stats.js';
import { fetchAccountLimits } from '../account-limits.js';

export function registerSystemRoutes(router) {
  // MVP6 seed (backlog.md): the per-process delegation handshake secret -
  // see session-registry.js's own module-level comment for the full
  // rationale. No session token gate (there's no one session it belongs
  // to), same as /api/browse below - Host/Origin allowlisting is the actual
  // boundary here, per server.js's isSpoofedRequest.
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

  router.get('/api/browse', async (req, res, url) => {
    try {
      return respondJson(res, 200, await listDirectory(url.searchParams.get('path')));
    } catch (err) {
      return respondJson(res, 400, { error: String(err.message || err) });
    }
  });

  // All-projects usage stats (Settings > Stats tab) - see global-stats.js's
  // module comment for why this re-scans transcripts itself rather than
  // reading the CLI's own `~/.claude/stats-cache.json`. Read-only, no
  // session concept, same Origin/Host-only gating as /api/browse above.
  router.get('/api/stats', async (req, res, url) => {
    try {
      const range = url.searchParams.get('range') || 'all';
      return respondJson(res, 200, await computeGlobalStats(undefined, { range }));
    } catch (err) {
      return respondJson(res, 500, { error: String(err.message || err) });
    }
  });

  // Account-level plan quota (Settings > Stats tab's "Account limits"
  // section) - shells out to `claude -p "/usage"` rather than reading
  // anything local, since this is the one figure that's actually tracked
  // server-side across every device on the account (see
  // account-limits.js's module comment). On-demand only (its own button),
  // not part of computeGlobalStats' load - a real subprocess spawn, not a
  // free local read.
  router.get('/api/account-limits', async (req, res) => {
    try {
      return respondJson(res, 200, await fetchAccountLimits());
    } catch (err) {
      return respondJson(res, 502, { error: String(err.message || err) });
    }
  });
}
