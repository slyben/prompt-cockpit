// Renders the SDK message stream. Tool calls render one fixed-height row
// (see appendToolCallRow); a matching tool_result patches that row in place
// rather than appending a second block. Consecutive tool calls fold into
// one "group" summary row ("3 tool calls: Bash -> Read -> Edit") that stays
// open until real text/thinking or turn end (see closeGroup call sites).

import { resetToolCallStore, createToolCallRecord, completeToolCallRecord, mergeToolCallStore, recordOrphanResult, popOrphanResult } from '/tool-call-store.js';
import { renderMarkdown } from '/markdown.js';
import { joinStreamText, createFenceTracker } from '/stream-join.js';
import { createDelegateView } from '/delegate-view.js';
import { diffLines, countDiff, diffSummaryText } from '/diff-lines.js';

// One tracker per streamed-block body element, so joinStreamText resumes
// its fence scan instead of rescanning the whole reply on every chunk.
// WeakMap keyed on `body` needs no explicit cleanup and naturally resets on
// a new stream block (a fresh `body` per block).
const fenceTrackerByBody = new WeakMap();

const seenInitByContainer = new WeakMap();
const groupsByContainer = new WeakMap(); // container -> group[]
const openGroupByContainer = new WeakMap(); // container -> the currently-accumulating group, if any
// delegate-view.js takes appendBlock/closeGroup as constructor params
// instead of importing this module back (would be a cycle). Both are
// function declarations further down, fully hoisted before this runs.
const delegateView = createDelegateView({ appendBlock, closeGroup });

// When true, a new top-level tool-call group opening auto-folds the
// immediately preceding one to its summary line, so a long turn's tool
// history reads as a list of past runs rather than a wall of open ones. A
// click on a group's header always re-expands it either way.
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
  delegateView.reset(container);
  resetToolCallStore(container);
}

// Renders `messages` (oldest-first) into a detached fragment, then inserts
// them all at once above `container`'s existing content in one DOM
// operation, in order. Historical entries have no `turnIndex` (minted only
// for this session's own live pushInput calls), so their rewind buttons
// don't appear - a real limitation, not an oversight.
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

  // Groups registered under the fragment's own WeakMap entry get merged
  // into the real container's list, with `container` re-pointed on each
  // (it was stamped `fragment` at creation). Any dangling open group (the
  // history slice ending mid-run) is discarded, not merged - it belongs to
  // a different DOM subtree and can't accept another tool call once sealed.
  const fragmentGroups = groupsByContainer.get(fragment) || [];
  const containerGroups = groupsByContainer.get(container) || [];
  fragmentGroups.forEach((g) => { g.container = container; });

  groupsByContainer.set(container, [...fragmentGroups, ...containerGroups]);
  groupsByContainer.delete(fragment);
  openGroupByContainer.delete(fragment);

  // Tool-call records need the same fold-in, so a click on a just-prepended
  // historical row still resolves to its record.
  const mergedIds = mergeToolCallStore(fragment, container);

  container.prepend(fragment);

  // A tool_use that just arrived via this merge might be the match an
  // earlier orphan result has been waiting for - resolve it now rather than
  // leaving that row pending forever, and drop the redundant orphan row.
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

// receivedAtMs: the cockpit's own receive-time, used whenever the SDK's own
// message.timestamp is absent (older emitters, or Grok, which has no
// timestamp field at all). history-pane.js passes no receivedAtMs, so a
// transcript with no recorded timestamp shows none rather than a
// fabricated "just now".
export function renderMessage(container, message, { onRewindClick, hasFileCheckpointing = true, turnIndexUnreliable = false, turnPointIndex = null, assistantLabel = 'Claude', rewindLabel, receivedAtMs = null, historical = false, onSelectToolCall, onOpenAgentTab, onToolCallStarted, onToolResultArrived, onShowDelegatedTrace } = {}) {
  if (!groupsByContainer.has(container)) resetStreamView(container);

  const parsed = message.timestamp ? Date.parse(message.timestamp) : NaN;
  const timestampMs = Number.isFinite(parsed) ? parsed : receivedAtMs;
  // Detail-pane hooks (all optional, default no-ops via `?.()`) - threaded
  // through like onRewindClick rather than a global event bus. `historical`
  // tells appendToolCallRow/renderUser's tool_result handler whether
  // Date.now() is a real per-block timestamp (live) or meaningless
  // ("whenever this batch render loop happened to run").
  const toolOpts = { historical, onSelectToolCall, onOpenAgentTab, onToolCallStarted, onToolResultArrived };

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
      return delegateView.renderDelegateSent(container, message, timestampMs);
    case 'cockpit:delegate-full-trace':
      return delegateView.renderDelegateFullTrace(container, message, onShowDelegatedTrace);
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
      // Same live-vs-historical split as appendToolCallRow's own startedAtMs:
      // Date.now() is the real fired-at moment live; message.timestampMs is
      // the coarser fallback for a historical batch render.
      const groupFiredAtMs = toolOpts.historical ? timestampMs : Date.now();
      const parent = addToolCallToGroup(container, block.name, message._usageInfo, groupFiredAtMs);
      appendToolCallRow(container, block, message._usageInfo, parent, turnPointIndex, toolOpts, timestampMs);
    }
  }
}

// This is the *only* DOM node for the tool call: the tool_result handler
// below patches it in place rather than appending a second block, so the
// run merges into one line per group entry instead of a call/result pair.
function appendToolCallRow(container, block, usageInfo, parent, turnPointIndex, toolOpts = {}, messageTimestampMs = null) {
  // Historical batch renders happen in one synchronous loop with no real
  // elapsed time between iterations, so Date.now() would misleadingly read
  // "0ms" - use the assistant message's own (coarser) timestamp instead, or
  // null if that's missing too, letting the Timing tab show "-" honestly.
  const startedAtMs = toolOpts.historical ? messageTimestampMs : Date.now();

  // Checked against `container` (the real scroll region), not `parent` (a
  // group's .inner, which never scrolls on its own) - otherwise every call
  // after a group's first grows it with no re-pin and the transcript walks
  // off screen mid-run.
  const wasAtBottom = isScrolledToBottom(container);

  const wrap = document.createElement('div');
  wrap.className = 'msg tool-row tool-row-pending';
  wrap.setAttribute('role', 'button');
  wrap.tabIndex = -1;
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

  // Resolve the *real* container at click time - prependHistory discards
  // its detached fragment once records are merged, so `container` here
  // would be stale. An Agent (Task) row opens the subagent's own transcript
  // in the detail pane's Agent tab instead of the normal tabs, which never
  // have its live tool calls.
  if (block.name === 'Agent') wrap.classList.add('tool-row-agent');
  wrap.addEventListener('click', (e) => {
    e.stopPropagation(); // don't also toggle the enclosing group
    if (block.name === 'Agent' && toolOpts.onOpenAgentTab) {
      toolOpts.onOpenAgentTab(block);
      return;
    }
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

// "$0.0X, N in, M out". 4-decimal USD below a cent so a tiny per-call cost
// doesn't round to "$0.00" and look free. Returns null when there's no
// figure to show - an unpriced model, or a message with none attached.
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
// dump: Edit/MultiEdit render as a diff, Bash/Write as a plain command/file.
// Returns a plain string, { lines, lang } for diff output, or { header,
// code, lang } for a single syntax-highlighted block - see renderBody.
function formatToolInput(name, input) {
  if (!input || typeof input !== 'object') return JSON.stringify(input);

  if (name === 'Edit') {
    const lang = langFromPath(input.file_path);
    const header = input.file_path ? [{ text: input.file_path, cls: 'diff-meta' }] : [];
    const diff = diffLines(input.old_string, input.new_string);
    const summary = [{ text: diffSummaryText(countDiff(diff)), cls: 'diff-summary' }];
    return { lines: [...header, ...summary, ...diff], lang };
  }

  if (name === 'MultiEdit' && Array.isArray(input.edits)) {
    const lang = langFromPath(input.file_path);
    const header = input.file_path ? [{ text: input.file_path, cls: 'diff-meta' }] : [];
    const editDiffs = input.edits.map((edit) => diffLines(edit.old_string, edit.new_string));
    const totals = editDiffs.reduce((acc, diff) => {
      const c = countDiff(diff);
      return { added: acc.added + c.added, removed: acc.removed + c.removed };
    }, { added: 0, removed: 0 });
    const lines = [...header, { text: diffSummaryText(totals), cls: 'diff-summary' }];
    editDiffs.forEach((diff, i) => {
      lines.push({ text: `@@ edit ${i + 1}/${input.edits.length} @@`, cls: 'diff-hunk' });
      lines.push(...diff);
    });
    return { lines, lang };
  }

  if (name === 'Write') {
    return { header: input.file_path || null, code: input.content ?? '', lang: langFromPath(input.file_path) };
  }

  if (name === 'Bash') {
    return { header: input.description || null, code: input.command ?? '', lang: 'bash' };
  }

  // Everything else: key: value per line rather than a braces-and-quotes
  // JSON blob - still compact, far less visual noise.
  return Object.entries(input)
    .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join('\n');
}

// File extension -> Prism.js language id (public/vendor/prism/, loaded as
// classic globals by index.html). Unmapped/unknown extensions fall back to
// plain text rather than guessing - see highlightSource.
const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  py: 'python', pyw: 'python',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  go: 'go', rs: 'rust', java: 'java', sql: 'sql', cs: 'csharp',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
};

export function langFromPath(filePath) {
  if (typeof filePath !== 'string') return null;
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  return m ? (LANG_BY_EXT[m[1].toLowerCase()] || null) : null;
}

// Prism.highlight() escapes the source itself before tokenizing, so the
// returned HTML is safe to drop straight into innerHTML - null (not thrown)
// when Prism, or that specific language's grammar, isn't loaded, so callers
// can fall back to plain textContent instead of rendering nothing.
function highlightSource(code, lang) {
  const Prism = globalThis.Prism;
  if (!lang || !Prism || !Prism.languages[lang]) return null;
  try {
    return Prism.highlight(code, Prism.languages[lang], lang);
  } catch {
    return null;
  }
}

// The row's "brief args" cell, e.g. file_path: "package.json" - just the key:
// value fragment, not wrapped in `name(...)`, since .tool-row-name already
// prints the tool name right before this in the same row (used to be
// combined into one string back when this fed a "Write(file_path: ...)"-style
// collapsed block label with no separate name element next to it).
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return '';
  if (name === 'Edit' && typeof input.file_path === 'string') {
    const { added, removed } = countDiff(diffLines(input.old_string, input.new_string));
    return `${input.file_path} (+${added} -${removed})`;
  }
  if (name === 'MultiEdit' && typeof input.file_path === 'string' && Array.isArray(input.edits)) {
    const totals = input.edits.reduce((acc, edit) => {
      const c = countDiff(diffLines(edit.old_string, edit.new_string));
      return { added: acc.added + c.added, removed: acc.removed + c.removed };
    }, { added: 0, removed: 0 });
    return `${input.file_path} (+${totals.added} -${totals.removed})`;
  }
  const preferredKeys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'];
  const key = preferredKeys.find((k) => k in input) || Object.keys(input)[0];
  if (!key) return '';
  // JSON.stringify(undefined) returns the value undefined, not a string
  // (e.g. a key explicitly set to undefined) - String() coalesces it to the
  // literal text "undefined" instead of crashing on .length below.
  const value = typeof input[key] === 'string' ? input[key] : String(JSON.stringify(input[key]));
  const truncated = value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return `${key}: ${JSON.stringify(truncated)}`;
}

function renderUser(container, message, onRewindClick, hasFileCheckpointing, rewindLabel, timestampMs = null, toolOpts = {}) {
  const content = message.message && message.message.content;
  if (message.isSynthetic) return; // priming sentinel, not a real turn

  if (typeof content === 'string') {
    // Always our own local echo (session.js: the CLI never streams the
    // prompt back) - turnIndex is minted synchronously at send time, so
    // the rewind button can attach immediately, no waiting on anything.
    closeGroup(container); // a real message from you ends whatever tool run preceded it
    // A resumed session never has file snapshots for its earlier turns -
    // enableFileCheckpointing can't apply retroactively - so the button is
    // labeled honestly rather than offering a revert that server-side just
    // no-ops. Grok has no Claude-style file rewind, so its caller passes
    // rewindLabel ("fork back to here") instead of this Claude default.
    const label = rewindLabel
      || (hasFileCheckpointing ? '⟲ rewind here' : '⟲ rewind here (conversation only)');
    const actions = onRewindClick && message.turnIndex
      ? [{ label, title: 'Fork a new session starting from this message', onClick: () => onRewindClick(message.turnIndex) }]
      : [];
    const delegated = delegateView.delegatedLabelAndText(content);
    const isDelegatedReply = Boolean(delegated && delegated.kind === 'reply');
    const cls = isDelegatedReply ? 'assistant delegated-reply' : 'user';
    const wrap = appendBlock(container, cls, delegated ? delegated.label : 'You', delegated ? delegated.text : content, actions, container, null, null, timestampMs, isDelegatedReply);
    if (isDelegatedReply) delegateView.registerDelegatedReplyBubble(container, message.queueId, wrap);
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
          // No matching tool_use here (see appendOrphanResultRow). Retain
          // the result text/error, not just a placeholder, so a later
          // "Load earlier history" merge can retroactively complete this
          // record instead of leaving a permanently-pending orphan.
          const parent = getOrOpenGroup(container).inner;
          const orphanRow = appendOrphanResultRow(container, block, parent);
          recordOrphanResult(container, block.tool_use_id, { resultText, isError, resultAtMs, rowEl: orphanRow });
        }
        toolOpts.onToolResultArrived?.(container, block.tool_use_id);
      } else if (block.type === 'text') {
        closeGroup(container);
        const delegated = delegateView.delegatedLabelAndText(block.text);
        const isDelegatedReply = Boolean(delegated && delegated.kind === 'reply');
        const cls = isDelegatedReply ? 'assistant delegated-reply' : 'user';
        const wrap = appendBlock(container, cls, delegated ? delegated.label : 'You', delegated ? delegated.text : block.text, [], container, null, null, timestampMs, isDelegatedReply);
        if (isDelegatedReply) delegateView.registerDelegatedReplyBubble(container, message.queueId, wrap);
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
    // dataset.keepOpen means a chart-bar click just expanded this group to
    // show the caller something - skip the auto-fold while it's set, or a
    // tool call landing a beat later would yank the group shut mid-click
    // (and could leave positionHighlights measuring a zero-height node).
    if (previous && previous.expanded && !previous.wrap.dataset.keepOpen) setGroupExpanded(previous, false);
  }

  const wasAtBottom = isScrolledToBottom(container);

  const wrap = document.createElement('div');
  wrap.className = 'msg group collapsible';
  wrap.setAttribute('aria-expanded', 'true');
  const roleRow = document.createElement('div');
  roleRow.className = 'role';
  const roleText = document.createElement('span');
  roleText.className = 'role-text';
  const usageMetaText = document.createElement('span');
  // group-usage-meta carries the margin-left: auto that pins the trailing
  // cost/tokens + fired-at cluster to the row's right edge as one unit;
  // .group-time has no margin of its own so it just sits adjacent instead
  // of both fighting over the same auto-margin space.
  usageMetaText.className = 'usage-meta group-usage-meta';
  const timeText = document.createElement('span');
  timeText.className = 'group-time';
  roleRow.append(roleText, usageMetaText, timeText);
  const inner = document.createElement('div');
  inner.className = 'group-body';
  wrap.append(roleRow, inner);
  container.append(wrap);
  if (wasAtBottom) container.scrollTop = container.scrollHeight;

  // Sums every tool call's usage into one figure, visible collapsed or
  // expanded, so "what did this run cost" needs no opening. Deduped by
  // object identity (countedUsageInfos): one assistant message can emit
  // several tool_use blocks sharing a single usage figure, and counting it
  // per block would inflate the sum by however many calls it made.
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

// Opens (or reuses) the container's current group and returns the DOM node
// its row should render into instead of the top-level container. firedAtMs
// only takes effect for a *new* group - joining an already-open one never
// overwrites its start time.
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
  // Its own span, not appended into roleText - sits dim/small/right-aligned
  // regardless of roleText's own hover/expanded state or how long the
  // tool-name list runs. Always shown, expanded or not.
  group.timeText.textContent = group.firedAtMs != null ? formatClock(group.firedAtMs) : '';
}

function setGroupExpanded(group, expanded) {
  group.expanded = expanded;
  group.wrap.classList.toggle('expanded', expanded);
  group.wrap.setAttribute('aria-expanded', expanded ? 'true' : 'false');
  renderGroupSummary(group);
}

// { lines } (diff output) -> one colored div per line, reusing
// diff-view.js's classes. `hint` is unused today but kept since renderBody
// is also reused as a generic content renderer elsewhere. Above this many
// changed rows a diff renders collapsed behind a toggle instead of pushing
// the rest of the transcript off screen.
const DIFF_COLLAPSE_THRESHOLD = 40;

export function renderBody(body, content, hint = null, markdown = false) {
  if (content && typeof content === 'object' && Array.isArray(content.lines)) {
    body.className = 'body';
    body.textContent = '';
    renderDiffLines(body, content.lines, content.lang);
    return;
  }
  if (content && typeof content === 'object' && typeof content.code === 'string') {
    body.className = 'body';
    body.textContent = '';
    renderCodeBlock(body, content.header, content.code, content.lang);
    return;
  }
  // Markdown path ignores `hint` - nothing calls this with both today, and
  // mixing the two would need the markdown fragment squeezed into
  // .body-content's flex row instead of owning the whole body element.
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

// Rows with a `lineNo` get a gutter + marker + text layout so CSS can tint
// the row; rows without one (header, `@@ edit N @@`, summary) render as
// plain divs. `lang` highlights each row independently, which can
// occasionally mis-highlight at a fragment's edge - an accepted tradeoff.
function renderDiffLines(body, lines, lang) {
  const diffLineCount = lines.filter((l) => l.lineNo != null).length;
  if (diffLineCount <= DIFF_COLLAPSE_THRESHOLD) {
    for (const line of lines) body.append(renderDiffRow(line, lang));
    return;
  }

  const collapsedLabel = `▸ Show full diff (${diffLineCount} lines)`;
  const toggle = document.createElement('div');
  toggle.className = 'diff-collapse-toggle';
  toggle.textContent = collapsedLabel;
  toggle.setAttribute('role', 'button');
  toggle.tabIndex = 0;

  const diffWrap = document.createElement('div');
  diffWrap.hidden = true;
  for (const line of lines) diffWrap.append(renderDiffRow(line, lang));

  let expanded = false;
  const toggleExpanded = () => {
    expanded = !expanded;
    diffWrap.hidden = !expanded;
    toggle.textContent = expanded ? '▾ Hide full diff' : collapsedLabel;
  };
  toggle.addEventListener('click', toggleExpanded);
  toggle.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    toggleExpanded();
  });

  body.append(toggle, diffWrap);
}

function renderDiffRow(line, lang) {
  const div = document.createElement('div');
  if (line.lineNo == null) {
    div.textContent = line.text;
    if (line.cls) div.className = line.cls;
    return div;
  }
  div.className = `diff-row ${line.cls}`;
  const gutter = document.createElement('span');
  gutter.className = 'diff-gutter';
  gutter.textContent = String(line.lineNo);
  const marker = document.createElement('span');
  marker.className = 'diff-marker';
  marker.textContent = line.cls === 'diff-add' ? '+' : line.cls === 'diff-del' ? '-' : ' ';
  const text = document.createElement('span');
  text.className = 'diff-text';
  const highlighted = highlightSource(line.text, lang);
  // Safe: highlightSource only ever returns Prism.highlight()'s output,
  // which HTML-escapes the source before tokenizing (see its own comment).
  if (highlighted != null) text.innerHTML = highlighted;
  else text.textContent = line.text;
  div.append(gutter, marker, text);
  return div;
}

// Write's full file content / Bash's command text - highlighted as one
// block rather than per-line, since (unlike Edit's fragments) this is
// always the whole string, so full-context tokenization is exact, no
// line-boundary caveat. `header`, when given, is the file_path/description
// shown as a dim line above the code.
function renderCodeBlock(body, header, code, lang) {
  if (header) {
    const h = document.createElement('div');
    h.className = 'diff-meta';
    h.textContent = header;
    body.append(h);
  }
  const pre = document.createElement('div');
  pre.className = 'code-block';
  const highlighted = highlightSource(code, lang);
  // Safe: see the same note on renderDiffRow's innerHTML above.
  if (highlighted != null) pre.innerHTML = highlighted;
  else pre.textContent = code;
  body.append(pre);
}

// `parent` is the DOM node the block is inserted into - defaults to
// `container`, but a grouped tool call/result passes a group's inner node
// instead. `container` always stays the scroll-position/registry reference
// regardless of where the block physically lands.

// If the last block in `container` is already the same kind of streamed
// assistant/thinking card, append `text` onto it and return true. Used
// while Grok is still mid-thought / mid-reply so we don't stack a new
// .msg per token.
function appendToLastStreamBlock(container, cls, text, markdown) {
  const last = container.lastElementChild;
  // A delegated-reply bubble carries both 'assistant' and 'delegated-reply'
  // (see the isDelegatedReply branches above) - excluded here so a genuine
  // assistant block streamed right after one doesn't get merged into it.
  if (!last || !last.classList.contains('msg') || !last.classList.contains(cls) || last.classList.contains('delegated-reply')) return false;
  const body = last.querySelector('.body');
  if (!body) return false;
  const wasAtBottom = isScrolledToBottom(container);
  if (markdown) {
    const prev = Object.prototype.hasOwnProperty.call(body.dataset, 'rawText')
      ? body.dataset.rawText
      : (body.textContent ?? '');
    if (!fenceTrackerByBody.has(body)) fenceTrackerByBody.set(body, createFenceTracker());
    const next = joinStreamText(prev, text, fenceTrackerByBody.get(body));
    body.dataset.rawText = next;
    renderBody(body, next, null, true);
  } else {
    if (!fenceTrackerByBody.has(body)) fenceTrackerByBody.set(body, createFenceTracker());
    body.textContent = joinStreamText(body.textContent ?? '', text, fenceTrackerByBody.get(body));
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
    btn.type = 'button';
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
