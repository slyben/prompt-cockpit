// Durable "always allow this tool" rules - the wider-scope counterpart
// to session.js's in-memory, per-session version, stored in the same
// per-cwd `.claude/settings.local.json` used by session-defaults.js.
// Rule strings mirror the SDK's PermissionRuleValue format so a future
// input-pattern rule is a straight read. server.js is the only writer.
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
