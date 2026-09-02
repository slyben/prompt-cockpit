// Cross-session delegation (`/ask <Name>: <text>`) message rendering,
// mirroring src/delegation.js's server-side split via the same
// appendBlock/closeGroup injection shape. session-registry.js wraps each
// exchange in a prose header before pushing it as a plain user turn; this
// regex unwraps it so the bubble doesn't show "You" for unaffiliated text.
const DELEGATED_HEADER_RE = /^\[Prompt Cockpit\] Relayed (task|reply) from "([^"]*)"\n\n[\s\S]*?\n---\n([\s\S]*)$/;

export function createDelegateView({ appendBlock, closeGroup }) {
  // Delegated-reply bubbles awaiting a possible cockpit:delegate-full-trace
  // marker - container -> Map<queueId, roleRowEl>. The marker always
  // arrives after the bubble it belongs to (the turn echoes synchronously
  // before the marker broadcasts), so there's no "marker beats bubble"
  // race - only "marker never comes" (no extra content beyond the answer).
  const delegatedBubblesByContainer = new WeakMap();

  // Call once per fresh session view (stream-view.js's resetStreamView does
  // this) so stale bubble references from a previous session don't linger.
  function reset(container) {
    delegatedBubblesByContainer.set(container, new Map());
  }

  // `kind` distinguishes the two delegation directions so the caller can style
  // them differently: a 'task' is real input relayed from another human, so
  // it stays a "user" bubble. A 'reply' is another session's own answer
  // forwarded back, so it renders like an assistant response instead.
  function delegatedLabelAndText(text) {
    const match = DELEGATED_HEADER_RE.exec(text);
    if (match) return { kind: match[1], label: match[2], text: match[3] };
    return null;
  }

  // Remembers a just-rendered delegated-reply bubble so a later
  // cockpit:delegate-full-trace marker (see attachDelegatedTrace below) can
  // find it again. `queueId` is null for anything that isn't this session's
  // own live pushInput echo - harmless no-op, since relayDelegationResult
  // only ever mints a marker for a queueId it minted itself.
  function registerDelegatedReplyBubble(container, queueId, wrap) {
    if (queueId == null) return;
    if (!delegatedBubblesByContainer.has(container)) delegatedBubblesByContainer.set(container, new Map());
    delegatedBubblesByContainer.get(container).set(queueId, wrap);
  }

  // cockpit:delegate-full-trace marker handler - adds a corner button to the
  // matching delegated-reply bubble that opens the full (narration-included)
  // text in the detail pane. No bubble found is a silent no-op, not an
  // error: the marker always arrives after its bubble, so a miss here just
  // means the bubble's container was reset/replaced - the marker is stale.
  function attachDelegatedTrace(container, queueId, label, text, onShowDelegatedTrace) {
    const bubbles = delegatedBubblesByContainer.get(container);
    const wrap = bubbles?.get(queueId);
    if (!wrap) return;
    const roleRow = wrap.querySelector(':scope > .role');
    if (roleRow) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'trace-toggle-btn';
      btn.textContent = '⤢ Expand answer';
      btn.title = 'Show the full reply (narration included) - by default only the final answer is relayed into this session';
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        onShowDelegatedTrace?.(container, queueId, label, text);
      });
      roleRow.append(btn);
    }
    bubbles.delete(queueId); // one marker per bubble - nothing left to match if another somehow arrived for the same id
  }

  // renderMessage's 'cockpit:delegate-sent' case - cockpit-only marker, never
  // a real SDK message, appended straight to the origin's own eventLog by
  // session-registry.js's delegateTask so it survives reconnect. Minimal/
  // textual per the confirmed v1 scope - no special styling beyond the
  // existing 'system' block class.
  function renderDelegateSent(container, message, timestampMs) {
    closeGroup(container);
    return appendBlock(container, 'system', 'Delegated', `-> Asked ${message.targetName}: ${message.text}`, [], container, null, null, timestampMs);
  }

  // renderMessage's 'cockpit:delegate-full-trace' case - cockpit-only marker,
  // never a real SDK message, appended straight to the origin's own eventLog
  // by session-registry.js's relayDelegationResult so it survives reconnect.
  // Purely additive UI: attaches a button to an already-rendered bubble,
  // renders nothing of its own.
  function renderDelegateFullTrace(container, message, onShowDelegatedTrace) {
    return attachDelegatedTrace(container, message.queueId, message.label, message.text, onShowDelegatedTrace);
  }

  return {
    reset,
    delegatedLabelAndText,
    registerDelegatedReplyBubble,
    renderDelegateSent,
    renderDelegateFullTrace,
  };
}
