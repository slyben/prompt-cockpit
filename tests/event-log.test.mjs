// Unit tests for the durable per-session event log (plan MVP3: reconnect,
// designed rather than assumed).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createEventLog, append, replay } from '../src/event-log.js';

test('append assigns increasing seq numbers starting at 1', () => {
  const log = createEventLog();
  assert.equal(append(log, { a: 1 }), 1);
  assert.equal(append(log, { a: 2 }), 2);
  assert.equal(append(log, { a: 3 }), 3);
});

test('replay(0) returns every entry in order', () => {
  const log = createEventLog();
  append(log, { a: 1 });
  append(log, { a: 2 });
  const { events, gap } = replay(log, 0);
  assert.equal(gap, false);
  assert.deepEqual(events.map((e) => e.message.a), [1, 2]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2]);
});

test('replay(sinceSeq) returns only entries after that seq', () => {
  const log = createEventLog();
  append(log, { a: 1 });
  const cut = append(log, { a: 2 });
  append(log, { a: 3 });
  const { events, gap } = replay(log, cut);
  assert.equal(gap, false);
  assert.deepEqual(events.map((e) => e.message.a), [3]);
});

test('replay past the last seq returns nothing, no gap', () => {
  const log = createEventLog();
  const last = append(log, { a: 1 });
  const { events, gap } = replay(log, last);
  assert.equal(gap, false);
  assert.deepEqual(events, []);
});

test('the byte cap evicts oldest entries first', () => {
  const log = createEventLog({ maxBytes: 1 }); // forces eviction on every append past the first
  append(log, { a: 1 });
  append(log, { a: 2 });
  append(log, { a: 3 });
  // Always keeps at least the just-appended entry, even over cap.
  assert.equal(log.entries.length, 1);
  assert.equal(log.entries[0].message.a, 3);
  assert.ok(log.evictedThrough >= 2);
});

test('replay(sinceSeq) reports a gap once sinceSeq has been evicted, and hands back everything remaining instead', () => {
  const log = createEventLog({ maxBytes: 1 });
  const first = append(log, { a: 1 });
  append(log, { a: 2 });
  append(log, { a: 3 });
  const { events, gap } = replay(log, first);
  assert.equal(gap, true);
  assert.deepEqual(events.map((e) => e.message.a), [3]); // whatever the log still holds, not a partial replay with a hole
});

test('a single message larger than the cap does not evict itself', () => {
  const log = createEventLog({ maxBytes: 1 });
  const huge = { blob: 'x'.repeat(1000) };
  append(log, huge);
  assert.equal(log.entries.length, 1);
  assert.deepEqual(log.entries[0].message, huge);
});
