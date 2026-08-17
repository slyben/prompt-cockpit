// Durable "always allow this tool in this project" rules - the wider-scope
// increment beyond session.js's per-tool-name/in-memory/this-session-only
// version. Stored under `permissions.allow` in the same per-cwd
// `.claude/settings.local.json` file session-defaults.js/plugin-settings.js
// use (settings-file.js), which is *itself* what makes this cwd-scoped -
// no matching code of our own needed, the file already lives one per
// project. Rule strings are deliberately shaped like the SDK's own
// PermissionRuleValue ({toolName, ruleContent}) serialized as "Tool" or
// "Tool(content)" - this repo doesn't build input-pattern (`ruleContent`)
// rules yet, but a future one landing in this same string format is a
// straight read, not a migration.
//
// server.js is the only writer, same boundary as session-defaults.js: it
// calls addAllowRule()/removeAllowRule() as a side effect of a live
// resolveApproval()/settings-panel action, keeping session.js/session-
// registry.js free of filesystem knowledge.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

export function formatRule({ toolName, ruleContent }) {
  return ruleContent ? `${toolName}(${ruleContent})` : toolName;
}

export async function readAllowRules(cwd) {
  const settings = await readSettingsFile(cwd);
  return Array.isArray(settings.permissions?.allow) ? settings.permissions.allow : [];
}

// Dedupes on exact string match; preserves permissions.deny/ask and every
// other key already in the file (settings.permissions is shallow-merged,
// not replaced).
export async function addAllowRule(cwd, rule) {
  return updateSettingsFile(cwd, (settings) => {
    const permissions = { ...(settings.permissions || {}) };
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    permissions.allow = allow.includes(rule) ? allow : [...allow, rule];
    settings.permissions = permissions;
    return permissions.allow;
  });
}

// Removing a rule that isn't there is a no-op, not an error - the caller
// (server.js's DELETE route) doesn't need to distinguish "already gone"
// from "just removed".
export async function removeAllowRule(cwd, rule) {
  return updateSettingsFile(cwd, (settings) => {
    const permissions = { ...(settings.permissions || {}) };
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    permissions.allow = allow.filter((r) => r !== rule);
    settings.permissions = permissions;
    return permissions.allow;
  });
}
