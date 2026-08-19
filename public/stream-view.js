// Renders the SDK message stream: assistant text, tool calls, tool
// results, thinking blocks. Whole-message rendering (no token-level
// partials - see plan MVP1 scope). Hook/thinking-token/rate-limit chatter
// and repeat init messages are dropped entirely rather than dumped as raw
// JSON. Per-tool approval (accept-this-once / no) is a banner driven by
// cockpit:approval-request, handled in app.js - not part of this module.
//
// Tool calls render Trajectory-style (docs/deepseek.jpg): each tool_use gets
// one fixed-height one-line row (name + brief args + inline usage/duration),
// not a click-to-expand block - see appendToolCallRow. Its matching
// tool_result patches that same row in place (duration, status glyph)
// instead of appending a second block, so a call/result pair merges into one
// line. Full payload/result/timing for a row lives in tool-call-store.js and
// is surfaced by the docked detail pane (detail-pane.js, wired in app.js via
// the onSelectToolCall/onToolCallStarted/onToolResultArrived callbacks
// threaded through renderMessage) - click a row to pin it there, or leave it
// on "follow the most recent call" by default. Thinking blocks always render
// fully expanded now too (plain appendBlock, no collapse state) - the whole
// click-to-collapse/Ctrl+O-to-expand interaction this app used to have is
// gone, not just narrowed to tool calls.
//
// Consecutive tool calls are still folded into one "group" block (e.g.
// "3 tool calls: Bash → Read → Edit") rather than each getting its own
// top-level row - that's what actually made a multi-tool turn noisy, more
// than any single row's verbosity, and is a deliberately-kept exception to
// the no-collapse rule above (a locked-in design decision, not an oversight -
// folding a long tool-call run to one line is worth keeping even though
// per-block collapse wasn't). A group stays open across tool calls and their
// results and closes the moment real Claude text or a thinking block
// appears, or the turn ends - see closeGroup call sites. Groups render
// expanded as they accumulate; by default (settings-panel toggle,
// autoCollapsePreviousGroup below) the previous group auto-folds the moment
// the next one opens, so only the run currently in flight stays open. Only a
// direct click toggles a group now (no keyboard shortcut, no "expand/collapse
// all" button - both were removed along with the rest of the old interaction).

import { resetToolCallStore, createToolCallRecord, completeToolCallRecord, mergeToolCallStore, recordOrphanResult, popOrphanResult } from '/tool-call-store.js';
import { renderMarkdown } from '/markdown.js';

const seenInitByContainer = new WeakMap();
const groupsByContainer = new WeakMap(); // container -> group[]
const openGroupByContainer = new WeakMap(); // container -> the currently-accumulating group, if any
// Delegated-reply bubbles awaiting a possible cockpit:delegate-full-trace
// marker (session-registry.js's relayDelegationResult) - container ->
// Map<queueId, roleRowEl>. The marker, when it comes, always arrives AFTER
// the bubble it belongs to (relayDelegationResult pushes the turn - which
// echoes synchronously, see session.js's pushInput - before it broadcasts
// the marker), live or replayed alike, so there's no "marker beats bubble"
// race to handle here, only "marker never comes" (the common case: no extra
// content beyond the clean answer, see relayDelegationResult).
const delegatedBubblesByContainer = new WeakMap();

// Settings-panel toggle (default on - see settings.js). When true, the
// moment a new top-level tool-call group opens, the immediately preceding
// one auto-folds to its one-line summary instead of sitting there expanded
// forever - a long turn's tool history reads like a list of past runs, not
// a wall of them all still open. Off just restores the old always-expanded
// behavior; either way a click on the group's own header still re-expands it.
let autoCollapsePreviousGroup = true;
export function setAutoCollapsePreviousGroup(enabled) {
  autoCollapsePreviousGroup = enabled;
}

// "3:41 PM" for the role row; the full date/time lives in the span's title
// tooltip (appendBlock) - same split app.js's formatRelativeTime uses for
// the resume list.
function formatClock(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const SILENT_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_response',
  'thinking_tokens',
]);

// Call once per fresh session view (app.js does this on connect(), right
// after clearing the container) so stale block references from a previous
// session don't linger.
export function resetStreamView(container) {
  groupsByContainer.set(container, []);
  openGroupByContainer.delete(container);
  seenInitByContainer.delete(container);
  delegatedBubblesByContainer.set(container, new Map());
  resetToolCallStore(container);
}

// Renders `messages` (oldest-first) into a detached fragment, then inserts
// them all at once above whatever's already in `container` - used for the
// "Load earlier history" button (app.js) so a resumed session's older
// turns land above its initial tail in one DOM operation, in the right
// order. Historical entries have no `turnIndex` (that's minted only for
// this session's own live pushInput calls - see session.js), so their
// rewind buttons don't appear; a real limitation, not an oversight.
export function prependHistory(container, messages, options = {}) {
  if (!groupsByContainer.has(container)) resetStreamView(container);

  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    // Forced true regardless of what the caller passed - this whole function
    // is by definition a batch of already-past messages rendered in one
    // synchronous loop, so Date.now()-based tool-call timing would be
    // meaningless here (see appendToolCallRow's historical branch).
    renderMessage(fragment, message, { ...options, historical: true });
  }

  // Groups built into the fragment registered themselves under the
  // fragment's own WeakMap entry (renderMessage's container param) - merge
  // them into the real container's list. The fragment's own dangling open
  // group (if the history slice ends mid-run) is discarded, not merged - it
  // belongs to a different DOM subtree and can never accept another tool
  // call now that it's sealed. Each group's `container` field also gets
  // re-pointed at the real container - it was stamped `fragment` during
  // creation, and fragment is discarded below, so anything still
  // referencing it would look up an empty list.
  const fragmentGroups = groupsByContainer.get(fragment) || [];
  const containerGroups = groupsByContainer.get(container) || [];
  fragmentGroups.forEach((g) => { g.container = container; });

  groupsByContainer.set(container, [...fragmentGroups, ...containerGroups]);
  groupsByContainer.delete(fragment);
  openGroupByContainer.delete(fragment);

  // Tool-call records built during the fragment render (see tool-call-store.js's
  // mergeToolCallStore doc comment) need the same fold-in, so a click on a
  // just-prepended historical row still resolves to its record.
  const mergedIds = mergeToolCallStore(fragment, container);

  container.prepend(fragment);

  // A tool_use that just arrived via this merge might be the match an
  // earlier orphan result (rendered before this history page ever loaded -
  // see appendOrphanResultRow/renderUser's tool_result handling) has been
  // waiting for. Resolve it now instead of leaving that row pending forever:
  // complete the record and patch its row exactly like a live result
  // arriving would, then drop the now-redundant orphan placeholder row.
  for (const id of mergedIds) {
    const orphan = popOrphanResult(container, id);
    if (!orphan) continue;
    const record = completeToolCallRecord(container, id, { resultText: orphan.resultText, isError: orphan.isError, resultAtMs: orphan.resultAtMs });
    if (record) {
      updateToolCallRow(record);
      orphan.rowEl?.remove();
    }
  }
}

// receivedAtMs: the cockpit's own receive-time (Date.now() at the moment
// app.js got this message over the websocket), used whenever the SDK's own
// message.timestamp is absent (older emitters, or the Grok provider, which
// has no timestamp field at all - see src/grok-messages.js). The SDK's own
// field is "for display only, do not order messages by this field" per its
// doc comment, which is exactly the use made of it here. history-pane.js
// passes no receivedAtMs, so a transcript with no recorded timestamp simply
// shows none rather than a fabricated "just now".
export function renderMessage(container, message, { onRewindClick, hasFileCheckpointing = true, turnIndexUnreliable = false, turnPointIndex = null, assistantLabel = 'Claude', rewindLabel, receivedAtMs = null, historical = false, onSelectToolCall, onToolCallStarted, onToolResultArrived, onShowDelegatedTrace } = {}) {
  if (!groupsByContainer.has(container)) resetStreamView(container);

  const parsed = message.timestamp ? Date.parse(message.timestamp) : NaN;
  const timestampMs = Number.isFinite(parsed) ? parsed : receivedAtMs;
  // Detail-pane hooks (all optional, default no-ops via `?.()` at every call
  // site below) - threaded through the same way onRewindClick already is,
  // rather than a global event bus, so app.js stays the only place that
  // knows the detail-pane instance exists. `historical` (forced true by
  // prependHistory/history-pane.js, false for the one live-streaming call
  // site in app.js) tells appendToolCallRow/renderUser's tool_result handler
  // whether Date.now() is a real per-block timestamp (live) or would just be
  // "whenever this synchronous render loop happened to run" (a batch of
  // already-past messages, rendered in one tick with no real elapsed time
  // between them) - see the Timing-tab honesty note this drives in
  // detail-pane.js.
  const toolOpts = { historical, onSelectToolCall, onToolCallStarted, onToolResultArrived };

  switch (message.type) {
    case 'system':
      return renderSystem(container, message, timestampMs);
    case 'assistant':
      return renderAssistant(container, message, turnPointIndex, assistantLabel, timestampMs, toolOpts);
    case 'user':
      return renderUser(container, message, turnIndexUnreliable ? null : onRewindClick, hasFileCheckpointing, rewindLabel, timestampMs, toolOpts);
    case 'result':
      return renderResult(container, message, timestampMs);
    case 'rate_limit_event':
      return; // noise - not actionable per-turn
    case 'cockpit:delegate-sent':
      // MVP5 cross-session delegation (backlog.md) - cockpit-only marker,
      // never a real SDK message, appended straight to the origin's own
      // eventLog by session-registry.js's delegateTask so it survives
      // reconnect. Minimal/textual per the confirmed v1 scope - no special
      // styling beyond the existing 'system' block class.
      closeGroup(container);
      return appendBlock(container, 'system', 'Delegated', `-> Asked ${message.targetName}: ${message.text}`, [], container, null, null, timestampMs);
    case 'cockpit:delegate-full-trace':
      // MVP5 cross-session delegation follow-up (backlog.md) - cockpit-only
      // marker, never a real SDK message, appended straight to the origin's
      // own eventLog by session-registry.js's relayDelegationResult so it
      // survives reconnect. Purely additive UI: attaches a button to an
      // already-rendered bubble, renders nothing of its own.
      return attachDelegatedTrace(container, message.queueId, message.label, message.text, onShowDelegatedTrace);
    default:
      return; // large open-ended SDKMessage union; unhandled types stay silent
  }
}

function renderSystem(container, message, timestampMs = null) {
  if (SILENT_SYSTEM_SUBTYPES.has(message.subtype)) return;

  if (message.subtype === 'init') {
    if (seenInitByContainer.get(container)) return; // priming sentinel causes a harmless second init
    seenInitByContainer.set(container, true);
    closeGroup(container);
    appendBlock(container, 'system', 'Session', `model: ${message.model}  ·  cwd: ${message.cwd}  ·  mode: ${message.permissionMode}`, [], container, null, null, timestampMs);
    return;
  }

  if (message.subtype === 'permission_denied') {
    closeGroup(container); // a denial interrupts whatever tool run was in progress
    appendBlock(container, 'error', `${message.tool_name} Denied`, message.decision_reason || message.message || 'permission denied', [], container, null, null, timestampMs);
    return;
  }
  // other system subtypes: silent by default, see module comment
}

function renderAssistant(container, message, turnPointIndex = null, assistantLabel = 'Claude', timestampMs = null, toolOpts = {}) {
  const blocks = message.message && message.message.content;
  if (!Array.isArray(blocks)) return;
  // One API call produced every block below - the SDK doesn't sub-divide
  // cost/tokens per tool call, so all of them (the reply text, a thinking
  // block, every tool_use) honestly share this same figure rather than
  // fabricating a split. Server-attached (session-registry.js's
  // handleMessage), absent for models with no pricing.json entry.
  const usage = formatUsageInline(message._usageInfo);
  for (const block of blocks) {
    if (block.type === 'text') {
      closeGroup(container); // real reply - whatever tool run preceded it is done
      // Grok streams agent_message_chunk one token at a time. Append to the
      // last assistant card instead of opening a new one per word.
      if (appendToLastStreamBlock(container, 'assistant', block.text, true)) {
        if (turnPointIndex != null) {
          const last = container.lastElementChild;
          if (last) last.dataset.turnPoint = String(turnPointIndex);
        }
        continue;
      }
      const wrap = appendBlock(container, 'assistant', assistantLabel, block.text, [], container, null, usage, timestampMs, true); // the actual reply - never collapsed; markdown-rendered (see markdown.js)
      // Text-only turns (no tool_use blocks) otherwise never get tagged, so
      // clicking their bar in turn-chart.js just clears whatever highlight
      // was showing and does nothing (B7) - tag this one too. It's not
      // collapsible, so turn-chart's selectIndex just scrolls/highlights it
      // rather than trying to expand it.
      if (turnPointIndex != null) wrap.dataset.turnPoint = String(turnPointIndex);
    } else if (block.type === 'thinking') {
      closeGroup(container); // keeps DOM order honest: thinking always precedes the calls that follow it
      if (!block.thinking || !block.thinking.trim()) continue; // signature-only/empty thinking blocks - nothing to show
      // Same token-stream problem as text: Grok thought chunks are often
      // one word (sometimes "word\n") each. A new .msg.thinking per chunk
      // is what made thinking render as one word per line.
      if (appendToLastStreamBlock(container, 'thinking', block.thinking, false)) continue;
      appendBlock(container, 'thinking', 'Thinking', block.thinking, [], container, null, usage, timestampMs); // always fully rendered now, no collapse/expand affordance (see module comment)
    } else if (block.type === 'tool_use') {
      // Same live-vs-historical split as appendToolCallRow's own startedAtMs
      // below: Date.now() is the real fired-at moment for a message arriving
      // live; a historical batch render has no such moment; message.timestampMs
      // is the coarser fallback (see appendToolCallRow's comment).
      const groupFiredAtMs = toolOpts.historical ? timestampMs : Date.now();
      const parent = addToolCallToGroup(container, block.name, message._usageInfo, groupFiredAtMs);
      appendToolCallRow(container, block, message._usageInfo, parent, turnPointIndex, toolOpts, timestampMs);
    }
  }
}

// Trajectory-style fixed one-liner per tool call - verb + brief args (reuses
// summarizeToolInput, unchanged) + inline usage + a duration placeholder
// filled in by updateToolCallRow once the matching tool_result arrives. This
// is the *only* DOM node for the tool call: the tool_result handler below
// patches it in place rather than appending a second block, so the run
// merges into one line per group entry instead of a call/result pair.
function appendToolCallRow(container, block, usageInfo, parent, turnPointIndex, toolOpts = {}, messageTimestampMs = null) {
  // Live: Date.now() is a real per-block stamp, the whole point of this
  // instrumentation. Historical (prependHistory/history-pane.js force
  // toolOpts.historical = true): every message in the batch renders in one
  // synchronous loop with no real elapsed time between iterations, so
  // Date.now() here would just be "whenever this loop happened to run," not
  // when the tool call actually started - that's what produced the
  // misleading "0ms" on every historical row. Use the assistant message's
  // own timestamp instead (still a real, if coarser, signal); if it's
  // missing too (older emitters, Grok), leave it null and let the Timing tab
  // / duration cell show "-" rather than a fabricated number.
  const startedAtMs = toolOpts.historical ? messageTimestampMs : Date.now();


  // Same pin-to-bottom the old appendBlock/openGroup path did - checked
  // against `container` (the real scroll region: #stream/#historyBody), not
  // `parent` (a group's .inner, which never scrolls on its own). Without
  // this, every tool call after a group's first one grows the group with no
  // re-pin, so a long in-flight Bash -> Read -> Edit run walks off the
  // bottom of the transcript. (On a detached prependHistory fragment,
  // isScrolledToBottom reads undefined dimensions and returns false, so this
  // is a harmless no-op there, same as it already is for appendBlock.)
  const wasAtBottom = isScrolledToBottom(container);

  const wrap = document.createElement('div');
  wrap.className = 'msg tool-row tool-row-pending';
  wrap.dataset.toolKind = classifyTool(block.name);
  wrap.dataset.toolCallId = block.id;
  if (turnPointIndex != null) wrap.dataset.turnPoint = String(turnPointIndex);

  const nameEl = document.createElement('span');
  nameEl.className = 'tool-row-name';
  nameEl.textContent = block.name;

  const argsEl = document.createElement('span');
  argsEl.className = 'tool-row-args';
  argsEl.textContent = summarizeToolInput(block.name, block.input);

  const metaEl = document.createElement('span');
  metaEl.className = 'tool-row-meta usage-meta';
  metaEl.textContent = formatUsageInline(usageInfo) || '';

  const durationEl = document.createElement('span');
  durationEl.className = 'tool-row-duration';
  durationEl.textContent = '…';
  durationEl.title = 'Client-observed wall time (includes network + render lag), not the tool\'s server-side execution time';

  const statusEl = document.createElement('span');
  statusEl.className = 'tool-row-status';
  statusEl.textContent = '●';

  wrap.append(nameEl, argsEl, metaEl, durationEl, statusEl);
  parent.append(wrap);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;

  // Resolve the *real* container at click time, not the one closed over at
  // creation - prependHistory renders into a detached fragment first, then
  // merges its records into the real container's map and discards the
  // fragment's own entry (tool-call-store.js's mergeToolCallStore), so by
  // the time this ever fires, `container` (the fragment) is stale and would
  // resolve to nothing. The two ids below are this app's only two real
  // renderMessage containers (live #stream, history modal's #historyBody) -
  // `wrap` is a genuine DOM descendant of whichever one it ended up in by
  // the time a user can click it, fragment or not.
  wrap.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle the enclosing group
    const liveContainer = wrap.closest('#stream') || wrap.closest('#historyBody');
    toolOpts.onSelectToolCall?.(liveContainer || container, block.id);
  });

  const record = createToolCallRecord(container, {
    id: block.id, name: block.name, kind: classifyTool(block.name),
    input: block.input, payload: formatToolInput(block.name, block.input),
    usage: usageInfo, rowEl: wrap, startedAtMs,
  });

  toolOpts.onToolCallStarted?.(container, record);

  return wrap;
}

// null when either stamp is missing (no real timestamp available for a
// historical row - see tool-call-store.js) - an em dash beats a fabricated
// "0ms" that implies a measurement never actually happened.
function formatToolRowDuration(startedAtMs, resultAtMs) {
  if (startedAtMs == null || resultAtMs == null) return '–';
  const ms = resultAtMs - startedAtMs;
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`;
}

// Patches the row appendToolCallRow already built - duration + status glyph -
// instead of appending a second block for the result, so a tool call reads
// as one line, not a call/result pair.
function updateToolCallRow(record) {
  record.rowEl.querySelector('.tool-row-duration').textContent = formatToolRowDuration(record.startedAtMs, record.resultAtMs);
  record.rowEl.querySelector('.tool-row-status').textContent = record.status === 'error' ? '✗' : '✓';
  record.rowEl.classList.toggle('tool-row-error', record.status === 'error');
  record.rowEl.classList.remove('tool-row-pending');
}

// A tool_result with no matching tool_use record - real case, not a bug: a
// "Load earlier history" fetch can start mid-run, landing a result whose
// call lived on an earlier, unfetched page (see tool-call-store.js). Render
// an honest orphan row rather than silently dropping the result, same
// "flag the real limitation" spirit as renderUser's rewind-button omission.
function appendOrphanResultRow(container, block, parent) {
  const wasAtBottom = isScrolledToBottom(container); // same reasoning as appendToolCallRow's own wasAtBottom

  const wrap = document.createElement('div');
  wrap.className = 'msg tool-row tool-row-orphan';
  wrap.dataset.toolKind = 'other';
  wrap.dataset.orphanToolUseId = block.tool_use_id; // for inspection only - resolution is driven by tool-call-store.js's orphan map, not this attribute
  const nameEl = document.createElement('span');
  nameEl.className = 'tool-row-name';
  nameEl.textContent = 'Result';
  const argsEl = document.createElement('span');
  argsEl.className = 'tool-row-args';
  argsEl.textContent = '(tool call not loaded - result from an earlier, unfetched history page)';
  wrap.append(nameEl, argsEl);
  parent.append(wrap);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  return wrap;
}

// "$0.0X, N in, M out" - dim/small (index.html's .usage-meta), on the same
// role row as the label. 4-decimal USD below a cent, mirrors stats-panel.js's
// fmtUSD so a tiny per-call cost doesn't just round to "$0.00" and look
// like it was free. Returns null (nothing rendered) when there's no figure
// to show - an unpriced model, or a message this repo never attached one to
// (system/user/result messages, or an assistant message with none).
export function formatUsageInline(info) {
  if (!info) return null;
  const usd = info.costUsd > 0 && info.costUsd < 0.01 ? `$${info.costUsd.toFixed(4)}` : `$${info.costUsd.toFixed(2)}`;
  return `${usd}, ${info.inputTokens} in, ${info.outputTokens} out`;
}

// Which color bucket a tool's role label falls into - see index.html's
// [data-tool-kind] rules. Purely cosmetic grouping, not a capability check.
function classifyTool(name) {
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return 'edit';
  if (name === 'Bash' || name === 'BashOutput' || name === 'KillShell') return 'bash';
  if (name === 'Read' || name === 'NotebookRead') return 'read';
  if (name === 'Glob' || name === 'Grep' || name === 'WebSearch') return 'search';
  return 'other';
}

// Terminal-style expanded rendering per tool, instead of a raw JSON.stringify
// dump of `input` - that was the single biggest verbosity gap against the
// CLI, which shows Edit/MultiEdit as a diff and Bash as a plain command
// rather than an escaped JSON blob. Returns either a plain string or
// { lines: [{ text, cls }] } for diff-colored output (see appendBlock).
function formatToolInput(name, input) {
  if (!input || typeof input !== 'object') return JSON.stringify(input);

  if (name === 'Edit') {
    const header = input.file_path ? [{ text: input.file_path, cls: 'diff-meta' }] : [];
    return { lines: [...header, ...diffLines(input.old_string, input.new_string)] };
  }

  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lines = input.file_path ? [{ text: input.file_path, cls: 'diff-meta' }] : [];
    input.edits.forEach((edit, i) => {
      lines.push({ text: `@@ edit ${i + 1}/${input.edits.length} @@`, cls: 'diff-hunk' });
      lines.push(...diffLines(edit.old_string, edit.new_string));
    });
    return { lines };
  }

  if (name === 'Write') {
    const header = input.file_path ? `${input.file_path}\n` : '';
    return header + (input.content ?? '');
  }

  if (name === 'Bash') {
    const desc = input.description ? `# ${input.description}\n` : '';
    return desc + (input.command ?? '');
  }

  // Everything else: key: value per line rather than a braces-and-quotes
  // JSON blob - still compact, far less visual noise.
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

const MAX_DIFF_CELLS = 200_000; // guard the O(n*m) LCS below against pathological input sizes

// Minimal line-level diff (LCS backtrack) between two strings, rendered
// terminal-`/diff`-style: '-' removed, '+' added, ' ' unchanged context.
function diffLines(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');

  if (a.length * b.length > MAX_DIFF_CELLS) {
    // Too big to diff cheaply - fall back to a plain before/after dump.
    return [
      { text: '--- before', cls: 'diff-meta' },
      ...a.map((l) => ({ text: `-${l}`, cls: 'diff-del' })),
      { text: '+++ after', cls: 'diff-meta' },
      ...b.map((l) => ({ text: `+${l}`, cls: 'diff-add' })),
    ];
  }

  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ text: ` ${a[i]}`, cls: 'diff-ctx' }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ text: `-${a[i]}`, cls: 'diff-del' }); i++; }
    else { lines.push({ text: `+${b[j]}`, cls: 'diff-add' }); j++; }
  }
  while (i < n) { lines.push({ text: `-${a[i]}`, cls: 'diff-del' }); i++; }
  while (j < m) { lines.push({ text: `+${b[j]}`, cls: 'diff-add' }); j++; }
  return lines;
}

// The row's "brief args" cell, e.g. file_path: "package.json" - just the key:
// value fragment, not wrapped in `name(...)`, since .tool-row-name already
// prints the tool name right before this in the same row (used to be
// combined into one string back when this fed a "Write(file_path: ...)"-style
// collapsed block label with no separate name element next to it).
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  const preferredKeys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'];
  const key = preferredKeys.find((k) => k in input) || Object.keys(input)[0];
  if (!key) return '';
  const value = typeof input[key] === 'string' ? input[key] : JSON.stringify(input[key]);
  const truncated = value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return `${key}: ${JSON.stringify(truncated)}`;
}

// MVP5 cross-session delegation: session-registry.js wraps both directions
// of the exchange in a self-identifying prose header before pushing them as
// a plain user turn - "[Prompt Cockpit] Relayed task from "..."" going out
// (delegateTask), "[Prompt Cockpit] Relayed reply from "..."" coming back
// (relayDelegationResult), both followed by an explanatory paragraph, a
// `\n---\n` separator, then the actual payload. Without unwrapping here, the
// bubble would show "You" for a turn neither side's human actually typed.
// (Earlier version of this wrapper used an XML-ish `<delegated_task from=
// "...">` tag - dropped 2026-08-20 because receiving models were pattern-
// matching it as a spoofed tool-scaffolding tag and refusing it outright;
// see session-registry.js's buildDelegatedHeader comment and backlog.md.)
// No unescaping needed here (unlike the old tag shape) - the server no
// longer HTML-escapes the payload, and this renders via textContent
// downstream regardless, never as markup.
const DELEGATED_HEADER_RE = /^\[Prompt Cockpit\] Relayed (task|reply) from "([^"]*)"\n\n[\s\S]*?\n---\n([\s\S]*)$/;

// `kind` distinguishes the two delegation directions so the caller can style
// them differently: a 'task' is real input to THIS session (the operator
// relayed another human's typed message in) - it stays a "user" bubble, blue
// box and all. A 'reply' is the opposite - another session's own answer,
// forwarded back - so it renders like an assistant response (see renderUser),
// not like something typed here.
// Remembers a just-rendered delegated-reply bubble so a later
// cockpit:delegate-full-trace marker (see attachDelegatedTrace below) can
// find it again. `queueId` is null for anything that isn't this session's
// own live pushInput echo (a historical/replayed array-content block, say) -
// harmless no-op, since relayDelegationResult only ever mints a matching
// marker for a queueId it minted itself.
function registerDelegatedReplyBubble(container, queueId, wrap) {
  if (queueId == null) return;
  if (!delegatedBubblesByContainer.has(container)) delegatedBubblesByContainer.set(container, new Map());
  delegatedBubblesByContainer.get(container).set(queueId, wrap);
}

// cockpit:delegate-full-trace marker handler (renderMessage's switch) - adds
// a small corner button to the matching delegated-reply bubble that opens
// the full (narration-included) text in the detail pane, via
// onShowDelegatedTrace (app.js -> detail-pane.js's showText). No bubble
// found is a silent no-op, not an error: the marker always arrives after its
// bubble (session-registry.js's relayDelegationResult comment), so a miss
// here would mean the bubble's own container got reset/replaced in between -
// the marker is just stale at that point, nothing to attach to.
function attachDelegatedTrace(container, queueId, label, text, onShowDelegatedTrace) {
  const bubbles = delegatedBubblesByContainer.get(container);
  const wrap = bubbles?.get(queueId);
  if (!wrap) return;
  const roleRow = wrap.querySelector(':scope > .role');
  if (roleRow) {
    const btn = document.createElement('button');
    btn.className = 'trace-toggle-btn';
    btn.textContent = '⤢ Expand answer';
    btn.title = 'Show the full reply (narration included) - by default only the final answer is relayed into this session';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onShowDelegatedTrace?.(container, queueId, label, text);
    });
    roleRow.append(btn);
  }
  bubbles.delete(queueId); // one marker per bubble - nothing left to match if another somehow arrived for the same id
}

function delegatedLabelAndText(text) {
  const match = DELEGATED_HEADER_RE.exec(text);
  if (match) return { kind: match[1], label: match[2], text: match[3] };
  return null;
}

function renderUser(container, message, onRewindClick, hasFileCheckpointing, rewindLabel, timestampMs = null, toolOpts = {}) {
  const content = message.message && message.message.content;
  if (message.isSynthetic) return; // priming sentinel, not a real turn

  if (typeof content === 'string') {
    // Always our own local echo (session.js: the CLI never streams the
    // prompt back) - turnIndex is minted synchronously at send time, so
    // the rewind button can attach immediately, no waiting on anything.
    closeGroup(container); // a real message from you ends whatever tool run preceded it
    // A resumed session (terminal-started or a prior cockpit run) never has
    // file snapshots for its earlier turns - enableFileCheckpointing can't
    // apply retroactively (plan Decisions). Label the button honestly
    // rather than offering a file revert that server-side just no-ops
    // (registry.rewind() checks the same flag and skips rewindFiles).
    // Grok has no Claude-style file rewind, so the caller passes
    // rewindLabel ("fork back to here") instead of this Claude default.
    const label = rewindLabel
      || (hasFileCheckpointing ? '⟲ rewind here' : '⟲ rewind here (conversation only)');
    const actions = onRewindClick && message.turnIndex
      ? [{ label, title: 'Fork a new session starting from this message', onClick: () => onRewindClick(message.turnIndex) }]
      : [];
    const delegated = delegatedLabelAndText(content);
    const cls = delegated && delegated.kind === 'reply' ? 'assistant delegated-reply' : 'user';
    const wrap = appendBlock(container, cls, delegated ? delegated.label : 'You', delegated ? delegated.text : content, actions, container, null, null, timestampMs);
    if (delegated && delegated.kind === 'reply') registerDelegatedReplyBubble(container, message.queueId, wrap);
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        // Patches the row appendToolCallRow already built for the matching
        // tool_use (correlated via the Anthropic tool_use_id join key) -
        // merges into one line instead of appending a second "Tool: Result"
        // block, per the Trajectory-style redesign.
        const resultText = flattenToolResult(block.content);
        const isError = Boolean(block.is_error);
        // Same live-vs-historical reasoning as appendToolCallRow's
        // startedAtMs - Date.now() only means something for a result that's
        // really arriving right now.
        const resultAtMs = toolOpts.historical ? timestampMs : Date.now();
        const record = completeToolCallRecord(container, block.tool_use_id, { resultText, isError, resultAtMs });
        if (record) {
          updateToolCallRow(record);
        } else {
          // No matching tool_use in this container - real limitation, not a
          // bug: see appendOrphanResultRow's own comment. Retain the result
          // text/error (not just render a placeholder) so that if "Load
          // earlier history" later pulls in the missing tool_use, the merge
          // step below can retroactively complete this record instead of
          // leaving a permanently-pending orphan.
          const parent = getOrOpenGroup(container).inner;
          const orphanRow = appendOrphanResultRow(container, block, parent);
          recordOrphanResult(container, block.tool_use_id, { resultText, isError, resultAtMs, rowEl: orphanRow });
        }
        toolOpts.onToolResultArrived?.(container, block.tool_use_id);
      } else if (block.type === 'text') {
        closeGroup(container);
        const delegated = delegatedLabelAndText(block.text);
        const cls = delegated && delegated.kind === 'reply' ? 'assistant delegated-reply' : 'user';
        const wrap = appendBlock(container, cls, delegated ? delegated.label : 'You', delegated ? delegated.text : block.text, [], container, null, null, timestampMs);
        if (delegated && delegated.kind === 'reply') registerDelegatedReplyBubble(container, message.queueId, wrap);
      }
    }
  }
}

function flattenToolResult(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (c.type === 'text' ? c.text : JSON.stringify(c)))
      .join('\n');
  }
  return JSON.stringify(content);
}

function renderResult(container, message, timestampMs = null) {
  closeGroup(container); // the turn is over - nothing can extend the run anymore
  if (message.subtype === 'success') return; // state pill already shows idle/running
  appendBlock(container, 'error', 'Turn Error', message.error || 'unknown error', [], container, null, null, timestampMs);
}

// A run of consecutive tool call/result pairs, collapsed to one summary row
// ("3 tool calls: Bash → Read → Edit") instead of each pair getting its own
// top-level row. See module comment for when a group opens/closes.
function getOrOpenGroup(container, firedAtMs) {
  return openGroupByContainer.get(container) || openGroup(container, firedAtMs);
}

function openGroup(container, firedAtMs = null) {
  if (autoCollapsePreviousGroup) {
    const existing = groupsByContainer.get(container) || [];
    const previous = existing[existing.length - 1];
    if (previous && previous.expanded) setGroupExpanded(previous, false);
  }

  const wasAtBottom = isScrolledToBottom(container);

  const wrap = document.createElement('div');
  wrap.className = 'msg group collapsible';
  const roleRow = document.createElement('div');
  roleRow.className = 'role';
  const roleText = document.createElement('span');
  roleText.className = 'role-text';
  const usageMetaText = document.createElement('span');
  // group-usage-meta (in addition to the plain .usage-meta every other row
  // type uses) carries the margin-left: auto that pins this whole trailing
  // cluster - cost/tokens then fired-at time, in that order - to the row's
  // right edge as one unit; .group-time deliberately has no margin of its
  // own so it just sits adjacent to usageMetaText instead of each fighting
  // over the same auto-margin space.
  usageMetaText.className = 'usage-meta group-usage-meta';
  const timeText = document.createElement('span');
  timeText.className = 'group-time';
  roleRow.append(roleText, usageMetaText, timeText);
  const inner = document.createElement('div');
  inner.className = 'group-body';
  wrap.append(roleRow, inner);
  container.append(wrap);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;

  // Sums every tool call's usage into one figure on the group's own row -
  // visible whether the group is collapsed or expanded (unlike each tool
  // call's own .usage-meta, which only shows once its block is expanded),
  // so "what did this run cost" doesn't require opening anything. Deduped
  // by object identity (countedUsageInfos), not tool count: one assistant
  // message emitting several tool_use blocks in a row shares one usage
  // figure (addToolCallToGroup below), and counting it once per block would
  // inflate the sum by however many tool calls that single API call made.
  const group = {
    wrap, inner, roleText, usageMetaText, timeText, toolNames: [], expanded: true,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    countedUsageInfos: new Set(),
    container, firedAtMs, // when the run started - set once at creation, never touched by later calls joining the same group
  };
  wrap.classList.add('expanded'); // groups open by default
  wrap.addEventListener('click', () => setGroupExpanded(group, !group.expanded));

  openGroupByContainer.set(container, group);
  const list = groupsByContainer.get(container) || [];
  list.push(group);
  groupsByContainer.set(container, list);
  return group;
}

function closeGroup(container) {
  openGroupByContainer.delete(container);
}

// Opens (or reuses) the container's current group, records the tool call
// (and its originating message's usage, if any - see openGroup's comment)
// in its summary, and returns the DOM node its one-line row (appendToolCallRow)
// should render into (instead of the top-level container). firedAtMs only
// takes effect the moment a *new* group is opened (openGroup's own default
// param) - joining an already-open group never overwrites its start time.
function addToolCallToGroup(container, name, usageInfo, firedAtMs) {
  const group = getOrOpenGroup(container, firedAtMs);
  group.toolNames.push(name);
  if (usageInfo && !group.countedUsageInfos.has(usageInfo)) {
    group.countedUsageInfos.add(usageInfo);
    group.usage.costUsd += usageInfo.costUsd;
    group.usage.inputTokens += usageInfo.inputTokens;
    group.usage.outputTokens += usageInfo.outputTokens;
  }
  renderGroupSummary(group);
  return group.inner;
}

// Rebuilds the group's summary line with each tool name in its own colored
// span (same [data-tool-kind] scheme as an individual tool block) - a group
// mixing tool kinds (e.g. Bash + Read + Edit) needs per-name color, a single
// color for the whole row can't carry that.
function renderGroupSummary(group) {
  group.roleText.textContent = '';
  group.toolNames.forEach((name, i) => {
    if (i > 0) group.roleText.append(document.createTextNode(' → '));
    const span = document.createElement('span');
    span.className = 'group-tool-name';
    span.dataset.toolKind = classifyTool(name);
    span.textContent = name;
    group.roleText.append(span);
  });
  // Blank until the first priced tool call lands (most groups' first call
  // is a real API turn, but nothing guarantees it) - showing "$0.00, 0 in,
  // 0 out" in that gap would read as a real (if boring) number rather than
  // "nothing counted yet".
  const hasUsage = group.usage.costUsd > 0 || group.usage.inputTokens > 0 || group.usage.outputTokens > 0;
  group.usageMetaText.textContent = hasUsage ? formatUsageInline(group.usage) : '';
  // Its own span (index.html's .group-time), not appended into roleText -
  // lets it sit dim/small/right-aligned regardless of roleText's own
  // hover/expanded color changes, and regardless of how long the tool-name
  // list runs. Replaces the old "click to expand"/"click to collapse" hint
  // text (the row's still just as clickable, it just no longer says so) -
  // when the group started is more useful at a glance than a reminder of an
  // interaction most users find on their own. Always shown, expanded or
  // not, unlike the old hint's collapsed-only dedup logic - there's nothing
  // to dedup, every group has its own distinct start time.
  group.timeText.textContent = group.firedAtMs != null ? formatClock(group.firedAtMs) : '';
}

function setGroupExpanded(group, expanded) {
  group.expanded = expanded;
  group.wrap.classList.toggle('expanded', expanded);
  renderGroupSummary(group);
}

// Plain string -> textContent, same as before. { lines } (diff output from
// formatToolInput) -> one colored div per line, reusing the diff-view.js
// classes (diff-add/diff-del/diff-hunk/diff-meta/diff-ctx) so an expanded
// Edit/MultiEdit reads like the terminal's own diff instead of raw JSON.
// `hint`, when given, renders as a trailing .expand-hint span in the same flex row
// as the content (index.html's `.body.with-hint`) - unused today (nothing
// still renders a collapsed-with-hint block; the click-to-collapse
// interaction that used this is gone), kept because renderBody is exported
// and reused as a generic content renderer (detail-pane.js's Payload/Result
// tabs) where a future caller passing a hint should still work correctly.
export function renderBody(body, content, hint = null, markdown = false) {
  if (content && typeof content === 'object' && Array.isArray(content.lines)) {
    body.className = 'body';
    body.textContent = '';
    for (const line of content.lines) {
      const div = document.createElement('div');
      div.textContent = line.text;
      if (line.cls) div.className = line.cls;
      body.append(div);
    }
    return;
  }
  // Markdown path - only ever passed true for Claude's own reply text (see
  // appendBlock's caller in renderAssistant). Ignores `hint`: nothing calls
  // this with both today (see renderBody's own module comment on `hint`
  // being otherwise unreachable), and mixing the two would need the
  // markdown fragment squeezed into .body-content's flex row instead of
  // owning the whole body element.
  if (markdown && typeof content === 'string') {
    body.className = 'body markdown-body';
    body.textContent = '';
    body.append(renderMarkdown(content));
    return;
  }
  if (hint) {
    body.className = 'body with-hint';
    body.textContent = '';
    const contentSpan = document.createElement('span');
    contentSpan.className = 'body-content';
    contentSpan.textContent = content ?? '';
    const hintSpan = document.createElement('span');
    hintSpan.className = 'expand-hint';
    hintSpan.textContent = hint;
    body.append(contentSpan, hintSpan);
    return;
  }
  body.className = 'body';
  body.textContent = content ?? '';
}

// `parent` is the DOM node the block is actually inserted into - defaults
// to `container`, but a grouped tool call/result passes a group's inner
// node instead. `container` always stays the scroll-position/registry
// reference regardless of where the block physically lands, since `parent`
// is always a descendant of it.
// Grok streams BPE pieces (Rac + oon). Inventing a space between every
// bare pair is what turned "Racoon" into "Rac oon". A single trailing
// newline is the one case that is a word boundary rather than a
// paragraph. Keep this in sync with src/grok-messages.js joinStreamText.
function joinStreamText(existing, next) {
  const left = existing ?? '';
  const right = next ?? '';
  if (!left) return right;
  if (!right) return left;
  let a = left;
  if (a.endsWith('\n') && !a.endsWith('\n\n') && !right.startsWith('\n')) {
    a = a.slice(0, -1);
    if (/\s$/.test(a) || /^\s/.test(right) || /^[,.;:!?')\]}]/.test(right)) {
      return a + right;
    }
    return `${a} ${right}`;
  }
  return a + right;
}

// If the last block in `container` is already the same kind of streamed
// assistant/thinking card, append `text` onto it and return true. Used
// while Grok is still mid-thought / mid-reply so we don't stack a new
// .msg per token.
function appendToLastStreamBlock(container, cls, text, markdown) {
  const last = container.lastElementChild;
  if (!last || !last.classList.contains('msg') || !last.classList.contains(cls)) return false;
  const body = last.querySelector('.body');
  if (!body) return false;
  const wasAtBottom = isScrolledToBottom(container);
  if (markdown) {
    const prev = Object.prototype.hasOwnProperty.call(body.dataset, 'rawText')
      ? body.dataset.rawText
      : (body.textContent ?? '');
    const next = joinStreamText(prev, text);
    body.dataset.rawText = next;
    renderBody(body, next, null, true);
  } else {
    body.textContent = joinStreamText(body.textContent ?? '', text);
  }
  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  return true;
}

function appendBlock(container, cls, roleLabel, text, actions = [], parent = container, hint = null, meta = null, timestampMs = null, markdown = false) {
  const wasAtBottom = isScrolledToBottom(container);

  const wrap = document.createElement('div');
  wrap.className = `msg ${cls}`;

  const roleRow = document.createElement('div');
  roleRow.className = 'role';
  const roleText = document.createElement('span');
  roleText.textContent = roleLabel;
  roleRow.append(roleText);
  if (meta) {
    const metaSpan = document.createElement('span');
    metaSpan.className = 'usage-meta';
    metaSpan.textContent = meta;
    roleRow.append(metaSpan);
  }
  // Always rendered (not gated behind the setting here) so toggling
  // "show timestamps" in Settings is instant and retroactive across the
  // whole transcript - it's the container's .show-timestamps class
  // (index.html) that actually controls visibility, not this element's
  // presence. Hidden by default via that same CSS rule.
  if (timestampMs != null) {
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    timeSpan.textContent = formatClock(timestampMs);
    timeSpan.title = new Date(timestampMs).toLocaleString();
    roleRow.append(timeSpan);
  }
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = 'msg-action';
    btn.textContent = action.label;
    if (action.title) btn.title = action.title;
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the enclosing group's own toggle, if this block happens to be inside one
      action.onClick();
    });
    roleRow.append(btn);
  }

  const body = document.createElement('div');
  body.className = 'body';
  renderBody(body, text, hint, markdown);
  // Live Grok text chunks re-render markdown from this raw string (see
  // appendToLastStreamBlock). Without it, later tokens would be joined
  // onto the already-rendered visible text and lose the source form.
  if (markdown && typeof text === 'string') body.dataset.rawText = text;

  wrap.append(roleRow, body);
  parent.append(wrap);

  if (wasAtBottom) container.scrollTop = container.scrollHeight;
  return wrap;
}

// Exported for app.js's compose-resize handle: shrinking/growing #stream
// (via the compose box's height) doesn't touch its scrollTop on its own,
// so a reader anchored to the bottom needs re-pinning after each resize
// step the same way a new message re-pins it here.
export function isScrolledToBottom(container) {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 48;
}
