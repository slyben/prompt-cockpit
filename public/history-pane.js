// Read-only transcript viewer for any session, live or past (plan MVP4).
// Reuses stream-view.js's renderMessage rather than a second renderer -
// same reasoning as the plan's "reuse claude-realtime-usage's renderer,
// don't reinvent it", just applied to this project's own renderer instead.
// Trajectory-style tool-call rows (see stream-view.js's module comment) come
// along for free via that same renderMessage call - the only extra wiring
// this file needs is its own docked detail pane so clicking one of those
// rows here has somewhere to land, same as the live #stream/#detailPane pair
// in app.js. tool-call-store.js's WeakMap-per-container keying keeps this
// modal's records isolated from whatever's showing live in #stream.
import { renderMessage, resetStreamView } from '/stream-view.js';
import { initDetailPane } from '/detail-pane.js';

export function initHistoryPane({ modal, body, closeButton, titleEl, exportButton }) {
  const detailPane = initDetailPane({
    panel: document.getElementById('historyDetailPane'),
    headerLabel: document.getElementById('historyDetailPaneLabel'),
    followLiveBtn: document.getElementById('historyDetailPaneFollowLiveBtn'),
    tabButtons: [...modal.querySelectorAll('#historyDetailPane .detail-tab')],
    body: document.getElementById('historyDetailPaneBody'),
  });

  closeButton.addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  function close() {
    modal.style.display = 'none';
    body.innerHTML = '';
    detailPane.reset(body); // don't leave this session's payload/result sitting next to whatever opens next
  }

  async function open({ sessionId, cwd, label, provider }) {
    titleEl.textContent = label || sessionId;
    body.innerHTML = '<span class="tool-pending">Loading...</span>';
    detailPane.reset(body); // clear whatever the previously-viewed session (or a failed fetch) left showing before this one's data arrives
    modal.style.display = 'flex';
    const qs = new URLSearchParams({ cwd: cwd || '', provider: provider || 'claude' });
    if (exportButton) exportButton.href = `/api/history/${sessionId}/markdown?${qs}`;
    try {
      const res = await fetch(`/api/history/${sessionId}?${qs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const { messages } = await res.json();
      body.innerHTML = '';
      resetStreamView(body);
      // detailPane.reset(body) already ran at the top of open() - no need to
      // repeat it here now that the fetch succeeded.
      // No onRewindClick, no file checkpointing, turn numbering not
      // reliable here (this isn't a live registry row) - all three flags
      // just suppress the rewind button, which renderUser also only shows
      // for locally-echoed messages (message.turnIndex) that a fetched
      // transcript never has anyway. Belt and suspenders.
      //
      // onToolCallStarted is deliberately omitted (unlike the live
      // renderMessage call site in app.js) - this whole transcript is
      // history rendered in one pass, wiring it would just leave the pane
      // "following" whichever tool call happens to be last in the array,
      // not something worth calling live. onSelectToolCall (click to pin)
      // is the only interaction that makes sense here.
      for (const message of messages) {
        renderMessage(body, message, {
          onRewindClick: null,
          hasFileCheckpointing: false,
          turnIndexUnreliable: true,
          assistantLabel: provider === 'grok' ? 'Grok' : 'Claude',
          historical: true, // a fetched transcript, not a live stream - see appendToolCallRow's historical branch
          onSelectToolCall: (container, id) => detailPane.selectToolCall(container, id),
        });
      }
      if (!messages.length) {
        const empty = document.createElement('span');
        empty.className = 'tool-pending';
        empty.textContent = '(empty transcript)';
        body.replaceChildren(empty);
      }
    } catch (err) {
      // err.message is usually just a UUID (src/routes/history.js's error
      // field), but it's still server/SDK-originated text, not a literal -
      // build this via textContent rather than innerHTML like every other
      // error block (stream-view.js's appendBlock) instead of being the one
      // innerHTML-with-untrusted-text spot in the renderer.
      const wrap = document.createElement('span');
      wrap.className = 'msg error';
      const bodyText = document.createElement('span');
      bodyText.className = 'body';
      bodyText.textContent = `Could not load history: ${String((err && err.message) || err)}`;
      wrap.append(bodyText);
      body.replaceChildren(wrap);
    }
  }

  return { open, close };
}
