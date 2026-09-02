// Miscellaneous host-level routes with no session/history concept of their
// own. Split out of server.js unchanged (behavior-wise) into its own route
// module.
import { defaultScreenshotDir } from '../os-defaults.js';
import { listDirectory } from '../session-launcher.js';
import { respondJson } from '../http-utils.js';
import { availableProviders } from '../provider-availability.js';
import { providerDetails } from '../provider-registry.js';
import { getHandshakeSecret, regenerateHandshakeSecret, memorySnapshot } from '../session-registry.js';
import { computeGlobalStats } from '../global-stats.js';
import { fetchAccountLimits } from '../account-limits.js';

export function registerSystemRoutes(router) {
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

  router.get('/api/browse', async (req, res, url) => {
    try {
      return respondJson(res, 200, await listDirectory(url.searchParams.get('path')));
    } catch (err) {
      return respondJson(res, 400, { error: String(err.message || err) });
    }
  });

  // All-projects usage stats (Settings > Stats tab) - re-scans transcripts
  // itself rather than reading the CLI's own stats-cache.json. Read-only,
  // same Origin/Host-only gating as /api/browse above.
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
  router.get('/api/account-limits', async (req, res) => {
    try {
      return respondJson(res, 200, await fetchAccountLimits());
    } catch (err) {
      return respondJson(res, 502, { error: String(err.message || err) });
    }
  });
}
