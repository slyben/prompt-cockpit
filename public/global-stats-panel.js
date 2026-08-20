// Settings > Stats tab: fetches /api/stats (src/global-stats.js) and
// renders a GitHub-style activity heatmap plus an overview number grid.
// Lazy: does nothing until initGlobalStatsPanel()'s returned refresh() is
// called (app.js does that on the tab's first click, not on every modal
// open - this is a real transcript scan server-side, not a cheap GET).
const MIN_WEEKS_SHOWN = 53; // ~a year of columns, GitHub-heatmap style - floor, not a fixed count
const LEVEL_THRESHOLDS = [1, 5, 15, 40]; // message-count breakpoints for the 5 shade levels (0-4)
// Pixel width of one grid column step: a cell is 10px wide including its
// 1px border (style.css sets box-sizing: border-box globally, so the border
// does NOT add to it), plus the grid's 3px gap = 13px. Must track
// .stats-heatmap-cell/.stats-heatmap-grid's CSS in style.css - used to
// pixel-position month labels exactly over their column (see renderHeatmap's
// monthRow loop). Getting this wrong slides every label off its column.
const COL_STEP_PX = 13;

export function initGlobalStatsPanel({ bodyEl, rangeSelect, refreshButton }) {
  let loaded = false;

  async function refresh() {
    bodyEl.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'stats-note';
    loading.textContent = 'Scanning local session transcripts…';
    bodyEl.append(loading);

    let stats;
    try {
      const res = await fetch(`/api/stats?range=${encodeURIComponent(rangeSelect.value)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      stats = await res.json();
    } catch (err) {
      bodyEl.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'mcp-error';
      p.textContent = `Could not load stats: ${err.message || err}`;
      bodyEl.append(p);
      return;
    }
    bodyEl.innerHTML = '';
    // A fixed 53 columns falls short of the panel's actual width on wider
    // windows, leaving a bare gap after the last (current) week instead of
    // the grid running edge-to-edge like GitHub's. Grow the column count to
    // whatever the panel can currently fit, using a fixed-width reference
    // element already in the DOM (bodyEl) since the heatmap itself doesn't
    // exist yet to measure. Never shrinks below MIN_WEEKS_SHOWN (~a year),
    // even on a narrow panel - in that case it just scrolls, as before.
    const weeksShown = computeWeeksShown(bodyEl);
    bodyEl.append(renderHeatmap(stats, weeksShown), renderOverview(stats), renderModelTable(stats), renderAccountLimitsSection());
    // Wider-than-panel content (still possible on a narrow window) scrolls -
    // the interesting end is the recent one, so park the scroll on the
    // right so the current week is visible on open. Has to happen here
    // rather than in renderHeatmap: scrollLeft is a no-op on a node that
    // isn't in the document yet.
    const heatmap = bodyEl.querySelector('.stats-heatmap');
    if (heatmap) heatmap.scrollLeft = heatmap.scrollWidth;
  }

  if (refreshButton) refreshButton.addEventListener('click', refresh);
  if (rangeSelect) rangeSelect.addEventListener('change', refresh);

  return {
    // Called by app.js on the tab's first click - `force` lets the Refresh
    // button re-run even though `loaded` is already true.
    ensureLoaded(force = false) {
      if (loaded && !force) return;
      loaded = true;
      refresh();
    },
  };
}

// How many columns fit across `el`'s current width. Matches
// .stats-heatmap-corner/-weekdays' 24px plus COL_STEP_PX per column; falls
// back to MIN_WEEKS_SHOWN if el isn't laid out yet (width 0, e.g. panel
// hidden behind an inactive tab).
function computeWeeksShown(el) {
  const available = el.clientWidth - 24;
  if (available <= 0) return MIN_WEEKS_SHOWN;
  return Math.max(MIN_WEEKS_SHOWN, Math.ceil(available / COL_STEP_PX));
}

// Mon..Sun, top-to-bottom - matches the grid's own row order (see the `d`
// loop below): endOfWeek is anchored to a Sunday, so d=0 in every column
// is that week's Monday. Only Mon/Wed/Fri get a visible label, same
// convention GitHub's own graph uses to avoid a solid wall of 7 labels.
const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

function renderHeatmap(stats, weeksShown) {
  // Two boxes on purpose: `scroller` is the only thing that scrolls
  // horizontally (a year of columns is wider than the panel), and the
  // legend sits in `wrap` outside it - inside, it would scroll off to the
  // left along with the older weeks the moment refresh() parks the scroll
  // on the current week.
  const wrap = document.createElement('div');
  wrap.className = 'stats-heatmap-wrap';
  const scroller = document.createElement('div');
  scroller.className = 'stats-heatmap';

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  // Align the grid's last column to the end of the current week (Sunday,
  // since weeks run Mon..Sun here), so today always lands somewhere in the
  // rightmost column rather than at a ragged edge. today.getDay() is
  // 0=Sun..6=Sat; (7 - getDay()) % 7 is 0 when today already is Sunday.
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + ((7 - today.getDay()) % 7));

  const days = [];
  for (let i = weeksShown * 7 - 1; i >= 0; i -= 1) {
    const d = new Date(endOfWeek);
    d.setDate(endOfWeek.getDate() - i);
    days.push(d);
  }

  // Month labels, one row above the grid - stamped only on the first column
  // whose Monday falls in a new month, not every column (which would just
  // repeat "Aug Aug Aug…" across the whole row). Positioned with an exact
  // pixel offset (COL_STEP_PX per column) rather than as a flexed 12px-wide
  // span with overflow spill - the spill trick left every label reading as
  // shifted right of the column it actually belongs to.
  const header = document.createElement('div');
  header.className = 'stats-heatmap-header';
  const corner = document.createElement('div');
  corner.className = 'stats-heatmap-corner';
  const monthRow = document.createElement('div');
  monthRow.className = 'stats-heatmap-months';
  monthRow.style.width = `${weeksShown * COL_STEP_PX}px`;
  let lastMonth = -1;
  for (let w = 0; w < weeksShown; w += 1) {
    const firstOfCol = days[w * 7];
    if (firstOfCol.getMonth() !== lastMonth) {
      const label = document.createElement('span');
      label.textContent = firstOfCol.toLocaleDateString(undefined, { month: 'short' });
      label.style.left = `${w * COL_STEP_PX}px`;
      monthRow.append(label);
      lastMonth = firstOfCol.getMonth();
    }
  }
  header.append(corner, monthRow);
  scroller.append(header);

  const weekdayCol = document.createElement('div');
  weekdayCol.className = 'stats-heatmap-weekdays';
  for (let d = 0; d < 7; d += 1) {
    const label = document.createElement('span');
    label.textContent = WEEKDAY_LABELS[d];
    weekdayCol.append(label);
  }

  const grid = document.createElement('div');
  grid.className = 'stats-heatmap-grid';
  for (let w = 0; w < weeksShown; w += 1) {
    const col = document.createElement('div');
    col.className = 'stats-heatmap-col';
    for (let d = 0; d < 7; d += 1) {
      const date = days[w * 7 + d];
      const key = dayKey(date);
      // Each cell = one calendar day; shade level (0-4, see LEVEL_THRESHOLDS)
      // is how many messages were sent that day, across every project.
      const count = stats.dailyCounts[key] || 0;
      const cell = document.createElement('div');
      cell.className = `stats-heatmap-cell level-${levelFor(count)}`;
      cell.title = `${date.toDateString()}: ${count} message${count === 1 ? '' : 's'}`;
      col.append(cell);
    }
    grid.append(col);
  }

  const body = document.createElement('div');
  body.className = 'stats-heatmap-body';
  body.append(weekdayCol, grid);
  scroller.append(body);

  const legend = document.createElement('div');
  legend.className = 'stats-heatmap-legend';
  legend.innerHTML = '<span>Less</span>' + [0, 1, 2, 3, 4].map((l) => `<div class="stats-heatmap-cell level-${l}"></div>`).join('') + '<span>More</span>';
  wrap.append(scroller, legend);

  return wrap;
}

function levelFor(count) {
  if (count <= 0) return 0;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (count <= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return LEVEL_THRESHOLDS.length + 1;
}

function dayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function renderOverview(stats) {
  const wrap = document.createElement('div');
  wrap.className = 'stats-overview';

  const rows = [
    ['Favorite model', stats.favoriteModel || '—'],
    ['Total tokens', formatCount(stats.totalTokens)],
    ['Sessions', String(stats.sessions)],
    ['Longest session', formatDuration(stats.longestSessionMs)],
    ['Active days', stats.totalDaysSpan ? `${stats.activeDays}/${stats.totalDaysSpan}` : String(stats.activeDays)],
    ['Longest streak', `${stats.longestStreak} day${stats.longestStreak === 1 ? '' : 's'}`],
    ['Most active day', stats.mostActiveDay ? formatDayLabel(stats.mostActiveDay) : '—'],
    ['Current streak', `${stats.currentStreak} day${stats.currentStreak === 1 ? '' : 's'}`],
  ];
  for (const [label, value] of rows) {
    const row = document.createElement('div');
    row.className = 'settings-row';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('strong');
    v.textContent = value;
    v.style.marginLeft = 'auto';
    row.append(l, v);
    wrap.append(row);
  }

  const breakdown = document.createElement('p');
  breakdown.className = 'stats-note';
  breakdown.textContent = `Input ${formatCount(stats.inputTokens)} · Output ${formatCount(stats.outputTokens)} · `
    + `Cache read ${formatCount(stats.cacheReadTokens)} · Cache write ${formatCount(stats.cacheWriteTokens)}`;
  wrap.append(breakdown);

  return wrap;
}

// Per-model cost table (src/global-stats.js's perModel, built via the same
// costForUsage pricing math as the live per-session stats panel - not a
// separate estimate). Models with no pricing.json/pricing_grok.json entry
// are flagged below the table instead of silently missing from it.
function renderModelTable(stats) {
  const wrap = document.createElement('div');
  wrap.className = 'stats-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('strong');
  title.textContent = 'Cost by model';
  const total = document.createElement('span');
  total.className = 'stats-note';
  total.textContent = `total ${formatUsd(stats.totalCostUsd)}`;
  header.append(title, total);
  wrap.append(header);

  if (!stats.perModel || stats.perModel.length === 0) {
    const p = document.createElement('p');
    p.className = 'stats-note';
    p.textContent = 'No priced usage in this range.';
    wrap.append(p);
    return wrap;
  }

  const table = document.createElement('table');
  table.className = 'stats-model-table';
  const thead = document.createElement('thead');
  thead.innerHTML = '<tr><th>Model</th><th>Input</th><th>Output</th><th>Cache read</th><th>Cache write</th><th>Cost</th></tr>';
  table.append(thead);

  const tbody = document.createElement('tbody');
  for (const m of stats.perModel) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${escapeHtml(m.model)}</td>`
      + `<td>${formatCount(m.inputTokens)}</td>`
      + `<td>${formatCount(m.outputTokens)}</td>`
      + `<td>${formatCount(m.cacheReadTokens)}</td>`
      + `<td>${formatCount(m.cacheWriteTokens)}</td>`
      + `<td>${formatUsd(m.costUsd)}</td>`;
    tbody.append(tr);
  }
  table.append(tbody);
  wrap.append(table);

  if (stats.unpricedModels && stats.unpricedModels.length > 0) {
    const note = document.createElement('p');
    note.className = 'stats-note';
    note.textContent = `Not priced (missing from pricing.json), excluded above: ${stats.unpricedModels.join(', ')}`;
    wrap.append(note);
  }

  return wrap;
}

// Account-level plan quota, the one figure everything else in this panel
// can't show: it's tracked server-side by Anthropic across every device
// signed into this account (this local-transcript-scanning panel, by
// design, only ever sees this machine - see global-stats.js's own module
// comment). Fetched by shelling out to `claude -p "/usage"`
// (src/account-limits.js) - a real subprocess spawn, a few seconds, so this
// loads on its own (independent of the rest of this tab's fetch, and its
// own Refresh button) rather than blocking or riding along with the local
// scan above.
function renderAccountLimitsSection() {
  const wrap = document.createElement('div');
  wrap.className = 'stats-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('strong');
  title.textContent = 'Account limits';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.textContent = 'Refresh';
  refreshBtn.title = 'Runs claude -p "/usage" (a few seconds) - reflects your plan quota across every device signed into this account, not just local transcripts';
  header.append(title, refreshBtn);
  wrap.append(header);

  const body = document.createElement('div');
  wrap.append(body);

  async function load() {
    refreshBtn.disabled = true;
    body.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'stats-note';
    loading.textContent = 'Asking claude -p "/usage"…';
    body.append(loading);
    try {
      const res = await fetch('/api/account-limits');
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      body.innerHTML = '';
      const pre = document.createElement('pre');
      pre.className = 'stats-account-limits';
      pre.textContent = data.text || '(no output)';
      body.append(pre);
    } catch (err) {
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'mcp-error';
      p.textContent = `Could not load account limits: ${err.message || err}`;
      body.append(p);
    } finally {
      refreshBtn.disabled = false;
    }
  }

  refreshBtn.addEventListener('click', load);
  load();

  return wrap;
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

function formatUsd(n) {
  if (!n) return '$0.00';
  return `$${n.toFixed(n < 1 ? 4 : 2)}`;
}

function formatDayLabel(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// GitHub-stats-style abbreviation (1.2k / 3.9m / 6.5b) - these totals get
// large fast (cache-read tokens especially), a raw digit string would just
// be noise here.
function formatCount(n) {
  if (!n) return '0';
  const units = [[1e9, 'b'], [1e6, 'm'], [1e3, 'k']];
  for (const [threshold, suffix] of units) {
    if (n >= threshold) return `${(n / threshold).toFixed(1)}${suffix}`;
  }
  return String(n);
}

function formatDuration(ms) {
  if (!ms) return '—';
  const totalMinutes = Math.round(ms / 60000);
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(' ');
}
