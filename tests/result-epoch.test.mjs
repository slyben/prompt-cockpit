import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createResultEpochTracker } from '../src/result-epoch.js';

test('consumeFifo matches push order until forceIdle', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.push('b');
  const first = t.consumeFifo();
  assert.equal(first.stale, false);
  assert.equal(first.queueId, 'a');
  assert.equal(first.epoch, 0);
  const second = t.consumeFifo();
  assert.equal(second.queueId, 'b');
  assert.equal(second.stale, false);
});

test('forceIdle then a new push: FIFO late result is stale, the new turn is not', () => {
  const t = createResultEpochTracker();
  const a = t.push('a');
  t.forceIdle();
  assert.equal(t.epoch, 1);
  const b = t.push('b');
  const late = t.consumeFifo();
  assert.equal(late.queueId, 'a');
  assert.equal(late.stale, true);
  assert.equal(late.epoch, a.epoch);
  const live = t.consumeFifo();
  assert.equal(live.queueId, 'b');
  assert.equal(live.stale, false);
  assert.equal(live.epoch, b.epoch);
});

test('consume by identity does not let a never-arriving abandoned turn steal the next live result', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.forceIdle();
  const b = t.push('b');
  const live = t.consume(b);
  assert.equal(live.queueId, 'b');
  assert.equal(live.stale, false);
  const late = t.consume('a');
  assert.equal(late.queueId, 'a');
  assert.equal(late.stale, true);
});

test('stamp uses abandoned-in-flight meta so leftover assistant text keeps the old epoch', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.forceIdle();
  t.push('b');
  const msg = { type: 'assistant' };
  t.stamp(msg);
  assert.equal(msg._cockpitEpoch, 0);
  assert.equal(msg._cockpitQueueId, 'a');
});

// forceIdle abandons the whole remaining pending list. Grok's runPrompt
// closes over the exact meta object push() returned; after forceIdle that
// object must read as stale so a prompt sitting on promptTail is skipped
// instead of firing after recovery. Callers with a local unsent queue
// remove() those ids first so they never land here.
test('forceIdle abandons every pending meta, including still-queued ones', () => {
  const t = createResultEpochTracker();
  t.push('stuck');
  const heldRef = t.push('still-queued');
  t.forceIdle();
  assert.equal(t.epoch, 1);
  const abandonedQueued = t.consume(heldRef);
  assert.equal(abandonedQueued.stale, true);
  assert.equal(abandonedQueued.queueId, 'still-queued');
  const abandonedHead = t.consumeFifo();
  assert.equal(abandonedHead.stale, true);
  assert.equal(abandonedHead.queueId, 'stuck');
  assert.equal(t.consumeFifo().meta, null);
});

test('remove drops a queued id so a later fifo consume cannot hit it', () => {
  const t = createResultEpochTracker();
  t.push('in-flight');
  t.push('queued');
  assert.equal(t.remove('queued'), true);
  assert.equal(t.consumeFifo().queueId, 'in-flight');
  assert.equal(t.consumeFifo().meta, null);
});

// Delegation tags used to live in a parallel ordered array on the registry
// row (row.pendingResultTags), hand-mirrored onto this tracker's ordering by
// every call site. Everything below covers the behaviors that array was
// carrying, now that the tracker owns them - see this module's comment for
// the three misrouted-delegation bugs the two copies kept producing.

test('a tag is addressed by queueId, so reordering the tail never changes which turn owns it', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.push('c');
  t.push('b');
  t.setTag('a', { fromName: 'A' });
  t.setTag('c', { fromName: 'C' });
  t.setTag('b', { fromName: 'B' });

  // The real frontend only ever names the still-queued ids - never the
  // in-flight one - which is exactly what used to push the in-flight turn's
  // tag to the back of the registry's copy.
  t.reorderTail(['b', 'c']);
  assert.deepEqual(t.pendingQueueIds(), ['a', 'b', 'c'], 'the in-flight turn stays pinned first');

  // A's own result still arrives first and must still carry A's tag.
  const first = t.consumeFifo();
  assert.equal(first.queueId, 'a');
  assert.equal(t.claimTag(first.queueId).fromName, 'A');
  const second = t.consumeFifo();
  assert.equal(second.queueId, 'b');
  assert.equal(t.claimTag(second.queueId).fromName, 'B');
});

test('claimTag releases a tag exactly once, so a later result cannot re-claim it', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.setTag('a', { fromName: 'A' });
  assert.equal(t.peekTag('a').fromName, 'A', 'peek must not release - a turn keeps buffering into its tag');
  assert.equal(t.claimTag('a').fromName, 'A');
  assert.equal(t.claimTag('a'), null);
  assert.equal(t.peekTag('a'), null);
  assert.equal(t.claimTag(undefined), null, 'an unstamped result must claim nothing at all');
});

// Grok's runPrompt consumes its meta and then throws without ever emitting a
// `result`; codex consumes a microtask after the result message is already
// out. Tag lifetime is therefore deliberately not tied to consume() - the
// registry-side copy used to cover this by accident, and losing it here
// would strand a delegation origin waiting forever.
test('a tag survives consume() so a session-wide failure sweep can still find it', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.setTag('a', { fromName: 'A' });
  t.consume('a'); // provider gave up on the turn without delivering a result
  assert.equal(t.pendingCount, 0);
  assert.deepEqual(t.takeAllTags().map((e) => e.queueId), ['a']);
  assert.deepEqual(t.takeAllTags(), [], 'the sweep releases each tag once');
});

test('takeAllTags releases tags without disturbing turn order, so a late result still reads stale', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.setTag('a', { fromName: 'A' });
  t.forceIdle();
  t.push('b');
  t.setTag('b', { fromName: 'B' });

  // forceIdle's registry-side sweep: fail everything still waiting.
  assert.deepEqual(t.takeAllTags().map((e) => e.tag.fromName).sort(), ['A', 'B']);

  // A's abandoned turn can still emit - it must be matchable and stale, and
  // must not carry a tag any longer (its origin was already told).
  const late = t.consumeFifo();
  assert.equal(late.queueId, 'a');
  assert.equal(late.stale, true);
  assert.equal(t.claimTag('a'), null);
});

test('abandonAll zeroes the in-flight count without dropping the turns or bumping the epoch', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.push('b');
  assert.equal(t.pendingCount, 2);
  t.abandonAll();
  assert.equal(t.pendingCount, 0, 'a crashed row must stop reporting turns in flight');
  assert.equal(t.epoch, 0, 'forceIdle owns the epoch bump, not this');
  assert.deepEqual(t.pendingQueueIds(), []);
  // Order is preserved in `abandoned`, so a straggler still matches its own
  // turn rather than stealing a slot.
  assert.equal(t.consumeFifo().queueId, 'a');
  assert.equal(t.consumeFifo().queueId, 'b');
});

test('frontPending is the in-flight turn, never an abandoned one', () => {
  const t = createResultEpochTracker();
  t.push('a');
  t.forceIdle();
  t.push('b');
  assert.equal(t.frontPending().queueId, 'b', 'leftover narration from `a` must not append into `b`\'s tag');
  assert.equal(t.currentMeta().queueId, 'a', 'stamping still uses the abandoned in-flight meta');
});

test('snapshot.pendingCountHistory records only real pending.length transitions, oldest first', () => {
  const t = createResultEpochTracker();
  assert.deepEqual(t.snapshot().pendingCountHistory, []);
  t.push('a'); // 0 -> 1
  t.push('b'); // 1 -> 2
  t.consumeFifo(); // 2 -> 1
  t.remove('nope'); // no-op: not present, pending.length unchanged
  t.consumeFifo(); // 1 -> 0
  const counts = t.snapshot().pendingCountHistory.map((e) => e.count);
  assert.deepEqual(counts, [1, 2, 1, 0]);
});

test('snapshot.pendingCountHistory caps at 20 entries, dropping the oldest', () => {
  const t = createResultEpochTracker();
  for (let i = 0; i < 25; i += 1) {
    t.push(`t${i}`);
    t.consumeFifo();
  }
  const history = t.snapshot().pendingCountHistory;
  assert.equal(history.length, 20);
  assert.equal(history[history.length - 1].count, 0);
});
