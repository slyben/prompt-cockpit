// Read-only transcript viewer for any session, live or past. Reuses
// stream-view.js's renderMessage so tool-call rows come free, but needs
// its own docked detail pane for clicks to land in (like the live
// #stream/#detailPane pair in app.js). tool-call-store.js's WeakMap
// keying keeps this modal isolated from whatever's showing in #stream.
import { renderMessage, resetStreamView } from '/stream-view.js';
import { appendOperatorQuery } from '/operator-auth.js';
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
  modal.addEventListener('close', () => {
    body.innerHTML = '';
    detailPane.reset(body);
  });

  function close() {
    if (modal.open) modal.close();
  }

  async function open({ sessionId, cwd, label, provider, assistantLabel }) {
    titleEl.textContent = label || sessionId;
    body.innerHTML = '<span class="tool-pending">Loading...</span>';
    detailPane.reset(body); // clear whatever the previously-viewed session (or a failed fetch) left showing before this one's data arrives
    if (!modal.open) modal.showModal();
    const qs = new URLSearchParams({ cwd: cwd || '', provider: provider || 'claude' });
    appendOperatorQuery(qs);
    if (exportButton) exportButton.href = `/api/history/${sessionId}/markdown?${qs}`;
    try {
      const res = await fetch(`/api/history/${sessionId}?${qs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const { messages } = await res.json();
      body.innerHTML = '';
      resetStreamView(body);
      // No onRewindClick, no file checkpointing, turn numbering not reliable
      // here (not a live registry row) - these just suppress the rewind
      // button, which only shows for locally-echoed messages anyway.
      // onToolCallStarted is omitted too: this is one full history render,
      // not a live stream, so nothing should be "following" the last tool call.
      for (const message of messages) {
        renderMessage(body, message, {
          onRewindClick: null,
          hasFileCheckpointing: false,
          turnIndexUnreliable: true,
          assistantLabel: assistantLabel || provider || 'Assistant',
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
