// Cockpit-wide commit guard. The setting lives under ~/.prompt-cockpit so
// every provider and project reads the same policy. The legacy per-project
// Claude setting is imported once when no server setting exists.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { readSettingsFile } from './settings-file.js';
import { readServerSettings, updateServerSettings } from './server-settings.js';

// 'commit': only deny a `git commit`/`gh pr create`/`gh pr edit` invocation
//   whose command text also contains a guarded phrase - avoids blocking
//   unrelated commands that merely mention the phrase (grepping, editing a doc).
// 'all': deny any shell command whose text contains a guarded phrase.
// 'off': no attribution or commit-message check.
export const GIT_GUARD_MODES = ['commit', 'all', 'off'];
const DEFAULT_MODE = 'all';

function normalizeGitGuardSettings(guard = {}) {
  return {
    mode: GIT_GUARD_MODES.includes(guard.mode) ? guard.mode : DEFAULT_MODE,
    validateCommitMessage: guard.validateCommitMessage === true,
  };
}

export async function readGitGuardSettingsState(cwd) {
  const settings = await readServerSettings();
  if (settings.gitCommitGuard) {
    return { ...normalizeGitGuardSettings(settings.gitCommitGuard), configured: true };
  }

  if (cwd) {
    const legacySettings = await readSettingsFile(cwd);
    if (legacySettings.gitCommitGuard) {
      const migrated = normalizeGitGuardSettings(legacySettings.gitCommitGuard);
      const saved = await updateServerSettings((current) => {
        current.gitCommitGuard ||= migrated;
        return current.gitCommitGuard;
      });
      return { ...normalizeGitGuardSettings(saved), configured: true };
    }
  }
  return { ...normalizeGitGuardSettings(), configured: false };
}

export async function readGitGuardSettings(cwd) {
  const { mode, validateCommitMessage } = await readGitGuardSettingsState(cwd);
  return { mode, validateCommitMessage };
}

export async function readGitGuardMode(cwd) {
  return (await readGitGuardSettings(cwd)).mode;
}

export async function setGitGuardMode(cwd, mode) {
  if (!GIT_GUARD_MODES.includes(mode)) throw new Error(`invalid gitCommitGuard mode: ${mode}`);
  return updateServerSettings((settings) => {
    settings.gitCommitGuard = { ...(settings.gitCommitGuard || {}), mode };
    return settings.gitCommitGuard;
  });
}

export async function setGitGuardSettings(cwd, { mode, validateCommitMessage }) {
  if (!GIT_GUARD_MODES.includes(mode)) throw new Error(`invalid gitCommitGuard mode: ${mode}`);
  if (typeof validateCommitMessage !== 'boolean') throw new Error('validateCommitMessage must be a boolean');
  return updateServerSettings((settings) => {
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
const CO_AUTHORED_RE = /\bco-authored[-\s]+by\b/i;
// Keep Claude Code's existing footer verbatim and recognize common attribution
// wording for current providers plus provider-level labels that survive a
// product-name change (e.g. Anthropic instead of Claude Code).
const GENERATED_WITH_CLAUDE_CODE_RE = /generated\s+with\s+claude\s+code/i;
const AI_PROVIDER_ATTRIBUTION_RE = /\b(?:generated|created|written|authored)\s+(?:with|by)\s+(?:(?:the\s+)?(?:claude|anthropic|codex|openai|grok|xai|gemini|google|copilot|microsoft|mistral|deepseek|llama|meta)(?:\s+(?:claude|code|cli|assistant|ai))?|(?:an?\s+)?(?:ai|assistant|language\s+model))\b/i;

function hasAiAttribution(text) {
  return CO_AUTHORED_RE.test(text)
    || GENERATED_WITH_CLAUDE_CODE_RE.test(text)
    || AI_PROVIDER_ATTRIBUTION_RE.test(text);
}

// This is intentionally a command-text check, not a shell parser. Matching
// common git global options and git.exe keeps ordinary direct, -C, and
// PowerShell invocations covered.
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
      else if (ch === '\\' && i + 1 < text.length && /["\\$`]/.test(text[i + 1])) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch === "'" ? 'single' : 'double';
    } else if (ch === '\\' && i + 1 < text.length) {
      word += text[++i];
    } else if (ch === '\n' || ch === '\r') {
      if (word) {
        words.push(word);
        word = '';
      }
      if (words[words.length - 1] !== ';') words.push(';');
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
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

export function commandHasGitPush(command, depth = 0) {
  if (typeof command !== 'string' || depth > 3) return false;
  const words = shellWords(command);
  if (!words) return false;
  const boundaries = new Set(['&', '|', ';']);
  const valueOptions = new Set(['-c', '-C', '--config-env', '--exec-path', '--git-dir', '--namespace', '--work-tree']);
  let atCommandStart = true;

  for (let i = 0; i < words.length; i += 1) {
    const word = words[i];
    if (boundaries.has(word)) {
      atCommandStart = true;
      continue;
    }
    if (!atCommandStart) continue;

    let executableIndex = i;
    while (executableIndex < words.length) {
      const prefix = String(words[executableIndex]).toLowerCase();
      if (/^(?:command|exec|nohup)$/.test(prefix)) {
        executableIndex += 1;
        continue;
      }
      if (prefix === 'sudo') {
        executableIndex += 1;
        while (executableIndex < words.length && words[executableIndex].startsWith('-')) {
          const option = words[executableIndex++].toLowerCase();
          if (['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-c', '--close-from', '-r', '--role', '-t', '--type', '-d', '--chdir'].includes(option)) executableIndex += 1;
          else if (option === '--') break;
        }
        continue;
      }
      if (prefix === 'env') {
        executableIndex += 1;
        while (executableIndex < words.length) {
          const option = String(words[executableIndex]).toLowerCase();
          if (/^[a-z_][a-z0-9_]*=/.test(option)) executableIndex += 1;
          else if (['-u', '--unset', '-c', '--chdir'].includes(option)) executableIndex += 2;
          else if (option.startsWith('-')) executableIndex += 1;
          else break;
        }
        continue;
      }
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[executableIndex])) {
        executableIndex += 1;
        continue;
      }
      break;
    }

    const executable = String(words[executableIndex] || '').split(/[\\/]/).pop().toLowerCase();
    if (['bash', 'cmd', 'dash', 'fish', 'powershell', 'pwsh', 'sh', 'zsh'].includes(executable)) {
      const commandFlags = new Set(['-c', '-command', '-commandwithargs', '/c', '/k']);
      for (let j = executableIndex + 1; j < words.length && !boundaries.has(words[j]); j += 1) {
        if (commandFlags.has(String(words[j]).toLowerCase()) && words[j + 1]) {
          let end = j + 1;
          while (end < words.length && !boundaries.has(words[end])) end += 1;
          const shellCommand = ['cmd', 'powershell', 'pwsh'].includes(executable)
            ? words.slice(j + 1, end).join(' ')
            : words[j + 1];
          if (commandHasGitPush(shellCommand, depth + 1)) return true;
          break;
        }
      }
    }
    if (executable !== 'git' && executable !== 'git.exe') {
      atCommandStart = false;
      continue;
    }

    for (let j = executableIndex + 1; j < words.length && !boundaries.has(words[j]); j += 1) {
      const arg = words[j];
      if (valueOptions.has(arg)) {
        j += 1;
        continue;
      }
      if (arg.startsWith('--git-dir=') || arg.startsWith('--work-tree=')
        || arg.startsWith('--namespace=') || arg.startsWith('--exec-path=')
        || arg.startsWith('--config-env=')) continue;
      if (arg.startsWith('-')) continue;
      if (arg.toLowerCase() === 'push') return true;
      break;
    }
    atCommandStart = false;
  }
  return false;
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
  if (hasAiAttribution(normalized)) {
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

export function shellCommandFromToolInput(input, depth = 0) {
  if (typeof input === 'string') return input;
  if (!input || typeof input !== 'object' || depth > 2) return null;
  for (const key of ['command', 'cmd', 'commandLine', 'shellCommand', 'script']) {
    if (typeof input[key] === 'string') return input[key];
  }
  for (const key of ['input', 'arguments', 'parameters', 'rawInput']) {
    const nested = shellCommandFromToolInput(input[key], depth + 1);
    if (nested) return nested;
  }
  return null;
}

export async function evaluateGitGuardCommand(command, cwd) {
  const guard = await readGitGuardSettings(cwd);
  if (commandTripsGuard(command, guard.mode)) {
    return { blocked: true, reason: 'the command contains AI attribution text' };
  }
  if (guard.mode === 'off' || !guard.validateCommitMessage) return { blocked: false };
  const result = await validateCommitCommand(command, cwd);
  return result.checked && !result.valid
    ? { blocked: true, reason: result.reason }
    : { blocked: false };
}

// Pure text check, deliberately not shell-aware: doesn't matter whether the
// command text came from bash quoting, PowerShell here-strings, or cmd.exe -
// as long as the literal phrase is in the command string, this matches.
export function commandTripsGuard(command, mode) {
  if (mode === 'off' || typeof command !== 'string') return false;
  const hasGuardedPhrase = hasAiAttribution(command);
  if (!hasGuardedPhrase) return false;
  if (mode === 'all') return true;
  return COMMIT_SHAPE_RE.test(command); // mode === 'commit'
}
