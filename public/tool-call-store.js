// Retained per-tool-call records, decoupled from stream-view.js's own
// rendering-only WeakMaps, so detail-pane.js can read payload/result/usage/
// timing without reaching into stream-view.js's internals or creating a
// circular import. Keyed by the Anthropic tool_use.id field, the same join
// key used server-side for TaskCreate/TaskUpdate/TaskList tracking.

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
// a historical/replayed batch has no real per-call timing, so callers pass
// null and display "-" rather than a fabricated 0ms.
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

// Returns null (not a throw) when no matching tool_use was ever recorded -
// a real case, not a bug: a history slice can start mid-run, landing a
// tool_result whose tool_use lived on an earlier, unfetched page. Callers
// render an honest orphan row for that rather than dropping the result.
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

// Paired with prependHistory, which renders a history batch into a
// detached fragment first, then calls this after container.prepend(fragment)
// to fold the fragment's records into the container's own map so a click on
// a historical row still resolves. Returns the merged ids (oldest-first) so
// the caller can check each against popOrphanResult for a waiting result.
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
