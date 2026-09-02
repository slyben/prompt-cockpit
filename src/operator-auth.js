// Process-level operator token, distinct from per-session bearer
// tokens and the /ask handshake secret. Required on every /api/*
// route and the websocket upgrade; static HTML/JS/CSS stay Origin/Host
// only. Persisted under ~/.prompt-cockpit/operator-token so a local
// tab survives `npm start`; COCKPIT_OPERATOR_TOKEN/_FILE override it.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const TOKEN_BYTES = 32;

// Not exported - nothing outside this file references it, it's just called
// from resolveOperatorToken() below and at module-load time further down.
function defaultOperatorFilePath(home = homedir()) {
  return path.join(home, '.prompt-cockpit', 'operator-token');
}

export function mintOperatorToken() {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

export function tokensEqual(expected, actual) {
  if (typeof expected !== 'string' || typeof actual !== 'string' || !expected || !actual) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(actual);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function resolveOperatorToken({
  envToken,
  filePath,
  readFileSyncImpl = readFileSync,
  writeFileSyncImpl = writeFileSync,
  mkdirSyncImpl = mkdirSync,
  mintImpl = mintOperatorToken,
} = {}) {
  const fromEnv = typeof envToken === 'string' ? envToken.trim() : '';
  if (fromEnv) return fromEnv;

  const dest = filePath || defaultOperatorFilePath();
  try {
    const existing = readFileSyncImpl(dest, 'utf8').trim();
    if (existing.length >= 16) return existing;
  } catch {
    // missing or unreadable - mint below
  }
  const token = mintImpl();
  try {
    mkdirSyncImpl(path.dirname(dest), { recursive: true });
    writeFileSyncImpl(dest, `${token}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // still usable this process; next start will mint again if the write failed
  }
  return token;
}

const operatorToken = resolveOperatorToken({
  envToken: process.env.COCKPIT_OPERATOR_TOKEN,
  filePath: process.env.COCKPIT_OPERATOR_FILE || defaultOperatorFilePath(),
});

export function getOperatorToken() {
  return operatorToken;
}

// Not exported - only checkOperatorToken (below, in this file) calls it.
function extractOperatorToken(req, url) {
  const header = req.headers['x-cockpit-operator'];
  if (typeof header === 'string' && header.trim()) return header.trim();
  const q = url.searchParams.get('op');
  return typeof q === 'string' && q.trim() ? q.trim() : '';
}

export function checkOperatorToken(req, url) {
  return tokensEqual(operatorToken, extractOperatorToken(req, url));
}
