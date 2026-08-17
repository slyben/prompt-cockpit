// Docked detail pane for the Trajectory-style tool-call rows (stream-view.js).
// Shows Summary/Payload/Result/Timing for whichever tool call is selected -
// defaults to "follow the most recent tool call live", switches to a pinned
// historical row on click. Mirrors turn-chart.js's shape: init*(...) closing
// over its DOM refs and returning a small method bag, no global event bus.
import { renderBody, formatUsageInline } from '/stream-view.js';
import { getToolCallRecord, getMostRecentToolCallRecord } from '/tool-call-store.js';

// v1 has no Schema tab (Decision 4) - no client-side tool schema registry
// exists to source it from. Nothing to render, nothing to wire.

// Matches index.html's .detail-pane min-width - kept as one number here
// rather than read back from computed style, same reasoning as compose.js's
// own MIN_HEIGHT_PX (the two only ever need to agree, not derive from
// each other).
const MIN_WIDTH_PX = 280;

export function initDetailPane({ panel, headerLabel, followLiveBtn, tabButtons, body, resizeHandle, initialWidth, onWidthChange }) {
  let enabled = true;
  let currentContainer = null;
  let pinnedId = null; // set by an explicit row click; cleared by followLive() or reset()
  let currentRecord = null;
  let activeTab = 'summary'; // 'summary' | 'payload' | 'result' | 'timing'

  function setContainer(container) {
    currentContainer = container;
  }

  // Drag-to-resize (same pattern as compose.js's #composeResizeHandle,
  // mirrored horizontally: the pane is right-docked, so dragging the handle
  // left grows it - inverted delta from a normal left-edge resize). Below
  // the app's one responsive breakpoint (index.html's @media max-width:900px,
  // which stacks the pane full-width below #stream instead of docking it
  // beside it) this is a no-op: setting an inline width there would win over
  // that breakpoint's `width: 100%` rule (inline style beats any class/id
  // selector), silently breaking the narrow-viewport layout for a pane
  // that's still holding a wide desktop width from before the window shrank.
  const isNarrowLayout = () => window.matchMedia('(max-width: 900px)').matches;

  if (initialWidth != null && !isNarrowLayout()) {
    panel.style.width = `${Math.max(initialWidth, MIN_WIDTH_PX)}px`;
  }

  if (resizeHandle) {
    let dragStartX = null;
    let dragStartWidth = null;

    resizeHandle.addEventListener('mousedown', (event) => {
      if (isNarrowLayout()) return; // handle is visually still there but inert in the stacked layout
      event.preventDefault(); // don't let the drag start a text selection
      dragStartX = event.clientX;
      dragStartWidth = panel.getBoundingClientRect().width;
      document.addEventListener('mousemove', onDragMove);
      document.addEventListener('mouseup', onDragEnd);
    });

    function onDragMove(event) {
      const maxPx = window.innerWidth * 0.7; // leaves #stream at least 30% of the viewport, same spirit as compose.js's 50vh cap on the other axis
      // Dragging left (clientX decreases) grows the box - delta is inverted
      // relative to a normal right-edge-of-a-left-docked-panel resize.
      const target = Math.min(Math.max(dragStartWidth + (dragStartX - event.clientX), MIN_WIDTH_PX), maxPx);
      panel.style.width = `${target}px`;
    }

    function onDragEnd() {
      document.removeEventListener('mousemove', onDragMove);
      document.removeEventListener('mouseup', onDragEnd);
      // Persisted once per drag (not per mousemove) - onWidthChange is
      // app.js's patchSettings() call, cheap but no reason to hammer
      // localStorage dozens of times a second while dragging.
      onWidthChange?.(Math.round(panel.getBoundingClientRect().width));
    }
  }

  // Explicit click on a row - always pins, whether the row clicked is the
  // live one or a historical one. Re-clicking the already-pinned row is a
  // harmless no-op (same record, re-renders identically).
  function selectToolCall(container, id) {
    const record = getToolCallRecord(container, id);
    if (!record) return;
    pinnedId = id;
    currentContainer = container;
    currentRecord = record;
    highlightRow(record);
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

  function render() {
    if (!enabled) return;
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
    // enough to read at a glance without turning the Summary tab into a
    // scroll-fest that duplicates the Payload/Result tabs. Below the
    // threshold, show both in full (reusing renderBody for diff coloring);
    // above it, or while the result hasn't arrived yet, say nothing here -
    // the dedicated tabs are one click away.
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
    renderBody(resultWrap, record.resultText);
    body.append(resultWrap);
  }

  // record.payload is either a plain string or formatToolInput's
  // { lines: [{ text, cls }] } diff shape (see stream-view.js) - flatten to
  // plain text for the fits-inline size check, same content renderBody would
  // paint either way.
  function payloadToPlainText(payload) {
    if (payload == null) return '';
    if (typeof payload === 'string') return payload;
    if (Array.isArray(payload.lines)) return payload.lines.map((l) => l.text).join('\n');
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
    renderBody(wrap, record.resultText);
    body.append(wrap);
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

  for (const btn of tabButtons) {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      for (const b of tabButtons) b.classList.toggle('active', b === btn);
      render();
    });
  }

  if (followLiveBtn) followLiveBtn.addEventListener('click', followLive);

  function setEnabled(next) {
    enabled = next;
    panel.classList.toggle('enabled', enabled);
    if (enabled) render();
  }

  function reset(container) {
    currentContainer = container;
    pinnedId = null;
    currentRecord = null;
    activeTab = 'summary';
    for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === 'summary');
    updateLiveIndicator();
    renderEmpty();
  }

  renderEmpty();

  return {
    setContainer,
    selectToolCall,
    onToolCallStarted,
    onToolResultArrived,
    followLive,
    setEnabled,
    reset,
    isEnabled: () => enabled,
  };
}
