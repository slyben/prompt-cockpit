// Cross-session delegation (`/ask <Name>: <text>`) and the handshake-trust
// gate it depends on - unit tests against a stubbed startSession (see
// test-helpers.mjs), split out of session-registry.test.mjs to mirror the
// src/delegation.js split (session-registry.js's own tests stay in
// session-registry.test.mjs). Everything here exercises delegation.js only
// through session-registry.js's public re-exports (registry.delegateTask,
// registry.setSessionHandshake, etc.) - same as before the split, since
// those exports are unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as registry from '../src/session-registry.js';
import { fakeWs, fakeStartSession, pendingTurnIds, pendingTurnCount, frontDelegationTag } from './test-helpers.mjs';

// Cross-session delegation - findByName is the addressing
// primitive `/ask <Name>: ...` resolves against: case-insensitive within a
// cwd, never matches across cwds or against an unnamed row.
test('findByName matches case-insensitively within a cwd, and never across cwds or against an unnamed row', () => {
  registry._reset();
  registry.createSession({ cwd: '/tmp/a', name: 'Grok', startSessionImpl: fakeStartSession() });
  registry.createSession({ cwd: '/tmp/a', startSessionImpl: fakeStartSession() }); // unnamed
  registry.createSession({ cwd: '/tmp/b', name: 'Grok', startSessionImpl: fakeStartSession() });

  const found = registry.findByName('/tmp/a', 'grok');
  assert.ok(found, 'lookup must be case-insensitive');
  assert.equal(found.cwd, '/tmp/a');

  assert.equal(registry.findByName('/tmp/a', 'GROK'), found, 'must match regardless of case on either side');
  assert.equal(registry.findByName('/tmp/does-not-exist', 'Grok'), null, 'must not match across cwds');
  assert.equal(registry.findByName('/tmp/a', ''), null, 'an empty name must never match');
  assert.equal(registry.findByName('/tmp/a', '   '), null, 'a whitespace-only name must never match');
});

test('findByName matches equivalent cwd spellings (trailing slash, Windows drive case)', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  assert.equal(registry.findByName('/tmp/proj/', 'Claude')?.id, row.id, 'trailing slash must not hide a same-project session');
  if (process.platform === 'win32') {
    const win = registry.createSession({ cwd: 'D:\\Dev\\proj', name: 'Win', startSessionImpl: fakeStartSession() });
    assert.equal(registry.findByName('d:\\dev\\proj', 'Win')?.id, win.id, 'drive-letter case must not hide a same-project session');
  }
});

test('delegateTask pushes the task into the named target session and throws on unknown name or self-delegation', () => {
  registry._reset();
  const claude = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  const grokImpl = fakeStartSession();
  const grok = registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  const result = registry.delegateTask(claude.id, 'Grok', 'summarize main.py');
  assert.equal(result.targetId, grok.id);
  assert.match(
    grokImpl.lastInput,
    /^\[Prompt Cockpit\] Relayed task from "Claude"\n\n[\s\S]*\n---\nsummarize main\.py$/,
    'the task text pushed into the target session must self-identify its origin via the prose header, symmetric with the relayed-reply header on the response'
  );
  assert.equal(pendingTurnCount(grok), 1);
  assert.equal(frontDelegationTag(grok).fromId, claude.id);
  assert.equal(frontDelegationTag(grok).fromName, 'Claude');
  assert.match(
    grokImpl.lastInput,
    /handshake secret/,
    'the header must cite the handshake-trust check as a checkable fact, not leave the trust chain purely implicit'
  );

  assert.throws(() => registry.delegateTask(claude.id, 'NoSuchName', 'hi'), /no session named/);
  assert.throws(() => registry.delegateTask(claude.id, 'Claude', 'hi'), /cannot delegate to the same session/);
});

test('delegateTask reaches a same-named session in a different cwd via the handshake-trust fallback, but not an untrusted one', () => {
  registry._reset();
  const claude = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  const otherImpl = fakeStartSession();
  const other = registry.createSession({ cwd: '/tmp/other', name: 'Other', startSessionImpl: otherImpl });

  // Trusted by construction (both created locally) - cross-cwd now works.
  const result = registry.delegateTask(claude.id, 'Other', 'hi');
  assert.equal(result.targetId, other.id, 'a trusted session outside the origin cwd must be reachable by name');

  // Revoke Other's trust - it must go back to being unreachable by name,
  // same as if it did not exist, not just refused after being found.
  registry.setSessionHandshake(other.id, 'garbage-does-not-match');
  assert.throws(
    () => registry.delegateTask(claude.id, 'Other', 'hi'),
    /no session named/,
    'an untrusted cross-cwd namesake must not be reachable at all'
  );
});

// 2026-08-24 review fix, exercised through delegateTask: the TARGET's queue is
// closed at delegation time, so the task can never run and no `result`
// will ever arrive for it. Without the fix this pushed a permanent
// tagged turn entry that desynced every later result on that row -
// with the fix, delegateTask must notice and relay an immediate failure
// back to the origin instead of leaving it waiting forever.
test('delegateTask relays an immediate failure to the origin when the target queue is already closed, instead of stranding a dead turn entry', () => {
  registry._reset();
  const originImpl = fakeStartSession();
  const origin = registry.createSession({ cwd: '/tmp/proj', name: 'Origin', startSessionImpl: originImpl });
  const targetImpl = fakeStartSession();
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'Target', startSessionImpl: targetImpl });

  targetImpl.closed = true; // simulate the race: row still registered, handle already dead

  registry.delegateTask(origin.id, 'Target', 'do the thing');

  assert.equal(pendingTurnCount(target), 0, 'no dead entry should be left on the target row');
  assert.equal(frontDelegationTag(target), null, 'no orphaned tag should be left behind either');
  assert.match(
    originImpl.lastInput,
    /ERROR:.*no longer available/,
    'the origin must be told immediately, not left waiting for a result that will never come',
  );
});

test('delegateTask appends a durable cockpit:delegate-sent marker to the ORIGIN eventLog and broadcasts it, so a reconnecting origin tab sees it', () => {
  registry._reset();
  const claude = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: fakeStartSession() });

  registry.delegateTask(claude.id, 'Grok', 'summarize main.py');

  // Attach a fresh client AFTER the delegation - proves it survives via
  // eventLog replay, not just an in-flight broadcast the caller happened to
  // catch live.
  const ws = fakeWs();
  registry.attachClient(claude.id, ws);
  const marker = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-sent');
  assert.ok(marker, 'the sent-marker must replay to a newly attached client');
  assert.equal(marker.message.targetName, 'Grok');
  assert.equal(marker.message.text, 'summarize main.py');
});

test('a delegated task result relays back into the origin session as a wrapped queued turn, text-only', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'list the files here');

  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Here are the files: a.js, b.js' }] } });
  grokImpl.emitMessage({ type: 'result' });

  assert.match(claudeImpl.lastInput, /^\[Prompt Cockpit\] Relayed reply from "Grok"\n\n[\s\S]*\n---\nHere are the files: a\.js, b\.js$/);
});

// 2026-08-20 follow-up: the origin model must only see the final answer, not
// every buffered narration block - the full trace is relayed separately, out
// of the model's context, as a cockpit:delegate-full-trace marker.
//
// The two narration blocks are separated by a tool call, on purpose: a bare
// tool_use/tool_result boundary is what actually marks two DISTINCT
// narration steps (see collectDelegationText's 2026-08-21 comment) - two
// plain text messages with nothing between them are instead treated as one
// continuous streamed reply and merged, which is covered separately below.
test('a multi-block delegated reply relays only the final answer into the origin turn, and ships the full narration as a separate out-of-band marker', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'run the tests and report back');

  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'Let me run the test suite first.' }] } });
  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'npm test' } }] } });
  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'All 311 tests pass.' }] } });
  grokImpl.emitMessage({ type: 'result' }); // no result.result field (test stub) - falls back to the last buffered block

  assert.match(claudeImpl.lastInput, /\n---\nAll 311 tests pass\.$/, 'the origin turn must carry only the last block, not the narration before it');
  assert.doesNotMatch(claudeImpl.lastInput, /Let me run the test suite first\./, 'narration must not leak into the origin model\'s own context');

  const ws = fakeWs();
  registry.attachClient(claudeRow.id, ws);
  const trace = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-full-trace');
  assert.ok(trace, 'a full-trace marker must be sent when there is more than just the final answer');
  assert.match(trace.message.text, /Let me run the test suite first\.[\s\S]*All 311 tests pass\./, 'the marker carries the whole narration, in order');
  assert.equal(typeof trace.message.queueId, 'string');
});

// 2026-08-21 bug fix: Grok streams its reply one BPE piece at a time - a
// SEPARATE assistant message per word (see grok-messages.js's joinStreamText
// comment) - not one message per complete sentence like Claude. Before this
// fix, collectDelegationText pushed a new buffer entry per message
// regardless, so a Grok delegation's full-trace buffer held one entry per
// WORD (unreadable once joined with blank lines) and finalAnswerText's
// "last non-empty block" fallback grabbed a single trailing token/punctuation
// mark instead of the real last sentence - so the origin model's relayed
// "final answer" was garbage too (observed: a lone ".").
test('a Grok-style word-at-a-time streamed reply re-assembles into real sentences, not one buffer entry per word', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'list the files here');

  for (const piece of ['I', "'ll", ' run', ' ', 'ls', ' -', 'la', '.']) {
    grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: piece }] } });
  }
  grokImpl.emitMessage({ type: 'result' }); // no result.result field - falls back to the last (now fully re-assembled) buffered block

  assert.match(claudeImpl.lastInput, /\n---\nI'll run ls -la\.$/, 'word-at-a-time chunks must re-assemble into one real sentence, not relay a lone trailing token');

  const ws = fakeWs();
  registry.attachClient(claudeRow.id, ws);
  const trace = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-full-trace');
  assert.equal(trace, undefined, 'a single re-assembled sentence has nothing extra beyond the final answer, so no full-trace marker should be sent');
});

test('a one-shot delegated reply (no narration) does not emit a full-trace marker - nothing extra to show', () => {
  registry._reset();
  const claudeImpl = fakeStartSession();
  const claudeRow = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: claudeImpl });
  const grokImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: grokImpl });

  registry.delegateTask(claudeRow.id, 'Grok', 'what is 2+2');
  grokImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: '4' }] } });
  grokImpl.emitMessage({ type: 'result' });

  const ws = fakeWs();
  registry.attachClient(claudeRow.id, ws);
  const trace = ws.sent.find((m) => m.type === 'sdk:message' && m.message.type === 'cockpit:delegate-full-trace');
  assert.equal(trace, undefined, 'a single-block reply has nothing extra beyond the final answer, so no marker should be sent');
});

test('two concurrent delegations to the same target route their results back to the correct distinct origins, in FIFO order', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const cImpl = fakeStartSession();
  const c = registry.createSession({ cwd: '/tmp/proj', name: 'C', startSessionImpl: cImpl });
  const bImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A');
  registry.delegateTask(c.id, 'B', 'task from C');

  // First delegated turn finishes first (FIFO) - its result must go to A, not C.
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(aImpl.lastInput, /reply to A/);
  assert.equal(cImpl.lastInput, undefined, 'C must not receive A\'s reply');

  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to C' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(cImpl.lastInput, /reply to C/);
});

// Regression test for the FIFO-desync bug found in review: a plain human
// message typed directly into the target session, interleaved with a
// pending delegation, used to desync the registry's own copy of the turn list from actual
// turn order (only delegateTask's own push was tagged) - the human's own
// reply could get relayed to the WRONG origin, or a real delegation's reply
// could get silently dropped. Fixed via pushTurn() tagging every push
// (sendInput included) with a queueId-keyed entry, tag or not.
test('a human message typed directly into the target session, interleaved with a pending delegation, does not desync the relay', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const cImpl = fakeStartSession();
  const c = registry.createSession({ cwd: '/tmp/proj', name: 'C', startSessionImpl: cImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A'); // tag 1: delegation from A
  registry.sendInput(b.id, 'a human typed this directly into B'); // tag 2: plain, no delegation
  registry.delegateTask(c.id, 'B', 'task from C'); // tag 3: delegation from C

  // Turn 1 (A's delegated task) finishes.
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(aImpl.lastInput, /reply to A/);

  // Turn 2 (the human's own message) finishes - NOT a delegation, so this
  // must not relay anywhere. Before the fix, shift() would have popped
  // tag 3 (C's) here and relayed B's answer to the human's own message
  // into C's session, mislabeled as C's delegated reply.
  cImpl.lastInput = undefined;
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to the human' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.equal(cImpl.lastInput, undefined, 'a non-delegated turn finishing must not relay anything to C');

  // Turn 3 (C's delegated task) finishes - must now correctly reach C.
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to C' }] } });
  bImpl.emitMessage({ type: 'result' });
  assert.match(cImpl.lastInput, /reply to C/);
});

// Regression test for the second FIFO-desync trigger found in review:
// removeQueued/reorderQueue mutate session.js's real queue but used to
// leave the registry's copy of the turn list untouched, so a removed/reordered turn threw
// off every later shift(). Only meaningfully exercisable when a turn is
// actually queued behind a running one - the fake handle's removeQueued/
// reorderQueue are simple recorders (no real queue semantics), so this
// drives registry.js's own mirroring logic directly against the queueIds
// pushInput handed back.
test('removeQueued drops the matching turn from the tracker and relays a cancellation notice if it was a delegation', async () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A');
  const [queueId] = pendingTurnIds(b);
  assert.equal(pendingTurnCount(b), 1);

  await registry.removeQueued(b.id, queueId);

  assert.equal(pendingTurnCount(b), 0, 'the turn must leave the tracker so a later unrelated result cannot be mismatched against it');
  assert.equal(frontDelegationTag(b), null, 'and its tag must be released, not left for a later result to claim');
  assert.match(aImpl.lastInput, /ERROR: the delegated task was removed from the queue before it ran/);
});

// Regression test: interruptTurn() (the Stop button) used to call
// row.handle.interrupt() alone - session.js's interrupt() now also drains
// its OWN local queue (see its comment), but that's session.js's private
// bookkeeping, invisible to the registry. The registry's own parallel copy
// of the turn list was left stale for every turn Stop dropped, so a later
// unrelated result could be mismatched against a cancelled tag, and a
// cancelled delegation was never told its task got dropped. The tracker is
// now the only copy - but the registry still has to fail the tags, since the
// provider layer knows nothing about delegation.
test('interruptTurn releases the delegation tag of every turn the Stop-drained local queue held, relaying a cancellation notice', async () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A');
  const [queueId] = pendingTurnIds(b);
  assert.equal(pendingTurnCount(b), 1);

  // session.js's real interrupt() drains its local queue synchronously
  // before handle.interrupt() is even invoked - interruptTurn() has to
  // snapshot listQueue() first to still see what's about to be dropped
  // (see its own comment); this fixture stands in for that pre-drain state.
  bImpl.queue = [{ id: queueId, text: 'task from A' }];

  await registry.interruptTurn(b.id);

  assert.equal(bImpl.interrupted, 1);
  assert.equal(pendingTurnCount(b), 0, 'the dropped turn must not be left for a later unrelated result to be mismatched against');
  assert.equal(frontDelegationTag(b), null, 'the cancelled delegation\'s tag must be released too');
  assert.match(aImpl.lastInput, /ERROR: the delegated task was removed from the queue before it ran/);
});

// Follow-up finding while fixing sendNow above: reorderQueue's own mirror
// had the identical defect. The real frontend's queueIds (public/queue-
// panel.js's reorderBySwap, sourced from listQueue()) can never name the
// in-flight turn - it never appears in the visible queue at all - so the
// old "named ids first, everything unlisted appended after" algorithm
// always pushed the in-flight entry's tag to the BACK the moment any two
// queued items were reordered while a delegated turn was running. Proven
// live via a probe before this fix: turn list [A(in-flight), C, B]
// reordered with queueIds [B, C] (realistically excluding A) produced
// [B, C, A] - A's own result would then have been shift()'d off as B's.
test('reorderQueue reorders only the still-queued tail; the in-flight entry never moves', async () => {
  registry._reset();
  const dAImpl = fakeStartSession();
  const dA = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorA', startSessionImpl: dAImpl });
  const dCImpl = fakeStartSession();
  const dC = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorC', startSessionImpl: dCImpl });
  const dBImpl = fakeStartSession();
  const dB = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorB', startSessionImpl: dBImpl });
  const tImpl = fakeStartSession();
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'Target', startSessionImpl: tImpl });

  registry.delegateTask(dA.id, 'Target', 'task from A'); // in-flight (pushed first)
  registry.delegateTask(dC.id, 'Target', 'task from C'); // queued
  registry.delegateTask(dB.id, 'Target', 'task from B'); // queued
  const [idA, idC, idB] = pendingTurnIds(target);

  // Realistic frontend call: queueIds is only the visible (queued) entries,
  // reordered so B runs before C - never names idA.
  await registry.reorderQueue(target.id, [idB, idC]);
  assert.deepEqual(
    pendingTurnIds(target),
    [idA, idB, idC],
    'A must stay pinned first; only the queued tail (C, B) reorders',
  );

  // A's own (still in-flight) result must go to A's origin, not B's just
  // because the queue panel reordered B ahead of C.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dAImpl.lastInput, /reply to A/);
  assert.equal(dBImpl.lastInput, undefined, 'B must not receive A\'s reply just because the queue was reordered');

  // B runs next, per the reordered tail.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to B' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dBImpl.lastInput, /reply to B/);
  assert.equal(dCImpl.lastInput, undefined, 'C must still be waiting behind B');
});

// A caller naming the in-flight entry's id explicitly (not something the
// real frontend does, but defense in depth) must not be able to move it
// either - pinning by position, not by whether the id happens to appear in
// queueIds.
test('reorderQueue ignores the in-flight entry even if a caller explicitly names its id', async () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const cImpl = fakeStartSession();
  const c = registry.createSession({ cwd: '/tmp/proj', name: 'C', startSessionImpl: cImpl });
  const bImpl = fakeStartSession();
  const b = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'task from A'); // in-flight
  registry.delegateTask(c.id, 'B', 'task from C'); // queued
  const [idA, idC] = pendingTurnIds(b);

  await registry.reorderQueue(b.id, [idC, idA]); // asks to put C ahead of A
  assert.deepEqual(
    pendingTurnIds(b),
    [idA, idC],
    'naming the in-flight id in queueIds must not move it out of position 0',
  );
});

// Review finding: sendNow used to unshift the target tag all the way to
// absolute index 0 of the turn list, but index 0 is always the
// currently in-flight turn (handle.sendNow only reorders the NOT-yet-
// started sub-queue behind it, per session.js's moveToFront - it can't
// make a queued turn's result arrive before the already-running turn's
// own interrupted result does). With A running and B/C queued, sending B
// now used to produce [B, A, C] - so A's own interrupted result got
// shifted off as if it were B's answer, and B's real answer would later
// get mismatched against C. The tag must land right after the in-flight
// entry instead: [A, B, C].
test('sendNow inserts the target tag after the in-flight entry, not ahead of it', async () => {
  registry._reset();
  const dAImpl = fakeStartSession();
  const dA = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorA', startSessionImpl: dAImpl });
  const dCImpl = fakeStartSession();
  const dC = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorC', startSessionImpl: dCImpl });
  const dBImpl = fakeStartSession();
  const dB = registry.createSession({ cwd: '/tmp/proj', name: 'DelegatorB', startSessionImpl: dBImpl });
  const tImpl = fakeStartSession();
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'Target', startSessionImpl: tImpl });

  registry.delegateTask(dA.id, 'Target', 'task from A'); // in-flight (pushed first)
  registry.delegateTask(dC.id, 'Target', 'task from C'); // queued
  registry.delegateTask(dB.id, 'Target', 'task from B'); // queued
  const [idA, idC, idB] = pendingTurnIds(target);

  assert.equal(await registry.sendNow(target.id, idB), true);
  assert.deepEqual(
    pendingTurnIds(target),
    [idA, idB, idC],
    'B must land right after the in-flight A, not ahead of it',
  );

  // A's (interrupted) result still arrives first - it must go to A's
  // origin, never to B's just because B was sent-now'd.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to A' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dAImpl.lastInput, /reply to A/);
  assert.equal(dBImpl.lastInput, undefined, 'B must not receive A\'s interrupted reply just because it was sent now');

  // B runs next, per the reordered queue.
  tImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'reply to B' }] } });
  tImpl.emitMessage({ type: 'result' });
  assert.match(dBImpl.lastInput, /reply to B/);
  assert.equal(dCImpl.lastInput, undefined, 'C must still be waiting behind B');
});

// Regression test for the closeSession stranding bug found in review:
// closing a session that's currently the target of a pending delegation
// used to delete the row with no notice to the origin at all (unlike a
// crash, which handleError already relayed as an ERROR:).
test('closing a session that is the target of a pending delegation relays a failure notice to the origin instead of stranding it', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: fakeStartSession() });

  registry.delegateTask(a.id, 'B', 'do something');
  registry.closeSession(registry.findByName('/tmp/proj', 'B').id);

  assert.match(aImpl.lastInput, /ERROR: the target session was closed before it replied/);
});

// 2026-08-20: the wrapper moved from an XML-ish `<delegated_result from=
// "...">` tag to a prose header + `\n---\n` separator specifically because
// receiving models were pattern-matching the tag shape as a spoofed
// tool-scaffolding tag and refusing legitimate delegations outright.
// There is no closing-tag boundary left for a reply body to
// spoof, so the body is no longer escaped - it goes through verbatim, same
// as any other plain-text turn.
test('a delegated reply body is inserted verbatim after the separator, unescaped', () => {
  registry._reset();
  const aImpl = fakeStartSession();
  const a = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: aImpl });
  const bImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: bImpl });

  registry.delegateTask(a.id, 'B', 'say something with special chars');
  bImpl.emitMessage({ type: 'assistant', message: { content: [{ type: 'text', text: 'x < y && y > z' }] } });
  bImpl.emitMessage({ type: 'result' });

  assert.ok(aImpl.lastInput.endsWith('\n---\nx < y && y > z'), 'the body must appear verbatim after the separator, with no HTML-style escaping');
});

test('a target session erroring mid-delegated-turn relays an ERROR-tagged notice back to the origin instead of stranding it', () => {
  registry._reset();
  const originImpl = fakeStartSession();
  const origin = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: originImpl });
  const targetImpl = fakeStartSession();
  registry.createSession({ cwd: '/tmp/proj', name: 'Grok', startSessionImpl: targetImpl });

  registry.delegateTask(origin.id, 'Grok', 'do something that will fail');
  targetImpl.emitError(new Error('CLI crashed'));

  assert.ok(originImpl.lastInput.startsWith('[Prompt Cockpit] Relayed reply from "Grok"'));
  assert.match(originImpl.lastInput, /ERROR: CLI crashed/);
});

// The per-process delegation handshake secret -
// see session-registry.js's own module-level comment for the full
// rationale. Deliberately NOT calling registry._reset() at the top of every
// test in this block the way the rest of the file does where it would wipe
// state the test needs to observe across regenerateHandshakeSecret calls -
// each test still resets the session map, just not in a way that assumes
// anything about the secret's own value (never asserted verbatim, only
// compared against itself via getHandshakeSecret()).
test('a locally-created session is trusted by default; getHandshakeSecret returns a stable non-empty value until rotated', () => {
  registry._reset();
  const secret = registry.getHandshakeSecret();
  assert.ok(secret && secret.length >= 16, 'must be a real random-looking value, not empty/short');
  assert.equal(registry.getHandshakeSecret(), secret, 'must stay stable across calls until explicitly rotated');

  const row = registry.createSession({ cwd: '/tmp/proj', name: 'Claude', startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(row).handshakeTrusted, true);
});

test('delegateTask throws if either the origin or the target has a mismatched handshake', () => {
  registry._reset();
  const origin = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: fakeStartSession() });
  const target = registry.createSession({ cwd: '/tmp/proj', name: 'B', startSessionImpl: fakeStartSession() });

  registry.setSessionHandshake(target.id, 'garbage-does-not-match');
  assert.throws(() => registry.delegateTask(origin.id, 'B', 'hi'), /does not have a matching handshake/);

  // Re-sync the target, then break the origin instead.
  registry.setSessionHandshake(target.id, registry.getHandshakeSecret());
  registry.setSessionHandshake(origin.id, 'also-garbage');
  assert.throws(() => registry.delegateTask(origin.id, 'B', 'hi'), /cannot delegate to other sessions/);

  // Re-sync the origin too - now it should go through.
  registry.setSessionHandshake(origin.id, registry.getHandshakeSecret());
  const result = registry.delegateTask(origin.id, 'B', 'hi');
  assert.equal(result.targetId, target.id);
});

test('setSessionHandshake trims the pasted value and reports whether it now matches', () => {
  registry._reset();
  const row = registry.createSession({ cwd: '/tmp/proj', name: 'A', startSessionImpl: fakeStartSession() });
  const secret = registry.getHandshakeSecret();

  assert.equal(registry.setSessionHandshake(row.id, `  ${secret}  `), true, 'surrounding whitespace from a copy-paste must not break the match');
  assert.equal(registry.setSessionHandshake(row.id, 'wrong'), false);
  assert.throws(() => registry.setSessionHandshake('does-not-exist', secret), /unknown session/);
});

test('regenerateHandshakeSecret revokes trust for existing rows but not for rows created afterward', () => {
  registry._reset();
  const before = registry.createSession({ cwd: '/tmp/proj', name: 'Before', startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(before).handshakeTrusted, true);

  const rotated = registry.regenerateHandshakeSecret();
  assert.notEqual(rotated, undefined);
  assert.equal(registry.toSummary(before).handshakeTrusted, false, 'a row stamped with the OLD secret must no longer match');

  const after = registry.createSession({ cwd: '/tmp/proj', name: 'After', startSessionImpl: fakeStartSession() });
  assert.equal(registry.toSummary(after).handshakeTrusted, true, 'a row created after rotation gets the NEW secret automatically');
});
