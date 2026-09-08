import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  fetchCodexSessionHistory,
  listAllCodexThreads,
  listCodexSessions,
  scanCodexUsageFile,
  scanCodexUsageSessions,
} from '../src/codex-history.js';

test('Codex thread listing maps app-server metadata to resumable sessions', async () => {
  const calls = [];
  const manager = {
    async request(method, params) {
      calls.push([method, params]);
      // Real Thread summaries from thread/list don't carry a model field
      // (developers.openai.com/codex/app-server's Thread schema has none) -
      // fabricating one here would hide listCodexSessions() actually
      // dropping it, which the resumable-list UI needs to tolerate.
      return { data: [{
        id: 'thread-1', cwd: '/repo', name: 'Refactor', preview: 'fallback',
        updatedAt: 1_700_000_000,
      }] };
    },
  };
  const sessions = await listCodexSessions(manager);
  assert.equal(calls[0][0], 'thread/list');
  assert.deepEqual(sessions[0], {
    sessionId: 'thread-1', cwd: '/repo', projectDirName: '/repo',
    label: 'Refactor', title: 'Refactor', mtimeMs: 1_700_000_000_000,
    provider: 'codex', model: null,
  });
});

test('listAllCodexThreads paginates thread/list past the resume-list cap', async () => {
  const calls = [];
  const manager = {
    async request(method, params) {
      calls.push([method, params]);
      if (params.cursor === 'page-two') {
        return { data: [{ id: 'thread-2', updatedAt: 1_700_000_100 }], nextCursor: null };
      }
      return { data: [{ id: 'thread-1', updatedAt: 1_700_000_000 }], nextCursor: 'page-two' };
    },
  };
  const threads = await listAllCodexThreads(manager);
  assert.deepEqual(calls, [
    ['thread/list', { limit: 100, sortKey: 'updated_at' }],
    ['thread/list', { limit: 100, sortKey: 'updated_at', cursor: 'page-two' }],
  ]);
  assert.deepEqual(threads.map((thread) => thread.id), ['thread-1', 'thread-2']);
});

test('scanCodexUsageSessions emits activity rows without inventing token totals', async () => {
  const manager = {
    async request() {
      return { data: [{
        id: 'thread-1', createdAt: 1_700_000_000, updatedAt: 1_700_000_100,
      }] };
    },
  };
  const scans = await scanCodexUsageSessions(manager, { sessionsDir: '/nonexistent/codex-sessions' });
  assert.equal(scans.length, 1);
  assert.equal(scans[0].firstTs, 1_700_000_000_000);
  assert.equal(scans[0].lastTs, 1_700_000_100_000);
  assert.equal(scans[0].rows.length, 1);
  assert.equal(scans[0].rows[0].ts, 1_700_000_100_000);
  assert.equal(scans[0].rows[0].model, null);
  assert.equal(scans[0].rows[0].usage, null);
});

test('scanCodexUsageFile reads current rollout token records and resolves their model', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-rollout-stats-'));
  const filePath = path.join(root, 'rollout-2026-09-08T10-00-00-thread-1.jsonl');
  const firstTs = '2026-09-08T10:00:00.000Z';
  const lastTs = '2026-09-08T10:01:00.000Z';
  await writeFile(filePath, [
    JSON.stringify({
      timestamp: firstTs,
      type: 'session_meta',
      payload: {
        session_id: 'thread-1',
        timestamp: firstTs,
        base_instructions: { provenance: { model: 'gpt-5.3-codex' } },
      },
    }),
    JSON.stringify({
      timestamp: '2026-09-08T10:00:30.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-5.3-codex' },
    }),
    JSON.stringify({
      timestamp: lastTs,
      type: 'token_usage_record',
      payload: {
        turn_id: 'turn-1',
        usage: {
          input_tokens: 1_000,
          cached_input_tokens: 400,
          output_tokens: 100,
          reasoning_output_tokens: 20,
          total_tokens: 1_100,
        },
      },
    }),
    // Current rollouts can also retain an event_msg mirror. It must not be
    // counted a second time when token_usage_record is present.
    JSON.stringify({
      timestamp: lastTs,
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 1_000, cached_input_tokens: 400, output_tokens: 100 } },
      },
    }),
  ].join('\n') + '\n');

  try {
    const scan = await scanCodexUsageFile(filePath);
    assert.equal(scan.sessionId, 'thread-1');
    assert.equal(scan.firstTs, Date.parse(firstTs));
    assert.equal(scan.lastTs, Date.parse(lastTs));
    assert.equal(scan.rows.length, 1);
    assert.equal(scan.rows[0].model, 'gpt-5.3-codex');
    assert.deepEqual(scan.rows[0].usage, {
      input_tokens: 600,
      output_tokens: 100,
      cache_read_input_tokens: 400,
      cache_creation_input_tokens: 0,
      reasoning_output_tokens: 20,
      total_tokens: 1_100,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanCodexUsageFile supports legacy token_count records and per-turn models', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-rollout-legacy-'));
  const filePath = path.join(root, 'legacy.jsonl');
  await writeFile(filePath, [
    JSON.stringify({
      timestamp: '2026-09-07T10:00:00.000Z',
      type: 'turn_context',
      payload: { turn_id: 'turn-1', model: 'gpt-5.5' },
    }),
    JSON.stringify({
      timestamp: '2026-09-07T10:00:01.000Z',
      type: 'event_msg',
      payload: {
        type: 'token_count',
        info: { last_token_usage: { input_tokens: 100, cached_input_tokens: 25, output_tokens: 10 } },
      },
    }),
  ].join('\n') + '\n');

  try {
    const scan = await scanCodexUsageFile(filePath);
    assert.equal(scan.rows.length, 1);
    assert.equal(scan.rows[0].model, 'gpt-5.5');
    assert.equal(scan.rows[0].usage.input_tokens, 75);
    assert.equal(scan.rows[0].usage.cache_read_input_tokens, 25);
    assert.equal(scan.rows[0].usage.output_tokens, 10);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('scanCodexUsageSessions merges rollout usage with thread-list activity without duplication', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'codex-rollout-merge-'));
  const day = path.join(root, '2026', '09', '08');
  await mkdir(day, { recursive: true });
  await writeFile(path.join(day, 'rollout-2026-09-08T10-00-00-thread-1.jsonl'), JSON.stringify({
    timestamp: '2026-09-08T10:00:00.000Z',
    type: 'session_meta',
    payload: { session_id: 'thread-1', base_instructions: { provenance: { model: 'gpt-5.4' } } },
  }) + '\n' + JSON.stringify({
    timestamp: '2026-09-08T10:01:00.000Z',
    type: 'token_usage_record',
    payload: { usage: { input_tokens: 100, cached_input_tokens: 20, output_tokens: 10 } },
  }) + '\n');

  const manager = {
    async request() {
      return { data: [{
        id: 'thread-1',
        createdAt: Date.parse('2026-09-08T10:00:00.000Z') / 1000,
        updatedAt: Date.parse('2026-09-08T10:01:00.000Z') / 1000,
      }] };
    },
  };

  try {
    const scans = await scanCodexUsageSessions(manager, { sessionsDir: root });
    assert.equal(scans.length, 1);
    assert.equal(scans[0].rows.length, 1);
    assert.equal(scans[0].rows[0].usage.input_tokens, 80);
    assert.equal(scans[0].rows[0].model, 'gpt-5.4');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('Codex history reads full turns without starting or resuming a thread', async () => {
  let call;
  const manager = {
    async request(method, params) {
      call = [method, params];
      // Same as above - the real Thread response from thread/read has no
      // model field either.
      return { thread: {
        id: 'thread-1', turns: [{
          status: 'completed',
          items: [{ type: 'agentMessage', text: 'saved answer' }],
        }],
      } };
    },
  };
  const messages = await fetchCodexSessionHistory('thread-1', '/ignored', manager);
  assert.deepEqual(call, ['thread/read', { threadId: 'thread-1', includeTurns: true }]);
  assert.equal(messages[0].message.content[0].text, 'saved answer');
  assert.equal(messages[0].message.model, undefined);
});
