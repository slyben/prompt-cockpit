import path from 'node:path';
import { homedir } from 'node:os';
import { readFileSync, statSync } from 'node:fs';
import { serverSettingsPath } from './server-settings.js';

function resolveConfigDir(value, settingsFile) {
  if (value === '~') return homedir();
  if (/^~[\\/]/.test(value)) return path.resolve(homedir(), value.slice(2));
  return path.resolve(path.dirname(settingsFile), value);
}

// Parsed result cached by file identity: subagent polling resolves a
// subscription every couple of seconds, and the file almost never changes.
let cache = null; // { file, mtimeMs, size, value }

function configuredSubscriptions(settingsFile) {
  let stat;
  try {
    stat = statSync(settingsFile);
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  if (cache && cache.file === settingsFile && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.value;
  const value = parseSubscriptions(settingsFile);
  cache = { file: settingsFile, mtimeMs: stat.mtimeMs, size: stat.size, value };
  return value;
}

function parseSubscriptions(settingsFile) {
  let raw;
  try {
    raw = readFileSync(settingsFile, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
  let settings;
  try { settings = JSON.parse(raw); } catch {
    throw new Error(`${settingsFile} contains invalid JSON`);
  }
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    throw new Error(`${settingsFile} must contain a JSON object`);
  }
  const subscriptions = settings.claudeSubscriptions ?? [];
  if (!Array.isArray(subscriptions)) throw new Error(`${settingsFile}: claudeSubscriptions must be an array`);
  const seen = new Set(['default']);
  return subscriptions.map((account, index) => {
    const field = `${settingsFile}: claudeSubscriptions[${index}]`;
    if (!account || typeof account.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/i.test(account.id)) {
      throw new Error(`${field}.id must contain letters, digits, underscores, or hyphens`);
    }
    if (seen.has(account.id)) throw new Error(`${field}.id is reserved or duplicated: ${account.id}`);
    seen.add(account.id);
    if (typeof account.configDir !== 'string' || !account.configDir.trim()) {
      throw new Error(`${field}.configDir must be a non-empty folder path`);
    }
    if (account.label != null && (typeof account.label !== 'string' || !account.label.trim())) {
      throw new Error(`${field}.label must be a non-empty string`);
    }
    return { id: account.id, label: account.label?.trim() || account.id, configDir: resolveConfigDir(account.configDir.trim(), settingsFile) };
  });
}

// Claude supplies the default directory; additional logins are opt-in in
// Cockpit's existing server settings. Never accept paths from API clients.
function defaultSubscription() {
  return { id: 'default', label: 'Default', configDir: path.resolve(process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')) };
}

export function listClaudeSubscriptions() {
  return [defaultSubscription(), ...configuredSubscriptions(serverSettingsPath())];
}

export function resolveClaudeSubscription(subscription) {
  const id = subscription ?? 'default';
  if (id === 'default') return defaultSubscription(); // never depends on the optional settings file
  const account = listClaudeSubscriptions().find((entry) => entry.id === id);
  if (!account) {
    const error = new Error(`unknown Claude subscription: ${String(id)}`);
    error.code = 'ERR_INVALID_SUBSCRIPTION';
    throw error;
  }
  return account;
}

// A bad settings file must not take the default account down with it.
export function safeListClaudeSubscriptions() {
  try {
    return { subscriptions: listClaudeSubscriptions() };
  } catch (error) {
    console.warn(`claude subscriptions unavailable: ${error.message}`);
    return {
      subscriptions: [defaultSubscription()],
      error: error.message,
    };
  }
}

export function isDefaultClaudeSubscription(subscription) {
  return subscription == null || subscription === 'default';
}

export function claudeSubscriptionEnv(subscription) {
  // The default account is the user's ambient environment, API-key and
  // token auth included - leave it untouched.
  if (isDefaultClaudeSubscription(subscription)) return { ...process.env };
  const env = { ...process.env, CLAUDE_CONFIG_DIR: resolveClaudeSubscription(subscription).configDir };
  // Explicit credentials override the login in CLAUDE_CONFIG_DIR. A
  // non-default selection must use that directory's saved login.
  // Provider-routing overrides likewise would send the session to a cloud
  // provider or gateway instead of the selected subscription.
  for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR', 'CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR',
    'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_BEDROCK_BASE_URL', 'ANTHROPIC_VERTEX_BASE_URL', 'ANTHROPIC_FOUNDRY_BASE_URL']) delete env[key];
  return env;
}
