// Project-scoped commit-message guard - reads/writes the `gitCommitGuard`
// key in `.claude/settings.local.json`. Enforcement is a
// PreToolUse hook, not canUseTool, since canUseTool is skipped in some
// permission modes and would silently stop applying there.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readSettingsFile, updateSettingsFile } from './settings-file.js';

// 'commit': only deny a `git commit`/`gh pr create`/`gh pr edit` invocation
//   whose text also contains a guarded phrase - avoids blocking unrelated
//   commands that merely mention the phrase (grepping, editing a doc).
// 'all': deny any Bash command containing a guarded phrase (catches
//   variants 'commit' can't, e.g. `-F file` forms). 'off': no check.
export const GIT_GUARD_MODES = ['commit', 'all', 'off'];
const DEFAULT_MODE = 'all';

export async function readGitGuardSettings(cwd) {
  const settings = await readSettingsFile(cwd);
  const guard = settings.gitCommitGuard || {};
  return {
    mode: GIT_GUARD_MODES.includes(guard.mode) ? guard.mode : DEFAULT_MODE,
    validateCommitMessage: guard.validateCommitMessage === true,
  };
}

export async function readGitGuardMode(cwd) {
  return (await readGitGuardSettings(cwd)).mode;
}

export async function setGitGuardMode(cwd, mode) {
  if (!GIT_GUARD_MODES.includes(mode)) throw new Error(`invalid gitCommitGuard mode: ${mode}`);
  return updateSettingsFile(cwd, (settings) => {
    settings.gitCommitGuard = { ...(settings.gitCommitGuard || {}), mode };
    return settings.gitCommitGuard;
  });
}

export async function setGitGuardSettings(cwd, { mode, validateCommitMessage }) {
  if (!GIT_GUARD_MODES.includes(mode)) throw new Error(`invalid gitCommitGuard mode: ${mode}`);
  if (typeof validateCommitMessage !== 'boolean') throw new Error('validateCommitMessage must be a boolean');
  return updateSettingsFile(cwd, (settings) => {
    settings.gitCommitGuard = {
      ...(settings.gitCommitGuard || {}),
      mode,
      validateCommitMessage,
    };
    return settings.gitCommitGuard;
  });
}

// 'commit' mode's command-shape check: a `git commit` (message trailer) or
// a `gh pr create`/`gh pr edit` (PR body line) - the two places these
// attribution phrases actually end up in this project's workflow.
const COMMIT_SHAPE_RE = /\bgit(?:\.exe)?(?:\s+(?:-[^\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\S+))?)*\s+commit\b|\bgh\s+pr\s+(create|edit)\b/i;
const CO_AUTHORED_RE = /co-authored-by/i;
const GENERATED_WITH_RE = /generated\s+with\s+claude\s+code/i;

// This is intentionally a command-text check, not a shell parser. The Bash
// hook receives the command string, so matching common git global options and
// git.exe keeps ordinary direct, -C, and PowerShell invocations covered.
const GIT_COMMIT_RE = /\bgit(?:\.exe)?(?:\s+(?:-[^\s]+)(?:\s+(?:"[^"]*"|'[^']*'|\S+))?)*\s+commit\b/i;
const GIT_COMMIT_GLOBAL_RE = new RegExp(GIT_COMMIT_RE.source, 'gi');

export function commandHasGitCommit(command) {
  return typeof command === 'string' && GIT_COMMIT_RE.test(command);
}

function shellWords(text) {
  const words = [];
  let word = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === 'single') {
      if (ch === "'") quote = null;
      else word += ch;
      continue;
    }
    if (quote === 'double') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < text.length) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch === "'" ? 'single' : 'double';
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[++i];
    } else if (/\s/.test(ch)) {
      if (word) {
        words.push(word);
        word = '';
      }
    } else if (ch === '&' || ch === '|' || ch === ';') {
      if (word) {
        words.push(word);
        word = '';
      }
      if ((ch === '&' || ch === '|') && text[i + 1] === ch) i += 1;
      words.push(ch);
    } else {
      word += ch;
    }
  }
  if (quote) return null;
  if (word) words.push(word);
  return words;
}

function commitArgs(command) {
  const match = GIT_COMMIT_RE.exec(command);
  if (!match) return null;
  const commitOffset = match[0].toLowerCase().lastIndexOf('commit');
  const words = shellWords(command.slice(match.index + commitOffset + 'commit'.length));
  if (!words) return { error: 'the commit command has unbalanced shell quoting' };

  const messages = [];
  let messageFile = null;
  for (let i = 0; i < words.length; i += 1) {
    const token = words[i];
    if (token === '&' || token === '|' || token === ';') break;
    if (token === '--no-verify') return { error: '--no-verify is not allowed by the commit-message guard' };
    if (token === '-e' || token === '--edit' || token === '-c' || token === '-C'
      || token === '--reuse-message' || token === '--reedit-message'
      || token === '--fixup' || token === '--squash') {
      return { error: 'the final commit message is supplied by an editor or another commit' };
    }
    if (token === '-m' || token === '--message') {
      if (i + 1 >= words.length) return { error: `${token} needs a message` };
      messages.push(words[++i]);
    } else if (token.startsWith('--message=')) {
      messages.push(token.slice('--message='.length));
    } else if (token.startsWith('-m') && token.length > 2) {
      messages.push(token.slice(2));
    } else if (!token.startsWith('--') && token.includes('m')) {
      // Git accepts short-option clusters such as `-am message`.
      const messageFlag = token.indexOf('m');
      const inlineMessage = token.slice(messageFlag + 1);
      if (inlineMessage) messages.push(inlineMessage);
      else if (i + 1 >= words.length) return { error: `${token} needs a message` };
      else messages.push(words[++i]);
    } else if (token === '-F' || token === '--file') {
      if (i + 1 >= words.length) return { error: `${token} needs a file` };
      messageFile = words[++i];
    } else if (token.startsWith('--file=')) {
      messageFile = token.slice('--file='.length);
    } else if (token.startsWith('-F') && token.length > 2) {
      messageFile = token.slice(2);
    } else if (token === '--') {
      break;
    }
  }
  if (messages.length && messageFile) return { error: 'use either -m/--message or -F/--file, not both' };
  if (messages.length) return { message: messages.join('\n\n') };
  if (messageFile) return { messageFile };
  return { error: 'the final commit message is not visible to Cockpit; use -m/--message or -F/--file' };
}

export function validateScopedCommitMessage(message) {
  if (typeof message !== 'string' || !message.trim()) return { valid: false, reason: 'the commit message is empty' };
  const normalized = message.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
  if (normalized.includes('—')) return { valid: false, reason: 'em dashes are not allowed' };
  if (CO_AUTHORED_RE.test(normalized) || GENERATED_WITH_RE.test(normalized)) {
    return { valid: false, reason: 'AI attribution text is not allowed' };
  }
  const lines = normalized.split('\n');
  const title = lines[0];
  if (title.length > 80) return { valid: false, reason: 'the title exceeds 80 characters' };
  if (!/^[^\s:]+:\s+\S.*$/.test(title)) {
    return { valid: false, reason: 'the title must use "scope: description" format' };
  }
  if (lines.length === 1) return { valid: true };
  if (lines[1] !== '') return { valid: false, reason: 'the body must start after one blank line' };
  const bullets = lines.slice(2);
  if (bullets.length > 4) return { valid: false, reason: 'the body may contain at most four bullets' };
  for (const bullet of bullets) {
    if (!/^[-]\s+\S.*$/.test(bullet)) return { valid: false, reason: 'body lines must be one-line bullets starting with "- "' };
    if (bullet.length > 80) return { valid: false, reason: 'a body bullet exceeds 80 characters' };
  }
  return { valid: true };
}

export async function validateCommitCommand(command, cwd) {
  if (!commandHasGitCommit(command)) return { checked: false, valid: true };
  const matches = [...command.matchAll(GIT_COMMIT_GLOBAL_RE)];
  if (matches.length > 1) return { checked: true, valid: false, reason: 'multiple git commit commands must be run separately' };
  const args = commitArgs(command);
  if (args.error) return { checked: true, valid: false, reason: args.error };
  let message = args.message;
  if (args.messageFile) {
    if (args.messageFile === '-') return { checked: true, valid: false, reason: 'stdin commit messages cannot be inspected' };
    try {
      message = await readFile(path.resolve(cwd || process.cwd(), args.messageFile), 'utf8');
    } catch {
      return { checked: true, valid: false, reason: `cannot read commit message file ${args.messageFile}` };
    }
  }
  const result = validateScopedCommitMessage(message);
  return { checked: true, ...result };
}

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
