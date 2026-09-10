// Settings > Stats tab: fetches /api/stats (src/global-stats.js) and
// renders a GitHub-style activity heatmap plus an overview number grid.
// Lazy: does nothing until initGlobalStatsPanel()'s returned refresh() is
// called (app.js does that on the tab's first click, not on every modal
// open - this is a real transcript scan server-side, not a cheap GET).
import { escapeHtml } from '/escape-html.js';
const HEATMAP_MONTHS = 3; // transcripts prune; a year of empty columns is just noise
const LEVEL_THRESHOLDS = [1, 5, 15, 40]; // message-count breakpoints for the 5 shade levels (0-4)
// Pixel width of one grid column step: a 10px cell (border-box, so its
// 1px border doesn't add to it) plus the grid's 3px gap = 13px. Must track
// .stats-heatmap-cell/.stats-heatmap-grid's CSS in style.css - used to
// pixel-position month labels exactly over their column; getting this
// wrong slides every label off its column.
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
      // Guarded like the addEventListener below - this module otherwise
      // treats rangeSelect as optional throughout, so reading .value
      // unguarded here would be inconsistent and could throw if it's absent.
      const range = rangeSelect ? rangeSelect.value : 'all';
      const res = await fetch(`/api/stats?range=${encodeURIComponent(range)}`);
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
    const weeksShown = heatmapWeeksShown();
    bodyEl.append(
      renderHeatmap(stats, weeksShown),
      renderOverview(stats),
      renderModelTable(stats),
      renderWeekCostSection(),
      renderAccountLimitsSection(),
    );
    // Three months still overflows a narrow settings panel. Park the
    // scroll on the recent end. Has to happen here rather than in
    // renderHeatmap: scrollLeft is a no-op on a node that isn't in the
    // document yet.
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

// Last HEATMAP_MONTHS calendar months, aligned to Monday of the week that
// contains the start day and Sunday of the current week. Does not grow to
// fill the panel - extra empty history is what this is trying to drop.
function heatmapWeeksShown(now = new Date()) {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const endOfWeek = new Date(today);
  endOfWeek.setDate(today.getDate() + ((7 - today.getDay()) % 7));
  const start = new Date(today.getFullYear(), today.getMonth() - HEATMAP_MONTHS, today.getDate());
  start.setHours(0, 0, 0, 0);
  const mondayOffset = start.getDay() === 0 ? 6 : start.getDay() - 1;
  start.setDate(start.getDate() - mondayOffset);
  const days = Math.round((endOfWeek.getTime() - start.getTime()) / 86400000) + 1;
  return Math.max(1, Math.ceil(days / 7));
}

// Mon..Sun, top-to-bottom - matches the grid's own row order (see the `d`
// loop below): endOfWeek is anchored to a Sunday, so d=0 in every column
// is that week's Monday. Only Mon/Wed/Fri get a visible label, same
// convention GitHub's own graph uses to avoid a solid wall of 7 labels.
const WEEKDAY_LABELS = ['Mon', '', 'Wed', '', 'Fri', '', ''];

function renderHeatmap(stats, weeksShown) {
  // Two boxes on purpose: `scroller` is the only thing that scrolls
  // horizontally (three months can still overflow a narrow panel), and the
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
  // whose Monday falls in a new month, not every column (which would repeat
  // "Aug Aug Aug…" across the row). Positioned with an exact pixel offset
  // (COL_STEP_PX per column) rather than a flexed span with overflow spill -
  // the spill trick left every label shifted right of its actual column.
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
      const byProvider = (stats.dailyByProvider && stats.dailyByProvider[key]) || {};
      const cell = document.createElement('div');
      const level = levelFor(count);
      cell.className = `stats-heatmap-cell level-${level}`;
      paintHeatmapCell(cell, level, byProvider);
      cell.title = heatmapTitle(date, count, byProvider);
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
  const providers = document.createElement('span');
  providers.className = 'stats-provider-legend';
  for (const { id, label } of STATS_PROVIDERS) {
    const item = document.createElement('span');
    item.className = 'stats-provider-item';
    const swatch = document.createElement('span');
    swatch.className = `stats-swatch stats-swatch-${id}`;
    item.append(swatch, document.createTextNode(label));
    providers.append(item);
  }
  const intensity = document.createElement('span');
  intensity.className = 'stats-heatmap-intensity';
  intensity.innerHTML = '<span>Less</span>' + [0, 1, 2, 3, 4].map((l) => `<div class="stats-heatmap-cell level-${l}"></div>`).join('') + '<span>More</span>';
  legend.append(providers, intensity);
  wrap.append(scroller, legend);

  return wrap;
}

const STATS_PROVIDERS = [
  { id: 'claude', label: 'Claude' },
  { id: 'grok', label: 'Grok' },
  { id: 'codex', label: 'Codex' },
];
const PROVIDER_COLORS = {
  claude: '#5b8cff',
  grok: '#5ec98d',
  codex: '#ff6b6b',
};
const LEVEL_MIX_PCT = [0, 25, 50, 75, 100];

function levelFor(count) {
  if (count <= 0) return 0;
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i += 1) {
    if (count <= LEVEL_THRESHOLDS[i]) return i + 1;
  }
  return LEVEL_THRESHOLDS.length;
}

function activeProviders(byProvider) {
  return STATS_PROVIDERS.filter(({ id }) => (byProvider[id] || 0) > 0);
}

function paintHeatmapCell(cell, level, byProvider) {
  const providers = activeProviders(byProvider);
  if (providers.length === 1) {
    const id = providers[0].id;
    cell.classList.add(`provider-${id}`);
    cell.style.setProperty('--cell-color', PROVIDER_COLORS[id]);
    return;
  }
  if (providers.length < 2 || level <= 0) return;
  const mix = LEVEL_MIX_PCT[level] ?? 100;
  const n = providers.length;
  const stops = providers.map(({ id }, i) => {
    const start = (i / n) * 100;
    const end = ((i + 1) / n) * 100;
    return `color-mix(in srgb, ${PROVIDER_COLORS[id]} ${mix}%, var(--panel)) ${start}% ${end}%`;
  });
  cell.style.background = `linear-gradient(90deg, ${stops.join(', ')})`;
  cell.style.borderColor = 'transparent';
}

function providerIdForModel(model) {
  const id = String(model || '').toLowerCase();
  if (!id) return null;
  if (id.includes('grok')) return 'grok';
  if (id.includes('codex') || id.startsWith('gpt-')) return 'codex';
  return 'claude';
}

function emptyProviderTotals() {
  return { costUsd: 0, inputTokens: 0, outputTokens: 0, sessions: 0 };
}

function totalsByProvider(stats) {
  const out = Object.fromEntries(STATS_PROVIDERS.map(({ id }) => [
    id,
    { ...emptyProviderTotals(), ...(stats.perProvider && stats.perProvider[id]) },
  ]));
  const hasCost = STATS_PROVIDERS.some(({ id }) => out[id].costUsd > 0);
  if (hasCost) return out;
  for (const row of stats.perModel || []) {
    const id = providerIdForModel(row.model);
    if (!id || !out[id]) continue;
    out[id].costUsd += row.costUsd || 0;
    out[id].inputTokens += row.inputTokens || 0;
    out[id].outputTokens += row.outputTokens || 0;
  }
  return out;
}

function heatmapTitle(date, count, byProvider) {
  const parts = activeProviders(byProvider).map(({ id, label }) => `${label} ${byProvider[id]}`);
  const extra = parts.length ? ` (${parts.join(', ')})` : '';
  return `${date.toDateString()}: ${count} message${count === 1 ? '' : 's'}${extra}`;
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
    note.textContent = `Not priced (missing from pricing.json/pricing_grok.json/pricing_codex.json), excluded above: ${stats.unpricedModels.join(', ')}`;
    wrap.append(note);
  }

  return wrap;
}

// Last-7-day spend per provider, on its own button so an All-time heatmap
// view does not have to switch the range dropdown. Reuses /api/stats?range=7d
// (and its 15s scan cache) rather than a second aggregator.
function renderWeekCostSection() {
  const wrap = document.createElement('div');
  wrap.className = 'stats-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('strong');
  title.textContent = 'Past week cost';
  const computeBtn = document.createElement('button');
  computeBtn.type = 'button';
  computeBtn.className = 'btn';
  computeBtn.textContent = 'Compute';
  computeBtn.title = 'Scan local transcripts for the last 7 days and total cost per provider';
  header.append(title, computeBtn);
  wrap.append(header);

  const body = document.createElement('div');
  wrap.append(body);
  const hint = document.createElement('p');
  hint.className = 'stats-note';
  hint.textContent = 'Click Compute for the last 7 days, split by Claude / Grok / Codex.';
  body.append(hint);

  async function load() {
    computeBtn.disabled = true;
    body.innerHTML = '';
    const loading = document.createElement('p');
    loading.className = 'stats-note';
    loading.textContent = 'Scanning last 7 days…';
    body.append(loading);
    try {
      const res = await fetch('/api/stats?range=7d');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const stats = await res.json();
      body.innerHTML = '';
      const perProvider = totalsByProvider(stats);
      const list = document.createElement('div');
      list.className = 'stats-week-cost';
      for (const { id, label } of STATS_PROVIDERS) {
        const row = document.createElement('div');
        row.className = 'settings-row';
        const name = document.createElement('span');
        name.className = `stats-provider-label stats-provider-${id}`;
        name.textContent = label;
        const value = document.createElement('strong');
        const totals = perProvider[id] || emptyProviderTotals();
        const sessionBit = totals.sessions ? ` · ${totals.sessions} session${totals.sessions === 1 ? '' : 's'}` : '';
        value.textContent = `${formatUsd(totals.costUsd)}${sessionBit}`;
        value.style.marginLeft = 'auto';
        row.append(name, value);
        list.append(row);
      }
      body.append(list);
      const totalNote = document.createElement('p');
      totalNote.className = 'stats-note';
      totalNote.textContent = `Last 7 days total ${formatUsd(stats.totalCostUsd)} · ${stats.sessions || 0} session${stats.sessions === 1 ? '' : 's'} (heatmap range above can be wider).`;
      body.append(totalNote);
      const codex = perProvider.codex;
      if (codex && codex.sessions > 0 && !codex.costUsd) {
        const note = document.createElement('p');
        note.className = 'stats-note';
        const hasTokens = (codex.inputTokens || 0) + (codex.outputTokens || 0) > 0;
        note.textContent = hasTokens
          ? 'Codex usage was found, but its model is not in pricing_codex.json; the cost is therefore understated.'
          : 'No Codex token records were found; the line reflects thread activity only.';
        body.append(note);
      }
    } catch (err) {
      body.innerHTML = '';
      const p = document.createElement('p');
      p.className = 'mcp-error';
      p.textContent = `Could not compute past week cost: ${err.message || err}`;
      body.append(p);
    } finally {
      computeBtn.disabled = false;
    }
  }

  computeBtn.addEventListener('click', load);
  return wrap;
}

// Account-level plan quota, the one figure this panel's own local scan
// can't show: tracked server-side by Anthropic across every device, while
// this panel only ever sees local transcripts. Fetched by shelling out to
// `claude -p "/usage"` - a real subprocess spawn, a few seconds - so it
// loads independently, with its own Refresh button, rather than blocking.
function renderAccountLimitsSection() {
  const wrap = document.createElement('div');
  wrap.className = 'stats-section';

  const header = document.createElement('div');
  header.className = 'settings-section-header';
  const title = document.createElement('strong');
  title.textContent = 'Account limits';
  const refreshBtn = document.createElement('button');
  refreshBtn.type = 'button';
  refreshBtn.className = 'btn';
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
