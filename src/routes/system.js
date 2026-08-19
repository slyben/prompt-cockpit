// Miscellaneous host-level routes with no session/history concept of their
// own. Split out of server.js unchanged (behavior-wise) into its own route
// module.
import { defaultScreenshotDir } from '../os-defaults.js';
import { listDirectory } from '../session-launcher.js';
import { respondJson } from '../http-utils.js';
import { availableProviders } from '../provider-availability.js';
import { getHandshakeSecret, regenerateHandshakeSecret } from '../session-registry.js';

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
    return respondJson(res, 200, { providers: await availableProviders() });
  });

  router.get('/api/browse', async (req, res, url) => {
    try {
      return respondJson(res, 200, await listDirectory(url.searchParams.get('path')));
    } catch (err) {
      return respondJson(res, 400, { error: String(err.message || err) });
    }
  });
}
