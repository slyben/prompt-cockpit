import { getCodexAppServerManager } from './codex-app-server.js';

// Shared by the launcher and live sessions; discovery does not create a thread.
export async function listCodexModels(manager = getCodexAppServerManager()) {
  const models = [];
  let cursor;
  do {
    const result = await manager.request('model/list', {
      limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}),
    });
    for (const entry of result?.data || []) {
      const value = entry.model || entry.id;
      if (!value || entry.hidden) continue;
      models.push({
        value,
        displayName: entry.displayName || value,
        description: entry.description || '',
        resolvedModel: value,
        ...(entry.isDefault === true ? { isDefault: true } : {}),
        supportedEfforts: Array.isArray(entry.supportedReasoningEfforts)
          ? entry.supportedReasoningEfforts.map((effort) => typeof effort === 'string' ? effort : effort.reasoningEffort).filter(Boolean)
          : null,
      });
    }
    cursor = result?.nextCursor;
  } while (cursor);
  return models;
}
