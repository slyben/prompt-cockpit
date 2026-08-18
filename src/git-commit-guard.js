// Project-scoped "no Co-Authored-By trailers" guard - reads/writes the
// `gitCommitGuard` key in a project's `.claude/settings.local.json`
// (settings-file.js), same storage boundary as plugin-settings.js/
// session-defaults.js: this follows the *project* around, not the browser,
// and only takes effect for a session started/resumed after the change
// (session.js reads it once at query() build time, same convention
// plugin-settings.js's own comment documents for enabledPlugins).
//
// Enforcement itself lives in session.js as a PreToolUse hook, not in
// canUseTool - canUseTool is skipped entirely by the SDK in
// acceptEdits/bypassPermissions/dontAsk/auto modes (see permissions.js's
// AUTO_ALLOW_MODES comment), so a check living there would silently stop
// applying the moment someone cycles modes. Hooks run on every tool call
// regardless of permission mode, which is the whole point of using one
// here.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

// 'commit': only deny when the command is a `git commit` invocation whose
//   text also contains a Co-Authored-By trailer (the common case: don't
//   block unrelated commands that merely mention the phrase, e.g. grepping
//   for it or editing a CLAUDE.md that documents the convention).
// 'all': deny any Bash command containing the literal string at all,
//   regardless of context - broader, catches variants 'commit' can't (e.g.
//   `git commit -F file` where the trailer isn't in the command, is still
//   invisible to us either way - this option is about being blunt on the
//   command text itself, not about parsing intent).
// 'off': no check.
export const GIT_GUARD_MODES = ['commit', 'all', 'off'];
const DEFAULT_MODE = 'all';

export async function readGitGuardMode(cwd) {
  const settings = await readSettingsFile(cwd);
  const mode = settings.gitCommitGuard?.mode;
  return GIT_GUARD_MODES.includes(mode) ? mode : DEFAULT_MODE;
}

export async function setGitGuardMode(cwd, mode) {
  if (!GIT_GUARD_MODES.includes(mode)) throw new Error(`invalid gitCommitGuard mode: ${mode}`);
  return updateSettingsFile(cwd, (settings) => {
    settings.gitCommitGuard = { ...(settings.gitCommitGuard || {}), mode };
    return settings.gitCommitGuard;
  });
}

const COMMIT_RE = /\bgit\s+commit\b/i;
const CO_AUTHORED_RE = /co-authored-by/i;

// Pure text check, deliberately not shell-aware: doesn't matter whether the
// command text came from bash quoting, PowerShell here-strings, or cmd.exe
// - as long as the literal trailer text is somewhere in the string Claude
// sent to the Bash tool, this matches regardless of platform/shell.
export function commandTripsGuard(command, mode) {
  if (mode === 'off' || typeof command !== 'string') return false;
  if (!CO_AUTHORED_RE.test(command)) return false;
  if (mode === 'all') return true;
  return COMMIT_RE.test(command); // mode === 'commit'
}
