// Per-cwd session defaults: the thinking budget/display and auto-continue
// preference a session was last set to, for this project. Stored under the
// `sessionDefaults` key in the same `.claude/settings.local.json` file
// plugin-settings.js uses (settings-file.js), so it survives a cockpit
// process restart and is shared across every browser/tab pointed at this
// cwd - unlike the in-memory registry row (session-registry.js), which
// forgets everything the moment a session closes or the process restarts,
// and unlike localStorage (public/settings.js), which is scoped to one
// browser and never crosses machines or tabs.
//
// server.js is the only writer: it calls setSessionDefaults() right after a
// live registry.setMaxThinkingTokens()/setAutoContinue() call succeeds, and
// reads them back via readSessionDefaults() when seeding a freshly created
// or forked session. That keeps session-registry.js itself free of any
// filesystem knowledge - it stays a pure in-memory mirror of live SDK
// state, which is the boundary this module exists to enforce.
//
// `model` deliberately isn't tracked here: a fork already carries the
// origin session's model forward via its own createSession `model` param
// (see server.js's rewind/fork route), so there was never a gap for it the
// way there was for thinking budget/auto-continue (backlog's B6).
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

const EMPTY_DEFAULTS = { maxThinkingTokens: null, thinkingDisplay: null, autoContinue: false };

export async function readSessionDefaults(cwd) {
  const settings = await readSettingsFile(cwd);
  return { ...EMPTY_DEFAULTS, ...(settings.sessionDefaults || {}) };
}

// `patch` is shallow-merged over whatever's already stored, so a caller
// that only just changed the thinking budget doesn't have to also know (or
// accidentally reset) the current auto-continue value. Goes through
// updateSettingsFile so this queues against a concurrent plugin toggle (or
// another session-defaults write) instead of racing on the shared
// settings file - see settings-file.js.
export async function setSessionDefaults(cwd, patch) {
  return updateSettingsFile(cwd, (settings) => {
    const merged = { ...EMPTY_DEFAULTS, ...(settings.sessionDefaults || {}), ...patch };
    settings.sessionDefaults = merged;
    return merged;
  });
}
