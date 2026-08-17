// Retained per-tool-call records, decoupled from stream-view.js's own
// rendering-only WeakMaps (groupsByContainer/openGroupByContainer - all
// DOM-refs-plus-expand-flags, only stream-view.js itself reads them). This
// module holds *content* - full payload, result text, usage, client-observed
// timing - that a second, independent module
// (detail-pane.js) also needs to read without reaching into stream-view.js's
// internals. Splitting it out avoids a circular import (stream-view.js ->
// detail-pane.js -> stream-view.js) and keeps detail-pane.js talking to a
// small explicit API instead of renderer guts, the same way turn-chart.js
// only ever receives data via addPoint()/nextPointIndex().
//
// Keyed by the Anthropic tool_use.id field (present on every tool_use
// block) - tool_result blocks carry the matching tool_use_id, so this is a
// real, stable join key already used server-side for the same purpose
// (src/session-registry.js's TaskCreate/TaskUpdate/TaskList tracking), not a
// synthetic id scheme invented for this feature.

const recordsByContainer = new WeakMap(); // container -> Map<tool_use id, record>
const orderByContainer = new WeakMap();   // container -> id[] insertion order, for "most recent"
// A tool_result that arrived with no matching tool_use yet (a resumed tail
// starting mid-run) - held here so that if "Load earlier history" later
// pulls in the missing tool_use, stream-view.js can retroactively complete
// the record instead of leaving a permanently-pending orphan row. See
// recordOrphanResult/popOrphanResult and prependHistory's merge step.
const orphansByContainer = new WeakMap(); // container -> Map<tool_use_id, { resultText, isError, rowEl }>

export function resetToolCallStore(container) {
  recordsByContainer.set(container, new Map());
  orderByContainer.set(container, []);
  orphansByContainer.set(container, new Map());
}

export function recordOrphanResult(container, id, { resultText, isError, rowEl }) {
  if (!orphansByContainer.has(container)) orphansByContainer.set(container, new Map());
  orphansByContainer.get(container).set(id, { resultText, isError, rowEl });
}

// Removes and returns the orphan waiting on `id`, or null if none - a
// tool_use merged in by prependHistory calls this once per newly-merged id
// to check whether an already-rendered orphan result is waiting for it.
export function popOrphanResult(container, id) {
  const orphans = orphansByContainer.get(container);
  if (!orphans || !orphans.has(id)) return null;
  const orphan = orphans.get(id);
  orphans.delete(id);
  return orphan;
}

// startedAtMs is supplied by the caller, not defaulted to Date.now() here -
// stream-view.js's appendToolCallRow computes it: a real Date.now() for a
// tool_use rendered live, or the assistant message's own (coarser, possibly
// absent) timestamp for a historical/replayed batch, where Date.now() would
// only measure "when this synchronous render loop happened to run," not
// anything about the tool call itself. Can be null (unknown - no timestamp
// available either way); callers display that as "-", not a fabricated 0ms.
export function createToolCallRecord(container, { id, name, kind, input, payload, usage, rowEl, startedAtMs }) {
  if (!recordsByContainer.has(container)) resetToolCallStore(container);
  const record = {
    id, name, kind, input, payload,
    resultText: null,
    usage,
    startedAtMs: startedAtMs ?? null,
    resultAtMs: null,
    rowEl,
    status: 'pending', // 'pending' | 'done' | 'error'
  };
  recordsByContainer.get(container).set(id, record);
  orderByContainer.get(container).push(id);
  return record;
}

// Returns null (not a throw) when no matching tool_use was ever recorded in
// this container - a real case, not a bug: a history slice can start
// mid-run, landing a tool_result whose tool_use lived in an earlier,
// unfetched page. Callers render an honest orphan row for that case rather
// than silently dropping the result (see stream-view.js). resultAtMs: same
// live-vs-historical/nullable reasoning as createToolCallRecord's startedAtMs.
export function completeToolCallRecord(container, id, { resultText, isError, resultAtMs }) {
  const record = recordsByContainer.get(container)?.get(id);
  if (!record) return null;
  record.resultText = resultText;
  record.resultAtMs = resultAtMs ?? null;
  record.status = isError ? 'error' : 'done';
  return record;
}

export function getToolCallRecord(container, id) {
  return recordsByContainer.get(container)?.get(id) || null;
}

export function getMostRecentToolCallRecord(container) {
  const order = orderByContainer.get(container) || [];
  const id = order[order.length - 1];
  return id ? getToolCallRecord(container, id) : null;
}

// Paired with stream-view.js's prependHistory, which renders a "Load earlier
// history" batch into a detached fragment first (so it can insert everything
// above the live tail in one DOM operation), then merges the fragment's
// collapsible-block/group lists into the real container's. Tool-call records
// built during that fragment render are keyed under the fragment; after
// container.prepend(fragment), call this to fold them into the container's
// own map so a click on a historical row (rendered via the fragment) still
// resolves. Order: fragment's ids go first (they're the older, earlier
// history), container's existing ids follow - no seq-offset juggling needed
// here since, unlike collapsible-block hints, there's no "most recently
// collapsed" concept for tool-call records to get backwards.
// Returns the ids that were just merged in (oldest-first, i.e. fragOrder) so
// the caller can check each one against popOrphanResult - a tool_use that
// just arrived via this merge might be the match an earlier orphan result
// (rendered before this history page ever loaded) has been waiting for.
export function mergeToolCallStore(fragment, container) {
  const fragRecords = recordsByContainer.get(fragment);
  const fragOrder = orderByContainer.get(fragment) || [];
  const fragOrphans = orphansByContainer.get(fragment);

  if (fragOrphans?.size) {
    // Rare nested case: the fragment itself rendered an orphan (its own
    // tool_result with no tool_use in that same batch) - fold those into the
    // container's orphan map too rather than dropping them, same reasoning
    // as the records merge below.
    if (!orphansByContainer.has(container)) orphansByContainer.set(container, new Map());
    const containerOrphans = orphansByContainer.get(container);
    for (const [id, orphan] of fragOrphans) containerOrphans.set(id, orphan);
    orphansByContainer.delete(fragment);
  }

  if (!fragRecords || !fragOrder.length) return [];

  const containerRecords = recordsByContainer.get(container) || new Map();
  const containerOrder = orderByContainer.get(container) || [];

  const mergedRecords = new Map([...fragRecords, ...containerRecords]);
  const mergedOrder = [...fragOrder, ...containerOrder];

  recordsByContainer.set(container, mergedRecords);
  orderByContainer.set(container, mergedOrder);
  recordsByContainer.delete(fragment);
  orderByContainer.delete(fragment);

  return fragOrder;
}
