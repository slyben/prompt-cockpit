// Miscellaneous host-level routes with no session/history concept of their
// own. Split out of server.js unchanged (behavior-wise) into its own route
// module.
import { defaultScreenshotDir } from '../os-defaults.js';
import { listDirectory } from '../session-launcher.js';
import { respondJson } from '../http-utils.js';
import { availableProviders } from '../provider-availability.js';

export function registerSystemRoutes(router) {
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
