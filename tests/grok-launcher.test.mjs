import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { listGrokSessions } from '../src/grok-launcher.js';

async function writeSession(root, cwd, sessionId, { summary, updates, mtimeSec }) {
  const group = path.join(root, encodeURIComponent(cwd));
  const dir = path.join(group, sessionId);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'summary.json'), JSON.stringify(summary));
  if (updates) await writeFile(path.join(dir, 'updates.jsonl'), updates);
  if (mtimeSec != null) await utimes(path.join(dir, 'summary.json'), mtimeSec, mtimeSec);
}

test('listGrokSessions sorts newest-first and reads cwd/title from summary.json', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-sessions-'));
  try {
    const now = Date.now() / 1000;
    await writeSession(root, 'D:\\proj\\a', 'sess-old', {
      summary: {
        info: { id: 'sess-old', cwd: 'D:\\proj\\a' },
        generated_title: 'older grok chat',
        updated_at: '2026-08-01T00:00:00.000Z',
      },
      mtimeSec: now - 100,
    });
    await writeSession(root, 'D:\\proj\\b', 'sess-new', {
      summary: {
        info: { id: 'sess-new', cwd: 'D:\\proj\\b' },
        generated_title: 'newer grok chat',
        updated_at: '2026-08-16T00:00:00.000Z',
      },
      mtimeSec: now,
    });

    const sessions = await listGrokSessions(root);
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].sessionId, 'sess-new');
    assert.equal(sessions[0].cwd, 'D:\\proj\\b');
    assert.equal(sessions[0].label, 'newer grok chat');
    assert.equal(sessions[0].provider, 'grok');
    assert.equal(sessions[1].sessionId, 'sess-old');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listGrokSessions falls back to the first user prompt when there is no title', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'grok-sessions-label-'));
  try {
    await writeSession(root, '/tmp/p', 'sess-1', {
      summary: { info: { id: 'sess-1', cwd: '/tmp/p' }, session_summary: '' },
      updates: JSON.stringify({
        method: 'session/update',
        params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'Reply with pong' } } },
      }) + '\n',
    });
    const sessions = await listGrokSessions(root);
    assert.equal(sessions[0].label, 'Reply with pong');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('listGrokSessions returns [] when the sessions dir does not exist', async () => {
  assert.deepEqual(await listGrokSessions('/nonexistent/grok/sessions'), []);
});
