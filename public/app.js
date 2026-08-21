// Launcher (cwd picker + resume list), websocket wiring, and MVP2's five
// features' client-side glue. Rendering lives in stream-view.js, input in
// compose.js/file-picker.js, modals in dir-browser.js/diff-view.js.
import { renderMessage, resetStreamView, prependHistory, isScrolledToBottom, setAutoCollapsePreviousGroup } from '/stream-view.js';
import { initCompose } from '/compose.js';
import { initFilePicker } from '/file-picker.js';
import { initDropTarget } from '/drop-target.js';
import { initCommandPicker } from '/command-picker.js';
import { initModelPicker } from '/model-picker.js';
import { initDirBrowser } from '/dir-browser.js';
import { initDiffView } from '/diff-view.js';
import { initTabChrome } from '/tab-chrome.js';
import { initStatsPanel } from '/stats-panel.js';
import { initHistoryPane } from '/history-pane.js';
import { initMcpPanel } from '/mcp-panel.js';
import { initPluginPanel } from '/plugin-panel.js';
import { initGlobalStatsPanel } from '/global-stats-panel.js';
import { initSettings, loadSettings, patchSettings } from '/settings.js';
import { initTurnChart } from '/turn-chart.js';
import { initDetailPane } from '/detail-pane.js';
import { initSessionListPane } from '/session-list-pane.js';
import { initTaskPanel } from '/task-panel.js';
import { initQueuePanel } from '/queue-panel.js';
import { createPromptHistoryStore, fuzzyScore } from '/prompt-history.js';
import { initHistorySearch } from '/history-search.js';
import { PERMISSION_MODES } from '/permissions.js';

const launcherEl = document.getElementById('launcher');
const streamWrapEl = document.getElementById('streamWrap'); // #stream + #detailPane side-by-side row (index.html) - this, not #stream itself, now owns the pre-session/session display:none<->flex toggle, so an empty flex:1 row doesn't reserve space on the launcher screen before a session exists
const streamEl = document.getElementById('stream');
const composeEl = document.getElementById('compose');
const sessionLabelEl = document.getElementById('sessionLabel');
const stateLabelEl = document.getElementById('stateLabel');
const stateIconEl = document.getElementById('stateIcon');
const cwdInput = document.getElementById('cwdInput');
const startNameInput = document.getElementById('startNameInput');
const startBtn = document.getElementById('startBtn');
const startProviderSelect = document.getElementById('startProviderSelect');
const startModelSelect = document.getElementById('startModelSelect');
const startEffortSelect = document.getElementById('startEffortSelect');
const startClaudeEffortSelect = document.getElementById('startClaudeEffortSelect');
const browseBtn = document.getElementById('browseBtn');
const recentFoldersSelect = document.getElementById('recentFoldersSelect');
const resumeListEl = document.getElementById('resumeList');
const modeBtn = document.getElementById('modeBtn');
const stopBtn = document.getElementById('stopBtn');
const pendingTurnsBadge = document.getElementById('pendingTurnsBadge');
// Declared up here rather than down by forceIdleSession/disarmForceIdle
// below (where this state conceptually belongs) because initSettings()'s
// onPendingTurnsBadgeEnabledChange callback reads lastPendingTurnsCount and
// forceIdleArmed synchronously during setup, and that setup runs well
// before this file reaches its forceIdle section - a `let` down there would
// still be in its temporal dead zone at that point.
const FORCE_IDLE_CONFIRM_WINDOW_MS = 2000;
let forceIdleArmed = false;
let forceIdleArmTimer = null;
let lastPendingTurnsCount = 0; // drives the badge's label text on the next arm/disarm
const thinkingBudgetBtn = document.getElementById('thinkingBudgetBtn');
const thinkingDisplayBtn = document.getElementById('thinkingDisplayBtn');
const thinkingErrorEl = document.getElementById('thinkingError');
const effortBtn = document.getElementById('effortBtn');
const effortErrorEl = document.getElementById('effortError');
const modelBadge = document.getElementById('modelBadge');
const diffBtn = document.getElementById('diffBtn');
const compactBtn = document.getElementById('compactBtn');
const reportStuckBtn = document.getElementById('reportStuckBtn');
const copyLastBtn = document.getElementById('copyLastBtn');
const exportBtn = document.getElementById('exportBtn');
const autoContinueLabel = document.getElementById('autoContinueLabel');
const autoContinueBtn = document.getElementById('autoContinueBtn');
const rateLimitBanner = document.getElementById('rateLimitBanner');
const closeSessionBtn = document.getElementById('closeSessionBtn');
const settingsBtn = document.getElementById('settingsBtn');
const approvalBanner = document.getElementById('approvalBanner');
const approvalPlain = document.getElementById('approvalPlain');
const approvalHeading = document.getElementById('approvalHeading');
const approvalDetail = document.getElementById('approvalDetail');
const approveBtn = document.getElementById('approveBtn');
const rejectBtn = document.getElementById('rejectBtn');
const alwaysAllowScope = document.getElementById('alwaysAllowScope');
const alwaysAllowToolName = document.getElementById('alwaysAllowToolName');
const planReviewControls = document.getElementById('planReviewControls');
const planFeedbackText = document.getElementById('planFeedbackText');
const planNoteText = document.getElementById('planNoteText');
const questionForm = document.getElementById('questionForm');
const loadHistoryBar = document.getElementById('loadHistoryBar');
const loadHistoryBtn = document.getElementById('loadHistoryBtn');
const agentsBar = document.getElementById('agentsBar');
const agentsBtn = document.getElementById('agentsBtn');
const agentsList = document.getElementById('agentsList');
const turnChartToggleBtn = document.getElementById('turnChartToggleBtn');
const taskPanelToggleBtn = document.getElementById('taskPanelToggleBtn');
const detailPaneToggleBtn = document.getElementById('detailPaneToggleBtn');
const copyToast = document.getElementById('copyToast');
const activityBar = document.getElementById('activityBar');
const statsPanel = initStatsPanel({ el: document.getElementById('statsPanel') });

// Metric/exclude-cache-miss picks persist across reloads, same as the
// panel's own on/off state (settings.js's turnChartEnabled) - read before
// initTurnChart() runs since that call both rebuilds metricSelect's
// <option>s (always selecting 'cost') and captures
// excludeCacheMissCheckbox's checked state into a closured variable at call
// time, so the checkbox needs its persisted value in place first and the
// select needs its persisted value re-applied (plus a synthetic change
// event, since initTurnChart's own change listener - not this code - is
// what actually re-renders) after.
const persistedTurnChartPrefs = loadSettings();
const turnChartMetricSelect = document.getElementById('turnChartMetric');
const turnChartExcludeCacheMissCheckbox = document.getElementById('turnChartExcludeCacheMissBtn');
if (turnChartExcludeCacheMissCheckbox) turnChartExcludeCacheMissCheckbox.checked = Boolean(persistedTurnChartPrefs.turnChartExcludeCacheMisses);

// Docked tool-call detail pane (Trajectory-style redesign) - always shows
// either the most recently rendered tool call ("live") or whichever row got
// clicked ("pinned"), see detail-pane.js's own comment for the exact
// pin/follow semantics. Created before turnChart (below) so the chart's own
// onSelectToolCall callback can close over it.
const detailPane = initDetailPane({
  panel: document.getElementById('detailPane'),
  headerLabel: document.getElementById('detailPaneLabel'),
  followLiveBtn: document.getElementById('detailPaneFollowLiveBtn'),
  tabButtons: [...document.querySelectorAll('#detailPane .detail-tab')],
  body: document.getElementById('detailPaneBody'),
  resizeHandle: document.getElementById('detailPaneResizeHandle'),
  initialWidth: persistedTurnChartPrefs.detailPaneWidth,
  onWidthChange: (width) => patchSettings({ detailPaneWidth: width }),
});
document.getElementById('detailPaneCollapseBtn').addEventListener('click', () => settings.setDetailPaneEnabled(false));

// Header's server-wide session count + read-only list, overriding
// #detailPane's docked slot while open (session-list-pane.js). Independent
// of any live session in this tab - stays wired up even on the launcher
// screen, since "what else is running" is exactly what it's for there too.
const sessionListPane = initSessionListPane({
  panel: document.getElementById('sessionListPane'),
  body: document.getElementById('sessionListBody'),
  closeBtn: document.getElementById('sessionListCloseBtn'),
  countBtn: document.getElementById('sessionCountBtn'),
  headerEl: document.querySelector('header'),
  handshakeRow: document.getElementById('handshakeRow'),
  handshakeValue: document.getElementById('handshakeValue'),
  handshakeCopyBtn: document.getElementById('handshakeCopyBtn'),
  handshakeRegenBtn: document.getElementById('handshakeRegenBtn'),
});

document.getElementById('newSessionTabBtn').addEventListener('click', () => {
  // Plain location.href reuse is what caused the duplicate-session bug -
  // see discardInheritedSessionOnNewTab's comment above. `newTab=1` tells
  // the new tab to discard the sessionStorage it inherits from us.
  const url = new URL(window.location.origin + window.location.pathname);
  url.searchParams.set('newTab', '1');
  window.open(url, '_blank');
});

// Click is an explicit ask to inspect this call - un-collapse a dismissed pane
// rather than only painting .selected on a display:none box.
function selectLiveToolCall(container, id) {
  sessionListPane.closePane(); // inspecting a tool call always wins over the session-list override
  detailPane.selectToolCall(container, id);
  if (!settings.isDetailPaneEnabled()) settings.setDetailPaneEnabled(true);
}

// Delegated reply's "show full trace" corner button (stream-view.js's
// attachDelegatedTrace) - same open-and-enable-the-pane pattern as a tool
// call click above, just showing plain text instead of a tool-call record.
function selectDelegatedTrace(container, queueId, label, text) {
  sessionListPane.closePane();
  detailPane.showText(container, queueId, label, text);
  if (!settings.isDetailPaneEnabled()) settings.setDetailPaneEnabled(true);
}

// Agent (Task) tool row click (stream-view.js) - opens a dedicated
// read-only tab tailing the subagent's own transcript (agent-view.js, via
// src/agent-transcript.js) instead of the in-page detail pane, which only
// ever has this call's initial prompt/final result, never the subagent's
// own tool calls as they happen.
function openAgentTab(block) {
  if (!currentClaudeSessionId) {
    alert("This session's transcript id isn't known yet - try again in a moment.");
    return;
  }
  const label = typeof block.input?.description === 'string' ? block.input.description : '';
  const url = new URL(`${window.location.origin}/agent-view.html`);
  url.searchParams.set('claudeSessionId', currentClaudeSessionId);
  url.searchParams.set('toolUseId', block.id);
  if (label) url.searchParams.set('label', label);
  window.open(url, '_blank');
}

const turnChart = initTurnChart({
  panel: document.getElementById('turnChartPanel'),
  svg: document.getElementById('turnChart'),
  metricSelect: turnChartMetricSelect,
  scrollContainer: streamEl,
  excludeCacheMissCheckbox: turnChartExcludeCacheMissCheckbox,
  sliderTrack: document.getElementById('turnChartSlider'),
  sliderThumb: document.getElementById('turnChartSliderThumb'),
  // Clicking a cost-graph bar now also pins the detail pane to that turn's
  // (first) tool call, not just scroll-and-highlight - see turn-chart.js's
  // selectIndex.
  onSelectToolCall: selectLiveToolCall,
});

if (persistedTurnChartPrefs.turnChartMetric && turnChartMetricSelect.querySelector(`option[value="${persistedTurnChartPrefs.turnChartMetric}"]`)) {
  turnChartMetricSelect.value = persistedTurnChartPrefs.turnChartMetric;
  turnChartMetricSelect.dispatchEvent(new Event('change'));
}
turnChartMetricSelect.addEventListener('change', () => patchSettings({ turnChartMetric: turnChartMetricSelect.value }));
if (turnChartExcludeCacheMissCheckbox) {
  turnChartExcludeCacheMissCheckbox.addEventListener('change', () =>
    patchSettings({ turnChartExcludeCacheMisses: turnChartExcludeCacheMissCheckbox.checked }),
  );
}

const taskPanel = initTaskPanel({
  panel: document.getElementById('taskPanel'),
  listEl: document.getElementById('taskList'),
});
const queuePanel = initQueuePanel({
  panel: document.getElementById('queuePanel'),
  listEl: document.getElementById('queueList'),
  onReorder: (queueIds) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'queue-reorder', queueIds }));
  },
  onRemove: (queueId) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'queue-remove', queueId }));
  },
  onSendNow: (queueId) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'queue-send-now', queueId }));
  },
});
const historyPane = initHistoryPane({
  modal: document.getElementById('historyModal'),
  body: document.getElementById('historyBody'),
  closeButton: document.getElementById('historyCloseBtn'),
  titleEl: document.getElementById('historyTitle'),
  exportButton: document.getElementById('historyExportBtn'),
});

let ws = null;
let sessionId = null;
let sessionToken = null;
let currentMode = 'default';
let pendingApprovalRequestId = null;
let pendingApprovalToolName = null; // gates planReviewControls/rejectBtn's label - only ExitPlanMode gets the plan-review treatment
let availableCommands = [];
let availableAgents = []; // Query.supportedAgents(), fetched once on connect - see the `if (!reconnect)` block below
// Sticky "default agent" set by clicking a roster entry (renderAgentsList) -
// null means no forced delegation. Applied client-side only (see onSend
// below): there's no SDK hook to force a subagent, so this just prefixes an
// instruction onto the outgoing text. Not synced across tabs/reconnects -
// purely local UI state, cleared on session switch (the `if (!reconnect)`
// reset block below).
let selectedAgentName = null;
let currentModel = null; // set from cockpit:hello/state - see applySession
let currentProvider = 'claude';
let currentCwd = null; // set from cockpit:hello/state - see applySession; used by the export-session route
// The transcript's own session id (session-registry.js's row.claudeSessionId),
// not the cockpit registry's own `sessionId` - the export route reads the
// on-disk transcript, which is keyed by this one. Null until the SDK's
// first system/init message reports it (same "not yet known" window
// row.claudeSessionId itself has server-side), so #exportBtn stays disabled
// until then rather than pointing at a 404.
let currentClaudeSessionId = null;
let currentSessionName = null; // session.name - the durable title (session-titles.js), if this session has one

function sessionProviderLabel() {
  return currentProvider === 'grok' ? 'Grok' : 'Claude';
}

// Compose-box addressee: the session's own name when it has one (launcher
// "Name" field / rename), otherwise Claude or Grok. Used by the placeholder
// so a Grok tab never still says "Message Claude...".
function sessionAddressName() {
  return currentSessionName || sessionProviderLabel();
}

function composePlaceholder() {
  return `Message ${sessionAddressName()}... (Enter to send, Shift+Enter for newline, @ for files, / for commands)`;
}
let cachedModels = null; // Query.supportedModels() result, fetched once per session on first /model - see fetchModels
// Whether the plugin panel has already paid its one reload cost for this
// session (B2) - opening Settings repeatedly used to re-run reload-plugins
// (and its side effect of reloading commands/agents/MCP servers) every
// single time, which is both wasteful and mutates live session state just
// from opening a modal. Reset to false on every fresh connect() below.
let pluginsLoadedForSession = false;
let hasFileCheckpointing = true; // set from cockpit:hello/state - see applySession
let turnIndexUnreliable = false; // set from cockpit:hello/state - hides the rewind button entirely, see applySession

// Reconnect (MVP3): the highest event seq rendered so far (event-log.js),
// sent back as `since` on the next connect so the server can send only the
// delta instead of the whole visible transcript again. Reset to 0 whenever
// a session is entered fresh (new start, resume, rewind fork) - only an
// actual reconnect to the *same* session carries it forward.
let lastSeq = 0;
let reconnectAttempt = 0;
let reconnectTimer = null;
// Debug capture only (reportStuckBtn below) - epoch ms of the last message
// this socket actually received, so a report can show "stuck for Ns" rather
// than just the state label's word.
let lastMessageAt = null;
// Set right before a deliberate disconnect (closing the session, leaving
// for the launcher) so ws.onclose knows not to schedule a reconnect for it.
let intentionalClose = false;
let previousState = null; // drives the "turn finished while unfocused" needs-attention signal

const tabChrome = initTabChrome();

const ACTIVE_SESSION_KEY = 'cockpit:activeSession';

function saveActiveSession(id, token) {
  try {
    // sessionStorage, not localStorage: this must stay scoped to *this* tab.
    // localStorage is shared across every tab on the origin, so a second tab
    // opened to the same URL would read tab 1's session here and silently
    // rejoin it (see rejoinActiveSession) instead of showing the launcher -
    // which defeats having 2-3 independent sessions open at once.
    sessionStorage.setItem(ACTIVE_SESSION_KEY, JSON.stringify({ id, token }));
  } catch {
    // sessionStorage can throw (private browsing, quota) - reconnect-on-reload
    // just won't work this time, nothing else depends on it.
  }
}

function loadActiveSession() {
  try {
    const raw = sessionStorage.getItem(ACTIVE_SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function clearActiveSession() {
  try {
    sessionStorage.removeItem(ACTIVE_SESSION_KEY);
  } catch {
    // ignore, see saveActiveSession
  }
}

// Bug: window.open(url, '_blank') from newSessionTabBtn's handler below
// looked like it should land on a fresh launcher (sessionStorage is
// per-tab, per the comment on saveActiveSession) - but the HTML spec says
// a same-origin tab opened by a script (as opposed to by the user
// typing/bookmarking a URL) gets a *copy* of the opener's sessionStorage,
// not an empty one. So the new tab inherited cockpit:activeSession and
// rejoinActiveSession() below silently reattached it to the SAME session
// instead of showing the launcher. `?newTab=1` is a one-shot marker: the
// button appends it, and on load - before rejoinActiveSession runs - it
// clears the inherited copy and strips itself from the URL so a later
// reload of *this* tab (once it has its own real session) behaves
// normally again.
(function discardInheritedSessionOnNewTab() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has('newTab')) return;
  clearActiveSession();
  url.searchParams.delete('newTab');
  history.replaceState(null, '', url);
})();

// Last 3 unique folders a session was started in, most-recent-first, so the
// launcher can offer them as a dropdown instead of retyping/re-browsing the
// same path every time. Client-side only (localStorage) - the server has no
// notion of "recent", it just takes whatever cwd a start request sends.
const RECENT_FOLDERS_KEY = 'cockpit:recentFolders';
const MAX_RECENT_FOLDERS = 3;

function loadRecentFolders() {
  try {
    const raw = localStorage.getItem(RECENT_FOLDERS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function rememberRecentFolder(cwd) {
  if (!cwd) return;
  const list = [cwd, ...loadRecentFolders().filter((f) => f !== cwd)].slice(0, MAX_RECENT_FOLDERS);
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(list));
  } catch {
    // ignore, see saveActiveSession
  }
  renderRecentFolders();
}

function renderRecentFolders() {
  const list = loadRecentFolders();
  recentFoldersSelect.innerHTML = '<option value="">…</option>';
  for (const cwd of list) {
    const opt = document.createElement('option');
    opt.value = cwd;
    opt.textContent = cwd;
    recentFoldersSelect.append(opt);
  }
  if (list.length) recentFoldersSelect.setAttribute('data-has-options', '');
  else recentFoldersSelect.removeAttribute('data-has-options');
}

recentFoldersSelect.addEventListener('change', () => {
  if (recentFoldersSelect.value) cwdInput.value = recentFoldersSelect.value;
  recentFoldersSelect.value = '';
});

renderRecentFolders();

// Session-scoped /api/sessions/:id/* routes require this now, same as the
// websocket already did - they were reachable by any page's cross-origin
// fetch with only the session id (no secret) to guess, since the id is a
// UUID but was never actually checked. See server.js's handleSessionRoute.
function authHeaders() {
  return { authorization: `Bearer ${sessionToken}` };
}

// file-picker/model-picker/command-picker each toggle their own dropdown's
// visibility as their open/closed signal (classList 'show' for the former,
// style.display for the latter two - predates any shared convention, not
// worth normalizing just for this read). Checked from compose.js's history
// recall so Up/Down navigating an open suggestion list doesn't also swap
// in a history entry underneath it.
function isSuggestionPickerOpen() {
  const fileDropdown = document.getElementById('fileSuggestions');
  const modelDropdown = document.getElementById('modelSuggestions');
  const commandDropdown = document.getElementById('commandSuggestions');
  const historyDropdown = document.getElementById('historySuggestions');
  return (
    fileDropdown.classList.contains('show') ||
    modelDropdown.style.display === 'block' ||
    commandDropdown.style.display === 'block' ||
    historyDropdown.style.display === 'block'
  );
}

// Persisted prompt history + Ctrl+R fuzzy search (backlog.md) - one store
// shared by compose.js's Up/Down recall and history-search.js's dropdown,
// see prompt-history.js's module comment. setCwd() is called from
// applySession() below once a session's cwd is known.
const promptHistory = createPromptHistoryStore();
initHistorySearch({
  textarea: document.getElementById('composeInput'),
  dropdown: document.getElementById('historySuggestions'),
  getEntries: () => promptHistory.list(),
  fuzzyScore,
  isPickerOpen: isSuggestionPickerOpen,
});

const compose = initCompose({
  textarea: document.getElementById('composeInput'),
  sendButton: document.getElementById('sendBtn'),
  resizeHandle: document.getElementById('composeResizeHandle'),
  streamEl,
  isScrolledToBottom,
  isPickerOpen: isSuggestionPickerOpen,
  promptHistory,
  sendGroupEl: document.getElementById('composeSendGroup'),
  onSend: (text) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // MVP5 cross-session delegation (backlog.md) - `/ask <Name>: <text>`,
    // colon required, name is everything up to the first colon (trimmed).
    // Checked before the agent-prefix logic below: a delegate command must
    // never get wrapped in a Task-tool instruction or sent as a plain
    // 'input' turn - it's routed to a different session entirely.
    const trimmed = text.trim();
    const delegateMatch = /^\/ask\s+([^:]+):\s*([\s\S]+)$/i.exec(trimmed);
    if (delegateMatch) {
      const targetName = delegateMatch[1].trim();
      const task = delegateMatch[2].trim();
      ws.send(JSON.stringify({ type: 'delegate', targetName, text: task }));
      return;
    }
    // A malformed /ask (missing the colon, or nothing after it) must not
    // fall through to the plain-input path below - that would ship the
    // literal text "/ask ..." to this session's own model, which has no way
    // to know it's a misfired cockpit command and tries to resolve it as one
    // of ITS OWN slash commands instead (confirmed in review: shows "Unknown
    // command: /ask. Did you mean /fast?", which is actively misleading -
    // this was never headed for the model at all). Caught here, before it
    // ever reaches the websocket, with the actual fix spelled out.
    if (/^\/ask\b/i.test(trimmed)) {
      alert('To send to a session, use: /ask <Name>: <text>\n(e.g. "/ask Grok: send to session Grok this text")');
      return;
    }
    // Sticky agent prefix (see selectedAgentName above) - a plain
    // instruction, not an SDK-enforced setting, so it's visible in the
    // transcript like anything else you'd type by hand. Never applied to a
    // slash command: those resolve server-side before any model turn (see
    // command-picker.js's module comment), so wrapping one in a Task-tool
    // instruction would just make Claude ponder the literal command text
    // instead of running it. Agent name is JSON-stringified rather than
    // hand-quoted, so a name containing a quote/backslash can't break out of
    // the instruction string.
    const outgoing = selectedAgentName && !text.startsWith('/')
      ? `Use the Task tool with subagent_type: ${JSON.stringify(selectedAgentName)} to handle this request: ${text}`
      : text;
    ws.send(JSON.stringify({ type: 'input', text: outgoing }));
  },
});
compose.setEnabled(false);

initFilePicker({
  textarea: document.getElementById('composeInput'),
  dropdown: document.getElementById('fileSuggestions'),
  getSessionId: () => sessionId,
  getSessionToken: () => sessionToken,
  getCustomFolders: () => settings.getCustomFolders(),
});

initDropTarget({
  textarea: document.getElementById('composeInput'),
  getSessionId: () => sessionId,
  getSessionToken: () => sessionToken,
});

initModelPicker({
  textarea: document.getElementById('composeInput'),
  dropdown: document.getElementById('modelSuggestions'),
  fetchModels,
  getCurrentModel: () => currentModel,
  onSelect: selectModel,
});

initCommandPicker({
  textarea: document.getElementById('composeInput'),
  dropdown: document.getElementById('commandSuggestions'),
  getCommands: () => availableCommands,
});

// Shared "fetch a /api/sessions/:id/* route, parse JSON, throw the server's
// own error message on !ok" shape - every read/write call in this file that
// isn't already doing its own optimistic-UI-plus-alert() handling (selectModel,
// setMode, etc.) used to repeat this by hand.
async function sessionFetch(path, opts = {}) {
  const res = await fetch(`/api/sessions/${sessionId}${path}`, {
    ...opts,
    headers: { ...authHeaders(), ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.statusText);
  return res.json();
}

// Query.supportedModels() (same shape as supportedCommands(), server.js's
// 'models' route) - fetched lazily on first /model rather than eagerly on
// connect like commands, since picking a model is rare enough not to be
// worth a request every session start. Cached per session; reset on a
// fresh connect() below.
async function fetchModels() {
  if (cachedModels) return cachedModels;
  cachedModels = await sessionFetch('/models');
  return cachedModels;
}

async function selectModel(model) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/model`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ model }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`could not switch model: ${err.error || res.statusText}`);
    }
    // On success, the server pushes the confirmed model back via cockpit:state.
  } catch (err) {
    alert(`could not switch model: ${err.message || err}`);
  }
}

// MCP servers panel (settings modal) - same fetch/throw shape as
// fetchModels/selectModel above. No caching (unlike fetchModels): status can
// change any time and this only runs on-demand (modal open / manual
// refresh), so a stale cache would defeat the point.
async function fetchMcpStatus() {
  return sessionFetch('/mcp');
}

async function toggleMcpServer(name, enabled) {
  await sessionFetch('/mcp-toggle', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name, enabled }),
  });
}

async function reconnectMcpServerApi(name) {
  await sessionFetch('/mcp-reconnect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
}

const mcpPanel = initMcpPanel({
  listEl: document.getElementById('mcpServerList'),
  refreshButton: document.getElementById('mcpRefreshBtn'),
  fetchStatus: fetchMcpStatus,
  toggleServer: toggleMcpServer,
  reconnectServer: reconnectMcpServerApi,
});

// Plugins panel (settings modal) - loadOrReloadPlugins reuses reloadPlugins()
// too: there's no separate read-only "list plugins" route (Query has no
// plain listPlugins(), only the reload-and-return-list one), so opening the
// panel for the first time pays the same reload cost a manual "Reload
// plugins" click would. Named for what it actually does (a prior version was
// called fetchPlugins, which read as read-only and wasn't) - see
// pluginsLoadedForSession below (B2) for why this doesn't run on *every*
// open.
async function loadOrReloadPlugins() {
  const result = await reloadPluginsApi();
  return result.plugins || [];
}

async function reloadPluginsApi() {
  const result = await sessionFetch('/reload-plugins', { method: 'POST' });
  // reload-plugins reloads commands/agents/MCP servers too as an SDK-side
  // effect (session-registry.js's reloadPlugins comment), but that doesn't
  // go through the normal message loop that pushes a commands_changed event
  // (public/command-picker.js) - so without this, the "/" picker and agents
  // roster silently go stale the moment plugins are reloaded (B2).
  refreshCommandsAndAgents();
  return result;
}

// Fetches the current command/agent lists fresh and swaps them in. Used both
// on a brand-new connect() and after any plugin reload (see reloadPluginsApi
// above) - the only two things that can actually change what's in them.
function refreshCommandsAndAgents() {
  if (!sessionId) return;
  fetch(`/api/sessions/${sessionId}/commands`, { headers: authHeaders() })
    .then((r) => r.json()).then((cmds) => { availableCommands = cmds; }).catch(() => {});
  fetch(`/api/sessions/${sessionId}/agents`, { headers: authHeaders() })
    .then((r) => r.json()).then((agents) => {
      availableAgents = Array.isArray(agents) ? agents : [];
      agentsBtn.style.display = availableAgents.length > 0 ? 'inline-block' : 'none';
      // A previously-armed agent may no longer exist post-reload - drop it
      // silently rather than keep prefixing sends with a subagent_type the
      // roster no longer lists.
      if (selectedAgentName && !availableAgents.some((a) => a.name === selectedAgentName)) {
        selectedAgentName = null;
        applyAgentArmedIndicator();
      }
      if (agentsList.children.length) renderAgentsList(); // re-render if the roster dropdown was already open/populated
    }).catch(() => {});
}

async function setPluginEnabledApi(pluginKey, enabled) {
  await sessionFetch('/plugin-enabled', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ pluginKey, enabled }),
  });
}

const pluginPanel = initPluginPanel({
  listEl: document.getElementById('pluginList'),
  reloadButton: document.getElementById('pluginReloadBtn'),
  warningEl: document.getElementById('pluginWarning'),
  fetchPlugins: loadOrReloadPlugins,
  reloadPlugins: reloadPluginsApi,
  setPluginEnabled: setPluginEnabledApi,
});

// Stats tab (settings modal) - all-projects usage stats, src/global-stats.js.
// No sessionId dependency (unlike mcpPanel/pluginPanel above): it reads
// ~/.claude/projects directly, not this session's own SDK connection, so it
// works even pre-session. Lazy-loaded on the tab's own first click below
// (a real transcript scan, not a cheap status GET like MCP/plugins) rather
// than on every modal open.
const globalStatsPanel = initGlobalStatsPanel({
  bodyEl: document.getElementById('statsBody'),
  rangeSelect: document.getElementById('statsRangeBtn'),
  refreshButton: document.getElementById('statsRefreshBtn'),
});
document.querySelector('[data-settings-tab="stats"]')?.addEventListener('click', () => globalStatsPanel.ensureLoaded());

const dirBrowser = initDirBrowser({
  modal: document.getElementById('dirBrowserModal'),
  pathLabel: document.getElementById('dirPath'),
  list: document.getElementById('dirList'),
  upButton: document.getElementById('dirUpBtn'),
  selectButton: document.getElementById('dirSelectBtn'),
  cancelButton: document.getElementById('dirCancelBtn'),
  onSelect: (path) => {
    cwdInput.value = path;
  },
});
browseBtn.addEventListener('click', () => dirBrowser.open(cwdInput.value));

const diffView = initDiffView({
  modal: document.getElementById('diffModal'),
  body: document.getElementById('diffBody'),
  closeButton: document.getElementById('diffCloseBtn'),
});
diffBtn.addEventListener('click', () => sessionId && diffView.open(sessionId, sessionToken));

// Agents roster: expand/collapse in place, list built once from the
// already-fetched availableAgents (connect() above) - no round trip on
// click, this is read-only and doesn't change mid-session.
agentsBtn.addEventListener('click', () => {
  const opening = agentsList.style.display === 'none';
  if (opening && agentsList.children.length === 0) renderAgentsList();
  agentsList.style.display = opening ? 'block' : 'none';
  agentsBtn.classList.toggle('open', opening);
});

// Toggles the same settings.turnChartEnabled value the settings-modal
// checkbox does (see settings.js's setTurnChartEnabled) - two entry points
// into one persisted flag, not two independent states.
turnChartToggleBtn.addEventListener('click', () => settings.setTurnChartEnabled(!settings.isTurnChartEnabled()));

// Same shape as turnChartToggleBtn above, for the task list panel.
taskPanelToggleBtn.addEventListener('click', () => settings.setTaskPanelEnabled(!settings.isTaskPanelEnabled()));

// Same shape again, for the tool-call detail pane.
detailPaneToggleBtn.addEventListener('click', () => settings.setDetailPaneEnabled(!settings.isDetailPaneEnabled()));

function renderAgentsList() {
  agentsList.innerHTML = '';
  for (const agent of availableAgents) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'cmd-name' + (agent.name === selectedAgentName ? ' selected' : '');
    name.textContent = agent.name;
    const desc = document.createElement('span');
    desc.className = 'cmd-desc';
    desc.textContent = agent.model ? `${agent.description} (${agent.model})` : agent.description;
    li.append(name, desc);
    // Click toggles this agent as the sticky default (see selectedAgentName)
    // - clicking the already-selected one clears it back to no forced agent.
    li.addEventListener('click', () => {
      selectedAgentName = selectedAgentName === agent.name ? null : agent.name;
      renderAgentsList();
      applyAgentArmedIndicator();
    });
    agentsList.append(li);
  }
}

// Visible cue that a sticky agent is armed (B1) - without this the button
// looks identical whether or not every subsequent send is about to get
// prefixed with the Task-tool instruction.
function applyAgentArmedIndicator() {
  agentsBtn.classList.toggle('armed', Boolean(selectedAgentName));
  agentsBtn.textContent = selectedAgentName ? `Agents: ${selectedAgentName}` : 'Agents';
}
autoContinueBtn.addEventListener('click', () => setAutoContinue(autoContinueBtn.checked));

// Desktop's checkbox, ported here: same shape as setMode() above (optimistic
// UI already applied by the native checkbox click, revert on failure). The
// server pushes the confirmed value back via cockpit:state either way - see
// applySession.
async function setAutoContinue(enabled) {
  try {
    const res = await fetch(`/api/sessions/${sessionId}/auto-continue`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ enabled }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert(`could not change auto-continue: ${err.error || res.statusText}`);
      autoContinueBtn.checked = !enabled;
    }
  } catch (err) {
    alert(`could not change auto-continue: ${err.message || err}`);
    autoContinueBtn.checked = !enabled;
  }
}

// The one caller closeSession() previously had none of (see
// session-registry.js's closeSession comment) - without this, every
// rewind leaves its origin session's live query() (a real CLI subprocess)
// running for the cockpit process's entire remaining lifetime, with no way
// back to it and no way to end it. Doesn't touch the on-disk transcript -
// only ends this cockpit's live process for it, same as closing a terminal.
async function closeSession() {
  if (!sessionId) return;
  if (!confirm('Close this session? Its transcript stays on disk (resumable later), but this live process ends now.')) return;
  intentionalClose = true;
  await fetch(`/api/sessions/${sessionId}`, { method: 'DELETE', headers: authHeaders() });
  sessionListPane.refreshCount();
  returnToLauncher();
}

// Cog button opens the modal instead of Close session sitting directly in
// the header - see settings.js's module comment for why.
const settings = initSettings({
  modal: document.getElementById('settingsModal'),
  cogButton: settingsBtn,
  closeButton: document.getElementById('settingsCloseBtn'),
  autoCollapseCheckbox: document.getElementById('autoCollapsePreviousGroupBtn'),
  customFoldersListEl: document.getElementById('customFoldersList'),
  addCustomFolderButton: document.getElementById('addCustomFolderBtn'),
  // Reuses the same Browse modal as the cwd launcher (dirBrowser, defined
  // above) rather than standing up a second dir-browser instance - dir-
  // browser.js's open() takes a per-call onSelect override for exactly this.
  onBrowseFolder: (onSelect) => dirBrowser.open('', onSelect),
  turnChartCheckbox: document.getElementById('turnChartEnabledBtn'),
  timestampsCheckbox: document.getElementById('showTimestampsBtn'),
  detailPaneCheckbox: document.getElementById('detailPaneEnabledBtn'),
  pendingTurnsBadgeCheckbox: document.getElementById('pendingTurnsBadgeEnabledBtn'),
  closeSessionButton: closeSessionBtn,
  onAutoCollapseChange: setAutoCollapsePreviousGroup,
  onTurnChartEnabledChange: (enabled) => {
    turnChart.setEnabled(enabled);
    turnChartToggleBtn.classList.toggle('on', enabled);
  },
  onTaskPanelEnabledChange: (enabled) => {
    taskPanel.setEnabled(enabled);
    taskPanelToggleBtn.classList.toggle('on', enabled);
  },
  onDetailPaneEnabledChange: (enabled) => {
    detailPane.setEnabled(enabled);
    detailPaneToggleBtn.classList.toggle('on', enabled);
  },
  // Debug option - flipping it off hides the badge immediately even if a
  // turn is genuinely still pending; flipping it on re-shows it on the next
  // summary (applySession above already re-evaluates display each time).
  onPendingTurnsBadgeEnabledChange: (enabled) => {
    if (!enabled) pendingTurnsBadge.style.display = 'none';
    else if (!forceIdleArmed) pendingTurnsBadge.style.display = lastPendingTurnsCount > 0 ? 'inline-block' : 'none';
  },
  // Toggles the CSS class both stream-view.js render targets read
  // (index.html) - retroactive, so flipping this instantly stamps/unstamps
  // every message already on screen instead of only new ones.
  onTimestampsChange: (enabled) => {
    streamEl.classList.toggle('show-timestamps', enabled);
    const historyBody = document.getElementById('historyBody');
    if (historyBody) historyBody.classList.toggle('show-timestamps', enabled);
  },
  onCloseSession: closeSession,
  // No session yet (modal shouldn't really be reachable pre-session, but
  // guard anyway) - both panels' fetchers throw on a null sessionId, so skip
  // the round trip rather than surface a confusing error on open.
  onOpen: () => {
    if (!sessionId) return;
    mcpPanel.refresh(); // read-only status GET, safe to re-run every open
    // Plugin panel only auto-loads once per session (B2, see
    // pluginsLoadedForSession) - past the first open, its "Reload plugins"
    // button is the only thing that pays the reload cost again.
    if (!pluginsLoadedForSession) {
      pluginsLoadedForSession = true;
      pluginPanel.refresh();
    }
    refreshPermissionRulesList();
    refreshGitGuardMode();
    refreshHandshakeStatus();
  },
});

const gitGuardModeEl = document.getElementById('gitGuardModeBtn');
const gitGuardErrorEl = document.getElementById('gitGuardError');

// Project-scoped (src/git-commit-guard.js via settings.local.json), not a
// localStorage preference - same "read fresh on every modal open" reasoning
// as refreshPermissionRulesList: reflects whatever another tab/session for
// this cwd last saved, not a stale value cached from page load.
async function refreshGitGuardMode() {
  gitGuardErrorEl.style.display = 'none';
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/git-guard`, { headers: authHeaders() });
    if (!res.ok) return;
    const { mode } = await res.json();
    gitGuardModeEl.value = mode;
  } catch {
    // offline/blocked - select just keeps showing its last-known value
  }
}

gitGuardModeEl.addEventListener('change', async () => {
  if (!sessionId) return;
  const mode = gitGuardModeEl.value;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/git-guard`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ mode }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'save failed');
    gitGuardErrorEl.style.display = 'none';
  } catch (err) {
    gitGuardErrorEl.textContent = `Couldn't save git commit guard setting: ${err.message || err}`;
    gitGuardErrorEl.style.display = '';
  }
});

// MVP6 seed (backlog.md): THIS session's own delegation handshake trust
// status, plus a paste-in field to re-sync it. Distinct from the read-only
// server-wide copy in session-list-pane.js - see this file's own comment
// there for why the paste action has to live here, scoped to this tab's own
// session token, rather than in the cross-tab "All sessions" list.
const handshakeStatusEl = document.getElementById('handshakeStatus');
const handshakeInputEl = document.getElementById('handshakeInput');
const handshakeSaveBtnEl = document.getElementById('handshakeSaveBtn');
const handshakeErrorEl = document.getElementById('handshakeError');

async function refreshHandshakeStatus() {
  handshakeErrorEl.style.display = 'none';
  handshakeInputEl.value = '';
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/sessions/${sessionId}`, { headers: authHeaders() });
    if (!res.ok) return;
    const { handshakeTrusted } = await res.json();
    handshakeStatusEl.textContent = handshakeTrusted ? '✓ trusted' : '⚠ not trusted - paste the value below';
  } catch {
    // offline/blocked - status just keeps showing its last-known value
  }
}

handshakeSaveBtnEl.addEventListener('click', async () => {
  if (!sessionId) return;
  const value = handshakeInputEl.value;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/handshake`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ value }),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'save failed');
    const { trusted } = await res.json();
    handshakeStatusEl.textContent = trusted ? '✓ trusted' : '⚠ not trusted - value did not match';
    handshakeErrorEl.style.display = 'none';
  } catch (err) {
    handshakeErrorEl.textContent = `Couldn't save handshake value: ${err.message || err}`;
    handshakeErrorEl.style.display = '';
  }
});

const permissionRulesListEl = document.getElementById('permissionRulesList');

// Read-only status GET, same "safe to re-run every open" reasoning as
// mcpPanel.refresh() above - reflects whatever the approval banner's
// "always in this project" scope has written since the modal was last open.
async function refreshPermissionRulesList() {
  permissionRulesListEl.innerHTML = '';
  if (!sessionId) return;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/permissions`, { headers: authHeaders() });
    if (!res.ok) return;
    const { allow } = await res.json();
    for (const rule of allow || []) {
      const li = document.createElement('li');
      li.className = 'custom-folder-row'; // reuses the @-folder list's row/remove-button styling, same shape

      const label = document.createElement('span');
      label.className = 'cmd-name';
      label.textContent = rule;
      li.append(label);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'custom-folder-remove';
      removeBtn.textContent = '−';
      removeBtn.title = `Revoke always-allow for ${rule}`;
      removeBtn.addEventListener('click', async () => {
        await fetch(`/api/sessions/${sessionId}/permissions`, {
          method: 'DELETE',
          headers: { 'content-type': 'application/json', ...authHeaders() },
          body: JSON.stringify({ rule }),
        });
        refreshPermissionRulesList();
      });
      li.append(removeBtn);

      permissionRulesListEl.append(li);
    }
  } catch {
    // offline/blocked - list just stays empty until the next open, not fatal
  }
}

const sessionLabelErrorEl = document.getElementById('sessionLabelError');

sessionLabelEl.addEventListener('click', () => {
  if (!sessionId) return;
  // Pre-filled with whatever durable title (session-titles.js) this
  // session already has, so re-opening the prompt to tweak a title doesn't
  // start from blank - `prompt()`'s own default-value arg does this for
  // free, no extra state needed beyond what applySession already tracks.
  const next = prompt('Rename this session:', currentSessionName || '');
  if (next === null) return; // cancelled
  tabChrome.rename(next);
  sessionLabelErrorEl.style.display = 'none';
  fetch(`/api/sessions/${sessionId}/title`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ title: next }),
  }).then(async (res) => {
    if (res.ok) return;
    const body = await res.json().catch(() => ({}));
    sessionLabelErrorEl.textContent = `Rename didn't save: ${body.error || res.statusText}`;
    sessionLabelErrorEl.style.display = 'inline';
  }).catch(() => {
    sessionLabelErrorEl.textContent = "Rename didn't save (offline?) - it'll only last this tab.";
    sessionLabelErrorEl.style.display = 'inline';
  });
});

// Purely informational - a glance at what's active, not a control. Used to
// open Settings on click, but that surprised more than it helped (nothing
// about the badge signals "this is a button"), so it's inert now: no click
// handler, no pointer cursor (style.css), no "click to change" tooltip
// (index.html). Change model/effort/thinking from the Settings modal
// (settingsBtn) or the General tab directly.

// One SDK-reported model id (currentModel) + whichever reasoning knob this
// provider actually has - Claude's thinking-token budget or Grok's named
// effort tier, never both (session-registry.js's capabilities.thinkingBudget
// / .effort are already mutually exclusive per provider). currentModel can
// still be null right after a "Default model" launch, before the first
// assistant reply resolves it (session-registry.js's applyAssistantUsage) -
// the badge just stays hidden until then rather than showing a misleading
// blank chip.
function applyModelBadge(session) {
  if (!currentModel) { modelBadge.style.display = 'none'; return; }
  const parts = [currentModel];
  if (currentProvider === 'grok') {
    // Always shown, not just when explicitly set - mirrors thinking's own
    // "thinking default" fallback below rather than silently dropping the
    // part when session.effort happens to be falsy.
    parts.push(`${session.effort ? (GROK_EFFORT_LABELS[session.effort] || session.effort) : 'default'} effort`);
  } else {
    // Three distinct states, not two - 0 is a real explicit "Off" (falsy,
    // so it can't share a branch with "unset"; see THINKING_BUDGET_PRESETS'
    // comment for why 0 vs null actually differ on the SDK side). null/
    // undefined is "Default" - what actually happens then is model-
    // dependent (adaptive thinking on for Opus5/Sonnet5/Fable5, off on
    // older models), so the badge says "default" rather than guessing.
    // Claude has both dials now (session-registry.js line ~483: "both
    // providers support reasoning effort now") - the badge only ever showed
    // thinking-budget here, so effort silently never appeared for Claude
    // sessions even though it's a real, independently-set field. Always
    // shown now (not gated on session.effort being truthy), same reasoning
    // as the Grok branch above - an unset effort is still worth surfacing
    // as "default effort", not omitted.
    // Unset effort isn't "no effort" - the SDK still picks a real tier
    // ('high', per CLAUDE_EFFORT_OPTIONS' own sourced comment), so show that
    // real value (already carrying its own '*' default marker) instead of
    // the vague "default effort".
    parts.push(`${CLAUDE_EFFORT_LABELS[session.effort || 'high'] || session.effort} effort`);
    parts.push(
      session.maxThinkingTokens === 0
        ? 'thinking off'
        : session.maxThinkingTokens
          ? `thinking ${formatThinkingTokens(session.maxThinkingTokens)}`
          : 'thinking default',
    );
  }
  modelBadge.textContent = parts.join(' · ');
  modelBadge.style.display = 'inline-block';
}

function formatThinkingTokens(tokens) {
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

function returnToLauncher() {
  intentionalClose = true;
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (ws) {
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    ws.close();
    ws = null;
  }
  sessionId = null;
  sessionToken = null;
  lastSeq = 0;
  clearActiveSession();
  tabChrome.rename(null); // a tab name the user set only makes sense for the session it was set on
  tabChrome.setAutoName('Prompt Cockpit');
  tabChrome.setState('idle');
  setState('idle'); // stops the spinner interval too (stopSpinner), so hiding activityBar below doesn't leave a dead interval running behind it
  tabChrome.setNeedsAttention(false);
  statsPanel.reset();
  launcherEl.style.display = 'block';
  streamWrapEl.style.display = 'none';
  composeEl.style.display = 'none';
  activityBar.style.display = 'none'; // sits directly above compose (index.html) - hides in lockstep with it rather than floating alone on the launcher screen
  modeBtn.style.display = 'none';
  autoContinueLabel.style.display = 'none';
  rateLimitBanner.style.display = 'none';
  agentsBar.style.display = 'none';
  // Hides the panel even if the setting is persisted on (B9) - it otherwise
  // kept floating above the hidden compose box on the launcher screen.
  // Internal `enabled` flag is restored to match the setting in connect()
  // below, once there's a session for it to chart again.
  turnChart.setEnabled(false);
  taskPanel.setEnabled(false); // same B9-style force-hide as turnChart above - see its own comment
  detailPane.setEnabled(false); // same B9-style force-hide - nothing to show once there's no live session
  queuePanel.reset();
  agentsList.style.display = 'none';
  agentsList.innerHTML = '';
  agentsBtn.classList.remove('open');
  selectedAgentName = null;
  applyAgentArmedIndicator();
  diffBtn.style.display = 'none';
  compactBtn.style.display = 'none';
  compactBtn.classList.remove('compact-urgent');
  reportStuckBtn.style.display = 'none';
  copyLastBtn.style.display = 'none';
  exportBtn.style.display = 'none';
  currentCwd = null;
  currentClaudeSessionId = null;
  currentSessionName = null;
  sessionLabelErrorEl.style.display = 'none';
  modelBadge.style.display = 'none';
  stopBtn.style.display = 'none';
  disarmStop();
  pendingTurnsBadge.style.display = 'none';
  disarmForceIdle();
  closeSessionBtn.style.display = 'none';
  settingsBtn.style.display = 'none';
  document.getElementById('settingsModal').style.display = 'none';
  loadResumable();
}

// Best guess at the terminal's own per-mode colors, matched to this app's
// existing palette rather than exact CLI hex values (not independently
// confirmed against the CLI's actual ANSI/theme colors - easy to retune,
// it's just this one object). `auto` orange per direct request.
const MODE_COLORS = {
  default: 'var(--muted)',
  acceptEdits: 'var(--ok)',
  plan: 'var(--accent)',
  bypassPermissions: 'var(--error)',
  dontAsk: '#b585f0',
  auto: '#e0b34d',
};

function applyModeColor(mode) {
  const color = MODE_COLORS[mode] || 'var(--text)';
  modeBtn.style.color = color;
  modeBtn.style.borderColor = color;
}

// A dropdown instead of a click-to-cycle button: every mode is one click
// away rather than up to five. Shift+Tab still cycles (below) - the two
// controls drive the same setMode() and stay in sync via applySession's
// modeBtn.value assignment either way.
for (const mode of PERMISSION_MODES) {
  const option = document.createElement('option');
  option.value = mode;
  option.textContent = mode;
  option.style.color = MODE_COLORS[mode] || '';
  option.style.background = 'var(--panel)';
  modeBtn.append(option);
}
modeBtn.addEventListener('change', () => { applyModeColor(modeBtn.value); setMode(modeBtn.value); });

// Thinking budget: preset tiers only (deliberately no free-entry number
// field - see backlog). Values chosen as sensible round tiers, not anything
// the SDK prescribes. Lives in the Settings modal (thinkingControlsGroup)
// and the launcher's shared startEffortSelect slot (fillStartEffort below).
//
// '' (Default) vs '0' (Off) are deliberately two distinct options, not one -
// confirmed against the installed @anthropic-ai/claude-agent-sdk's own
// sdk.d.ts (0.3.231) plus a live probe against claude-opus-5
// (tests/thinking-default-probe.manual.mjs, 2026-08-20; see
// .claude/memory/sdk-streaming-input-gotchas.md item 3 for the full trail):
//   - Query.setMaxThinkingTokens (the only mid-session thinking control the
//     SDK exposes - there is no setThinking method) is deprecated, and its
//     own doc says "0 = disabled, any other value = adaptive" - so 0 is the
//     one value that genuinely turns thinking off.
//   - null/undefined (this UI's '') "clears the limit" - the probe confirmed
//     this actually resolves to ADAPTIVE THINKING ON for claude-opus-5 (and,
//     per the same class of model, sonnet-5/fable-5), not off. Before this
//     comment, '' was mislabeled "Off" here, which meant the launcher/
//     Settings "Off" button never actually disabled thinking on Opus 5.
// The 4k/10k/32k tiers still work as literal token budgets on pre-4.6
// models; on Opus 4.6+ they're indistinguishable from each other (any
// nonzero value just means "on") per the same doc comment - harmless to
// keep since they're not wrong, just no longer literally sized on new
// models.
const THINKING_BUDGET_PRESETS = [
  // Marked default (see CLAUDE.md-style marker request): this is genuinely
  // what happens with nothing set, on every Claude model - it just resolves
  // differently per model (adaptive-on for Opus5/Sonnet5/Fable5, off for
  // older/unsupported models), so the marked *option* never moves even
  // though its *meaning* is model-dependent.
  { value: '', label: 'Default *' },
  { value: '0', label: 'Off' },
  { value: '4000', label: '4k' },
  { value: '10000', label: '10k' },
  { value: '32000', label: '32k' },
];
for (const preset of THINKING_BUDGET_PRESETS) {
  const option = document.createElement('option');
  option.value = preset.value;
  option.textContent = preset.label;
  thinkingBudgetBtn.append(option);
}

// thinkingDisplay only matters once a budget is actually on, but stays
// enabled regardless - picking it ahead of turning thinking on is harmless,
// the SDK just ignores it until there's something to display.
const THINKING_DISPLAY_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'summarized', label: 'Summarized' },
  { value: 'omitted', label: 'Omitted' },
];
for (const opt of THINKING_DISPLAY_OPTIONS) {
  const option = document.createElement('option');
  option.value = opt.value;
  option.textContent = opt.label;
  thinkingDisplayBtn.append(option);
}

thinkingBudgetBtn.addEventListener('change', () => selectThinking());
thinkingDisplayBtn.addEventListener('change', () => selectThinking());

const GROK_EFFORT_OPTIONS = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
];
// Claude's effort ladder (Agent SDK's EffortLevel - session-registry.js's
// CLAUDE_EFFORTS) - one level wider than Grok's ('max'), and unlike Grok's
// select this one needs a blank "Default" option since effort is optional
// for Claude (unset = model/SDK default) where Grok's spawn-time flag is
// always some concrete value.
// 'high' is marked as the real default straight from the installed
// @anthropic-ai/claude-agent-sdk's sdk.d.ts (0.3.231) EffortLevel doc
// comment: "'high' — Deep reasoning (default)". Confirmed 2026-08-20,
// same investigation as THINKING_BUDGET_PRESETS' default-marker comment
// above - see .claude/memory/sdk-streaming-input-gotchas.md item 3.
const CLAUDE_EFFORT_OPTIONS = [
  { value: '', label: 'Default' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High *' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];
// Shared with the header badge (applyModelBadge) and the launcher's
// startEffortSelect below - one label source for "low" -> "Low" etc.
const GROK_EFFORT_LABELS = Object.fromEntries(GROK_EFFORT_OPTIONS.map((o) => [o.value, o.label]));
const CLAUDE_EFFORT_LABELS = Object.fromEntries(CLAUDE_EFFORT_OPTIONS.map((o) => [o.value, o.label]));

// Settings modal's Effort select is provider-aware (unlike the launcher's
// startEffortSelect, which only ever needs to reflect the provider picker
// at launch time) - a live session's provider doesn't change, but this
// function still needs to run per-summary since the modal's DOM is shared
// across every session tab a browser might switch between via history nav.
function fillSettingsEffortSelect(provider) {
  const grok = provider === 'grok';
  const list = grok ? GROK_EFFORT_OPTIONS : CLAUDE_EFFORT_OPTIONS;
  effortBtn.title = grok
    ? 'Grok reasoning effort. Low is cheaper and faster. High / Extra high spend more on reasoning.'
    : "Claude's reasoning effort for this session - low is cheaper and faster, high/xhigh/max spend more on thinking depth and thoroughness. Default leaves it up to the model.";
  effortBtn.innerHTML = '';
  for (const opt of list) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    effortBtn.append(option);
  }
}
fillSettingsEffortSelect('grok'); // placeholder population before any session summary arrives
effortBtn.addEventListener('change', () => selectEffort());

async function selectEffort() {
  // Claude's select has a blank "Default" option (unlike Grok's, which is
  // never blank - every Grok effort is a concrete spawn-time value); there's
  // no server-side "clear effort back to default" operation, so picking it
  // back is a client-only no-op rather than a 400 from the effort route's
  // CLAUDE_EFFORTS/GROK_EFFORTS validation.
  if (!effortBtn.value) return;
  if (effortErrorEl) effortErrorEl.style.display = 'none';
  try {
    const res = await fetch(`/api/sessions/${sessionId}/effort`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ effort: effortBtn.value }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (effortErrorEl) {
        effortErrorEl.textContent = `could not set effort: ${err.error || res.statusText}`;
        effortErrorEl.style.display = 'block';
      }
    }
  } catch (err) {
    if (effortErrorEl) {
      effortErrorEl.textContent = `could not set effort: ${err.message || err}`;
      effortErrorEl.style.display = 'block';
    }
  }
}

async function selectThinking() {
  const maxThinkingTokens = thinkingBudgetBtn.value ? Number(thinkingBudgetBtn.value) : null;
  const thinkingDisplay = thinkingDisplayBtn.value || null;
  // Inline, same as mcp-panel.js/plugin-panel.js's own error rendering
  // (.mcp-error) - this used to be an alert(), the one holdout in the
  // settings modal still blocking the UI thread for an error a misclick can
  // trigger repeatedly (the budget/display selects fire on every change).
  thinkingErrorEl.style.display = 'none';
  try {
    const res = await fetch(`/api/sessions/${sessionId}/thinking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ maxThinkingTokens, thinkingDisplay }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showThinkingError(`could not set thinking budget: ${err.error || res.statusText}`);
    }
    // On success, the server pushes the confirmed values back via cockpit:state.
  } catch (err) {
    showThinkingError(`could not set thinking budget: ${err.message || err}`);
  }
}

function showThinkingError(message) {
  thinkingErrorEl.textContent = message;
  thinkingErrorEl.style.display = '';
}
document.addEventListener('keydown', (event) => {
  if (event.key === 'Tab' && event.shiftKey && sessionId) {
    event.preventDefault();
    cycleMode();
  }
  // Grok CLI's Esc-stops-the-turn (see backlog.md). Deliberately deferred to
  // any @/model/command picker's own Escape-closes-dropdown handling
  // (isSuggestionPickerOpen, same guard compose.js's history recall uses) -
  // those listeners live on the textarea itself and don't stopPropagation,
  // so without this check Escape-to-close-a-dropdown would also cancel the
  // running turn underneath it. No-op while idle: nothing to cancel, and
  // stopBtn isn't even visible then.
  if (event.key === 'Escape' && stopBtn.style.display !== 'none' && !isSuggestionPickerOpen()) {
    event.preventDefault();
    interruptTurn();
  }
});

// Terminal-style select-and-release-to-copy: most terminal emulators copy
// the mouse selection the instant you let go of the button, no Ctrl+C
// needed. Scoped to the transcript pane only (not the compose textarea,
// which already has normal text-field selection/copy behavior) - mouseup
// fires after the selection is finalized, so `getSelection()` here sees the
// same range the user just drew. A collapsed selection (a plain click, no
// drag) has an empty string and is silently ignored.
// Shared "copy succeeded" feedback - a cursor/button-anchored toast that
// fades in and back out. Originally inline in the mouseup handler below;
// pulled out so #copyLastBtn's click-to-copy can show the identical toast
// instead of inventing a second copy-feedback UI.
function showCopyToast(x, y) {
  copyToast.style.left = `${x + 8}px`;
  copyToast.style.top = `${y - 8}px`;
  copyToast.classList.add('show');
  clearTimeout(copyToast._hideTimer);
  copyToast._hideTimer = setTimeout(() => copyToast.classList.remove('show'), 700);
}

streamEl.addEventListener('mouseup', (event) => {
  const selection = window.getSelection();
  const text = selection.toString();
  if (!text.trim()) return;
  // Selecting across two blocks (e.g. a tool call and its result) is normal
  // and fine to copy - this guard only rules out a selection that isn't
  // inside the transcript at all (e.g. it leaked in from an old range after
  // a click elsewhere), which anchorNode/focusNode both being contained
  // catches without needing to walk the whole selected range.
  if (!streamEl.contains(selection.anchorNode) || !streamEl.contains(selection.focusNode)) return;
  navigator.clipboard.writeText(text).then(() => {
    showCopyToast(event.clientX, event.clientY);
  }).catch(() => {
    // Clipboard write can fail (no permission, insecure context) - silently
    // leave the browser's own native selection/copy as the fallback rather
    // than surfacing an error for what's a convenience feature.
  });
});

// Markdown-rendered bodies store the source on dataset.rawText (stream-view.js
// appendBlock). textContent of a <p>/<ul>/<table> tree concatenates without
// block separators, so copy/suggestion must prefer the raw string.
function assistantBodySource(el) {
  if (!el) return '';
  if (Object.prototype.hasOwnProperty.call(el.dataset, 'rawText')) return el.dataset.rawText;
  return el.textContent || '';
}

// Copy the most recent assistant reply's text - reads the DOM (not a
// client-side message array; stream-view.js doesn't keep one, see its
// module comment) since the DOM is the one place already correct across
// every ingestion path (live sdk:message, prependHistory, and the
// cockpit:gap full resend). Assistant text blocks are never collapsible
// (stream-view.js's renderAssistant), so .body always holds the full text,
// nothing truncated to worry about.
copyLastBtn.addEventListener('click', () => {
  const replies = streamEl.querySelectorAll('.msg.assistant:not(.delegated-reply) .body');
  const last = replies[replies.length - 1];
  if (!last) return;
  const rect = copyLastBtn.getBoundingClientRect();
  navigator.clipboard.writeText(assistantBodySource(last)).then(() => {
    showCopyToast(rect.left, rect.bottom);
  }).catch(() => {});
});

// Export the whole transcript as markdown - a plain navigation, not a
// fetch+Blob dance, since the /markdown route sets content-disposition:
// attachment itself (src/server.js), so the browser just downloads it.
exportBtn.addEventListener('click', () => {
  if (!sessionId || !currentClaudeSessionId) return;
  const params = new URLSearchParams({ cwd: currentCwd || '', provider: currentProvider || 'claude' });
  window.location.href = `/api/history/${currentClaudeSessionId}/markdown?${params}`;
});

// Cancel the in-flight turn - Grok CLI's Esc/Ctrl+C equivalent (see
// backlog.md). Session and any queued follow-ups stay alive; only the turn
// currently running is aborted. `interruptInFlight` guards the same
// double-click race modeChangeInFlight guards below - a second click before
// the first request lands would just re-send the same no-op.
let interruptInFlight = false;

async function interruptTurn() {
  if (!sessionId || interruptInFlight) return;
  interruptInFlight = true;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/interrupt`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`interrupt failed: ${err.error || res.statusText}`);
    }
  } catch (err) {
    console.error('interrupt failed:', err);
  } finally {
    interruptInFlight = false;
  }
}

// Manual last-resort unstick for session-registry.js's pendingTurnsCount
// (see its own comment on toSummary, and forceIdle's on session.js) - for
// when interrupt above already ran (or there's nothing left to interrupt)
// and the badge next to the spinner still won't clear. Same
// in-flight-request guard as interruptTurn above.
let forceIdleInFlight = false;

async function forceIdleSession() {
  if (!sessionId || forceIdleInFlight) return;
  forceIdleInFlight = true;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/force-idle`, {
      method: 'POST',
      headers: authHeaders(),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`force-idle failed: ${err.error || res.statusText}`);
    }
  } catch (err) {
    console.error('force-idle failed:', err);
  } finally {
    forceIdleInFlight = false;
  }
}

// Same arm-then-confirm shape as stopBtn below (own timer/flag - kept
// separate rather than shared, since arming one shouldn't arm the other).
// State itself is declared up top near pendingTurnsBadge - see that comment.
function disarmForceIdle() {
  forceIdleArmed = false;
  clearTimeout(forceIdleArmTimer);
  forceIdleArmTimer = null;
  pendingTurnsBadge.textContent = String(lastPendingTurnsCount);
  pendingTurnsBadge.classList.remove('armed');
}

pendingTurnsBadge.addEventListener('click', () => {
  if (forceIdleArmed) {
    disarmForceIdle();
    forceIdleSession();
  } else {
    forceIdleArmed = true;
    pendingTurnsBadge.textContent = 'Nothing running?';
    pendingTurnsBadge.classList.add('armed');
    clearTimeout(forceIdleArmTimer);
    forceIdleArmTimer = setTimeout(disarmForceIdle, FORCE_IDLE_CONFIRM_WINDOW_MS);
  }
});

// Arm-then-confirm (backlog.md follow-up: Stop sat exactly where Send does,
// too easy to fat-finger right after hitting Enter). First click arms a
// short confirm window instead of interrupting outright; a second click
// inside that window is what actually stops the turn. Escape deliberately
// bypasses all of this and interrupts immediately (see the keydown handler
// below) - that's the "I meant it, right now" path, arming it too would
// defeat the point of a keyboard shortcut.
const STOP_CONFIRM_WINDOW_MS = 2000;
let stopArmed = false;
let stopArmTimer = null;

function armStop() {
  stopArmed = true;
  stopBtn.textContent = 'Confirm stop?'; // short enough to fit stopBtn's fixed width (index.html) without reflowing it
  stopBtn.classList.add('armed');
  clearTimeout(stopArmTimer);
  stopArmTimer = setTimeout(disarmStop, STOP_CONFIRM_WINDOW_MS);
}

function disarmStop() {
  stopArmed = false;
  clearTimeout(stopArmTimer);
  stopArmTimer = null;
  stopBtn.textContent = 'Stop';
  stopBtn.classList.remove('armed');
}

stopBtn.addEventListener('click', () => {
  if (stopArmed) {
    disarmStop();
    interruptTurn();
  } else {
    armStop();
  }
});

// Surfaces the CLI's own /compact as a button next to the context bar (see
// backlog.md) - there's no separate SDK method for it, so this sends the
// literal slash-command text through the same input path as anything typed
// by hand (compose.js's onSend). `prompt()` for the optional "keep this"
// note rather than a persistent field in the compose box or stats strip:
// stats-panel.js's innerHTML is rebuilt on every usage push (every assistant
// message), which would silently wipe a live input's value/focus mid-type.
function runCompact() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const note = prompt('Optional - what should Claude keep in mind after compacting? (blank to skip)');
  if (note === null) return; // cancelled, not just left blank
  const text = note.trim() ? `/compact ${note.trim()}` : '/compact';
  ws.send(JSON.stringify({ type: 'input', text }));
}

compactBtn.addEventListener('click', runCompact);

// Diagnostic snapshot for "spinner spins, nothing running" reports
// (backlog) - client-side state (what the browser thinks is happening) plus
// a fresh server-side pull (src/routes/session-actions.js's 'debug' action,
// registry.getDebugInfo) of what session.js/grok-session.js's internal
// pendingTurns/promptInFlight counters actually say - the two can disagree
// (a dropped state broadcast vs. a real turn-accounting bug look identical
// from the UI alone), which is the whole reason this exists instead of just
// screenshotting the spinner. Copies as one JSON blob rather than showing a
// modal - nothing here is meant to be read in the app, only pasted
// elsewhere.
async function reportStuckState() {
  const clientState = {
    uiState: stateLabelEl.title,
    spinnerRunning: spinTimer !== null,
    wsReadyState: ws ? ws.readyState : null, // 0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED / null no socket
    msSinceLastMessage: lastMessageAt != null ? Date.now() - lastMessageAt : null,
    lastSeq,
    sessionId,
    provider: currentProvider,
    tabHidden: document.hidden,
  };
  let serverState = null;
  let serverError = null;
  if (sessionId) {
    try {
      const res = await fetch(`/api/sessions/${sessionId}/debug`, { headers: authHeaders() });
      serverState = res.ok ? await res.json() : null;
      if (!res.ok) serverError = `HTTP ${res.status}`;
    } catch (err) {
      serverError = String(err.message || err);
    }
  }
  const report = { capturedAt: new Date().toISOString(), clientState, serverState, serverError };
  const text = JSON.stringify(report, null, 2);
  try {
    await navigator.clipboard.writeText(text);
    reportStuckBtn.textContent = '✓ Copied';
  } catch {
    // Clipboard API can be denied/unavailable (older browser, non-secure
    // context) - fall back to a selectable prompt rather than silently
    // failing with no way to get the data out at all.
    window.prompt('Clipboard copy failed - copy manually:', text);
  }
  setTimeout(() => { reportStuckBtn.textContent = '🐛 Report state'; }, 2000);
}

reportStuckBtn.addEventListener('click', reportStuckState);

let modeChangeInFlight = false;

async function cycleMode() {
  const i = PERMISSION_MODES.indexOf(currentMode);
  await setMode(PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length]);
}

async function setMode(next) {
  // Guards against the rapid-selection race: without this, N picks before
  // the first response lands all read the same stale `currentMode` and fire
  // N requests instead of settling on the last one. The dropdown already
  // shows `next` the instant the user picks it (native <select> behavior,
  // ahead of any of our code) - if this guard skips the request, revert the
  // visible value rather than leaving a selection that never actually took.
  if (modeChangeInFlight) {
    modeBtn.value = currentMode; applyModeColor(currentMode);
    return;
  }
  modeChangeInFlight = true;
  try {
    const res = await fetch(`/api/sessions/${sessionId}/mode`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ mode: next }),
    });
    if (!res.ok) {
      // Previously swallowed silently - this is what "the mode button got
      // stuck" turned out to be: bypassPermissions rejected server-side
      // (needs allowDangerouslySkipPermissions at session start) and
      // nothing told the user why nothing happened. Revert the dropdown's
      // optimistic value too, or it keeps showing the rejected mode.
      const err = await res.json().catch(() => ({}));
      alert(`could not change mode to ${next}: ${err.error || res.statusText}`);
      modeBtn.value = currentMode; applyModeColor(currentMode);
    }
    // On success, the server pushes the confirmed mode back via cockpit:state.
  } finally {
    modeChangeInFlight = false;
  }
}

approveBtn.addEventListener('click', () => {
  // Captured before sendApprovalDecision resolves - pendingApprovalToolName
  // is cleared once the request is gone, and reading it after the await
  // would race a fast-arriving next approval request for a different tool.
  const note = pendingApprovalToolName === 'ExitPlanMode' ? planNoteText.value.trim() : '';
  sendApprovalDecision('allow', undefined, alwaysAllowScope.value || undefined).then(() => {
    // Plan review's "append more before approving" (backlog.md) - queued as
    // a real follow-up turn right after approving (same ws 'input' path
    // compose.js uses, so it lands in the visible queue if a turn's already
    // running), since an `allow` PermissionResult has no message field of
    // its own for the model to see - there's nowhere else for this to ride.
    if (note && ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', text: note }));
    }
  });
});
rejectBtn.addEventListener('click', () => {
  // Plan review's "request changes" (backlog.md) - reuses the existing deny
  // path with a real reason instead of the hardcoded default: ExitPlanMode's
  // PermissionResult already carries `message` back to the model as
  // feedback, previously always "Not approved by user." regardless of why.
  const feedback = pendingApprovalToolName === 'ExitPlanMode' ? planFeedbackText.value.trim() : '';
  sendApprovalDecision('deny', undefined, false, feedback || undefined);
});

// One-off per action - the terminal's own "proceed? y/n", not a mode
// change. Every gated tool call routes here now (session.js's
// canUseTool), not just ExitPlanMode. `updatedInput` is what
// AskUserQuestion's answer actually rides back on (see
// renderQuestionForm) - every other caller omits it, same as before.
// `alwaysAllow` (backlog.md) only ever comes from approveBtn's own click
// above - session.js strips it back off before handing the decision to the
// SDK, it's cockpit-only bookkeeping (remembers the tool name for the rest
// of this session, nothing persisted to disk). `message` is the plan
// review "request changes" reason above; server.js falls back to its own
// default when this is undefined, same as it always has for a plain deny.
async function sendApprovalDecision(decision, updatedInput, alwaysAllow, message) {
  if (!pendingApprovalRequestId) return;
  await fetch(`/api/sessions/${sessionId}/approval-decision`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ requestId: pendingApprovalRequestId, decision, updatedInput, alwaysAllow, message }),
  });
  approvalBanner.style.display = 'none';
  questionForm.style.display = 'none';
  questionForm.innerHTML = '';
  alwaysAllowScope.value = '';
  planReviewControls.style.display = 'none';
  pendingApprovalRequestId = null;
  pendingApprovalToolName = null;
}

loadHistoryBtn.addEventListener('click', loadEarlierHistory);

// Resuming shows a recent tail (~1M estimated tokens - session.js/
// registry.js) immediately; this pulls the rest, refetched from disk on
// demand rather than cached (see loadEarlierHistory on the server), same
// as claude-realtime-usage's "load full history" button.
async function loadEarlierHistory() {
  loadHistoryBtn.disabled = true;
  loadHistoryBtn.textContent = 'Loading...';
  try {
    const { messages } = await sessionFetch('/earlier-history');
    // Deliberately no onToolCallStarted/onToolResultArrived here (unlike the
    // live renderMessage call site above) - this batch is all *history*,
    // rendered into a detached fragment in one shot (see prependHistory's own
    // comment). Wiring those would hijack the live "follow most recent tool
    // call" view to whatever the oldest loaded historical call happens to be.
    // Clicking a loaded row still works via onSelectToolCall (an explicit
    // pin, which is exactly what a click should do here too).
    prependHistory(streamEl, messages, {
      onRewindClick, hasFileCheckpointing, turnIndexUnreliable, rewindLabel: rewindButtonLabel(),
      onSelectToolCall: selectLiveToolCall,
      onOpenAgentTab: openAgentTab,
    });
    loadHistoryBar.style.display = 'none';
  } catch (err) {
    loadHistoryBtn.disabled = false;
    loadHistoryBtn.textContent = 'Load earlier history (failed, click to retry)';
  }
}

function rewindButtonLabel() {
  return currentProvider === 'grok' ? '⤴ fork back to here (conversation only)' : null;
}

async function onRewindClick(turnIndex) {
  const fileNote = hasFileCheckpointing
    ? 'Also reverts files to this point.'
    : currentProvider === 'grok'
      ? 'Files on disk are left as-is. This session stays open.'
      : 'This session has no file snapshots (resumed session) - conversation only, files are untouched.';
  const lead = currentProvider === 'grok'
    ? 'Fork back to here? Opens a new Grok session at this turn.'
    : 'Rewind here? Opens a new session forked at this point.';
  if (!confirm(`${lead} ${fileNote}`)) return;
  const res = await fetch(`/api/sessions/${sessionId}/rewind`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ turnIndex }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const verb = currentProvider === 'grok' ? 'fork' : 'rewind';
    alert(`${verb} failed: ${err.error || res.statusText}`);
    return;
  }
  const { newSession } = await res.json();
  if (newSession) connect(newSession.id, newSession.token);
}

// Coarse "how long ago" for the resume list (full timestamp lives in the
// element's title on hover) - buckets rather than exact units past the first
// couple, since "47 minutes ago" isn't more useful than "47m ago" here and
// nobody needs second-level precision on a session that's been sitting for
// a week.
function formatRelativeTime(ms) {
  const diffMs = Date.now() - ms;
  if (diffMs < 0) return 'just now'; // clock skew guard
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(ms).toLocaleDateString();
}

function selectedProvider() {
  return startProviderSelect.value === 'grok' ? 'grok' : 'claude';
}

let resumableGen = 0;

async function loadResumable() {
  const provider = selectedProvider();
  const gen = ++resumableGen;
  const res = await fetch(`/api/resumable?provider=${encodeURIComponent(provider)}`);
  const sessions = await res.json();
  if (gen !== resumableGen) return;
  resumeListEl.innerHTML = '';
  for (const s of sessions) {
    const li = document.createElement('li');
    const info = document.createElement('div');
    info.className = 'resume-info';
    const title = document.createElement('div');
    // A durable title (session-titles.js, joined server-side into s.title)
    // takes over the primary line; the transcript-derived label (the old
    // primary text) drops to the title tooltip instead of disappearing, so
    // a renamed session doesn't lose the "what was this actually about"
    // context the first message used to carry.
    title.textContent = s.title || s.label || s.sessionId;
    if (s.title && s.label) title.title = s.label;
    const cwd = document.createElement('div');
    cwd.className = 'cwd';
    cwd.textContent = s.cwd || s.projectDirName;
    info.append(title, cwd);
    // s.mtimeMs is the transcript file's own last-write time (session-launcher.js),
    // i.e. when its last message landed - the closest thing to "when this
    // session stopped" without actually parsing the last entry's timestamp.
    if (s.mtimeMs) {
      const time = document.createElement('div');
      time.className = 'resume-time';
      time.textContent = formatRelativeTime(s.mtimeMs);
      time.title = new Date(s.mtimeMs).toLocaleString();
      info.append(time);
    }
    info.addEventListener('click', () => startSession({ cwd: s.cwd, resume: s.sessionId, provider }));
    const renameBtn = document.createElement('button');
    renameBtn.className = 'renameResumeBtn';
    renameBtn.textContent = '✎';
    renameBtn.title = 'Rename this session';
    renameBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const next = prompt('Rename this session:', s.title || '');
      if (next === null) return;
      try {
        await fetch('/api/session-title', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cwd: s.cwd, sessionId: s.sessionId, title: next }),
        });
        loadResumable();
      } catch {
        // offline/blocked - the list just keeps showing the old title, not fatal
      }
    });
    const viewBtn = document.createElement('button');
    viewBtn.className = 'viewHistoryBtn';
    viewBtn.textContent = 'View';
    viewBtn.title = 'Read-only transcript, no live session started';
    viewBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      historyPane.open({ sessionId: s.sessionId, cwd: s.cwd, label: s.title || s.label, provider });
    });
    li.append(info, renameBtn, viewBtn);
    resumeListEl.append(li);
  }
}

const CLAUDE_START_MODELS = [
  { value: '', label: 'Default model' },
  // Marked default (same convention as THINKING_BUDGET_PRESETS/
  // CLAUDE_EFFORT_OPTIONS below): Sonnet is what the CLI actually resolves
  // '' to today, not just "a reasonable pick".
  { value: 'sonnet', label: 'Sonnet *' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
];
const GROK_START_MODELS = [
  { value: '', label: 'Default model' },
  { value: 'grok-4.5', label: 'Grok 4.5' },
  { value: 'grok-build', label: 'Grok Build' },
  { value: 'grok-4.6', label: 'Grok 4.6' },
];

function fillStartModels() {
  const list = startProviderSelect.value === 'grok' ? GROK_START_MODELS : CLAUDE_START_MODELS;
  startModelSelect.innerHTML = '';
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    startModelSelect.append(opt);
  }
}

// Launcher's effort/thinking-budget picker - same slot, repopulated per
// provider (mirrors fillStartModels above) rather than two separate selects
// the user has to know to pick between. Options and value semantics match
// the mid-session Settings versions exactly (GROK_EFFORT_OPTIONS/
// THINKING_BUDGET_PRESETS, defined further down but already evaluated by
// the time this runs - both are called from provider-select listeners, well
// after module load finishes) so "effort" means the same thing whether it's
// picked before or during a session.
function fillStartEffort() {
  const grok = startProviderSelect.value === 'grok';
  const list = grok ? GROK_EFFORT_OPTIONS : THINKING_BUDGET_PRESETS;
  startEffortSelect.title = grok
    ? 'Grok reasoning effort for this session. Low is cheaper and faster; High/Extra high spend more on reasoning.'
    : "Claude's thinking budget for this session - tokens it can spend reasoning before answering. Default lets the model decide (adaptive thinking on Opus 5/Sonnet 5/Fable 5); Off explicitly disables it.";
  startEffortSelect.innerHTML = '';
  // GROK_EFFORT_OPTIONS has no '' entry (Grok's spawn-time effort flag is
  // always a concrete value, unlike Claude's optional one), so this override
  // only ever fires for Claude. THINKING_BUDGET_PRESETS' '' label ("Default
  // *") reads fine in the Settings modal, which has an adjacent "Thinking
  // budget" span to disambiguate it - but this launcher row has no such
  // label, and sits right next to startClaudeEffortSelect's own bare
  // "Default" option, so a plain "Default" here read as ambiguous between
  // the two dials. Spelled out here only, not in the shared preset list.
  for (const item of list) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = (!grok && item.value === '') ? 'Default Thinking *' : item.label;
    startEffortSelect.append(opt);
  }
  // Claude's dedicated effort dial - a real, separate SDK option (not the
  // thinking-token budget above) - only shown for Claude; Grok's own effort
  // concept already lives in the shared slot above.
  startClaudeEffortSelect.style.display = grok ? 'none' : '';
  if (!grok) {
    startClaudeEffortSelect.innerHTML = '';
    for (const opt of CLAUDE_EFFORT_OPTIONS) {
      const option = document.createElement('option');
      option.value = opt.value;
      option.textContent = opt.value === '' ? 'Default effort' : opt.label;
      startClaudeEffortSelect.append(option);
    }
  }
}

startProviderSelect.addEventListener('change', () => {
  fillStartModels();
  fillStartEffort();
  loadResumable();
});
fillStartModels();

// Checked once on launch (server caches the result too - see
// src/provider-availability.js). Strips any <option> for a provider whose
// CLI isn't installed here (e.g. no `grok` binary), and if that leaves only
// one provider standing, hides the dropdown entirely rather than showing a
// pointless single-choice select.
async function applyAvailableProviders() {
  let providers;
  try {
    const res = await fetch('/api/providers');
    if (!res.ok) return;
    const data = await res.json();
    providers = Array.isArray(data.providers) && data.providers.length ? data.providers : ['claude'];
  } catch {
    return; // launch-time hiccup - leave the dropdown as-is, Claude still works
  }
  for (const opt of Array.from(startProviderSelect.options)) {
    if (!providers.includes(opt.value)) opt.remove();
  }
  if (providers.length <= 1) {
    startProviderSelect.style.display = 'none';
    startProviderSelect.value = providers[0] || 'claude';
    fillStartModels();
    fillStartEffort();
    loadResumable();
  }
}
applyAvailableProviders();
fillStartEffort();

startBtn.addEventListener('click', () => {
  const cwd = cwdInput.value.trim();
  if (!cwd) return;
  // Empty value ("Default") means don't send a model at all - same as
  // never having picked one, not a literal 'default' string the SDK would
  // have to resolve.
  const model = startModelSelect.value || undefined;
  const provider = selectedProvider();
  // Empty ("Default effort"/"Thinking: off") means skip it entirely below -
  // same "don't send what was never picked" rule as model above.
  const effortValue = startEffortSelect.value || undefined;
  const claudeEffortValue = startClaudeEffortSelect.value || undefined;
  // MVP5 cross-session delegation (backlog.md) - name is what another
  // session addresses this one by via `/ask <Name>: ...`. Optional: an
  // unnamed session just can't be delegated to, same as today.
  const name = startNameInput.value.trim() || undefined;
  startSession({
    cwd,
    model,
    provider,
    name,
    // Grok's effort rides the shared slot; Claude's rides its own dedicated
    // select - both are real creation-time `effort` values now (session.js
    // forwards Claude's into query()'s options too, see CLAUDE_EFFORTS).
    effort: provider === 'grok' ? effortValue : claudeEffortValue,
    thinkingBudget: provider === 'grok' ? undefined : effortValue,
  });
});

async function startSession({ cwd, resume, model, provider, name, effort, thinkingBudget }) {
  const res = await fetch('/api/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    // `effort` is a Grok spawn-time flag (grok-acp.js), so it's part of
    // creation itself - see routes/sessions.js. Claude's thinking budget has
    // no such creation-time param (it's always a live Query call), so it
    // rides in separately below once we have a token to call with.
    body: JSON.stringify({ cwd, resume, model, provider, name, effort }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    alert(`could not start session: ${err.error || res.statusText}`);
    return;
  }
  const { id, token } = await res.json();
  if (cwd) rememberRecentFolder(cwd);
  if (thinkingBudget) {
    // Best-effort: if this fails the session still starts fine at the SDK's
    // own default (model-dependent - adaptive thinking on for Opus 5/
    // Sonnet 5/Fable 5, off on older models; see THINKING_BUDGET_PRESETS'
    // comment) - not worth blocking connect() over, the Settings modal's
    // own thinking control is right there as a fallback. thinkingBudget
    // here is always a non-empty string when truthy - '0' (Off) included,
    // since JS string '0' is truthy even though numeric 0 isn't; only the
    // real "Default" value ('') is falsy and skips this block entirely.
    await fetch(`/api/sessions/${id}/thinking`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      body: JSON.stringify({ maxThinkingTokens: Number(thinkingBudget) }),
    }).catch(() => {});
  }
  connect(id, token);
}

// `reconnect: true` means this is the *same* session picking its websocket
// back up - the DOM, compose state and command list all stay put, and
// `since: lastSeq` asks the server for only what happened while the socket
// was down (event-log.js). Everything else (a fresh start, a resume, a
// rewind fork, or the very first connect after a page reload) is a new
// session as far as the client's view goes - full reset, full replay.
function connect(id, token, { reconnect = false } = {}) {
  if (ws) {
    // Plain assignment (not addEventListener), so this fully detaches the
    // old socket's handlers before closing it - otherwise its 'close'
    // handler fires asynchronously *after* the new socket below has
    // already opened, and disables compose out from under the live
    // session. Only rewind reconnects mid-session (server.js's newSession
    // flow), which is what actually hit this.
    ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
    ws.close();
  }
  sessionId = id;
  sessionToken = token;
  intentionalClose = false;
  saveActiveSession(id, token);

  if (!reconnect) {
    lastSeq = 0;
    streamEl.innerHTML = '';
    resetStreamView(streamEl);
    approvalBanner.style.display = 'none';
    questionForm.style.display = 'none';
    questionForm.innerHTML = '';
    pendingApprovalRequestId = null;
    loadHistoryBar.style.display = 'none';
    loadHistoryBtn.disabled = false;
    loadHistoryBtn.textContent = 'Load earlier history';
    availableCommands = [];
    availableAgents = [];
    selectedAgentName = null; // new session - no reason to carry the last one's forced agent over
    // agentsBar itself now stays visible regardless of whether this session
    // has any agents - it also hosts turnChartToggleBtn (the "same line as
    // Agents" cost-graph button), which has nothing to do with the roster.
    // Only agentsBtn's own visibility still depends on availableAgents.
    agentsBar.style.display = 'flex';
    agentsBtn.style.display = 'none';
    // Same idea as agentsBtn above: nothing to show yet, revealed by the
    // first cockpit:tasks push that actually has a task in it (see
    // ws.onmessage's cockpit:tasks branch) - a session that never calls a
    // Task* tool just never gets this button.
    taskPanelToggleBtn.style.display = 'none';
    agentsList.style.display = 'none';
    agentsList.innerHTML = '';
    agentsBtn.classList.remove('open');
    cachedModels = null;
    hasFileCheckpointing = true; // corrected by cockpit:hello before any message can reach renderMessage
    turnIndexUnreliable = false; // same
    previousState = null;
    statsPanel.reset(); // corrected by the first cockpit:usage push (sent on every attach, see session-registry.js)
    // Restores the panel's visibility to match the persisted setting (B9) -
    // returnToLauncher() force-hides it regardless of the setting while
    // there's no session to chart.
    turnChart.setEnabled(settings.isTurnChartEnabled());
    turnChart.reset();
    taskPanel.setEnabled(settings.isTaskPanelEnabled());
    taskPanel.reset();
    detailPane.setEnabled(settings.isDetailPaneEnabled());
    detailPane.reset(streamEl);
    queuePanel.reset(); // corrected by the first cockpit:queue push if a turn's already queued behind another, same as statsPanel above
    pluginsLoadedForSession = false; // new session - the plugin panel hasn't paid its one reload yet (B2)
    refreshCommandsAndAgents(); // fetched eagerly, not lazily like /model's picker - agentsBtn's own visibility depends on whether the list is empty
    sessionListPane.refreshCount(); // this tab just added a row to the server-wide count
  }

  launcherEl.style.display = 'none';
  streamWrapEl.style.display = 'flex';
  // detailPane.setEnabled() above (in the branch that sets up a fresh
  // session) ran its own offset measurement while streamWrap was still
  // display:none, so it measured a zero-width pane - re-measure now that
  // the pane is actually laid out, or #approvalBanner/#compose stay full
  // viewport width under the docked pane for the whole session (see
  // detail-pane.js's syncOffset comment).
  detailPane.syncOffset();
  composeEl.style.display = 'flex';
  activityBar.style.display = 'flex';
  modeBtn.style.display = 'inline-block';
  autoContinueLabel.style.display = 'flex';
  diffBtn.style.display = 'inline-block';
  compactBtn.style.display = 'inline-block';
  reportStuckBtn.style.display = 'inline-block';
  copyLastBtn.style.display = 'inline-block';
  exportBtn.style.display = 'inline-block';
  closeSessionBtn.style.display = 'inline-block';
  settingsBtn.style.display = 'inline-block';

  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws?id=${id}&token=${token}&since=${lastSeq}`);

  ws.onopen = () => {
    compose.setEnabled(true);
    reconnectAttempt = 0;
  };
  ws.onclose = () => {
    compose.setEnabled(false);
    if (intentionalClose) {
      setState('closed');
      return;
    }
    // Not a deliberate close (compose.js's page is still up on this
    // session) - the session itself runs independently of the browser
    // (plan Decisions), so a dropped socket is never a session event by
    // itself. Retry with backoff rather than dumping the user back to the
    // launcher; `since: lastSeq` on the next connect() picks up exactly
    // where this one left off.
    setState('reconnecting');
    const delay = Math.min(1000 * 2 ** reconnectAttempt, 10000);
    reconnectAttempt += 1;
    reconnectTimer = setTimeout(() => {
      if (!intentionalClose && sessionId === id) connect(id, token, { reconnect: true });
    }, delay);
  };
  ws.onerror = () => setState('error');

  ws.onmessage = (event) => {
    lastMessageAt = Date.now(); // debug capture only (reportStuckBtn below) - "how long since anything arrived on this socket"
    const payload = JSON.parse(event.data);
    if (payload.type === 'sdk:message') {
      if (typeof payload.seq === 'number') lastSeq = Math.max(lastSeq, payload.seq);
      if (payload.message.type === 'system' && payload.message.subtype === 'commands_changed') {
        // Fire-and-forget push after a mid-session change (e.g. skills
        // discovered in a subdirectory) - replace, don't merge (Spike C).
        availableCommands = payload.message.commands;
        return;
      }
      // Grab the index the point is about to get *before* rendering, so the
      // DOM stream-view.js is about to build for this message can be tagged
      // with the same index (data-turn-point) - that's what lets hovering a
      // bar in turn-chart.js find the tool blocks that produced it.
      const hasUsagePoint = payload.message.type === 'assistant' && payload.message._usageInfo;
      const turnPointIndex = hasUsagePoint ? turnChart.nextPointIndex() : null;
      renderMessage(streamEl, payload.message, {
        onRewindClick, hasFileCheckpointing, turnIndexUnreliable, turnPointIndex,
        assistantLabel: sessionProviderLabel(), rewindLabel: rewindButtonLabel(), receivedAtMs: Date.now(),
        onSelectToolCall: selectLiveToolCall,
        onOpenAgentTab: openAgentTab,
        onToolCallStarted: (container, record) => detailPane.onToolCallStarted(container, record),
        onToolResultArrived: (container, id) => detailPane.onToolResultArrived(container, id),
        onShowDelegatedTrace: selectDelegatedTrace,
      });
      // One bar per priced assistant turn (turn-chart.js) - same
      // message._usageInfo session-registry.js already stashes for
      // stream-view.js's inline "$0.0X, N in, M out" labels, just fed to
      // the chart too instead of computed twice.
      if (hasUsagePoint) {
        turnChart.addPoint(payload.message._usageInfo);
      }
    } else if (payload.type === 'cockpit:gap') {
      // The event log evicted past what we last saw (event-log.js) - the
      // full resend that follows this marker needs a clean view to land
      // in, or it renders as duplicates appended after what's already there.
      streamEl.innerHTML = '';
      resetStreamView(streamEl);
      turnChart.reset(); // same full-resend replay, so the chart would otherwise double up its bars
      detailPane.reset(streamEl); // same reasoning - a pinned/live record from before the gap now points at DOM that's gone
    } else if (payload.type === 'cockpit:hello' || payload.type === 'cockpit:state') {
      applySession(payload.session);
    } else if (payload.type === 'cockpit:approval-request') {
      showApprovalRequest(payload.request);
    } else if (payload.type === 'cockpit:usage') {
      statsPanel.update(payload.usage, payload.context, payload.rateLimits);
      // context.autoCompact comes from src/context-usage.js server-side:
      // the SDK's real threshold when it's confirmed plausible, else the
      // same 80% fallback this used to hardcode. warnPercent/source drive
      // both this button and stats-panel.js's contextBar coloring, so the
      // two stop being independently-hardcoded constants.
      const pct = payload.context ? payload.context.percentage || 0 : 0;
      const autoCompact = payload.context?.autoCompact;
      const warnPercent = autoCompact?.warnPercent ?? 80;
      compactBtn.classList.toggle('compact-urgent', pct >= warnPercent);
      if (autoCompact) {
        compactBtn.title = autoCompact.enabled
          ? `Run /compact now to free up context (auto-compact fires around ${Math.round(warnPercent)}%${autoCompact.source === 'fallback' ? ', assumed' : ''})`
          : 'Run /compact now to free up context (auto-compact is off for this session)';
      }
    } else if (payload.type === 'cockpit:mcp-auth') {
      // MCP "needs-auth" badge (backlog.md) - session-registry.js pushes
      // this whenever session.js's onElicitation catches a URL-mode auth
      // request or its completion notice, so a settings modal left open
      // through the flow doesn't sit on a stale badge until the next
      // manual open/refresh. Server already re-fetched the merged list
      // (payload.servers), but mcpPanel has no setServers() of its own -
      // just re-running the same GET refresh() does on open is simpler
      // than adding a second render path for one push message.
      if (document.getElementById('settingsModal').style.display !== 'none') mcpPanel.refresh();
    } else if (payload.type === 'cockpit:delegate-error') {
      // MVP5 cross-session delegation (backlog.md) - server.js sends this
      // straight back on the origin's own socket when delegateTask throws
      // (unknown name, self-delegation, cross-cwd). No durable eventLog
      // entry for this one (unlike the success marker) - it's a synchronous
      // rejection of something that never actually got sent anywhere, so
      // there's nothing for a reconnecting tab to replay.
      alert(`Could not ask "${payload.targetName}": ${payload.error}`);
    } else if (payload.type === 'cockpit:queue') {
      // Always the full current queue (session-registry.js's broadcastQueue
      // never sends a delta), sent on every attach and again on every real
      // change - queue-panel.js just replaces and re-renders.
      queuePanel.setQueue(payload.queue);
    } else if (payload.type === 'cockpit:tasks') {
      // Always the full current list (session-registry.js never sends a
      // delta), sent once on every attach/reconnect and again on every real
      // change - task-panel.js just replaces and re-renders, no merging.
      taskPanel.setTasks(payload.tasks);
      // Only worth a button once there's something to show - same "hidden
      // until proven relevant" treatment agentsBtn gets for an empty
      // roster. Doesn't force-hide again once a task list empties back out
      // (e.g. every task got deleted) - a session that's used the feature
      // once keeps the entry point, same as agentsBtn never re-hides either.
      if (payload.tasks.length > 0) taskPanelToggleBtn.style.display = 'inline-block';
    } else if (payload.type === 'cockpit:error') {
      renderMessage(streamEl, { type: 'result', subtype: 'error', error: payload.error });
    }
  };
}

function showApprovalRequest(request) {
  // Only one pending approval fits in this banner - fine in practice
  // since a turn awaits each tool_result before its next tool_use, so a
  // second request while one is showing would be unusual, not silent.
  pendingApprovalRequestId = request.requestId;

  // Belt-and-suspenders re-measure right before the banner actually needs
  // the offset to be right, instead of only trusting whatever earlier
  // lifecycle event (session connect, resize, drag) last computed it. The
  // connect()-time call this used to rely on exclusively measures
  // #detailPane while #streamWrap may still be display:none mid-setup
  // (see detail-pane.js's syncOffset comment) - that's now patched at the
  // one call site we found, but a banner is worth getting right every time
  // it appears, not just when every upstream timing assumption holds.
  detailPane.syncOffset();

  if (request.toolName === 'AskUserQuestion' && Array.isArray(request.input?.questions)) {
    approvalPlain.style.display = 'none';
    renderQuestionForm(request);
    questionForm.style.display = 'flex';
    approvalBanner.style.display = 'flex';
    tabChrome.setNeedsAttention(true);
    return;
  }
  questionForm.style.display = 'none';
  questionForm.innerHTML = '';
  approvalPlain.style.display = 'flex';
  alwaysAllowScope.value = ''; // never carry a stale scope into a different tool's request
  alwaysAllowToolName.textContent = request.toolName;
  pendingApprovalToolName = request.toolName;

  const isPlan = request.toolName === 'ExitPlanMode';
  approvalHeading.textContent = isPlan
    ? 'Plan ready - approve to exit plan mode?'
    : (request.title || request.displayName || `${request.toolName}?`);

  approvalDetail.textContent = isPlan && request.input?.plan
    ? request.input.plan
    : JSON.stringify(request.input, null, 2);
  approvalDetail.classList.toggle('plan-detail', isPlan);

  // Plan review (backlog.md) - preview + comment/revise, only for
  // ExitPlanMode. planFeedbackText/planNoteText always reset on a new
  // request, same as alwaysAllowScope above, so neither field leaks between
  // this plan and whatever comes after it.
  planReviewControls.style.display = isPlan ? 'flex' : 'none';
  planFeedbackText.value = '';
  planNoteText.value = '';
  rejectBtn.textContent = isPlan ? 'Request changes' : 'No';

  approvalBanner.style.display = 'flex';
  tabChrome.setNeedsAttention(true); // needs a decision regardless of focus - cleared on window focus (tab-chrome.js)
}

// Builds the AskUserQuestion form: one block per question (pill-style
// options, single-select or multi-select per `q.multiSelect`, plus a free-
// text "Other" fallback per the tool's own description - "Users will
// always be able to select 'Other' to provide custom text input"), and one
// Submit for the whole set. `answers` must be keyed by the *exact* question
// text (confirmed against the tool's own schema/checkPermissions handler -
// see the investigation that found this) - not an index, not the header.
function renderQuestionForm(request) {
  questionForm.innerHTML = '';
  const questions = request.input.questions || [];
  const state = new Map(); // question text -> { selected: Set<label>, otherEl }

  for (const q of questions) {
    const block = document.createElement('div');
    block.className = 'q-block';

    const text = document.createElement('div');
    text.className = 'q-text';
    text.textContent = q.header ? `${q.header}: ${q.question}` : q.question;
    block.append(text);

    const optionsEl = document.createElement('div');
    optionsEl.className = 'q-options';
    const selected = new Set();
    for (const opt of q.options || []) {
      const pill = document.createElement('div');
      pill.className = 'q-option';
      const label = document.createElement('span');
      label.textContent = opt.label;
      pill.append(label);
      if (opt.description) {
        const desc = document.createElement('span');
        desc.className = 'q-option-desc';
        desc.textContent = opt.description;
        pill.append(desc);
      }
      pill.addEventListener('click', () => {
        if (q.multiSelect) {
          pill.classList.toggle('selected');
          if (pill.classList.contains('selected')) selected.add(opt.label);
          else selected.delete(opt.label);
        } else {
          optionsEl.querySelectorAll('.q-option.selected').forEach((el) => el.classList.remove('selected'));
          pill.classList.add('selected');
          selected.clear();
          selected.add(opt.label);
        }
      });
      optionsEl.append(pill);
    }
    block.append(optionsEl);

    const other = document.createElement('input');
    other.type = 'text';
    other.className = 'q-other';
    other.placeholder = 'Other (type your own answer)…';
    block.append(other);

    questionForm.append(block);
    state.set(q.question, { selected, otherEl: other });
  }

  const actions = document.createElement('div');
  actions.className = 'q-actions';

  const submitBtn = document.createElement('button');
  submitBtn.className = 'q-submit';
  submitBtn.textContent = 'Submit answers';
  submitBtn.title = 'Send these answers and continue';
  submitBtn.addEventListener('click', () => {
    const answers = {};
    for (const [questionText, { selected, otherEl }] of state) {
      const typed = otherEl.value.trim();
      if (typed) answers[questionText] = typed;
      else if (selected.size > 0) answers[questionText] = [...selected].join(', ');
      // Neither: this question is left out of `answers` entirely rather
      // than sent as an empty string - an omitted key reads as "skipped
      // this one", not "answered with nothing".
    }
    sendApprovalDecision('allow', { questions, answers });
  });

  const skipBtn = document.createElement('button');
  skipBtn.className = 'q-skip';
  skipBtn.textContent = 'Skip';
  skipBtn.title = 'Denies the tool call outright, same as "No" on a plain approval';
  skipBtn.addEventListener('click', () => sendApprovalDecision('deny'));

  actions.append(submitBtn, skipBtn);
  questionForm.append(actions);
}

// Full cwd was crowding out everything else in the header on a deep path -
// last two segments is enough to place the session at a glance, and the
// rename-tab tooltip (sessionLabelEl.title, set once above) still carries
// the full path on hover for whoever needs the whole thing.
function shortenCwd(cwd) {
  const parts = cwd.split('/').filter(Boolean);
  if (parts.length <= 2) return cwd; // already short - nothing to trim
  return `.../${parts.slice(-2).join('/')}`;
}

function applySession(session) {
  promptHistory.setCwd(session.cwd); // no-ops if unchanged - safe on every cockpit:state broadcast, not just the first
  currentProvider = session.provider === 'grok' ? 'grok' : 'claude';
  currentCwd = session.cwd;
  currentClaudeSessionId = session.claudeSessionId || null;
  exportBtn.disabled = !currentClaudeSessionId;
  currentSessionName = session.name || null;
  compose.setDefaultPlaceholder(composePlaceholder());
  copyLastBtn.title = `Copy ${sessionAddressName()}'s most recent reply`;
  const providerLabel = sessionProviderLabel();
  // A durable title (session.name, set via the rename prompt below or
  // carried forward from a resumed transcript - session-titles.js) takes
  // over the label entirely; otherwise the usual cwd/provider/tab-count
  // summary.
  sessionLabelEl.textContent = currentSessionName
    || `${shortenCwd(session.cwd)}  ·  ${providerLabel}${session.tabCount > 1 ? `  ·  ${session.tabCount} tabs` : ''}`;
  sessionLabelEl.title = `${session.cwd} - click to rename this session`; // full path survives on hover once the label itself is truncated
  if (!tabChrome.isUserNamed()) tabChrome.setAutoName(currentSessionName || session.cwd.split('/').filter(Boolean).pop() || session.cwd);
  setState(session.state);
  // Turns-in-flight badge (session-registry.js's pendingTurnsCount) - debug
  // option, off by default (settings.isPendingTurnsBadgeEnabled(), toggled
  // via the settings modal's "Debug: show the turns-in-flight counter"
  // checkbox); when on, only shown once there's something to explain/unstick
  // - a healthy idle session stays at 0 and the badge never appears. Skips
  // the update while a click is armed so a summary landing mid-confirm-window
  // doesn't blow away the "Nothing running?" label out from under the second
  // click.
  lastPendingTurnsCount = session.pendingTurnsCount || 0;
  if (!forceIdleArmed) {
    pendingTurnsBadge.textContent = String(lastPendingTurnsCount);
    pendingTurnsBadge.style.display = settings.isPendingTurnsBadgeEnabled() && lastPendingTurnsCount > 0 ? 'inline-block' : 'none';
  }
  currentMode = session.mode;
  currentModel = session.model;
  hasFileCheckpointing = session.hasFileCheckpointing;
  const caps = session.capabilities || {};
  const grokCapsOff = currentProvider === 'grok';
  autoContinueLabel.style.display = (caps.autoContinue === false || grokCapsOff) ? 'none' : 'flex';
  const thinkingGroup = document.getElementById('thinkingControlsGroup');
  if (thinkingGroup) thinkingGroup.style.display = caps.thinkingBudget === false ? 'none' : '';
  const effortGroup = document.getElementById('effortControlsGroup');
  if (effortGroup) effortGroup.style.display = caps.effort ? '' : 'none';
  if (effortBtn) {
    fillSettingsEffortSelect(currentProvider);
    effortBtn.value = session.effort || '';
  }
  for (const tab of document.querySelectorAll('.settings-tab[data-settings-tab="mcp"], .settings-tab[data-settings-tab="plugins"]')) {
    tab.style.display = caps.mcpToggle === false ? 'none' : '';
  }
  const grokPanel = currentProvider === 'grok';
  const mcpNote = document.getElementById('mcpProviderNote');
  const pluginNote = document.getElementById('pluginProviderNote');
  if (mcpNote) mcpNote.style.display = grokPanel ? 'block' : 'none';
  if (pluginNote) pluginNote.style.display = grokPanel ? 'block' : 'none';
  turnIndexUnreliable = session.turnIndexUnreliable;
  modeBtn.value = session.mode; applyModeColor(session.mode);
  // != null, not a truthiness check - maxThinkingTokens: 0 is the real
  // "Off" value (THINKING_BUDGET_PRESETS above) and is falsy in JS, so a
  // `session.maxThinkingTokens ? ... : ''` here would render Off as Default.
  thinkingBudgetBtn.value = session.maxThinkingTokens != null ? String(session.maxThinkingTokens) : '';
  thinkingDisplayBtn.value = session.thinkingDisplay || '';
  applyModelBadge(session);
  // Server is the source of truth (registry.js flips this false once
  // loadEarlierHistory has nothing left) - reflects it on every summary,
  // safe to repeat since it's idempotent either way.
  loadHistoryBar.style.display = session.hasEarlierHistory ? 'flex' : 'none';
  // Auto-continue checkbox + banner: server is the source of truth here too
  // (session-registry.js's setAutoContinue/handleMessage), same idempotent-
  // repeat-on-every-summary pattern as the history bar above - a checkbox
  // toggled from another tab, or a timer firing server-side, shows up here
  // without this tab having done anything itself.
  autoContinueBtn.checked = Boolean(session.autoContinue);
  if (session.rateLimitHit) {
    const resetsAt = session.rateLimitHit.resetsAt;
    const when = resetsAt ? new Date(resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'unknown time';
    rateLimitBanner.textContent = session.autoContinue
      ? `⏳ Usage limit hit - resumes at ${when}`
      : `⚠ Usage limit hit - resets at ${when}`;
    rateLimitBanner.style.display = 'inline';
  } else {
    rateLimitBanner.style.display = 'none';
  }
  // The ws itself can stay open after the underlying query() has died
  // (session.js's for-await throws or exits) - relying only on ws 'close'
  // to disable compose left a dead session accepting input with no
  // feedback that it was going nowhere.
  if (session.state === 'error' || session.state === 'closed') {
    compose.setEnabled(false);
    // This session just ended on the server without going through
    // closeSession() (crashed CLI process, closed from another tab/the
    // API, etc.) - that path already calls refreshCount() itself, but this
    // one doesn't otherwise touch sessionListPane, so the header's count
    // would keep showing a session that's actually gone until something
    // else happened to refresh it.
    sessionListPane.refreshCount();
  }
}

// Drives the state icon: a static dot when idle, a classic ASCII spinner
// (cycling | / - \) while running/reconnecting - actual motion rather than
// a color or opacity toggle, so "busy" reads clearly even to someone who
// can't tell the state colors apart. Driven by setInterval rather than a
// CSS `animation: ... infinite` tied to the element holding the same class
// - stepping the frame ourselves every SPIN_INTERVAL_MS can't drift or get
// silently deprioritized the way a CSS keyframe animation can in a
// background tab.
const SPIN_INTERVAL_MS = 120;
const SPINNER_FRAMES = ['|', '/', '-', '\\'];
const IDLE_ICON = '•'; // •
let spinTimer = null;
let spinFrame = 0;

function startSpinner() {
  if (spinTimer) return; // already running - setState can be called repeatedly for the same state
  // Deliberately ignores prefers-reduced-motion: this one small icon is the
  // cockpit's only "something is happening" signal, and its owner has
  // decided the spinner beats a steady color even with reduced-motion on
  // system-wide (their OS/browser-wide setting is left untouched - this is
  // a single-purpose, single-user override, not a statement that motion
  // preferences don't matter generally).
  spinTimer = setInterval(() => {
    spinFrame = (spinFrame + 1) % SPINNER_FRAMES.length;
    stateIconEl.textContent = SPINNER_FRAMES[spinFrame];
  }, SPIN_INTERVAL_MS);
}

function stopSpinner() {
  if (spinTimer) {
    clearInterval(spinTimer);
    spinTimer = null;
  }
  stateIconEl.textContent = IDLE_ICON;
}

function setState(state) {
  stateLabelEl.title = state; // hover tooltip - the word's gone from the label itself, just the icon's color now (index.html)
  stateLabelEl.className = `state ${state}`;
  if (state === 'running' || state === 'reconnecting') startSpinner();
  else stopSpinner();
  // Stop (lives in #activityBar next to the state spinner - index.html)
  // only shows while there's actually a turn to cancel - reconnecting/idle/
  // error/closed all have nothing in flight on this connection to interrupt.
  stopBtn.style.display = state === 'running' ? 'inline-block' : 'none';
  if (state !== 'running') disarmStop(); // never carry an armed "click again" into the next turn
  // A turn that finished while this tab was unfocused is the terminal
  // bell's replacement (plan MVP3) - caught here as the running-to-idle
  // edge rather than on every 'idle' so it doesn't re-fire on states that
  // were never running (e.g. the initial idle after connect).
  if (document.hidden && previousState === 'running' && state === 'idle') {
    tabChrome.setNeedsAttention(true);
  }
  // Prompt suggestion (compose.js): computed once per completed turn, same
  // running->idle edge as the tab-attention ping above, not on every 'idle'
  // (would just be recomputing from the same last reply on states that were
  // never running - e.g. the initial idle right after connect, where
  // there's no assistant reply yet to suggest from anyway).
  if (previousState === 'running' && state === 'idle') {
    compose.setSuggestion(computePromptSuggestion());
  } else if (state === 'running') {
    compose.clearSuggestion(); // stale the moment a new turn starts, whether it came from accepting the suggestion or typing something else
  }
  previousState = state;
  tabChrome.setState(state);
}

// Heuristic source for the prompt-suggestion ghost text: the last assistant
// reply's first open checklist item (`- [ ] ...`), if it wrote one - mirrors
// how the DeepSeek/Claude Code screenshot this was modeled on showed a
// "Your move:" list and suggested its first item. Reads the DOM, same as
// copyLastBtn above and for the same reason (stream-view.js keeps no
// separate client-side message array - the DOM is the one place already
// correct across every ingestion path). No open checkbox in the reply ->
// null -> compose.js just falls back to its default placeholder text.
function computePromptSuggestion() {
  const replies = streamEl.querySelectorAll('.msg.assistant:not(.delegated-reply) .body');
  const last = replies[replies.length - 1];
  if (!last) return null;
  const match = assistantBodySource(last).match(/^\s*[-*]\s*\[ \]\s*(.+)$/m);
  return match ? match[1].trim() : null;
}

// Reconnect-on-reload (MVP3): if this browser tab already had a live
// session open, rejoin it instead of showing the launcher. `GET
// /api/sessions/:id` confirms it is still live before attempting the
// websocket - a stale/closed id falls through to the ordinary launcher.
async function rejoinActiveSession() {
  const saved = loadActiveSession();
  if (!saved) return false;
  try {
    const res = await fetch(`/api/sessions/${saved.id}`, { headers: { authorization: `Bearer ${saved.token}` } });
    if (!res.ok) {
      clearActiveSession();
      return false;
    }
    connect(saved.id, saved.token);
    return true;
  } catch {
    return false;
  }
}

rejoinActiveSession().then((rejoined) => {
  if (!rejoined) loadResumable();
});
