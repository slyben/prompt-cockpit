// Read-only "open in new tab" viewer for a single Agent (Task) tool call -
// polls the subagent's own transcript file (src/agent-transcript.js, via
// GET /api/history/:claudeSessionId/agent/:toolUseId) and renders it with
// stream-view.js's own renderMessage, same as history-pane.js does for a
// full past session. Launched by stream-view.js's Agent-row click handler
// (see openAgentTab in app.js) via window.open, so this always runs in its
// own tab/window, never embedded in the main app shell.
import { renderMessage, resetStreamView } from '/stream-view.js';

const params = new URLSearchParams(window.location.search);
const claudeSessionId = params.get('claudeSessionId') || '';
const toolUseId = params.get('toolUseId') || '';
const label = params.get('label') || '';

const titleEl = document.getElementById('agentTitle');
const statusEl = document.getElementById('agentStatus');
const streamEl = document.getElementById('agentStream');

if (label) titleEl.textContent = label;
resetStreamView(streamEl);

// Polling, not a websocket - this transcript file is written by a
// completely separate SDK-managed process/session that this tab has no
// live connection to; a plain re-read is the only way to see it grow.
const POLL_MS = 2000;
// Stop polling once the file has stopped growing for this many consecutive
// polls - a subagent's transcript never announces "I'm done" the way a
// live session's own result message does, so "no new lines for a while" is
// the best honest signal available here without cross-referencing the
// parent session's own tool_result (which may not even be loaded in this
// tab). A manual Refresh always overrides this.
const STALL_POLLS_BEFORE_STOP = 4;

let renderedCount = 0;
let lastMtimeMs = null;
let stallCount = 0;
let stopped = false;
let timer = null;

async function poll() {
  if (!claudeSessionId || !toolUseId) {
    statusEl.textContent = 'missing session/tool id in URL';
    return;
  }
  let data;
  try {
    const qs = new URLSearchParams({}); // toolUseId/claudeSessionId already in the path
    const res = await fetch(`/api/history/${encodeURIComponent(claudeSessionId)}/agent/${encodeURIComponent(toolUseId)}?${qs}`);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || res.statusText);
    }
    data = await res.json();
  } catch (err) {
    statusEl.textContent = `error: ${err.message || err}`;
    scheduleNext();
    return;
  }

  if (data.meta) {
    const desc = data.meta.description || data.meta.agentType || 'Agent';
    titleEl.textContent = label || desc;
    titleEl.title = `${data.meta.agentType || ''} · ${data.meta.model || ''}`.trim();
  }

  const newMessages = data.messages.slice(renderedCount);
  for (const message of newMessages) {
    renderMessage(streamEl, message, {
      onRewindClick: null,
      hasFileCheckpointing: false,
      turnIndexUnreliable: true,
      assistantLabel: 'Agent',
      historical: true,
    });
  }
  renderedCount = data.messages.length;

  const grew = data.mtimeMs != null && data.mtimeMs !== lastMtimeMs;
  lastMtimeMs = data.mtimeMs;
  stallCount = grew ? 0 : stallCount + 1;

  if (renderedCount === 0 && stallCount === 0) {
    statusEl.textContent = 'waiting for the agent to start writing…';
  } else if (stallCount >= STALL_POLLS_BEFORE_STOP) {
    statusEl.textContent = `${renderedCount} message${renderedCount === 1 ? '' : 's'} · no updates for a while - stopped auto-refreshing`;
    stopped = true;
    return; // no scheduleNext - manualRefreshBtn (below) is the way back in
  } else {
    statusEl.textContent = `${renderedCount} message${renderedCount === 1 ? '' : 's'} · live`;
  }
  scheduleNext();
}

function scheduleNext() {
  if (stopped) return;
  timer = setTimeout(poll, POLL_MS);
}

// A manual way back in once auto-refresh has stopped, without a full page
// reload (which would lose scroll position for no reason).
statusEl.addEventListener('click', () => {
  if (!stopped) return;
  stopped = false;
  stallCount = 0;
  statusEl.textContent = 'refreshing…';
  poll();
});
statusEl.title = 'Click to resume auto-refresh once stopped';
statusEl.style.cursor = 'pointer';

poll();
