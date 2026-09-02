// Ambient "is at least one subagent still working" tracker. An Agent
// tool call's tool_use/tool_result lifecycle isn't a reliable "done"
// signal - the parent gets its result back well before the subagent's
// real work finishes. Polls the transcript's mtime from tool-call start,
// tracking several concurrent subagents with no rendering.
const POLL_MS = 2000;
const STALL_POLLS_BEFORE_DONE = 4; // matches detail-pane.js's AGENT_STALL_POLLS_BEFORE_STOP - same "no growth in ~8s" heuristic, so the two views can't disagree about the same subagent

export function createAgentLivenessTracker({ onChange } = {}) {
  const tracked = new Map(); // toolUseId -> { claudeSessionId, timer, lastMtimeMs, stallCount }

  function notify() {
    onChange?.(tracked.size);
  }

  // No-op if this toolUseId is already tracked (e.g. a stray double-start) -
  // callers don't need to guard against that themselves.
  function track(claudeSessionId, toolUseId) {
    if (!claudeSessionId || !toolUseId || tracked.has(toolUseId)) return;
    tracked.set(toolUseId, { claudeSessionId, timer: null, lastMtimeMs: null, stallCount: 0 });
    notify();
    poll(toolUseId);
  }

  async function poll(toolUseId) {
    const entry = tracked.get(toolUseId);
    if (!entry) return; // dropped by reset() while nothing was in flight
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(entry.claudeSessionId)}/agent/${encodeURIComponent(toolUseId)}`);
      const data = res.ok ? await res.json() : null;
      const grew = data?.mtimeMs != null && data.mtimeMs !== entry.lastMtimeMs;
      entry.lastMtimeMs = data?.mtimeMs ?? entry.lastMtimeMs;
      entry.stallCount = grew ? 0 : entry.stallCount + 1;
    } catch {
      entry.stallCount += 1; // network hiccup counts the same as "no growth" - either way, not evidence the subagent is still working
    }
    if (!tracked.has(toolUseId)) return; // reset() ran while this fetch was in flight
    if (entry.stallCount >= STALL_POLLS_BEFORE_DONE) {
      tracked.delete(toolUseId);
      notify();
      return;
    }
    entry.timer = setTimeout(() => poll(toolUseId), POLL_MS);
  }

  // Drops every tracked call without waiting out its stall count - for a
  // session switch/gap-resend/teardown, where the toolUseIds themselves are
  // about to stop meaning anything, not just their subagents finishing.
  function reset() {
    for (const entry of tracked.values()) {
      if (entry.timer != null) clearTimeout(entry.timer);
    }
    tracked.clear();
    notify();
  }

  return { track, reset, count: () => tracked.size };
}
