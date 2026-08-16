// Reads/writes the `enabledPlugins` map in a project's
// `.claude/settings.local.json` (settings-file.js) - the personal,
// gitignored-by-convention override file (per the SDK's own
// settings-precedence note: user < project < local < flag < policy). There
// is no live SDK call to enable/disable a plugin at runtime (unlike MCP
// servers' toggleMcpServer) - this only takes effect the next time a
// session for this cwd starts/resumes.
//
// Only ever touches the `enabledPlugins` key; every other key in the file
// (hooks, permissions, session-defaults.js's `sessionDefaults`, whatever
// else the user has in there) round-trips untouched.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

export async function readEnabledPlugins(cwd) {
  const settings = await readSettingsFile(cwd);
  return settings.enabledPlugins || {};
}

// `pluginKey` is the `name@source` form the SDK's enabledPlugins setting
// expects (see plugin-panel.js - built from a reloadPlugins()/plugin list
// entry that has a `source`; plugins without one aren't toggleable here).
// Goes through updateSettingsFile so a plugin toggle and a concurrent
// session-defaults write (or another plugin toggle) queue instead of
// racing on the shared settings file - see settings-file.js.
export async function setPluginEnabled(cwd, pluginKey, enabled) {
  return updateSettingsFile(cwd, (settings) => {
    settings.enabledPlugins = { ...(settings.enabledPlugins || {}), [pluginKey]: Boolean(enabled) };
    return settings.enabledPlugins;
  });
}
