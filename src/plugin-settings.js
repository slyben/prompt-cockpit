// Reads/writes the `enabledPlugins` map in a project's personal,
// gitignored `.claude/settings.local.json`. No live SDK call toggles a
// plugin at runtime (unlike MCP's toggleMcpServer), so this only takes
// effect the next time a session for this cwd starts/resumes. Only
// touches `enabledPlugins`; every other key round-trips untouched.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

export async function readEnabledPlugins(cwd) {
  const settings = await readSettingsFile(cwd);
  return settings.enabledPlugins || {};
}

// `pluginKey` is the `name@source` form the SDK's enabledPlugins
// setting expects; plugins without a `source` aren't toggleable here.
// Goes through updateSettingsFile so this write queues instead of
// racing a concurrent session-defaults write or another plugin toggle
// on the shared settings file.
export async function setPluginEnabled(cwd, pluginKey, enabled) {
  return updateSettingsFile(cwd, (settings) => {
    settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [pluginKey]: Boolean(enabled) };
    return settings.enabledPlugins;
  });
}
