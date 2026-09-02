// Exercises the auth surface: Origin validation and per-session token, both
// on the ws upgrade path. Does not create a real session (that would spawn the CLI) -
// see tests/integration.manual.mjs for the spawn-a-real-session path.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import http from 'node:http';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import * as registry from '../src/session-registry.js';
import { setSessionDefaults } from '../src/session-defaults.js';
import { settingsPath } from '../src/settings-file.js';
import { readAllowRules, addAllowRule } from '../src/permission-rules.js';

process.env.COCKPIT_OPERATOR_TOKEN = process.env.COCKPIT_OPERATOR_TOKEN || 'test-operator-token-16plus';
process.env.PORT = process.env.PORT || '4319';
const { server, PORT, HOST, seedSessionDefaults } = await import('../src/server.js');
const { getOperatorToken } = await import('../src/operator-auth.js');
const ORIGIN = `http://${HOST}:${PORT}`;

const origFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => {
  const href = String(url);
  if (href.includes('/api/')) {
    const headers = new Headers(opts.headers || {});
    if (!headers.has('x-cockpit-operator')) headers.set('x-cockpit-operator', getOperatorToken());
    opts = { ...opts, headers };
  }
  return origFetch(url, opts);
};

function wsUrl(pathAndQuery) {
  const u = new URL(pathAndQuery, ORIGIN);
  if (!u.searchParams.has('op')) u.searchParams.set('op', getOperatorToken());
  return `ws://${HOST}:${PORT}${u.pathname}?${u.searchParams.toString()}`;
}

before(() => new Promise((resolve) => server.listen(PORT, HOST, resolve)));
after(() => new Promise((resolve) => server.close(resolve)));

// The thinking/auto-continue/reload-plugins/plugin-enabled routes each
// persist to <cwd>/.claude/settings.local.json (session-defaults.js/
// plugin-settings.js) as a side effect of a successful call - unlike every
// other route test in this file, those can't share the plain '/tmp' cwd the
// rest of this file uses, or they'd write real files into a shared temp dir
// across test runs (same tradeoff plugin-settings.test.mjs already solved
// for its own tests). Each test that touches one of those routes gets its
// own throwaway directory instead.
async function makeTmpCwd() {
  return mkdtemp(path.join(tmpdir(), 'cockpit-server-route-'));
}

// Minimal stub, same shape as session-registry.test.mjs's own fakeStartSession
// - doesn't spawn a real CLI process, just enough surface for the session
// routes under test to have something to call. `query` covers the model/
// thinking/mcp/plugin routes added after this stub was first written
// (backlog: those routes had zero test coverage) - each method just records
// its last call so a test can assert the route actually reached it, same as
// how setMode/resolveApproval above are asserted on indirectly via status.
function fakeStartSession() {
  return {
    pushInput: () => {},
    close: () => {},
    interrupt: async () => { lastInterruptCalled = true; },
    // interruptTurn() (session-registry.js) reads this before calling
    // interrupt(), to fail the delegation tag of anything Stop drops from
    // the local queue - real sessions always have it (session.js's return
    // shape), this stub just needs it to exist.
    listQueue: () => [],
    setMode: async (m) => m,
    getMode: () => 'default',
    // Mirrors session.js's real resolveApproval shape closely enough for
    // route-level tests: `requestId: 'unknown-request-id'` simulates a
    // stale/already-resolved request (the one case a fixed toolName can't
    // represent), everything else "succeeds" against a fake 'Bash' tool
    // call so the approval-decision route's alwaysAllow persistence logic
    // (server.js) has something real to react to.
    resolveApproval: (requestId, decision) => {
      if (requestId === 'unknown-request-id') return false;
      const scope = decision?.alwaysAllow === true ? 'session' : (decision?.alwaysAllow || null);
      return { resolved: true, toolName: 'Bash', scope };
    },
    query: {
      setModel: async () => {},
      setEffort: async () => {},
      supportedModels: async () => [],
      supportedCommands: async () => [{ name: 'help', description: 'help' }],
      supportedAgents: async () => [],
      setMaxThinkingTokens: async () => {},
      mcpServerStatus: async () => [{ name: 'example', status: 'connected' }],
      toggleMcpServer: async () => {},
      reconnectMcpServer: async () => {},
      reloadPlugins: async () => ({ plugins: [{ name: 'formatter', source: 'anthropic-tools' }] }),
      setPluginEnabled: async (pluginKey, enabled) => {
        lastPluginEnabled = { pluginKey, enabled };
      },
    },
  };
}

let lastPluginEnabled = null;
let lastInterruptCalled = false;

test('GET / serves the launcher page', async () => {
  const res = await fetch(`${ORIGIN}/`);
  assert.equal(res.status, 200);
  const body = await res.text();
  assert.match(body, /Prompt Cockpit/);
});

test('GET /stream-join.js and /permissions.js serve the shared src modules', async () => {
  const join = await fetch(`${ORIGIN}/stream-join.js`);
  assert.equal(join.status, 200);
  assert.match(join.headers.get('content-type'), /javascript/);
  assert.match(await join.text(), /export function joinStreamText/);

  const perm = await fetch(`${ORIGIN}/permissions.js`);
  assert.equal(perm.status, 200);
  assert.match(perm.headers.get('content-type'), /javascript/);
  assert.match(await perm.text(), /export const PERMISSION_MODES/);
});

test('GET /api/resumable requires the operator token, then returns an array', async () => {
  const noOp = await fetch(`${ORIGIN}/api/resumable`, { headers: { 'x-cockpit-operator': '' } });
  assert.equal(noOp.status, 401);
  const wrong = await fetch(`${ORIGIN}/api/resumable`, { headers: { 'x-cockpit-operator': 'nope' } });
  assert.equal(wrong.status, 401);
  const res = await fetch(`${ORIGIN}/api/resumable`);
  assert.equal(res.status, 200);
  assert.ok(Array.isArray(await res.json()));
});

test('GET /api/history/:sessionId/markdown on an unknown session id returns an empty-transcript markdown, not an error (same graceful-empty behavior as the underlying SDK read)', async () => {
  const sessionId = 'definitely-not-a-real-session-id';
  const res = await fetch(`${ORIGIN}/api/history/${sessionId}/markdown?cwd=/tmp`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/markdown/);
  assert.match(res.headers.get('content-disposition'), new RegExp(`attachment; filename="session-${sessionId}\\.md"`));
  const body = await res.text();
  assert.match(body, new RegExp(`^# Session transcript - ${sessionId}`));
});

// 2026-08-24 review fix: a malformed percent-escape in a :param URL segment
// (decodeURIComponent throws URIError) used to propagate uncaught out of
// router.js's route match, landing in server.js's generic catch-all as a
// bare 500 - a client typo should be a 400, not "the server broke".
test('a malformed percent-escape in a route param returns 400, not a generic 500', async () => {
  const res = await fetch(`${ORIGIN}/api/history/%/markdown`);
  assert.equal(res.status, 400);
});

// 2026-09-02 review: /api/history/:id used to trust each provider's own
// fetchHistory to validate `id` before touching disk - true for Claude/Grok
// (session-history.js/grok-history.js both call isSafeSessionId), but
// Codex's fetchCodexSessionHistory never did. The route now validates once,
// for every provider, before ever calling fetchHistory.
test('GET /api/history/:id rejects a path-traversal id before it reaches any provider', async () => {
  const jsonRes = await fetch(`${ORIGIN}/api/history/..%2F..%2F..%2Fetc?cwd=/tmp`);
  assert.equal(jsonRes.status, 400);
  assert.match((await jsonRes.json()).error, /invalid session id/);

  const mdRes = await fetch(`${ORIGIN}/api/history/..%2F..%2F..%2Fetc/markdown?cwd=/tmp`);
  assert.equal(mdRes.status, 400);
  assert.match((await mdRes.json()).error, /invalid session id/);
});

// A `"` in an id can't come from a real Claude/Grok/Codex session id, but
// isSafeSessionId (a plain path.basename check) does not itself reject one -
// belt-and-suspenders stripped separately so it can never break out of the
// quoted filename attribute in Content-Disposition.
test('GET /api/history/:id/markdown strips a stray quote from the Content-Disposition filename', async () => {
  const sessionId = 'weird"session';
  const res = await fetch(`${ORIGIN}/api/history/${encodeURIComponent(sessionId)}/markdown?cwd=/tmp`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-disposition'), 'attachment; filename="session-weirdsession.md"');
});

test('POST /api/sessions rejects a cwd that is not a directory', async () => {
  const res = await fetch(`${ORIGIN}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/definitely/not/a/real/directory' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/sessions rejects a model or grok effort that is not a safe token', async () => {
  const cwd = process.cwd();
  const badModel = await fetch(`${ORIGIN}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, provider: 'grok', model: 'grok-4.5 & calc' }),
  });
  assert.equal(badModel.status, 400);
  assert.match((await badModel.json()).error, /invalid model/);

  const badEffort = await fetch(`${ORIGIN}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, provider: 'grok', effort: 'low&whoami' }),
  });
  assert.equal(badEffort.status, 400);
  assert.match((await badEffort.json()).error, /invalid effort/);
});

test('provider routes preserve omitted-Claude behavior and reject explicit unknown providers', async () => {
  const cwd = process.cwd();
  const create = await fetch(`${ORIGIN}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, provider: 'not-a-provider' }),
  });
  assert.equal(create.status, 400);
  assert.match((await create.json()).error, /unknown provider/);

  for (const endpoint of [
    '/api/resumable?provider=not-a-provider',
    '/api/history/test-session?provider=not-a-provider',
    '/api/history/test-session/markdown?provider=not-a-provider',
  ]) {
    const response = await fetch(`${ORIGIN}${endpoint}`);
    assert.equal(response.status, 400, endpoint);
    assert.match((await response.json()).error, /unknown provider/);
  }
});

test('GET /api/providers keeps provider ids and includes descriptor metadata', async () => {
  const response = await fetch(`${ORIGIN}/api/providers`);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.ok(Array.isArray(body.providers));
  assert.ok(Array.isArray(body.providerDetails));
  assert.deepEqual(body.providerDetails.map(({ id }) => id), body.providers);
  for (const detail of body.providerDetails) {
    assert.equal(typeof detail.label, 'string');
    assert.equal(typeof detail.capabilities, 'object');
    assert.ok(Array.isArray(detail.launch.efforts));
  }
});

test('GET /healthz works with no operator token (liveness must not require a credential)', async () => {
  const res = await fetch(`${ORIGIN}/healthz`, { headers: { 'x-cockpit-operator': '' } });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, 'ok');
  assert.equal(typeof body.pid, 'number');
  assert.equal(typeof body.uptime, 'number');
});

test('GET /api/system/memory requires the operator token and reports live session rows', async () => {
  registry._reset();
  const noOp = await fetch(`${ORIGIN}/api/system/memory`, { headers: { 'x-cockpit-operator': '' } });
  assert.equal(noOp.status, 401);

  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const res = await fetch(`${ORIGIN}/api/system/memory`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.sessionCount, 1);
  assert.equal(typeof body.process.rss, 'number');
  const reported = body.sessions.find((s) => s.id === row.id);
  assert.ok(reported, 'the live row must appear in the snapshot');
  assert.equal(reported.tasks, 0);
  assert.equal(reported.eventLogEntries, 0);
});

test('a request with a foreign Host is rejected, even with the right Origin', async () => {
  // `fetch` treats Host as a forbidden header and silently overrides it
  // from the URL - can't use it to test this. A raw http.request can
  // actually send a spoofed Host, which is exactly the DNS-rebinding shape
  // isSpoofedRequest is defending against.
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: HOST, port: PORT, path: '/api/resumable', headers: { host: 'evil.example', origin: ORIGIN } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('a request with a foreign Origin is rejected, even with the right Host', async () => {
  const res = await fetch(`${ORIGIN}/api/resumable`, {
    headers: { origin: 'http://evil.example' },
  });
  assert.equal(res.status, 403);
});

test('a session-scoped route rejects a missing or wrong token, and accepts the right one', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });

  const noToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'plan' }),
  });
  assert.equal(noToken.status, 401);

  const wrongToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-wrong' },
    body: JSON.stringify({ mode: 'plan' }),
  });
  assert.equal(wrongToken.status, 401);

  const rightToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/mode`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
    body: JSON.stringify({ mode: 'plan' }),
  });
  assert.equal(rightToken.status, 200);
});

test('POST /api/sessions/:id/interrupt requires the session token and calls through to the handle', async () => {
  registry._reset();
  lastInterruptCalled = false;
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });

  const noToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/interrupt`, { method: 'POST' });
  assert.equal(noToken.status, 401);
  assert.equal(lastInterruptCalled, false);

  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/interrupt`, {
    method: 'POST',
    headers: { authorization: `Bearer ${row.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(lastInterruptCalled, true);
});

test('GET /api/sessions/:id requires the session token and returns the summary (MVP3 reload-rejoin check)', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });

  const noToken = await fetch(`${ORIGIN}/api/sessions/${row.id}`);
  assert.equal(noToken.status, 401);

  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}`, {
    headers: { authorization: `Bearer ${row.token}` },
  });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.id, row.id);
  assert.equal(body.cwd, '/tmp');
});

test('GET /api/sessions/:id on an unknown id returns 404', async () => {
  registry._reset();
  const res = await fetch(`${ORIGIN}/api/sessions/does-not-exist`, {
    headers: { authorization: 'Bearer whatever' },
  });
  assert.equal(res.status, 404);
});

test('DELETE /api/sessions/:id closes the session and it stops resolving', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });

  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${row.token}` },
  });
  assert.equal(res.status, 200);
  assert.equal(registry.get(row.id), undefined);
});

// The model/thinking/mcp/plugin routes below were added after this file was
// first written and had no coverage at all (backlog item) - each gets one
// happy-path test through handleSessionRoute's real dispatch (auth already
// covered generically above via the 'mode' route) plus the validation edges
// that are actually route-specific logic, not just auth boilerplate.

test('POST /api/sessions/:id/model sets the model and returns it', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/model`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
    body: JSON.stringify({ model: 'claude-opus-4' }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { model: 'claude-opus-4' });
});

test('POST /api/sessions/:id/title returns 409 when the session has no claude session id yet', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession }); // no `resume` -> claudeSessionId stays null
  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
    body: JSON.stringify({ title: 'too early' }),
  });
  assert.equal(res.status, 409);
});

test('POST /api/sessions/:id/title sets the live name and persists it to settings.local.json, once claudeSessionId is known', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, resume: 'transcript-session-1', startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ title: 'My renamed session' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { title: 'My renamed session' });
    assert.equal(registry.get(row.id).name, 'My renamed session');
    const onDisk = JSON.parse(await readFile(settingsPath(cwd), 'utf-8'));
    assert.equal(onDisk.sessionTitles['transcript-session-1'].title, 'My renamed session');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/session-title rejects an invalid cwd, and persists a title for a past session (no live registry row) otherwise', async () => {
  const invalid = await fetch(`${ORIGIN}/api/session-title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd: '/definitely/not/a/real/directory', sessionId: 'abc', title: 'x' }),
  });
  assert.equal(invalid.status, 400);

  const cwd = await makeTmpCwd();
  try {
    const res = await fetch(`${ORIGIN}/api/session-title`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId: 'past-session-1', title: 'a past session title' }),
    });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(await readFile(settingsPath(cwd), 'utf-8'));
    assert.equal(onDisk.sessionTitles['past-session-1'].title, 'a past session title');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('GET/DELETE /api/sessions/:id/permissions reject a missing or wrong token', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });

  const getNoToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/permissions`);
  assert.equal(getNoToken.status, 401);

  const deleteWrongToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/permissions`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-wrong' },
    body: JSON.stringify({ rule: 'Bash' }),
  });
  assert.equal(deleteWrongToken.status, 401);
});

test('GET /api/sessions/:id/permissions returns the persisted allow list, DELETE removes a rule', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${row.token}` };

    await addAllowRule(cwd, 'Bash');
    await addAllowRule(cwd, 'Read');

    const listRes = await fetch(`${ORIGIN}/api/sessions/${row.id}/permissions`, { headers: auth });
    assert.equal(listRes.status, 200);
    assert.deepEqual((await listRes.json()).allow.sort(), ['Bash', 'Read']);

    const deleteRes = await fetch(`${ORIGIN}/api/sessions/${row.id}/permissions`, {
      method: 'DELETE',
      headers: auth,
      body: JSON.stringify({ rule: 'Bash' }),
    });
    assert.equal(deleteRes.status, 200);
    assert.deepEqual((await deleteRes.json()).allow, ['Read']);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/approval-decision rejects an invalid alwaysAllow value', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/approval-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
    body: JSON.stringify({ requestId: 'x', decision: 'allow', alwaysAllow: 'forever' }),
  });
  assert.equal(res.status, 400);
});

test('POST /api/sessions/:id/approval-decision on an unknown requestId returns 404', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/approval-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
    body: JSON.stringify({ requestId: 'unknown-request-id', decision: 'allow' }),
  });
  assert.equal(res.status, 404);
  assert.deepEqual(await res.json(), { resolved: false });
});

test('POST /api/sessions/:id/approval-decision with alwaysAllow: "project" persists a rule to settings.local.json', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/approval-decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ requestId: 'req-1', decision: 'allow', alwaysAllow: 'project' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { resolved: true });
    assert.deepEqual(await readAllowRules(cwd), ['Bash']); // the fake resolveApproval always reports toolName: 'Bash'
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/approval-decision with alwaysAllow: "project" on a Codex session is rejected, not silently downgraded', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, provider: 'codex', startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/approval-decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ requestId: 'req-1', decision: 'allow', alwaysAllow: 'project' }),
    });
    assert.equal(res.status, 400);
    assert.deepEqual(await readAllowRules(cwd), []); // no rule written for a rejected request
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/approval-decision with alwaysAllow: "session" does not persist anything', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/approval-decision`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ requestId: 'req-1', decision: 'allow', alwaysAllow: 'session' }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await readAllowRules(cwd), []);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/thinking accepts a valid budget/display and rejects invalid ones', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${row.token}` };

    const ok = await fetch(`${ORIGIN}/api/sessions/${row.id}/thinking`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ maxThinkingTokens: 4096, thinkingDisplay: 'summarized' }),
    });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { maxThinkingTokens: 4096, thinkingDisplay: 'summarized' });

    const negativeTokens = await fetch(`${ORIGIN}/api/sessions/${row.id}/thinking`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ maxThinkingTokens: -1 }),
    });
    assert.equal(negativeTokens.status, 400);

    const badDisplay = await fetch(`${ORIGIN}/api/sessions/${row.id}/thinking`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ thinkingDisplay: 'verbose' }),
    });
    assert.equal(badDisplay.status, 400);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/auto-continue toggles the flag', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/auto-continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('GET /api/sessions/:id/commands returns the handle command list', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', provider: 'grok', startSessionImpl: fakeStartSession });
  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/commands`, {
    headers: { authorization: `Bearer ${row.token}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ name: 'help', description: 'help' }]);
});

test('GET /api/sessions/:id/mcp returns the server status list', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/mcp`, {
    headers: { authorization: `Bearer ${row.token}` },
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), [{ name: 'example', status: 'connected' }]);
});

test('POST /api/sessions/:id/mcp-toggle and mcp-reconnect require a name and otherwise succeed', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const auth = { 'content-type': 'application/json', authorization: `Bearer ${row.token}` };

  const missingName = await fetch(`${ORIGIN}/api/sessions/${row.id}/mcp-toggle`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ enabled: true }),
  });
  assert.equal(missingName.status, 400);

  const toggled = await fetch(`${ORIGIN}/api/sessions/${row.id}/mcp-toggle`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'example', enabled: false }),
  });
  assert.equal(toggled.status, 200);
  assert.deepEqual(await toggled.json(), { enabled: false });

  const reconnected = await fetch(`${ORIGIN}/api/sessions/${row.id}/mcp-reconnect`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ name: 'example' }),
  });
  assert.equal(reconnected.status, 200);
  assert.deepEqual(await reconnected.json(), { reconnected: true });
});

test('POST /api/sessions/:id/reload-plugins merges the on-disk enabledPlugins map into the SDK plugin list', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/reload-plugins`, {
      method: 'POST',
      headers: { authorization: `Bearer ${row.token}` },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    // No settings.local.json for this fresh tmp cwd, so readEnabledPlugins()
    // falls back to {} and every plugin with a `source` defaults to
    // enabled: true - see plugin-settings.js's readEnabledPlugins/server.js's
    // merge comment.
    assert.deepEqual(body.plugins, [{ name: 'formatter', source: 'anthropic-tools', enabled: true }]);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/plugin-enabled on a grok session uses grok plugin, not settings.local.json', async () => {
  registry._reset();
  lastPluginEnabled = null;
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, provider: 'grok', startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/plugin-enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ pluginKey: 'playwright@user', enabled: false }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(lastPluginEnabled, { pluginKey: 'playwright@user', enabled: false });
    const settingsFile = settingsPath(cwd);
    await assert.rejects(readFile(settingsFile), /ENOENT/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/plugin-enabled on a codex session is rejected instead of writing settings.local.json', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, provider: 'codex', startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/plugin-enabled`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ pluginKey: 'formatter@anthropic-tools', enabled: true }),
    });
    assert.equal(res.status, 400);
    const settingsFile = settingsPath(cwd);
    await assert.rejects(readFile(settingsFile), /ENOENT/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/plugin-enabled requires pluginKey and persists the toggle', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${row.token}` };

    const missingKey = await fetch(`${ORIGIN}/api/sessions/${row.id}/plugin-enabled`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(missingKey.status, 400);

    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/plugin-enabled`, {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({ pluginKey: 'formatter@anthropic-tools', enabled: true }),
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { enabled: true });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('ws upgrade from a foreign Origin is rejected', async () => {
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?id=x&token=y`, {
    headers: { Origin: 'http://evil.example' },
  });
  await assertRejectedUpgrade(ws);
});

test('ws upgrade with the right Origin but no session token is rejected', async () => {
  const ws = new WebSocket(wsUrl('/ws?id=x'), {
    headers: { Origin: ORIGIN },
  });
  await assertRejectedUpgrade(ws);
});

test('ws upgrade with the right Origin but a wrong session token is rejected', async () => {
  const ws = new WebSocket(wsUrl('/ws?id=x&token=definitely-wrong'), {
    headers: { Origin: ORIGIN },
  });
  await assertRejectedUpgrade(ws);
});

test('ws upgrade with a valid session token but no operator token is rejected', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });
  const ws = new WebSocket(`ws://${HOST}:${PORT}/ws?id=${row.id}&token=${row.token}`, {
    headers: { Origin: ORIGIN },
  });
  await assertRejectedUpgrade(ws);
});

// seedSessionDefaults regression coverage (backlog: previously untested
// despite two commits dedicated to this exact logic - see session-registry
// test suite's own note on the same gap). Also covers the fix for the
// cross-session cwd-carry-forward bug: a fork used to always re-read the
// cwd-level persisted store, so if another session sharing the same cwd had
// written to it more recently, the fork silently inherited *that* session's
// values instead of its own origin session's.

test('seedSessionDefaults applies explicit defaults when passed, ignoring what is on disk for the cwd', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    // Simulate "session B" (a different session sharing this cwd) having
    // most recently written its own settings to the shared cwd-level store.
    await setSessionDefaults(cwd, { maxThinkingTokens: 9999, thinkingDisplay: 'omitted', autoContinue: true });

    // "session A" - the one actually being forked - has different live
    // values, passed explicitly rather than read back from the cwd store.
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    await seedSessionDefaults(row, { maxThinkingTokens: 111, thinkingDisplay: null, autoContinue: false });

    const seeded = registry.get(row.id);
    assert.equal(seeded.maxThinkingTokens, 111);
    assert.equal(seeded.autoContinue, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('seedSessionDefaults falls back to the cwd-level persisted store when no explicit defaults are passed', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    await setSessionDefaults(cwd, { maxThinkingTokens: 555, thinkingDisplay: 'summarized', autoContinue: true });

    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    await seedSessionDefaults(row);

    const seeded = registry.get(row.id);
    assert.equal(seeded.maxThinkingTokens, 555);
    assert.equal(seeded.autoContinue, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// Regression test for the unawaited-write race (backlog H item): the
// thinking/auto-continue routes used to fire setSessionDefaults(...) without
// awaiting it before responding 200, so a client that read the settings
// file immediately after the response could still see the pre-write
// content. Now awaited, so the write is guaranteed done by response time.

test('POST /api/sessions/:id/thinking has already persisted to disk by the time it responds (no post-response write race)', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/thinking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ maxThinkingTokens: 2048, thinkingDisplay: 'summarized' }),
    });
    assert.equal(res.status, 200);
    // No delay, no retry loop - reading immediately is the whole point.
    const onDisk = JSON.parse(await readFile(settingsPath(cwd), 'utf-8'));
    assert.equal(onDisk.sessionDefaults.maxThinkingTokens, 2048);
    assert.equal(onDisk.sessionDefaults.thinkingDisplay, 'summarized');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('POST /api/sessions/:id/auto-continue has already persisted to disk by the time it responds', async () => {
  registry._reset();
  const cwd = await makeTmpCwd();
  try {
    const row = registry.createSession({ cwd, startSessionImpl: fakeStartSession });
    const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/auto-continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
      body: JSON.stringify({ enabled: true }),
    });
    assert.equal(res.status, 200);
    const onDisk = JSON.parse(await readFile(settingsPath(cwd), 'utf-8'));
    assert.equal(onDisk.sessionDefaults.autoContinue, true);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

// The generic 'a session-scoped route rejects a missing or wrong token'
// test above only exercises /mode - it proves the shared checkToken() gate
// in handleSessionRoute works, but every route added since (model/thinking/
// mcp-toggle/mcp-reconnect/reload-plugins/plugin-enabled) was only ever
// exercised with a valid token, with no 401 coverage on these specifically.
// Parametrized here rather than six near-identical tests,
// since the thing being proven - "this route is behind the same gate" - is
// identical for all six; a bad token never reaches the route's own body
// parsing or registry call either way.
const NEWER_ROUTES = [
  { action: 'model', body: { model: 'claude-opus-4' } },
  { action: 'thinking', body: { maxThinkingTokens: 1024 } },
  { action: 'mcp-toggle', body: { name: 'example', enabled: false } },
  { action: 'mcp-reconnect', body: { name: 'example' } },
  { action: 'reload-plugins', body: {} },
  { action: 'plugin-enabled', body: { pluginKey: 'formatter@anthropic-tools', enabled: true } },
  { action: 'title', body: { title: 'My renamed session' } },
  { action: 'approval-decision', body: { requestId: 'x', decision: 'allow' } },
  { action: 'handshake', body: { value: 'some-value' } },
];

for (const { action, body } of NEWER_ROUTES) {
  test(`POST /api/sessions/:id/${action} rejects a missing or wrong token`, async () => {
    registry._reset();
    const row = registry.createSession({ cwd: '/tmp', startSessionImpl: fakeStartSession });

    const noToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    assert.equal(noToken.status, 401);

    const wrongToken = await fetch(`${ORIGIN}/api/sessions/${row.id}/${action}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer definitely-wrong' },
      body: JSON.stringify(body),
    });
    assert.equal(wrongToken.status, 401);
  });
}

// Cross-session delegation - names must be unique within
// a cwd so `/ask <Name>: ...` addressing is unambiguous. Only the 409 path
// is exercised over real HTTP: it's caught before registry.createSession
// ever runs, so no real CLI process gets spawned. The success path (a
// distinct name creating fine) isn't re-tested here - it would spawn a real
// session via the default startSessionImpl, same reason every other test in
// this file avoids a bare POST /api/sessions without a validation failure.
test('POST /api/sessions rejects a name already used by another live session in the same cwd', async () => {
  registry._reset();
  const cwd = process.cwd();
  registry.createSession({ cwd, name: 'Grok', startSessionImpl: fakeStartSession });

  const res = await fetch(`${ORIGIN}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ cwd, name: 'grok' }), // case-insensitive collision
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already exists/);
});

test('POST /api/sessions/:id/title rejects renaming to a name already used by another live session in the same cwd', async () => {
  registry._reset();
  const cwd = '/tmp';
  registry.createSession({ cwd, name: 'Grok', startSessionImpl: fakeStartSession });
  const row = registry.createSession({ cwd, resume: 'transcript-session-x', name: 'Claude', startSessionImpl: fakeStartSession });

  const res = await fetch(`${ORIGIN}/api/sessions/${row.id}/title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${row.token}` },
    body: JSON.stringify({ title: 'Grok' }),
  });
  assert.equal(res.status, 409);
  assert.match((await res.json()).error, /already exists/);
  assert.equal(registry.get(row.id).name, 'Claude', 'the rejected rename must not have taken effect');
});

// End-to-end over a real websocket: a bad `/ask` target must produce a
// visible error back on the SAME socket that sent it, not silence and not a
// broadcast every other tab would also see.
test('a delegate ws payload with an unknown target name gets a cockpit:delegate-error back on the same socket', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', name: 'Claude', startSessionImpl: fakeStartSession });

  const ws = new WebSocket(wsUrl(`/ws?id=${row.id}&token=${row.token}`), {
    headers: { Origin: ORIGIN },
  });
  try {
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const errorPromise = new Promise((resolve) => {
      ws.on('message', (raw) => {
        const payload = JSON.parse(raw.toString('utf8'));
        if (payload.type === 'cockpit:delegate-error') resolve(payload);
      });
    });
    ws.send(JSON.stringify({ type: 'delegate', targetName: 'NoSuchName', text: 'hi' }));
    const errorPayload = await errorPromise;
    assert.equal(errorPayload.targetName, 'NoSuchName');
    assert.match(errorPayload.error, /no session named/);
  } finally {
    ws.close();
  }
});

// 2026-09-02 review: the ws transport had no maxPayload set (ws's own
// default is 100 MB) while HTTP's readJsonBody already capped bodies at
// 1 MB - a client could stream an arbitrarily large ws message into memory.
// server.js now sets maxPayload to that same 1 MB limit; `ws` enforces it by
// closing the socket with code 1009 (message too big) before 'message' ever
// fires, rather than buffering the oversized frame.
test('a ws message over the 1MB payload cap closes the socket with code 1009, not silently buffered', async () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp', name: 'Claude', startSessionImpl: fakeStartSession });

  const ws = new WebSocket(wsUrl(`/ws?id=${row.id}&token=${row.token}`), {
    headers: { Origin: ORIGIN },
  });
  try {
    await new Promise((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('error', reject);
    });
    const closePromise = new Promise((resolve) => ws.on('close', (code) => resolve(code)));
    const oversized = 'x'.repeat(2 * 1024 * 1024); // 2MB, well over the 1MB cap
    ws.send(JSON.stringify({ type: 'input', text: oversized }));
    const code = await closePromise;
    assert.equal(code, 1009);
  } finally {
    ws.close();
  }
});

// Handshake has no session token (no one session owns it) but does
// require the process operator token - the default fetch wrapper below
// supplies it; the 401 case is covered with an explicit empty header.
test('GET /api/handshake without an operator token is 401', async () => {
  const res = await fetch(`${ORIGIN}/api/handshake`, { headers: { 'x-cockpit-operator': '' } });
  assert.equal(res.status, 401);
});

test('GET /api/handshake returns the current secret, and POST /api/handshake/regenerate rotates it', async () => {
  const before = await fetch(`${ORIGIN}/api/handshake`);
  assert.equal(before.status, 200);
  const { secret: secretBefore } = await before.json();
  assert.ok(secretBefore && secretBefore.length >= 16);

  const regen = await fetch(`${ORIGIN}/api/handshake/regenerate`, { method: 'POST' });
  assert.equal(regen.status, 200);
  const { secret: secretAfter } = await regen.json();
  assert.notEqual(secretAfter, secretBefore);

  const after = await fetch(`${ORIGIN}/api/handshake`);
  assert.equal((await after.json()).secret, secretAfter, 'a subsequent GET must see the rotated value');
});

function assertRejectedUpgrade(ws) {
  return new Promise((resolve, reject) => {
    ws.on('open', () => {
      ws.close();
      reject(new Error('expected the upgrade to be rejected, but it succeeded'));
    });
    ws.on('error', () => resolve()); // unexpected-response -> ws surfaces this as an error event
  });
}
