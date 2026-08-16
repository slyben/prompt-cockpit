// Renders the SDK message stream: assistant text, tool calls, tool
// results, thinking blocks. Whole-message rendering (no token-level
// partials - see plan MVP1 scope). Modeled on the terminal, not a web
// chat: tool calls/results and thinking are collapsed to a one-line
// summary by default, same as the CLI's own transcript. Ctrl+O reveals
// everything currently collapsed - one-way, like the real CLI (confirmed
// against the actual terminal: pressing it again does not re-fold).
// Clicking a block individually still toggles just that one, both ways -
// mouse-driven fine control, not a claim about terminal parity.
// Hook/thinking-token/rate-limit chatter and repeat init messages are
// dropped entirely rather than dumped as raw JSON. Per-tool approval
// (accept-this-once / no) is a banner driven by cockpit:approval-request,
// handled in app.js - not part of this module.
//
// Consecutive tool call/result pairs are folded into one "group" block (e.g.
// "3 tool calls: Bash → Read → Edit") rather than each pair getting its own
// row - that's what actually made a multi-tool turn noisy, more than any
// single block's verbosity. A group stays open across tool calls and their
// results and closes the moment real Claude text or a thinking block
// appears, or the turn ends - see closeGroup call sites. Groups render
// expanded as they accumulate; by default (settings-panel toggle,
// autoCollapsePreviousGroup below) the previous group auto-folds the moment
// the next one opens, so only the run currently in flight stays open. The
// header's Collapse all button (or Ctrl+O to expand) still works on top of
// that for whatever's still expanded. The individual tool calls/results
// inside a group stay independently collapsed to one-liners regardless
// (click each, or Ctrl+O).

const seenInitByContainer = new WeakMap();
const collapsibleBlocksByContainer = new WeakMap();
const groupsByContainer = new WeakMap(); // container -> group[], for Ctrl+O
const openGroupByContainer = new WeakMap(); // container -> the currently-accumulating group, if any

// Settings-panel toggle (default on - see settings.js). When true, the
// moment a new top-level tool-call group opens, the immediately preceding
// one auto-folds to its one-line summary instead of sitting there expanded
// forever - a long turn's tool history reads like a list of past runs, not
// a wall of them all still open. Off just restores the old always-expanded
// behavior; either way a click (or Ctrl+O) still re-expands any of them.
let autoCollapsePreviousGroup = true;
export function setAutoCollapsePreviousGroup(enabled) {
  autoCollapsePreviousGroup = enabled;
}

const SILENT_SYSTEM_SUBTYPES = new Set([
  'hook_started',
  'hook_response',
  'thinking_tokens',
]);

// Collapsed preview is capped at one literal line - no embedded line feed -
// so a collapsed tool result/thinking block is always exactly 2 lines on
// screen: the first line, then the "... +N more lines" hint.
const COLLAPSE_LINES = 1;
const COLLAPSE_CHARS = 240;

// Monotonic creation order across both collapsible blocks and groups
// (they're two separate lists/types - see collapsibleBlocksByContainer /
// groupsByContainer - so a plain array index can't compare "which is
// newer" across the two). Stamped once per item at creation, read by
// updateCollapsedHints to find the single most-recently-collapsed one.
let nextHintSeq = 0;

// Call once per fresh session view (app.js does this on connect(), right
// after clearing the container) so stale block references from a previous
// session don't linger.
export function resetStreamView(container) {
  collapsibleBlocksByContainer.set(container, []);
  groupsByContainer.set(container, []);
  openGroupByContainer.delete(container);
  seenInitByContainer.delete(container);
}

// Bound to Ctrl+O in app.js. Expands every currently-collapsed block and
// group. One-way: blocks/groups already expanded (globally or by an
// individual click) are left alone, and this has no effect on blocks
// rendered afterward.
export function expandAllCollapsed(container) {
  for (const block of collapsibleBlocksByContainer.get(container) || []) {
    if (!block.expanded) setBlockExpanded(block, true);
  }
  for (const group of groupsByContainer.get(container) || []) {
    if (!group.expanded) setGroupExpanded(group, true);
  }
}

// Bound to the "Collapse all" button in app.js. The inverse of
// expandAllCollapsed above - folds every currently-expanded block and group
// back down, both those opened by Ctrl+O and those toggled individually by
// click. Unlike Ctrl+O this is two-way in practice: expand and collapse can
// be pressed repeatedly in either order with no dead state.
export function collapseAllExpanded(container) {
  for (const block of collapsibleBlocksByContainer.get(container) || []) {
    if (block.expanded) setBlockExpanded(block, false);
  }
  for (const group of groupsByContainer.get(container) || []) {
    if (group.expanded) setGroupExpanded(group, false);
  }
}

// Renders `messages` (oldest-first) into a detached fragment, then inserts
// them all at once above whatever's already in `container` - used for the
// "Load earlier history" button (app.js) so a resumed session's older
// turns land above its initial tail in one DOM operation, in the right
// order. Historical entries have no `turnIndex` (that's minted only for
// this session's own live pushInput calls - see session.js), so their
// rewind buttons don't appear; a real limitation, not an oversight.
export function prependHistory(container, messages, options = {}) {
  if (!collapsibleBlocksByContainer.has(container)) resetStreamView(container);

  const fragment = document.createDocumentFragment();
  for (const message of messages) {
    renderMessage(fragment, message, options);
  }

  // Collapsible blocks/groups built into the fragment registered themselves
  // under the fragment's own WeakMap entry (renderMessage's container param)
  // - merge them into the real container's list so Ctrl+O still reaches
  // them. The fragment's own dangling open group (if the history slice ends
  // mid-run) is discarded, not merged - it belongs to a different DOM
  // subtree and can never accept another tool call now that it's sealed.
  const fragmentBlocks = collapsibleBlocksByContainer.get(fragment) || [];
  const containerBlocks = collapsibleBlocksByContainer.get(container) || [];
  const fragmentGroups = groupsByContainer.get(fragment) || [];
  const containerGroups = groupsByContainer.get(container) || [];

  // Historical items got their updateCollapsedHints `seq` stamped while
  // rendering into `fragment`, which happens after the live container's own
  // entries already exist - so their seq would otherwise sort *after* the
  // live tail's, exactly backwards from where they land in the DOM (always
  // above it, never below). Shift the whole batch below the container's
  // current minimum seq, preserving order within the batch, so the live
  // tail still reads as "newest collapsed" once everything's merged. Each
  // item's `container` field also gets re-pointed at the real container -
  // it was stamped `fragment` during creation, and fragment is discarded
  // below, so anything still referencing it would look up an empty list.
  const fragItems = [...fragmentBlocks, ...fragmentGroups];
  const existing = [...containerBlocks, ...containerGroups];
  if (existing.length && fragItems.length) {
    const containerMin = Math.min(...existing.map((x) => x.seq));
    const fragMax = Math.max(...fragItems.map((x) => x.seq));
    if (fragMax >= containerMin) {
      const offset = fragMax - containerMin + 1;
      fragItems.forEach((x) => { x.seq -= offset; });
    }
  }
  fragItems.forEach((x) => { x.container = container; });

  collapsibleBlocksByContainer.set(container, [...fragmentBlocks, ...containerBlocks]);
  collapsibleBlocksByContainer.delete(fragment);

  groupsByContainer.set(container, [...fragmentGroups, ...containerGroups]);
  groupsByContainer.delete(fragment);
  openGroupByContainer.delete(fragment);

  container.prepend(fragment);
  updateCollapsedHints(container); // finalize hint ownership now that everything's merged in true document order
}

export function renderMessage(container, message, { onRewindClick, hasFileCheckpointing = true, turnIndexUnreliable = false, turnPointIndex = null, assistantLabel = 'Claude', rewindLabel } = {}) {
  if (!collapsibleBlocksByContainer.has(container)) resetStreamView(container);

  switch (message.type) {
    case 'system':
      return renderSystem(container, message);
    case 'assistant':
      return renderAssistant(container, message, turnPointIndex, assistantLabel);
    case 'user':
      return renderUser(container, message, turnIndexUnreliable ? null : onRewindClick, hasFileCheckpointing, rewindLabel);
    case 'result':
      return renderResult(container, message);
    case 'rate_limit_event':
      return; // noise - not actionable per-turn
    default:
      return; // large open-ended SDKMessage union; unhandled types stay silent
  }
}

function renderSystem(container, message) {
  if (SILENT_SYSTEM_SUBTYPES.has(message.subtype)) return;

  if (message.subtype === 'init') {
    if (seenInitByContainer.get(container)) return; // priming sentinel causes a harmless second init
    seenInitByContainer.set(container, true);
    closeGroup(container);
    appendBlock(container, 'system', 'Session', `model: ${message.model}  ·  cwd: ${message.cwd}  ·  mode: ${message.permissionMode}`);
    return;
  }

  if (message.subtype === 'permission_denied') {
    closeGroup(container); // a denial interrupts whatever tool run was in progress
    appendBlock(container, 'error', `${message.tool_name} Denied`, message.decision_reason || message.message || 'permission denied');
    return;
  }
  // other system subtypes: silent by default, see module comment
}

function renderAssistant(container, message, turnPointIndex = null, assistantLabel = 'Claude') {
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
      const wrap = appendBlock(container, 'assistant', assistantLabel, block.text, [], {}, container, null, usage); // the actual reply - never collapsed
      // Text-only turns (no tool_use blocks) otherwise never get tagged, so
      // clicking their bar in turn-chart.js just clears whatever highlight
      // was showing and does nothing (B7) - tag this one too. It's not
      // collapsible, so turn-chart's selectIndex just scrolls/highlights it
      // rather than trying to expand it.
      if (turnPointIndex != null) wrap.dataset.turnPoint = String(turnPointIndex);
    } else if (block.type === 'thinking') {
      closeGroup(container); // keeps DOM order honest: thinking always precedes the calls that follow it
      if (!block.thinking || !block.thinking.trim()) continue; // signature-only/empty thinking blocks - nothing to show
      appendCollapsibleBlock(container, 'thinking', 'Thinking', block.thinking, null, container, usage);
    } else if (block.type === 'tool_use') {
      const parent = addToolCallToGroup(container, block.name, message._usageInfo);
      const wrap = appendCollapsibleBlock(
        container, 'tool', `Tool: ${block.name}`,
        formatToolInput(block.name, block.input),
        summarizeToolInput(block.name, block.input),
        parent, usage,
      );
      wrap.dataset.toolKind = classifyTool(block.name);
      // Ties this block back to its bar in turn-chart.js's per-turn graph
      // (same index the point gets there - see app.js's nextPointIndex()
      // call) so hovering the bar can find and highlight it.
      if (turnPointIndex != null) wrap.dataset.turnPoint = String(turnPointIndex);
    }
  }
}

// "$0.0X, N in, M out" - dim/small (index.html's .usage-meta), on the same
// role row as the label. 4-decimal USD below a cent, mirrors stats-panel.js's
// fmtUSD so a tiny per-call cost doesn't just round to "$0.00" and look
// like it was free. Returns null (nothing rendered) when there's no figure
// to show - an unpriced model, or a message this repo never attached one to
// (system/user/result messages, or an assistant message with none).
function formatUsageInline(info) {
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

// Terminal-style one-liner for the collapsed state, e.g. Write(file_path: "...").
function summarizeToolInput(name, input) {
  if (!input || typeof input !== 'object') return `${name}()`;
  const preferredKeys = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'];
  const key = preferredKeys.find((k) => k in input) || Object.keys(input)[0];
  if (!key) return `${name}()`;
  const value = typeof input[key] === 'string' ? input[key] : JSON.stringify(input[key]);
  const truncated = value.length > 80 ? `${value.slice(0, 80)}…` : value;
  return `${name}(${key}: ${JSON.stringify(truncated)})`;
}

function renderUser(container, message, onRewindClick, hasFileCheckpointing, rewindLabel) {
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
      ? [{ label, onClick: () => onRewindClick(message.turnIndex) }]
      : [];
    appendBlock(container, 'user', 'You', content, actions);
    return;
  }
  if (Array.isArray(content)) {
    for (const block of content) {
      if (block.type === 'tool_result') {
        // Reuses (or opens) the group its matching tool_use started - see
        // module comment. "Tool: Result" to match the "Tool: <Name>" label.
        const parent = getOrOpenGroup(container).inner;
        appendCollapsibleBlock(container, 'tool', 'Tool: Result', flattenToolResult(block.content), undefined, parent);
      } else if (block.type === 'text') {
        closeGroup(container);
        appendBlock(container, 'user', 'You', block.text);
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

function renderResult(container, message) {
  closeGroup(container); // the turn is over - nothing can extend the run anymore
  if (message.subtype === 'success') return; // state pill already shows idle/running
  appendBlock(container, 'error', 'Turn Error', message.error || 'unknown error');
}

// A run of consecutive tool call/result pairs, collapsed to one summary row
// ("3 tool calls: Bash → Read → Edit") instead of each pair getting its own
// top-level row. See module comment for when a group opens/closes.
function getOrOpenGroup(container) {
  return openGroupByContainer.get(container) || openGroup(container);
}

function openGroup(container) {
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
  usageMetaText.className = 'usage-meta';
  const hintText = document.createElement('span');
  hintText.className = 'expand-hint';
  roleRow.append(roleText, usageMetaText, hintText);
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
    wrap, inner, roleText, usageMetaText, hintText, toolNames: [], expanded: true,
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0 },
    countedUsageInfos: new Set(),
    container, seq: nextHintSeq++,
  };
  wrap.classList.add('expanded'); // groups open by default - it's the individual tool
  // calls/results inside that stay collapsed to one-liners (see appendCollapsibleBlock)
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
// in its summary, and returns the DOM node its collapsible block should
// render into (instead of the top-level container).
function addToolCallToGroup(container, name, usageInfo) {
  const group = getOrOpenGroup(container);
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
  // Its own span (index.html's .expand-hint), not appended into roleText - lets it
  // sit dim/small/right-aligned regardless of roleText's own hover/expanded
  // color changes, and regardless of how long the tool-name list runs.
  // Collapsed case is provisional - updateCollapsedHints (called by every
  // site that can change collapsed state) decides whether this group
  // actually gets to keep that text or goes blank because a newer collapsed
  // item took over. 'click to collapse' isn't deduped: normally only the
  // one currently-open group shows it, so there's nothing to repeat.
  group.hintText.textContent = group.expanded ? 'click to collapse' : 'ctrl+o to expand';
}

function setGroupExpanded(group, expanded) {
  group.expanded = expanded;
  if (!expanded) group.seq = nextHintSeq++; // see setBlockExpanded's matching comment
  group.wrap.classList.toggle('expanded', expanded);
  renderGroupSummary(group); // updates the "click to collapse" / "ctrl+o to expand" hint
  updateCollapsedHints(group.container);
}

// Only the single most-recently-collapsed block or group across the whole
// container gets to show "ctrl+o to expand" - a stream with several
// collapsed blocks used to repeat that exact caption once per block, which
// reads as noise once there are more than one or two. Every other collapsed
// item still collapses/expands exactly the same way, it just renders blank
// where the hint used to be. Recomputed from scratch (not tracked
// incrementally) on every create/expand/collapse, so toggling any one item
// correctly hands the hint off to whichever remains newest - `seq` is what
// lets blocks and groups (two separate lists) be compared for "newest" at all.
function updateCollapsedHints(container) {
  const allGroups = groupsByContainer.get(container) || [];
  // A block inside a currently-collapsed group is invisible (the group's
  // own .group-body is display:none) even if the block's own `expanded` is
  // false - collapseAllExpanded (the "Collapse all" button) walks every
  // block regardless of visibility and re-collapses whichever were
  // individually expanded before, which re-stamps that block's seq
  // (setBlockExpanded) possibly *above* the actual visible winner. Without
  // this check an invisible nested block could win the hint slot, leaving
  // the real visible collapsed group with nothing.
  const isVisible = (block) => !allGroups.some((g) => !g.expanded && g.inner.contains(block.wrap));
  const blocks = (collapsibleBlocksByContainer.get(container) || []).filter((b) => !b.expanded && isVisible(b));
  const groups = allGroups.filter((g) => !g.expanded);
  let winner = null;
  for (const item of [...blocks, ...groups]) {
    if (!winner || item.seq > winner.seq) winner = item;
  }
  blocks.forEach((b) => renderBody(b.body, b.summary, b === winner ? b.hint : null));
  groups.forEach((g) => { g.hintText.textContent = g === winner ? 'ctrl+o to expand' : ''; });
}

// Renders collapsed to a short summary by default (terminal behavior);
// clicking the block, or Ctrl+O globally, expands it to the full text.
// `parent` is the DOM node to append into - the container itself normally,
// or a group's inner node when this call is part of a tool run (see above).
function appendCollapsibleBlock(container, cls, roleLabel, fullText, summaryOverride, parent = container, meta = null) {
  const { summary, hint, truncated } = summarize(fullText, summaryOverride);
  const wrap = appendBlock(container, cls, roleLabel, summary, [], { collapsible: truncated }, parent, hint, meta);

  if (truncated) {
    const block = { wrap, body: wrap.querySelector('.body'), fullText, summary, hint, expanded: false, container, seq: nextHintSeq++ };
    wrap.dataset.collapsible = 'true';
    wrap.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also toggle an enclosing group
      setBlockExpanded(block, !block.expanded);
    });

    const list = collapsibleBlocksByContainer.get(container) || [];
    list.push(block);
    collapsibleBlocksByContainer.set(container, list);
  }
  // Unconditional, not just on the truncated path above: this call is
  // cheap (a recompute over already-small lists) and removing the early
  // return means a non-collapsible block landing here can never leave a
  // stale hint owner in place, whatever state it interrupted.
  updateCollapsedHints(container);
  return wrap;
}

// `text` is either a plain string or { lines: [{ text, cls }] } - the latter
// from formatToolInput's diff output (see there). summaryOverride is always
// a plain string (the terminal-style one-liner), never the diff shape.
// `hint` is returned separately from `summary` now (not appended into the
// same string) so the caller can render it as its own dim/small/right-
// aligned span (index.html's .expand-hint) instead of plain trailing text.
function summarize(text, summaryOverride) {
  if (summaryOverride) return { summary: summaryOverride, hint: 'ctrl+o to expand', truncated: true };

  const source = text ?? '';
  const lines = source.split('\n');
  const fitsCollapsed = lines.length <= COLLAPSE_LINES && source.length <= COLLAPSE_CHARS;
  if (fitsCollapsed) return { summary: source, hint: null, truncated: false };

  const extraLines = Math.max(0, lines.length - COLLAPSE_LINES);
  const clipped = lines.slice(0, COLLAPSE_LINES).join('\n').slice(0, COLLAPSE_CHARS);
  const hint = extraLines > 0 ? `+${extraLines} more lines - ctrl+o to expand` : 'ctrl+o to expand';
  return { summary: clipped, hint, truncated: true };
}

function setBlockExpanded(block, expanded) {
  block.expanded = expanded;
  // Re-stamp on manual re-collapse (not just at creation) so clicking an old
  // block shut again correctly reclaims the hint from whatever's currently
  // showing it - "most recently collapsed", not just "most recently created".
  if (!expanded) block.seq = nextHintSeq++;
  renderBody(block.body, expanded ? block.fullText : block.summary, expanded ? null : block.hint);
  block.wrap.classList.toggle('expanded', expanded);
  updateCollapsedHints(block.container);
}

// Plain string -> textContent, same as before. { lines } (diff output from
// formatToolInput) -> one colored div per line, reusing the diff-view.js
// classes (diff-add/diff-del/diff-hunk/diff-meta/diff-ctx) so an expanded
// Edit/MultiEdit reads like the terminal's own diff instead of raw JSON.
// `hint`, when given, renders as a trailing .expand-hint span in the same flex row
// as the content (index.html's `.body.with-hint`) - collapsed content is
// always capped to one line (COLLAPSE_LINES), so it never has to compete
// with wrapped content for that row.
function renderBody(body, content, hint = null) {
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
function appendBlock(container, cls, roleLabel, text, actions = [], { collapsible = false } = {}, parent = container, hint = null, meta = null) {
  const wasAtBottom = isScrolledToBottom(container);

  const wrap = document.createElement('div');
  wrap.className = `msg ${cls}${collapsible ? ' collapsible' : ''}`;

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
  for (const action of actions) {
    const btn = document.createElement('button');
    btn.className = 'msg-action';
    btn.textContent = action.label;
    btn.addEventListener('click', (e) => {
      e.stopPropagation(); // don't also trigger the block's own collapse toggle
      action.onClick();
    });
    roleRow.append(btn);
  }

  const body = document.createElement('div');
  body.className = 'body';
  renderBody(body, text, hint);

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
