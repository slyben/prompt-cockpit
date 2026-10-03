import path from 'node:path';
import { homedir } from 'node:os';
import { getCodexAppServerManager } from './codex-app-server.js';
import { codexRateLimitsToPanel } from './codex-extensions.js';
import { accountUsageCache } from './account-usage-cache.js';

export function codexAccountUsageKey() {
  return `codex:${path.resolve(process.env.CODEX_HOME || path.join(homedir(), '.codex'))}`;
}

export async function fetchCodexRateLimits({ queryHandle, manager, refresh = false } = {}) {
  return accountUsageCache.fetch(codexAccountUsageKey(), async () => {
    if (queryHandle) return queryHandle.codexRateLimits();
    const result = await (manager || getCodexAppServerManager()).request('account/rateLimits/read', null);
    return codexRateLimitsToPanel(result);
  }, { refresh });
}
