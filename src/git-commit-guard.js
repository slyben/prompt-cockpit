// Project-scoped "no Co-Authored-By trailers" guard - reads/writes the
// `gitCommitGuard` key in `.claude/settings.local.json`, taking effect
// only for a session started after the change. Enforcement is a
// PreToolUse hook, not canUseTool, since canUseTool is skipped in some
// permission modes and would silently stop applying there.
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

// 'commit': only deny a `git commit`/`gh pr create`/`gh pr edit` invocation
//   whose text also contains a guarded phrase - avoids blocking unrelated
//   commands that merely mention the phrase (grepping, editing a doc).
// 'all': deny any Bash command containing a guarded phrase (catches
//   variants 'commit' can't, e.g. `-F file` forms). 'off': no check.
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

// 'commit' mode's command-shape check: a `git commit` (message trailer) or
// a `gh pr create`/`gh pr edit` (PR body line) - the two places these
// attribution phrases actually end up in this project's workflow.
const COMMIT_SHAPE_RE = /\bgit\s+commit\b|\bgh\s+pr\s+(create|edit)\b/i;
const CO_AUTHORED_RE = /co-authored-by/i;
const GENERATED_WITH_RE = /generated\s+with\s+claude\s+code/i;

// Pure text check, deliberately not shell-aware: doesn't matter whether the
// command text came from bash quoting, PowerShell here-strings, or cmd.exe
// - as long as the literal phrase text is somewhere in the string Claude
// sent to the Bash tool, this matches regardless of platform/shell.
export function commandTripsGuard(command, mode) {
  if (mode === 'off' || typeof command !== 'string') return false;
  const hasGuardedPhrase = CO_AUTHORED_RE.test(command) || GENERATED_WITH_RE.test(command);
  if (!hasGuardedPhrase) return false;
  if (mode === 'all') return true;
  return COMMIT_SHAPE_RE.test(command); // mode === 'commit'
}
