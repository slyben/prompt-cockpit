// THE single owner of per-session turn identity. One tracker per live
// session handle (session.js, grok-session.js, codex-session.js each create
// one and expose it as `handle.turns`); session-registry.js and
// delegation.js read turn identity off it rather than keeping any parallel
// record of their own.
//
// Two things live here, and only here:
//
// 1. ORDER (`pending` / `abandoned`) - which turn the next `result` belongs
//    to. Every queue-pane edit (remove/reorder/send-now) and every recovery
//    (force-idle, stop, close) mutates this list exactly once, inside the
//    provider module that also mutates its own real queue.
// 2. DELEGATION TAGS (`tags`, keyed by queueId) - the cross-session
//    delegation metadata session-registry.js's pushTurn attaches to a turn.
//    Deliberately a keyed side-table with NO order of its own: it is looked
//    up by the queueId the result message is stamped with, never by
//    position, so it cannot drift out of order with (1).
//
// This split is the fix for three separate production bugs, all of which
// came from session-registry.js previously keeping its own ORDERED copy of
// the in-flight turns (`row.pendingResultTags`) and blind-shift()ing it on
// every `result`:
//
// - A late `result` from a force-idled turn popped the tag of a turn pushed
//   AFTER recovery and relayed it to the wrong origin. forceIdle cleared
//   the registry's array but the CLI could still emit the abandoned turn's
//   result. A drop-N counter is the wrong fix: the original reason for
//   forceIdle is "a result is not coming", so counting that as N=1 swallows
//   the next real turn. Identity, not a count - hence `epoch` below.
// - An ordinary queue-panel drag while a delegated turn was running moved
//   the in-flight turn's tag to the BACK of the registry's copy (its
//   reorder named only the still-queued ids, so the in-flight entry always
//   fell into the "unlisted, appended after" bucket). The next result -
//   actually the in-flight turn finishing - was then delivered as some
//   queued turn's answer. `reorderTail` below pins index 0 for that reason.
// - sendNow had the same bug the other direction, unshifting to absolute
//   index 0 ahead of the in-flight turn.
//
// Each successful pushInput records {queueId, epoch}. forceIdle increments
// epoch and moves whatever is still pending into `abandoned` (work that
// may still produce a result). Callers with a local unsent queue must
// remove() those ids first - they will never emit, and leaving them here
// would FIFO-steal later live results. A result is stamped with that
// turn's epoch and `_cockpitStale` when the epoch no longer matches.
//
// Grok's runPrompt closes over the meta object and should consume() by
// identity, so a never-arriving abandoned turn cannot steal the next live
// result. Claude's SDK stream is FIFO only, so it uses consumeFifo()
// (abandoned first, then pending) plus interrupt() on forceIdle so the
// abandoned turn is expected to emit.
//
// Tag lifetime is deliberately NOT tied to consume(): a provider can
// consume a meta without ever delivering a `result` to the registry (grok's
// runPrompt error path, codex's abandoned-turn path), and codex consumes a
// microtask AFTER the result message is already on its way out. Tags are
// therefore released explicitly - claimTag() on a delivered result,
// takeAllTags() when the whole session gives up (close/force-idle/error) -
// so no path can strand a delegation origin waiting forever.

// How many transitions to keep for the debug snapshot's timeline (below) -
// enough to see a recent stuck-spinner report's actual shape (several
// pushes/consumes leading up to it) without the row holding on to unbounded
// history for a long-lived session.
const MAX_PENDING_COUNT_HISTORY = 20;

export function createResultEpochTracker() {
  let resultEpoch = 0;
  const pending = [];
  const abandoned = [];
  // queueId -> delegation tag. See the module comment: keyed, never
  // ordered, and released only by claimTag/takeAllTags.
  const tags = new Map();
  // Ring buffer of {ts, count} for every actual change to pending.length -
  // getDebugInfo's snapshot used to be a single point-in-time pendingCount
  // read, which can't distinguish "stuck at 1" from "just bounced 1->0->1"
  // when a bug report comes in. Recorded here (not in session-registry.js)
  // since this module is the only thing that mutates `pending`.
  const pendingCountHistory = [];

  function recordPendingCount() {
    const count = pending.length;
    const last = pendingCountHistory[pendingCountHistory.length - 1];
    if (last && last.count === count) return; // only real transitions, not no-op calls
    pendingCountHistory.push({ ts: Date.now(), count });
    if (pendingCountHistory.length > MAX_PENDING_COUNT_HISTORY) pendingCountHistory.shift();
  }

  function currentMeta() {
    return abandoned[0] || pending[0] || null;
  }

  function consumeMeta(meta) {
    if (!meta) return { meta: null, stale: false, epoch: undefined, queueId: undefined };
    return {
      meta,
      stale: meta.epoch !== resultEpoch,
      epoch: meta.epoch,
      queueId: meta.queueId,
    };
  }

  function take(list, pred) {
    const i = list.findIndex(pred);
    if (i === -1) return null;
    return list.splice(i, 1)[0];
  }

  return {
    get epoch() {
      return resultEpoch;
    },
    currentMeta,
    // The oldest still-queued turn = the one currently in flight (a
    // provider never hands the CLI more than one turn at a time).
    // delegation.js buffers assistant text against this turn's tag.
    // Deliberately NOT currentMeta(): an abandoned turn's leftover
    // narration must not append into a live turn's buffer.
    frontPending() {
      return pending[0] || null;
    },
    // Turns cockpit still considers in flight for this session - what
    // session-registry.js's pendingTurnsCount badge reports. Abandoned
    // turns deliberately don't count: force-idle's whole purpose is to
    // assert "nothing is running", and their result may never come.
    get pendingCount() {
      return pending.length;
    },
    // Debug/test visibility into (1) above - the actual execution order the
    // next results will be matched against.
    pendingQueueIds() {
      return pending.map((e) => e.queueId);
    },
    push(queueId) {
      const meta = { queueId, epoch: resultEpoch };
      pending.push(meta);
      recordPendingCount();
      return meta;
    },
    // Delegation tags (2) above. setTag is called by session-registry.js's
    // pushTurn immediately after pushInput returns a queueId; peekTag reads
    // without releasing (collectDelegationText, which keeps buffering into
    // the same tag across a whole turn); claimTag releases on delivery.
    setTag(queueId, tag) {
      if (queueId === undefined || queueId === null || !tag) return null;
      tags.set(queueId, tag);
      return tag;
    },
    peekTag(queueId) {
      if (queueId === undefined || queueId === null) return null;
      return tags.get(queueId) || null;
    },
    claimTag(queueId) {
      if (queueId === undefined || queueId === null) return null;
      const tag = tags.get(queueId);
      if (!tag) return null;
      tags.delete(queueId);
      return tag;
    },
    // "This session is not going to answer any of these" - close, force-idle
    // and a mid-turn crash all sweep every tag still held so their origins
    // get an explicit failure instead of waiting forever. Ordering (1) is
    // untouched: an abandoned turn's late result must still be matchable so
    // it can be recognized as stale rather than stealing a live turn's slot.
    takeAllTags() {
      const all = [...tags.entries()].map(([queueId, tag]) => ({ queueId, tag }));
      tags.clear();
      return all;
    },
    // Crash path only: the provider's turn loop has exited, so nothing
    // pending will be consumed normally. Moves entries to `abandoned`
    // rather than dropping them - a result that somehow still lands must
    // read as stale, not steal a slot. No epoch bump: forceIdle owns
    // that, and these turns are already unreachable.
    abandonAll() {
      if (pending.length) abandoned.push(...pending);
      pending.length = 0;
      recordPendingCount();
    },
    remove(queueId) {
      const i = pending.findIndex((e) => e.queueId === queueId);
      if (i === -1) return false;
      pending.splice(i, 1);
      recordPendingCount();
      return true;
    },
    // pending[0] is the in-flight turn; only the TAIL follows queue-pane
    // edits. reorderQueue()/sendNow() only touch the not-yet-started
    // sub-queue, which never contains the in-flight entry by construction
    // - pinning index 0 guarantees neither operation can change what
    // result arrives next, even if the caller names the in-flight id.
    reorderTail(queueIds) {
      const pinned = pending.length ? [pending[0]] : [];
      const tail = pending.slice(pinned.length);
      const byQueueId = new Map(tail.map((e) => [e.queueId, e]));
      const used = new Set();
      const ordered = [];
      for (const qid of queueIds) {
        const entry = byQueueId.get(qid);
        if (entry && !used.has(qid)) {
          ordered.push(entry);
          used.add(qid);
        }
      }
      for (const entry of tail) {
        if (!used.has(entry.queueId)) ordered.push(entry);
      }
      pending.length = 0;
      pending.push(...pinned, ...ordered);
    },
    forceIdle() {
      resultEpoch += 1;
      if (pending.length) abandoned.push(...pending);
      pending.length = 0;
      recordPendingCount();
    },
    consume(metaOrQueueId) {
      const pred = (e) => e === metaOrQueueId || e.queueId === metaOrQueueId;
      const meta = take(abandoned, pred) || take(pending, pred);
      recordPendingCount();
      if (meta) return consumeMeta(meta);
      if (metaOrQueueId && typeof metaOrQueueId === 'object' && 'epoch' in metaOrQueueId) {
        return consumeMeta(metaOrQueueId);
      }
      return consumeMeta(null);
    },
    consumeFifo() {
      const meta = abandoned.length ? abandoned.shift() : pending.shift();
      recordPendingCount();
      return consumeMeta(meta || null);
    },
    stamp(message) {
      const meta = currentMeta();
      if (meta && message && typeof message === 'object') {
        message._cockpitEpoch = meta.epoch;
        if (meta.queueId !== undefined) message._cockpitQueueId = meta.queueId;
      }
      return message;
    },
    applyResultStamp(message, consumed) {
      if (!message || typeof message !== 'object' || !consumed || !consumed.meta) return message;
      message._cockpitEpoch = consumed.epoch;
      if (consumed.queueId !== undefined) message._cockpitQueueId = consumed.queueId;
      if (consumed.stale) message._cockpitStale = true;
      return message;
    },
    snapshot() {
      return {
        resultEpoch,
        pendingTurnsMeta: pending.length,
        abandonedTurnsMeta: abandoned.length,
        delegationTagsHeld: tags.size,
        // {ts, count} transitions of pending.length, oldest first - see
        // MAX_PENDING_COUNT_HISTORY above. Lets a stuck-spinner report show
        // the recent shape ("bounced 1->0->1 three times" vs. "stuck at 1
        // since forever") instead of just this one instant's count.
        pendingCountHistory: [...pendingCountHistory],
      };
    },
  };
}
