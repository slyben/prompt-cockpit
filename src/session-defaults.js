// Per-cwd session defaults (thinking budget/display, auto-continue,
// effort) in `.claude/settings.local.json`, surviving a restart and
// shared across every tab on this cwd - unlike the in-memory registry
// row (forgets on close) or localStorage (one browser only). `model`
// isn't tracked: a fork always carries it forward via createSession.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

const EMPTY_DEFAULTS = { maxThinkingTokens: null, thinkingDisplay: null, autoContinue: false, effort: null };

export async function readSessionDefaults(cwd) {
  const settings = await readSettingsFile(cwd);
  return { ...EMPTY_DEFAULTS, ...(settings.sessionDefaults || {}) };
}

// `patch` is shallow-merged over what's already stored, so a caller that
// only changed one field doesn't accidentally reset the others.
// updateSettingsFile serializes this against concurrent writes to the
// shared settings file.
export async function setSessionDefaults(cwd, patch) {
  return updateSettingsFile(cwd, (settings) => {
    const merged = { ...EMPTY_DEFAULTS, ...(settings.sessionDefaults || {}), ...patch };
    settings.sessionDefaults = merged;
    return merged;
  });
}
