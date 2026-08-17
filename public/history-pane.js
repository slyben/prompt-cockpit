// Read-only transcript viewer for any session, live or past (plan MVP4).
// Reuses stream-view.js's renderMessage rather than a second renderer -
// same reasoning as the plan's "reuse claude-realtime-usage's renderer,
// don't reinvent it", just applied to this project's own renderer instead.
import { renderMessage, resetStreamView } from '/stream-view.js';

export function initHistoryPane({ modal, body, closeButton, titleEl, exportButton }) {
  closeButton.addEventListener('click', close);
  modal.addEventListener('click', (event) => {
    if (event.target === modal) close();
  });

  function close() {
    modal.style.display = 'none';
    body.innerHTML = '';
  }

  async function open({ sessionId, cwd, label, provider }) {
    titleEl.textContent = label || sessionId;
    body.innerHTML = '<span class="tool-pending">Loading...</span>';
    modal.style.display = 'flex';
    const qs = new URLSearchParams({ cwd: cwd || '', provider: provider || 'claude' });
    if (exportButton) exportButton.href = `/api/history/${sessionId}/markdown?${qs}`;
    try {
      const res = await fetch(`/api/history/${sessionId}?${qs}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
      const { messages } = await res.json();
      body.innerHTML = '';
      resetStreamView(body);
      // No onRewindClick, no file checkpointing, turn numbering not
      // reliable here (this isn't a live registry row) - all three flags
      // just suppress the rewind button, which renderUser also only shows
      // for locally-echoed messages (message.turnIndex) that a fetched
      // transcript never has anyway. Belt and suspenders.
      for (const message of messages) {
        renderMessage(body, message, {
          onRewindClick: null,
          hasFileCheckpointing: false,
          turnIndexUnreliable: true,
          assistantLabel: provider === 'grok' ? 'Grok' : 'Claude',
        });
      }
      if (!messages.length) body.innerHTML = '<span class="tool-pending">(empty transcript)</span>';
    } catch (err) {
      body.innerHTML = `<span class="msg error"><span class="body">Could not load history: ${String(err.message || err)}</span></span>`;
    }
  }

  return { open, close };
}
