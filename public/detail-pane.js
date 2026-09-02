// Docked detail pane for the Trajectory-style tool-call rows. Shows
// Summary/Payload/Result/Timing for the selected tool call, defaulting to
// "follow the most recent call live" until a historical row is pinned.
// Also hosts two independent tabs unrelated to tool-call selection (Tasks,
// Agent), folded in here so there's one right-hand pane, not three.
import { renderBody, formatUsageInline, renderMessage, resetStreamView, langFromPath } from '/stream-view.js';
import { getToolCallRecord, getMostRecentToolCallRecord } from '/tool-call-store.js';
import { initResizablePanel } from '/resizable-panel.js';

// No Schema tab: there's no client-side tool schema registry to source
// it from, so there's nothing to render or wire.

// Matches index.html's .detail-pane min-width - kept as one number here
// rather than read back from computed style, same reasoning as compose.js's
// own MIN_HEIGHT_PX (the two only ever need to agree, not derive from
// each other).
const MIN_WIDTH_PX = 280;

// pending/in_progress first, completed last - otherwise a long-running
// session's list reads bottom-heavy with finished work pushing what's
// actually still active off the visible area. (Moved here from the old
// standalone task-panel.js when the task list became a detail-pane tab.)
const TASK_STATUS_ORDER = { in_progress: 0, pending: 1, completed: 2 };
// A shape change (hollow circle -> solid -> check) reads clearly even
// without the blink; the blink (style-panels.css's task-status-in_progress)
// is on top of this, not instead of it - the previous version relied on the
// blink alone (same colored dot for every status, just pulsing when
// running), which turned out not to be noticeable enough in practice.
const TASK_STATUS_GLYPH = { pending: '○', in_progress: '●', completed: '✓' };

// How often the Agent tab polls the subagent's own transcript file while
// it's the active tab - same interval agent-view.js used before this became
// an inline tab instead of a separate window.open'd page.
const AGENT_POLL_MS = 2000;
// Stop polling once the file has stopped growing for this many consecutive
// polls - a subagent's transcript never announces "I'm done" the way a live
// session's own result message does, so "no new lines for a while" is the
// best honest signal available without cross-referencing the parent
// session's own tool_result. Clicking the status line resumes it.
const AGENT_STALL_POLLS_BEFORE_STOP = 4;

export function initDetailPane({ panel, headerLabel, followLiveBtn, tabButtons, body, resizeHandle, initialWidth, onWidthChange, tasksToggleBtn }) {
  let enabled = true;
  let currentContainer = null;
  let pinnedId = null; // set by an explicit row click; cleared by followLive() or reset()
  let currentRecord = null;
  let activeTab = 'summary'; // 'summary' | 'payload' | 'result' | 'timing' | 'tasks' | 'agent'
  let tasks = [];
  const tasksTabButton = tabButtons.find((b) => b.dataset.tab === 'tasks') || null;
  const agentTabButton = tabButtons.find((b) => b.dataset.tab === 'agent') || null;

  // Agent tab state - set by showAgent(), polled independently of the
  // tool-call live-follow machinery above (a subagent's transcript is a
  // completely separate file this pane just tails, see agentPoll() below).
  let agent = null; // { claudeSessionId, toolUseId, label, renderedCount, lastMtimeMs, stallCount, stopped, timer, pollId }
  let agentPollCounter = 0; // bumped on every showAgent() call so a stale in-flight fetch from a previous agent can't paint over a newer one
  // Set by showText() - a plain-text view that bypasses the tool-call tabs
  // entirely. Reuses `pinnedId` for the same "something specific is pinned,
  // don't auto-follow live tool calls" gating tool rows already get; cleared
  // by anything that goes back to tool-call mode (selectToolCall, followLive,
  // reset), same as currentRecord.
  let textView = null; // { id, label, text } | null

  function setContainer(container) {
    currentContainer = container;
  }

  // Drag-to-resize, mirrored horizontally from compose.js's handle: the pane
  // is right-docked, so dragging left grows it (inverted delta). Below the
  // app's 900px responsive breakpoint (which stacks the pane full-width
  // instead of docking it) this must stay a no-op - an inline width would
  // otherwise beat that breakpoint's `width: 100%` rule and break the layout.
  const isNarrowLayout = () => window.matchMedia('(max-width: 900px)').matches;

  // Keeps --detail-pane-offset (style.css) equal to the pane's real
  // on-screen width so #approvalBanner/#compose stop at #stream's right
  // edge instead of running full width underneath the docked pane. 0
  // whenever the pane isn't taking up horizontal space: disabled, or the
  // narrow-viewport breakpoint stacked it below #stream instead.
  function syncOffset() {
    const offset = enabled && !isNarrowLayout() ? panel.getBoundingClientRect().width : 0;
    document.documentElement.style.setProperty('--detail-pane-offset', `${offset}px`);
  }

  // Sets the persisted width (if any) synchronously, before the first
  // syncOffset() call measures the panel - resizable-panel.js only touches
  // panel.style.width, not --detail-pane-offset. Later drags are caught by
  // the ResizeObserver below; ordering only matters for this first call, so
  // it sees the real initial width, not the pre-resize CSS default.
  initResizablePanel({ panel, handle: resizeHandle, minWidthPx: MIN_WIDTH_PX, initialWidth, onWidthChange, isNarrowLayout });

  syncOffset();
  window.addEventListener('resize', syncOffset);
  // The explicit syncOffset() calls above only cover timing gaps caught in
  // the wild - anything slipping through them would leave the offset stale.
  // A ResizeObserver needs no call site: it fires on any real size change.
  // Kept alongside the explicit calls, since those also encode the
  // isNarrowLayout() 0-when-stacked case a bare resize can't.
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(syncOffset).observe(panel);
  }

  // Explicit click on a row - always pins, whether the row clicked is the
  // live one or a historical one. Re-clicking the already-pinned row is a
  // harmless no-op (same record, re-renders identically).
  function selectToolCall(container, id) {
    const record = getToolCallRecord(container, id);
    if (!record) return;
    textView = null; // clicking a tool row always exits text mode, if it was showing
    pinnedId = id;
    currentContainer = container;
    currentRecord = record;
    highlightRow(record);
    // An explicit click on a tool-call row is a direct request to see it -
    // bring the pane back from Tasks/Agent if that's what it was showing,
    // same reasoning as clearing textView above.
    if (activeTab === 'tasks' || activeTab === 'agent') { setActiveTab('summary'); return; }
    render();
  }

  // Delegated-reply "full trace" button (stream-view.js's attachDelegatedTrace)
  // - shows arbitrary plain text instead of a tool-call record. `id` is the
  // delegated turn's queueId, reused as pinnedId so a live tool call arriving
  // while this is open doesn't yank the pane away (same reasoning as pinning
  // a historical tool row).
  function showText(container, id, label, text) {
    pinnedId = id;
    currentContainer = container;
    currentRecord = null;
    textView = { id, label, text };
    updateLiveIndicator();
    if (activeTab === 'tasks' || activeTab === 'agent') { setActiveTab('summary'); return; }
    render();
  }

  // Called by stream-view.js the moment a new tool_use row is created.
  // Auto-follows unless the user has deliberately pinned a historical row -
  // yanking their view away from what they clicked to inspect would defeat
  // the point of pinning.
  function onToolCallStarted(container, record) {
    currentContainer = container;
    if (pinnedId != null) {
      updateLiveIndicator();
      return;
    }
    currentRecord = record;
    highlightRow(record);
    render();
  }

  // Called by stream-view.js when a tool_result lands - refreshes the pane
  // only if it's currently showing that exact record (so duration/result
  // text update live without stealing focus from a pinned different row).
  function onToolResultArrived(container, id) {
    if (currentRecord && currentRecord.id === id) render();
  }

  function followLive() {
    pinnedId = null;
    textView = null;
    const record = currentContainer ? getMostRecentToolCallRecord(currentContainer) : null;
    if (record) {
      currentRecord = record;
      highlightRow(record);
    }
    render();
  }

  // Only lights up when the pin is genuinely behind the newest tool call -
  // not just "something is pinned". Pinning the currently-live row itself
  // (clicking it to read its payload while it's still the most recent one)
  // shouldn't make "live" look like there's somewhere newer to jump to.
  function updateLiveIndicator() {
    if (!followLiveBtn) return;
    const mostRecent = currentContainer ? getMostRecentToolCallRecord(currentContainer) : null;
    const behindLive = pinnedId != null && mostRecent != null && pinnedId !== mostRecent.id;
    followLiveBtn.classList.toggle('pinned-away', behindLive);
  }

  function highlightRow(record) {
    if (currentContainer) {
      currentContainer.querySelectorAll('.tool-row.selected').forEach((el) => el.classList.remove('selected'));
    }
    record.rowEl?.classList.add('selected');
    updateLiveIndicator();
  }

  function renderEmpty() {
    headerLabel.textContent = 'No tool call selected yet';
    body.textContent = '';
    const placeholder = document.createElement('div');
    placeholder.className = 'detail-pane-placeholder';
    placeholder.textContent = 'No tool call selected yet.';
    body.append(placeholder);
  }

  function renderTextView(view) {
    headerLabel.textContent = view.label;
    body.textContent = '';
    const wrap = document.createElement('div');
    wrap.className = 'body';
    // Markdown-rendered, same as a live assistant reply (stream-view.js's
    // appendBlock call for block.text) - this is a delegated session's own
    // narration/answer text, which is itself markdown, not a diff/plain-text
    // tool payload (renderBody's other caller shape).
    renderBody(wrap, view.text, null, true);
    body.append(wrap);
  }

  function render() {
    if (!enabled) return;
    // No tabs make sense for a plain-text view - CSS keys off this class to
    // hide the tab row entirely while textView is showing.
    panel.classList.toggle('text-mode', Boolean(textView));
    if (textView) { renderTextView(textView); return; }
    // Tasks/Agent are independent of the tool-call-record machinery below -
    // they stay on whatever they last showed regardless of which tool call
    // is currently live, same as textView above.
    if (activeTab === 'tasks') { renderTasksTab(); return; }
    if (activeTab === 'agent') { renderAgentTab(); return; }
    if (!currentRecord) { renderEmpty(); return; }
    const statusGlyph = currentRecord.status === 'pending' ? '…' : currentRecord.status === 'error' ? '✗' : '✓';
    headerLabel.textContent = `${currentRecord.name} ${statusGlyph}`;
    body.textContent = '';
    switch (activeTab) {
      case 'summary': renderSummaryTab(currentRecord); break;
      case 'payload': renderPayloadTab(currentRecord); break;
      case 'result': renderResultTab(currentRecord); break;
      case 'timing': renderTimingTab(currentRecord); break;
      default: renderSummaryTab(currentRecord);
    }
  }

  function line(text, cls) {
    const div = document.createElement('div');
    if (cls) div.className = cls;
    div.textContent = text;
    body.append(div);
  }

  function renderSummaryTab(record) {
    line(`Tool: ${record.name}`);
    line(`Kind: ${record.kind}`);
    line(`Status: ${record.status}`);
    const usageText = formatUsageInline(record.usage);
    if (usageText) {
      line(`Usage: ${usageText}`);
      // Anthropic doesn't sub-divide cost/tokens per tool call - one
      // assistant API turn's figure is shared by every tool_use block that
      // turn emitted. Surface that honestly instead of implying a real
      // per-tool split (same reasoning stream-view.js's own module comment
      // already documents for the shared _usageInfo object).
      line('(Cost/tokens are for the whole API turn - may cover other tool calls made in the same response. The SDK does not report per-tool-call figures.)', 'detail-pane-note');
    }

    // Inline preview: only worth it when both payload and result are short
    // enough to read at a glance without duplicating the Payload/Result tabs.
    // Below the threshold, show both in full (reusing renderBody for diff
    // coloring); above it, or while the result hasn't arrived yet, say nothing
    // here - the dedicated tabs are one click away.
    if (record.resultText == null) return; // pending - nothing to preview yet
    const payloadText = payloadToPlainText(record.payload);
    const resultText = record.resultText;
    if (!fitsInline(payloadText) || !fitsInline(resultText)) return;

    line('');
    line('Payload:', 'detail-pane-section-label');
    const payloadWrap = document.createElement('div');
    payloadWrap.className = 'body';
    renderBody(payloadWrap, record.payload);
    body.append(payloadWrap);

    line('');
    line('Result:', 'detail-pane-section-label');
    const resultWrap = document.createElement('div');
    resultWrap.className = 'body';
    renderBody(resultWrap, resultBody(record));
    body.append(resultWrap);
  }

  // record.payload is a plain string, formatToolInput's { lines, lang } diff
  // shape, or its { header, code, lang } single-block shape (see
  // stream-view.js) - flatten to plain text for the fits-inline size check,
  // same content renderBody would paint either way.
  function payloadToPlainText(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload.lines)) return payload.lines.map((l) => l.text).join('\n');
    if (typeof payload.code === 'string') return payload.header ? `${payload.header}\n${payload.code}` : payload.code;
    return '';
  }

  // Fixed thresholds rather than measuring the pane's actual rendered
  // height - simpler, and "does this look like a quick summary or a wall of
  // text" doesn't really change with the pane's current drag-resized width.
  const INLINE_PREVIEW_MAX_CHARS = 600;
  const INLINE_PREVIEW_MAX_LINES = 16;
  function fitsInline(text) {
    if (!text) return true; // empty payload/result is trivially "fits"
    return text.length <= INLINE_PREVIEW_MAX_CHARS && text.split('\n').length <= INLINE_PREVIEW_MAX_LINES;
  }

  function renderPayloadTab(record) {
    // formatToolInput()'s output (record.payload) is either a plain string
    // or the {lines:[...]} diff shape - renderBody (exported from
    // stream-view.js) already knows how to render both, reused as-is rather
    // than duplicating the diff-coloring logic here.
    const wrap = document.createElement('div');
    wrap.className = 'body';
    renderBody(wrap, record.payload);
    body.append(wrap);
  }

  function renderResultTab(record) {
    if (record.resultText == null) { line('(pending - waiting for the tool result)', 'detail-pane-note'); return; }
    const wrap = document.createElement('div');
    wrap.className = 'body';
    renderBody(wrap, resultBody(record));
    body.append(wrap);
  }

  // Read/Edit/Write/NotebookRead results are the file's own content - same
  // Prism.js highlighting the payload side gets, keyed off the tool's own
  // file_path input rather than sniffing the result text. Anything without
  // a recognizable file_path/extension (Bash stdout, Grep matches, WebFetch
  // bodies, ...) just stays plain text.
  function resultBody(record) {
    const lang = langFromPath(record.input && record.input.file_path);
    if (!lang) return record.resultText;
    return { code: record.resultText, lang };
  }

  function formatClockMs(ms) {
    const d = new Date(ms);
    return `${d.toLocaleTimeString([], { hour12: false })}.${String(d.getMilliseconds()).padStart(3, '0')}`;
  }

  function formatDuration(ms) {
    return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
  }

  function renderTimingTab(record) {
    // startedAtMs/resultAtMs are null when this row came from a historical
    // batch render (prependHistory/history-pane.js) with no message
    // timestamp to fall back on - showing "0ms" there would be a fabricated
    // number (the render loop has no real per-call elapsed time to measure),
    // so this shows an honest "unknown" instead. See tool-call-store.js.
    line(`Row rendered:   ${record.startedAtMs != null ? formatClockMs(record.startedAtMs) : '(unknown - no timestamp recorded for this render)'}`);
    if (record.resultAtMs != null && record.startedAtMs != null) {
      line(`Result arrived: ${formatClockMs(record.resultAtMs)}`);
      line(`Client-observed duration: ${formatDuration(record.resultAtMs - record.startedAtMs)}`);
    } else if (record.status === 'pending') {
      line('Result arrived: (pending)');
    } else {
      line('Result arrived: (unknown - no timestamp recorded for this render)');
    }
    line('');
    line('Measured in the browser (render time to result-received time), including network and render lag - not the tool\'s actual server-side execution time. Historical/replayed rows may show no duration at all if no per-call timestamp was available to measure from.', 'detail-pane-note');
  }

  // --- Tasks tab (folded in from the old standalone task-panel.js) ---

  function renderTasksTab() {
    headerLabel.textContent = 'Tasks';
    body.textContent = '';
    if (!tasks.length) { line('No tasks yet.', 'detail-pane-note'); return; }
    const ul = document.createElement('ul');
    ul.className = 'task-list';
    [...tasks]
      .sort((a, b) => (TASK_STATUS_ORDER[a.status] ?? 3) - (TASK_STATUS_ORDER[b.status] ?? 3))
      .forEach((task) => ul.append(renderTaskRow(task)));
    body.append(ul);
  }

  function renderTaskRow(task) {
    const li = document.createElement('li');
    li.className = 'task-row';

    const dot = document.createElement('span');
    dot.className = `task-status task-status-${task.status}`;
    dot.textContent = TASK_STATUS_GLYPH[task.status] || TASK_STATUS_GLYPH.pending;
    dot.title = task.status;
    li.append(dot);

    const subject = document.createElement('span');
    subject.className = task.status === 'completed' ? 'task-subject task-subject-done' : 'task-subject';
    subject.textContent = task.subject;
    li.append(subject);

    if (task.owner) {
      const owner = document.createElement('span');
      owner.className = 'task-owner';
      owner.textContent = task.owner;
      li.append(owner);
    }

    if (task.blockedBy && task.blockedBy.length) {
      const blocked = document.createElement('span');
      blocked.className = 'task-blocked';
      blocked.textContent = `blocked by ${task.blockedBy.length}`;
      li.append(blocked);
    }

    return li;
  }

  // Called on every cockpit:tasks push (app.js) - always the full current
  // list (never a delta), so this just replaces and re-renders when the
  // Tasks tab is the one currently showing.
  function setTasks(next) {
    tasks = next || [];
    // "Hidden until proven relevant, never re-hidden" - doesn't force-hide
    // again once a task list empties back out; a session that's used the
    // feature once keeps the entry point. Auto-switches into the Tasks tab
    // only on the 0 -> >0 transition (first reveal); later updates just
    // re-render in place without stealing focus mid-inspection.
    if (tasks.length > 0 && tasksTabButton && tasksTabButton.hidden) {
      tasksTabButton.hidden = false;
      if (tasksToggleBtn) tasksToggleBtn.hidden = false;
      setActiveTab('tasks');
      return;
    }
    if (activeTab === 'tasks') render();
  }

  // Entry point for both the in-tab-row "Tasks" button and the agentsBar's
  // own taskPanelToggleBtn (index.html) - either one just jumps here.
  function showTasks() {
    if (tasksTabButton) tasksTabButton.hidden = false;
    if (tasksToggleBtn) tasksToggleBtn.hidden = false;
    setActiveTab('tasks');
  }

  // --- Agent tab: polls the subagent's own transcript file (GET
  // /api/history/:id/agent/:toolUseId) since it's written by a completely
  // separate SDK-managed process/session this pane has no live connection
  // to - a plain re-read on an interval is the only way to see it grow. ---

  function renderAgentTab() {
    headerLabel.textContent = (agent && agent.label) || 'Agent';
    body.textContent = '';
    if (!agent) { line('No agent selected.', 'detail-pane-note'); return; }
    body.append(agent.container);
  }

  function showAgent(claudeSessionId, toolUseId, label) {
    stopAgentPoll(); // clears whatever agent was previously polling, if any
    agentPollCounter += 1;
    const pollId = agentPollCounter;
    const statusEl = document.createElement('div');
    statusEl.className = 'agent-status';
    statusEl.textContent = 'connecting…';
    statusEl.title = 'Click to resume auto-refresh once stopped';
    statusEl.addEventListener('click', () => {
      if (!agent || agent.pollId !== pollId || !agent.stopped) return;
      agent.stopped = false;
      agent.stallCount = 0;
      statusEl.textContent = 'refreshing…';
      agentPoll(pollId);
    });
    const streamEl = document.createElement('div');
    streamEl.className = 'body agent-stream';
    resetStreamView(streamEl);
    const container = document.createElement('div');
    container.append(statusEl, streamEl);

    agent = {
      claudeSessionId, toolUseId, label: label || '',
      renderedCount: 0, lastMtimeMs: null, stallCount: 0, stopped: false,
      timer: null, pollId, statusEl, streamEl, container,
    };
    if (agentTabButton) agentTabButton.hidden = false;
    setActiveTab('agent');
    agentPoll(pollId);
  }

  async function agentPoll(pollId) {
    if (!agent || agent.pollId !== pollId) return; // superseded by a newer showAgent() call
    if (!agent.claudeSessionId || !agent.toolUseId) {
      agent.statusEl.textContent = 'missing session/tool id';
      return;
    }
    let data;
    try {
      const res = await fetch(`/api/history/${encodeURIComponent(agent.claudeSessionId)}/agent/${encodeURIComponent(agent.toolUseId)}`);
      if (!res.ok) {
        const errBody = await res.json().catch(() => ({}));
        throw new Error(errBody.error || res.statusText);
      }
      data = await res.json();
    } catch (err) {
      if (!agent || agent.pollId !== pollId) return; // showAgent() moved on while this fetch was in flight
      agent.statusEl.textContent = `error: ${err.message || err}`;
      scheduleAgentPoll(pollId);
      return;
    }
    if (!agent || agent.pollId !== pollId) return;

    if (data.meta) {
      const desc = data.meta.description || data.meta.agentType || 'Agent';
      if (!agent.label) { agent.label = desc; if (activeTab === 'agent') headerLabel.textContent = agent.label; }
      agent.streamEl.title = `${data.meta.agentType || ''} · ${data.meta.model || ''}`.trim();
    }

    const wasAtBottom = isScrolledToBottomLocal(body);
    const newMessages = data.messages.slice(agent.renderedCount);
    for (const message of newMessages) {
      renderMessage(agent.streamEl, message, {
        onRewindClick: null, hasFileCheckpointing: false, turnIndexUnreliable: true,
        assistantLabel: 'Agent', historical: true,
      });
    }
    agent.renderedCount = data.messages.length;
    if (newMessages.length && activeTab === 'agent' && wasAtBottom) body.scrollTop = body.scrollHeight;

    const grew = data.mtimeMs != null && data.mtimeMs !== agent.lastMtimeMs;
    agent.lastMtimeMs = data.mtimeMs;
    agent.stallCount = grew ? 0 : agent.stallCount + 1;

    if (agent.renderedCount === 0 && agent.stallCount === 0) {
      agent.statusEl.textContent = 'waiting for the agent to start writing…';
    } else if (agent.stallCount >= AGENT_STALL_POLLS_BEFORE_STOP) {
      agent.statusEl.textContent = `${agent.renderedCount} message${agent.renderedCount === 1 ? '' : 's'} · no updates for a while - click to resume`;
      agent.stopped = true;
      return; // no scheduleAgentPoll - the status-line click handler above is the way back in
    } else {
      agent.statusEl.textContent = `${agent.renderedCount} message${agent.renderedCount === 1 ? '' : 's'} · live`;
    }
    scheduleAgentPoll(pollId);
  }

  function scheduleAgentPoll(pollId) {
    if (!agent || agent.pollId !== pollId || agent.stopped) return;
    if (agent.timer != null) clearTimeout(agent.timer);
    agent.timer = setTimeout(() => agentPoll(pollId), AGENT_POLL_MS);
  }

  function stopAgentPoll() {
    if (agent && agent.timer != null) clearTimeout(agent.timer);
    if (agent) agent.timer = null;
  }

  // Local helper, distinct from stream-view.js's exported isScrolledToBottom
  // - that one measures a message-list container; this measures the pane's
  // own scroll box (#detailPaneBody), which is what actually scrolls here.
  function isScrolledToBottomLocal(container) {
    return container.scrollHeight - container.scrollTop - container.clientHeight < 48;
  }

  function setActiveTab(name) {
    activeTab = name;
    for (const b of tabButtons) {
      const on = b.dataset.tab === name;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (tasksToggleBtn) {
      tasksToggleBtn.classList.toggle('on', name === 'tasks');
      tasksToggleBtn.setAttribute('aria-pressed', name === 'tasks' ? 'true' : 'false');
    }
    render();
  }

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => setActiveTab(btn.dataset.tab));
  }

  if (followLiveBtn) followLiveBtn.addEventListener('click', followLive);

  function setEnabled(next) {
    enabled = next;
    panel.classList.toggle('enabled', enabled);
    if (enabled) render();
    syncOffset();
  }

  function reset(container) {
    currentContainer = container;
    pinnedId = null;
    currentRecord = null;
    textView = null;
    activeTab = 'summary';
    tasks = [];
    stopAgentPoll();
    agent = null;
    if (tasksTabButton) tasksTabButton.hidden = true;
    if (tasksToggleBtn) tasksToggleBtn.hidden = true;
    if (agentTabButton) agentTabButton.hidden = true;
    for (const b of tabButtons) {
      const on = b.dataset.tab === 'summary';
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    }
    if (tasksToggleBtn) {
      tasksToggleBtn.classList.remove('on');
      tasksToggleBtn.setAttribute('aria-pressed', 'false');
    }
    updateLiveIndicator();
    renderEmpty();
  }

  renderEmpty();

  return {
    setContainer,
    selectToolCall,
    showText,
    onToolCallStarted,
    onToolResultArrived,
    followLive,
    setEnabled,
    reset,
    setTasks,
    showTasks,
    showAgent,
    isEnabled: () => enabled,
    // Exposed for app.js: setEnabled()'s own syncOffset() fires before
    // #streamWrap is flipped back to display:flex, so it measures a
    // zero-width panel and leaves --detail-pane-offset stuck at 0 - the
    // approval banner/#compose then run full viewport width under the docked
    // pane. app.js calls this again once streamWrapEl is actually visible.
    syncOffset,
  };
}
