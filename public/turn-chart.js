// Per-turn cost graph, bar-per-turn SVG with a metric selector. Off by
// default; addPoint() is cheap to call unconditionally regardless. The
// viewport slider below the bars (not an SVG rect over them, which used to
// eat bar clicks) is a scroll thumb, not a zoom. Selection is click-only,
// no hover highlight - click a bar to jump/expand/highlight its turn.

const CACHE_MISS_COLOR = '#f0648b';

// Below this bar width, per-turn bars stop being readable/clickable -
// render() sums turns into fixed-width buckets instead of shrinking bars
// further. Sum (not average) per bucket so one expensive turn among cheap
// ones still stands out rather than getting diluted.
const MIN_BAR_WIDTH = 3;

// `cacheMissColor` opts a metric into the distinct prompt-cache-miss color
// below - only the cost metric does today, but this is a per-metric flag
// now instead of a hex-string comparison against the cost metric's own
// color (B8), so retuning that color (or any other metric's) can't
// silently make cache-miss highlighting vanish.
const METRIC_CONF = {
  cost: { label: 'Cost ($)', get: (p) => p.costUsd, color: '#f0b90b', cacheMissColor: true, unit: 'usd' },
  in: { label: 'Tokens In', get: (p) => p.inputTokens, color: '#2dd4a7', unit: 'tokens' },
  out: { label: 'Tokens Out', get: (p) => p.outputTokens, color: '#5b8def', unit: 'tokens' },
  cache: { label: 'Tokens Cached', get: (p) => p.cacheReadTokens + p.cacheWriteTokens, color: '#8b929c', unit: 'tokens' },
};

// 1 / 2 / 2.5 / 5 / 10 so axis labels stay round ($0.02, 2.5K) instead of
// echoing the raw tallest-bar value.
const NICE_STEPS = [1, 2, 2.5, 5, 10];

export function niceScaleMax(rawMax) {
  if (!(rawMax > 0) || !Number.isFinite(rawMax)) return 1;
  const exp = Math.floor(Math.log10(rawMax));
  const mag = 10 ** exp;
  const f = rawMax / mag;
  const step = NICE_STEPS.find((n) => f <= n) ?? 10;
  return step * mag;
}

function trimFrac(s) {
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}

export function formatAxisTick(unit, value) {
  if (unit === 'usd') {
    if (value === 0) return '$0';
    const abs = Math.abs(value);
    // 2.5-cent nice steps (and anything under a dime) need a third decimal
    // or $0.025 rounds to a lying "$0.03" on a 2-decimal format.
    if (abs < 0.01) return `$${trimFrac(value.toFixed(4))}`;
    if (abs < 0.1) return `$${trimFrac(value.toFixed(3))}`;
    return `$${value.toFixed(2)}`;
  }
  if (value === 0) return '0';
  if (value >= 1e6) return `${trimFrac((value / 1e6).toFixed(1))}M`;
  if (value >= 1e3) return `${trimFrac((value / 1e3).toFixed(1))}K`;
  return String(Math.round(value));
}

export function initTurnChart({ panel, svg, axisEl, axisRightEl, initialAxisPosition, metricSelect, scrollContainer, excludeCacheMissCheckbox, sliderTrack, sliderThumb, onSelectToolCall }) {
  const points = []; // one per assistant message that carried a priced usage figure
  let enabled = false;
  let dragging = false;
  // 'left' (default) | 'right' | 'both' - two fixed elements flank
  // .turn-chart-plot; this toggles which render ticks and are visible. A
  // wide detail pane pushes the chart into a narrow column where labels
  // sometimes read better hugging the other edge, or both.
  let axisPosition = initialAxisPosition || 'left';
  if (axisEl) axisEl.hidden = axisPosition === 'right';
  if (axisRightEl) axisRightEl.hidden = !(axisPosition === 'right' || axisPosition === 'both');
  // A prompt-cache-miss turn (info.writeTokens >= info.readTokens) runs up
  // to 10-20x the tokens of a normal turn, so left un-excluded it alone
  // sets the y-axis max and squashes every other bar to a sliver. The
  // checkbox only feeds the max-height calc - bars still clip at the
  // panel's height rather than disappearing or reflowing the graph.
  let excludeCacheMisses = excludeCacheMissCheckbox ? excludeCacheMissCheckbox.checked : false;
  let expandedBySelection = []; // tool-block elements the current selection expanded, so selecting a new bar (or none) can fold just those back
  let keepOpenGroups = []; // groups the current selection marked dataset.keepOpen (see selectIndex) - cleared in clearHighlights regardless of expand state, since it tracks "the selection is showing this," not "we opened this"
  let highlightedNodes = []; // wrap elements the current selection is highlighting - kept around so scroll/resize can reposition their boxes (B4)
  const highlightBoxes = [];
  // Set by render() each call; null in per-turn mode, or the bucket array
  // (see buildBuckets) once n exceeds what fits at MIN_BAR_WIDTH. Read back
  // by selectFromEvent so a click maps to the same buckets that were last
  // drawn, instead of recomputing against a possibly-stale width.
  let currentBuckets = null;

  metricSelect.innerHTML = '';
  Object.entries(METRIC_CONF).forEach(([value, conf]) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = conf.label;
    if (value === 'cost') opt.selected = true;
    metricSelect.append(opt);
  });

  metricSelect.addEventListener('change', render);
  if (excludeCacheMissCheckbox) {
    excludeCacheMissCheckbox.addEventListener('change', () => {
      excludeCacheMisses = excludeCacheMissCheckbox.checked;
      render();
    });
  }
  window.addEventListener('resize', () => {
    if (enabled && points.length) render();
    if (highlightedNodes.length) positionHighlights();
  });
  // Highlight boxes are `position: fixed` (viewport-relative), so scrolling
  // the transcript without touching the graph leaves stale boxes framing
  // whatever used to be there (B4) unless they're re-measured on every
  // scroll tick, not just once right after the click that created them.
  scrollContainer.addEventListener('scroll', () => {
    if (enabled) updateSlider();
    if (highlightedNodes.length) positionHighlights();
  });

  // Mousedown-and-drag scrubs scroll position proportionally; a plain click
  // does that scrollToFrac first, then the per-turn jump below corrects
  // it. `dragEl` records which element's rect a drag's x is measured
  // against, since the slider track and bars differ in width/position.
  let dragOrigin = null; // 'bars' | 'slider' | null - which surface started this drag, so a click-without-drag only ever jumps to a turn when it started on the bars
  let dragEl = null;
  let dragStartX = 0;
  let dragStartY = 0;
  let hasDragged = false;
  const CLICK_MOVE_THRESHOLD = 3; // px of mouse movement before a mousedown/mouseup pair stops counting as a click

  // scrollToFrac() is always paired with its own updateSlider() call
  // rather than leaning on the 'scroll' listener above - the browser
  // throttles native 'scroll' events to roughly one per frame, visibly
  // lagging a fast drag (thumb freezes mid-drag).
  svg.addEventListener('mousedown', (e) => {
    dragging = true;
    dragOrigin = 'bars';
    dragEl = svg;
    hasDragged = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    scrollToFrac(fracOf(svg, e));
    updateSlider();
  });
  sliderTrack.addEventListener('mousedown', (e) => {
    dragging = true;
    dragOrigin = 'slider';
    dragEl = sliderTrack;
    hasDragged = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    e.preventDefault(); // matches the old overlay rect's own preventDefault - stops text-selection drag artifacts
    scrollToFrac(fracOf(sliderTrack, e));
    updateSlider();
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    if (Math.abs(e.clientX - dragStartX) > CLICK_MOVE_THRESHOLD || Math.abs(e.clientY - dragStartY) > CLICK_MOVE_THRESHOLD) hasDragged = true;
    scrollToFrac(fracOf(dragEl, e));
    updateSlider();
  });
  window.addEventListener('mouseup', (e) => {
    if (dragging && dragOrigin === 'bars' && !hasDragged) selectFromEvent(e);
    dragging = false;
    dragOrigin = null;
    dragEl = null;
  });

  // Click on a bar -> jump to and highlight the turn's tool-call block(s) in
  // the transcript (stream-view.js tags them with data-turn-point, set by
  // app.js from addPoint's return value). Stays highlighted until another
  // bar is clicked - there's no hover-driven highlight anymore (it didn't
  // work reliably), so this is the only entry point now.
  function selectFromEvent(e) {
    const n = points.length;
    if (!n) return;
    if (currentBuckets) {
      const bi = Math.min(currentBuckets.length - 1, Math.floor(fracOf(svg, e) * currentBuckets.length));
      selectIndex(currentBuckets[bi].spikeIndex);
      return;
    }
    selectIndex(Math.min(n - 1, Math.floor(fracOf(svg, e) * n)));
  }

  // Groups points[] into fixed-width buckets once n won't fit at
  // MIN_BAR_WIDTH per turn, summing (not averaging) so one expensive turn
  // among cheap neighbors still reads as a tall bar. spikeIndex is the
  // single turn a click should jump to: the cache-miss turn if the bucket
  // has one, else whichever turn has the highest value for the metric.
  function buildBuckets(conf, bucketCount) {
    const bucketSize = Math.ceil(points.length / bucketCount);
    const buckets = [];
    for (let b = 0; b < bucketCount; b++) {
      const start = b * bucketSize;
      const end = Math.min(points.length, start + bucketSize);
      if (start >= end) break;
      let sum = 0;
      let hasCacheMiss = false;
      let spikeIndex = start;
      let spikeVal = -Infinity;
      // Tracks whether the *current* spike holder is a cache-miss turn,
      // separately from spikeIndex's own value - `spikeIndex === start`
      // can't double as an "uninitialized" sentinel since start is also a
      // valid winning index.
      let spikeIsCacheMiss = false;
      for (let i = start; i < end; i++) {
        const p = points[i];
        const v = conf.get(p);
        sum += v;
        if (p.cacheMiss) {
          hasCacheMiss = true;
          // Among cache-miss turns, pick the tallest one for this metric.
          // Last-miss-wins used to jump to a cheap miss that just happened
          // to sit later in the bucket.
          if (!spikeIsCacheMiss || v > spikeVal) {
            spikeIndex = i;
            spikeVal = v;
            spikeIsCacheMiss = true;
          }
        } else if (!spikeIsCacheMiss && v > spikeVal) {
          spikeVal = v;
          spikeIndex = i;
        }
      }
      buckets.push({ start, end, sum, hasCacheMiss, spikeIndex });
    }
    return buckets;
  }

  function selectIndex(i) {
    clearHighlights();
    if (i == null) return;
    const nodes = scrollContainer.querySelectorAll(`[data-turn-point="${i}"]`);
    if (!nodes.length) return;
    let firstNode = null;
    // A block can also be hidden by its enclosing tool-call group being
    // auto-collapsed - expanding just the inner block leaves the group's
    // .group-body display:none, so positionHighlights sees a zero-size
    // rect and silently drops it. Collected into a Set so a multi-tool-call
    // turn sharing one group only clicks that group's toggle once.
    const groupsToExpand = new Set();
    // Broader than groupsToExpand: every ancestor group touched, expanded
    // or not, so stream-view.js's auto-fold skips it via dataset.keepOpen
    // and a tool call landing right after this click doesn't fold what was
    // just opened.
    const groupsToKeepOpen = new Set();
    let firstToolCallId = null;
    nodes.forEach((wrap) => {
      const group = wrap.closest('.msg.group.collapsible');
      if (group) {
        groupsToKeepOpen.add(group);
        if (!group.classList.contains('expanded')) groupsToExpand.add(group);
      }
      // A turn can tag several tool-call rows with the same index (one
      // assistant message emitting multiple tool_use blocks all shares one
      // turnPointIndex - see app.js's nextPointIndex() call site) - pin the
      // detail pane to the first one, same "first match wins" rule firstNode
      // already uses below for scrolling.
      if (!firstToolCallId && wrap.dataset.toolCallId) firstToolCallId = wrap.dataset.toolCallId;
      if (!firstNode) firstNode = wrap;
    });
    groupsToKeepOpen.forEach((group) => {
      group.dataset.keepOpen = 'true';
      keepOpenGroups.push(group);
    });
    groupsToExpand.forEach((group) => {
      group.click(); // same toggle-handler trick, this time stream-view.js's setGroupExpanded
      expandedBySelection.push(group);
    });
    if (firstToolCallId) onSelectToolCall?.(scrollContainer, firstToolCallId);
    // An explicit click means "take me there" - unlike the old hover nudge,
    // scroll it fully into view (centered) rather than just nudging.
    firstNode.scrollIntoView({ block: 'center' });
    // Measured after expand + scroll settle, so the boxes land on final
    // layout. Kept in highlightedNodes (not just drawn once) so later scroll/
    // resize events can re-measure and reposition them (B4) instead of the
    // boxes going stale the moment the transcript moves under them.
    highlightedNodes = Array.from(nodes);
    positionHighlights();
  }

  function positionHighlights() {
    highlightBoxes.splice(0).forEach((box) => box.remove());
    if (!highlightedNodes.length) return;
    const containerRect = scrollContainer.getBoundingClientRect();
    highlightedNodes.forEach((wrap) => {
      // Clip to the scroll container's own visible rect - an expanded block
      // can still end up (partly) scrolled out of it, and without this the
      // box would draw straight over the header or compose bar instead of
      // just not showing that portion.
      const rect = wrap.getBoundingClientRect();
      const top = Math.max(rect.top, containerRect.top);
      const bottom = Math.min(rect.bottom, containerRect.bottom);
      const left = Math.max(rect.left, containerRect.left);
      const right = Math.min(rect.right, containerRect.right);
      if (bottom <= top || right <= left) return; // fully scrolled out of view - nothing to highlight
      const box = document.createElement('div');
      box.className = 'turn-chart-select-highlight';
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${right - left}px`;
      box.style.height = `${bottom - top}px`;
      document.body.append(box);
      highlightBoxes.push(box);
    });
  }

  function clearHighlights() {
    highlightBoxes.splice(0).forEach((box) => box.remove());
    highlightedNodes = [];
    // Clear the flag unconditionally (not gated on expand state, unlike
    // expandedBySelection below) - the selection is moving off these groups
    // either way, so stream-view.js's own auto-fold should resume treating
    // them normally the moment a newer group opens.
    keepOpenGroups.splice(0).forEach((group) => delete group.dataset.keepOpen);
    // Fold back only what's still actually expanded (B5) - if the user (or
    // auto-collapse) already collapsed one of these manually since this
    // selection opened it, its own toggle handler already fired once; firing
    // it again here would re-expand it instead of leaving it collapsed.
    expandedBySelection.splice(0).forEach((wrap) => {
      if (wrap.classList.contains('expanded')) wrap.click();
    });
  }

  // app.js calls this *before* rendering the message, so stream-view.js can
  // tag the DOM it's about to create with the same index this point will
  // get - addPoint() itself only pushes after the DOM already exists.
  function nextPointIndex() {
    return points.length;
  }

  function addPoint(usageInfo) {
    if (!usageInfo) return;
    points.push({ ...usageInfo, ts: Date.now() });
    if (enabled) render();
  }

  function reset() {
    points.length = 0;
    selectIndex(null);
    if (enabled) render();
  }

  function setEnabled(next) {
    enabled = next;
    panel.hidden = !enabled;
    if (enabled) render();
  }

  // Generalized from the old xToFrac (which only ever measured against
  // `svg`) now that a drag can start on either the bars or the separate
  // slider track below them - each has its own width/position, so "how far
  // across" has to be measured against whichever one the drag started on.
  function fracOf(el, e) {
    const rect = el.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
  }

  function scrollToFrac(frac) {
    scrollContainer.scrollTop = frac * scrollContainer.scrollHeight;
  }

  function render() {
    svg.innerHTML = '';
    const conf = METRIC_CONF[metricSelect.value] || METRIC_CONF.cost;
    const n = points.length;
    if (n === 0) {
      renderAxis(conf, 0, svg.height.baseVal.value || 60);
      return;
    }

    const width = svg.clientWidth || 900;
    svg.setAttribute('width', width);
    const height = svg.height.baseVal.value;

    // n turns won't stay readable (or clickable) at MIN_BAR_WIDTH each once
    // the session gets long - sum them into fixed-width buckets instead of
    // shrinking bars further. See MIN_BAR_WIDTH's comment and buildBuckets.
    const maxBars = Math.max(1, Math.floor(width / MIN_BAR_WIDTH));
    currentBuckets = n > maxBars ? buildBuckets(conf, maxBars) : null;
    const bars = currentBuckets || points.map((p, i) => ({ start: i, end: i + 1, sum: conf.get(p), hasCacheMiss: p.cacheMiss, spikeIndex: i }));

    const step = width / bars.length;
    const barWidth = Math.max(1, step - 1);

    let rawMax = 0;
    bars.forEach((bar) => {
      // scale is set by the normal turns only - see excludeCacheMisses's
      // comment above; in bucketed mode this re-sums just the non-miss
      // turns inside the bucket rather than reusing bar.sum.
      const v = excludeCacheMisses
        ? points.slice(bar.start, bar.end).reduce((acc, p) => (p.cacheMiss ? acc : acc + conf.get(p)), 0)
        : bar.sum;
      if (v > rawMax) rawMax = v;
    });
    const maxVal = niceScaleMax(rawMax);

    // Grid behind the bars so a bar's height can be read against the labels
    // on the left, not just against its neighbors.
    for (const frac of [1, 0.5, 0]) {
      const y = frac === 0 ? height - 0.5 : frac === 1 ? 0.5 : height * (1 - frac);
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
      line.setAttribute('x1', 0);
      line.setAttribute('x2', width);
      line.setAttribute('y1', y);
      line.setAttribute('y2', y);
      line.setAttribute('stroke', 'rgba(255,255,255,0.12)');
      line.setAttribute('stroke-width', '1');
      line.setAttribute('pointer-events', 'none');
      svg.append(line);
    }

    bars.forEach((bar, i) => {
      if (bar.sum <= 0) return;
      // A cache-miss turn excluded from the scale can still exceed it -
      // clip its bar to the panel height instead of drawing past it, same
      // idea as an axis break.
      const h = Math.min(height, (bar.sum / maxVal) * height);
      const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
      rect.setAttribute('x', i * step);
      rect.setAttribute('y', height - h);
      rect.setAttribute('width', barWidth);
      rect.setAttribute('height', h);
      // Prompt-cache-miss turns get a distinct color; a plain SVG <title>
      // costs nothing and gets a free native tooltip even with no custom
      // hover on this chart.
      rect.setAttribute('fill', conf.cacheMissColor && bar.hasCacheMiss ? CACHE_MISS_COLOR : conf.color);
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      const bucketed = bar.end - bar.start > 1;
      title.textContent = bucketed
        ? `${conf.label}: ${formatAxisTick(conf.unit, bar.sum)} (${bar.end - bar.start} turns)`
        : `${conf.label}: ${formatAxisTick(conf.unit, bar.sum)}`;
      rect.append(title);
      svg.append(rect);
    });

    renderAxis(conf, maxVal, height);
    updateSlider();
  }

  function renderAxis(conf, maxVal, height) {
    const showLeft = axisPosition !== 'right';
    const showRight = axisPosition === 'right' || axisPosition === 'both';
    fillAxis(axisEl, showLeft, conf, maxVal, height);
    fillAxis(axisRightEl, showRight, conf, maxVal, height);
  }

  function fillAxis(el, visible, conf, maxVal, height) {
    if (!el) return;
    if (el.hidden !== !visible) el.hidden = !visible;
    if (!visible) return;
    el.replaceChildren();
    el.style.height = `${height}px`;
    if (!maxVal) return;
    const ticks = [
      { frac: 1, align: 'top' },
      { frac: 0.5, align: 'mid' },
      { frac: 0, align: 'bottom' },
    ];
    for (const t of ticks) {
      const span = document.createElement('span');
      span.textContent = formatAxisTick(conf.unit, maxVal * t.frac);
      span.dataset.align = t.align;
      el.append(span);
    }
  }

  // Called by app.js on the Settings-modal select's change event. Re-renders
  // immediately (not just next render() call) so flipping the setting shows
  // its effect right away even if the chart isn't otherwise about to redraw.
  function setAxisPosition(position) {
    axisPosition = position;
    if (enabled && points.length) render();
    else {
      if (axisEl) axisEl.hidden = position === 'right';
      if (axisRightEl) axisRightEl.hidden = !(position === 'right' || position === 'both');
    }
  }

  // Positions the persistent slider thumb to reflect how much of the
  // transcript is visible and where. Percentages, not pixels: the slider
  // track has its own width independent of the SVG's.
  function updateSlider() {
    const scrollable = scrollContainer.scrollHeight > scrollContainer.clientHeight;
    const frac = scrollable ? scrollContainer.clientHeight / scrollContainer.scrollHeight : 1;
    const startFrac = scrollable ? scrollContainer.scrollTop / scrollContainer.scrollHeight : 0;
    sliderThumb.style.left = `${startFrac * 100}%`;
    sliderThumb.style.width = `${Math.max(4, frac * 100)}%`;
  }

  return { addPoint, nextPointIndex, reset, setEnabled, setAxisPosition };
}
