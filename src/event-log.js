// Append-only, sequence-numbered, byte-capped per-session event log (plan
// MVP3: "reconnect, designed rather than assumed"). Only the durable
// `sdk:message` stream goes through this - `cockpit:state`/
// `cockpit:approval-request` are current-snapshot broadcasts (registry.js
// resends the live snapshot on every attach) and would be meaningless to
// replay historically.
//
// The client tracks the highest `seq` it has rendered and sends it back as
// `since` on (re)connect. `replay()` returns everything after that seq, or
// `gap: true` if the log has already evicted past it - the caller then
// falls back to a full resend (registry.js's attachClient) rather than
// handing back a replay with a hole in it.

const DEFAULT_MAX_BYTES = 2 * 1024 * 1024; // prunable, not persisted across process restarts

export function createEventLog({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
  return { entries: [], nextSeq: 1, bytes: 0, evictedThrough: 0, maxBytes };
}

// Appends `message` and returns the seq assigned to it. Evicts from the
// front until back under the byte cap - always keeps at least the
// just-appended entry, even if it alone exceeds the cap, so one huge
// message can't wedge the log into evicting everything including itself.
export function append(log, message) {
  const seq = log.nextSeq;
  log.nextSeq += 1;
  const size = estimateBytes(message);
  log.entries.push({ seq, message, size });
  log.bytes += size;
  while (log.bytes > log.maxBytes && log.entries.length > 1) {
    const evicted = log.entries.shift();
    log.bytes -= evicted.size;
    log.evictedThrough = evicted.seq;
  }
  return seq;
}

// { events, gap } - events is [{seq, message}], newest last. `gap: true`
// means `sinceSeq` is older than what the log still holds; `events` is then
// the full remaining log (a fresh full resend), same shape a first-ever
// attach gets, rather than a replay with missing entries.
export function replay(log, sinceSeq) {
  if (sinceSeq > 0 && sinceSeq < log.evictedThrough) {
    return { events: log.entries.map(({ seq, message }) => ({ seq, message })), gap: true };
  }
  return {
    events: log.entries.filter((e) => e.seq > sinceSeq).map(({ seq, message }) => ({ seq, message })),
    gap: false,
  };
}

function estimateBytes(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
}
