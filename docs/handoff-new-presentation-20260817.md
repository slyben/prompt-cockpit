# Handoff: tool-call presentation redesign ("new-presentation" branch)

Date: 2026-08-17
Repo: `/Users/bertrandcarre/Development/Code/Claude/prompt-cocpkit` (remote: `git@github.com:slyben/prompt-cockpit.git`)
Branch: `new-presentation` (pushed to origin, currently identical to `main` @ `6e59b4c` — no code or plan file written yet)

## Where things stand

Prior branch `feature/session-qol-controls-2` was squash-merged to `main` and pushed
(commit `6e59b4c`), then deleted. `docs/deepseek-harness-notes.md` and `docs/deepseek.jpg`
were folded into that same squash commit (DeepSeek harness scouting notes, reconnaissance
only, no action taken). `new-presentation` was branched from `main` after that merge and
pushed with zero commits — it's purely a placeholder waiting for this feature's implementation.

**No plan document exists yet.** The prior session got through exploration + requirement
clarification in Claude Code plan mode but was stopped before Phase 2 (design agent) /
Phase 4 (writing the actual plan file) ran. Nothing was written to
`~/.claude/plans/*.md` — that file never got created. This handoff is the only record of
where things landed.

## The ask

Reference image: `docs/deepseek.jpg` (already committed to `main`) — a screenshot of
DeepSeek Harness's "Trajectory" view. Left column: flat list of tool-call rows, each a
single fixed line (`TOOL  bash {"command":"..."}  →  <one-line result preview>`), no
click-to-expand. Right column: a permanent detail pane for whichever row is
selected/current, with tabs (Summary / Payload / Result / Schema / Timing in the
reference; see decisions below for what we're actually building).

User wants Prompt Cockpit's tool-call rendering redesigned to match this shape:
one fixed-height line per tool call (verb + brief args + as much inline info as fits:
cost, tokens in/out, duration), remove the current click-to-expand /
Ctrl+O-to-expand interaction entirely, and add a right-side docked detail pane that
shows full payload/result/timing for either the in-flight tool call or whichever
historical row the user clicks.

## Decisions locked in (via AskUserQuestion, this session)

1. **Grouping**: Keep the existing grouping concept (consecutive tool calls collapse
   into one visual run, e.g. Bash → Read → Edit) — do NOT flatten to one row per tool
   call everywhere. But restyle: each tool call *inside* a group gets its own fixed
   one-liner: no more per-item click-to-collapse within the group.
2. **Timing**: Add it. No per-tool duration is tracked anywhere in the codebase today
   (only per-assistant-message cost/tokens, stamped server-side). Add real
   instrumentation: timestamp when a tool_use row is rendered client-side, timestamp
   again when its matching tool_result arrives, diff them for a duration shown in the
   detail pane. This is client-observed wall time (includes network/render lag, not a
   true server-side tool-execution time) — be honest about that distinction in the UI/copy.
3. **Pane behavior**: Always docked when a session is active (mirrors the existing
   `#turnChartPanel` toggle-button pattern), with a header button to collapse it away.
   Not closed-by-default/slide-in.
4. **Schema tab**: Skip it for v1. No client-side registry of tool schemas/descriptions
   exists; not worth adding a static map right now.

## Key facts gathered from exploration (Explore agents, this session — not re-verified, re-check before relying on line numbers)

### `public/stream-view.js` (726 lines) — current renderer, DOM-only, no message array retained
- State lives in DOM + four module-level `WeakMap`s keyed on the container:
  `seenInitByContainer`, `collapsibleBlocksByContainer`, `groupsByContainer`, `openGroupByContainer`.
- Two collapsible entity types share one monotonic `seq` counter (`nextHintSeq`) to track
  "most recently collapsed" across both: **block** (one tool call/result/thinking) and
  **group** (a run of consecutive tool calls).
- Collapse/expand machinery to be ripped out or heavily reworked:
  `appendCollapsibleBlock`, `setBlockExpanded`, `openGroup`/`closeGroup`/`getOrOpenGroup`,
  `setGroupExpanded`, `renderGroupSummary`, `updateCollapsedHints`, `expandAllCollapsed`
  (bound to Ctrl+O in app.js), `collapseAllExpanded` ("Collapse all" header button).
- **Reusable pieces** (already decoupled from the collapse machinery, pure formatters):
  - `summarizeToolInput(name, input)` (~line 356) — generic one-liner: picks first key
    present from `['file_path','path','command','pattern','query','url','prompt']`,
    truncates value to 80 chars, formats `Write(file_path: "...")`. This is basically
    already the "verb + brief args" line the new design wants for the collapsed row.
  - `formatToolInput(name, input)` (~line 283) — per-tool **expanded** formatter:
    Edit/MultiEdit → real LCS line diff (`diffLines`, capped `MAX_DIFF_CELLS=200_000`),
    Write → `file_path\n` + content, Bash → `# description\n` + command, everything else →
    `key: value` per line. This is the natural payload for the detail pane's "Payload" tab.
  - `classifyTool(name)` → `[data-tool-kind]` (`edit`/`bash`/`read`/`search`/`other`) —
    existing color-coding, reusable in both the row and the pane header.
  - `formatUsageInline(info)` (~line 262) — `"$0.0X, N in, M out"` string formatter, pure.
  - `flattenToolResult(content)` — normalizes any `tool_result` content shape to a display string.
- **Usage/cost granularity limit**: `message._usageInfo` (stamped server-side in
  `src/session-registry.js`'s `applyAssistantUsage`, ~line 615, via `costForUsage` in
  `src/usage.js`) is **one object per assistant API call**, shared by every `tool_use`
  block that call emits — the SDK doesn't sub-divide cost/tokens per tool. Multiple tool
  calls in one turn will show identical $/token figures; this is a real API limitation,
  not a bug to fix.
- **No duration/timing field exists anywhere today** — confirmed via grep, zero hits for
  `duration`/`elapsedMs`/`durationMs` in `stream-view.js` or `session-registry.js`. Decision
  #2 above requires adding this from scratch (client-side).
- **`data-turn-point` coupling with `public/turn-chart.js`**: `app.js` calls
  `turnChart.nextPointIndex()` *before* calling `renderMessage`, so `stream-view.js` can
  tag the DOM node it's about to create with the index the chart's `addPoint()` will use
  right after. `turn-chart.js`'s `selectIndex(i)` does
  `scrollContainer.querySelectorAll('[data-turn-point="${i}"]')` to find/highlight that
  turn's DOM — chart → row only, no reverse direction today. **Any redesign must
  preserve this eager-index-mint-before-render sequencing** or the cost graph's
  click-to-jump breaks silently (this already happened once per an existing code comment
  about text-only turns not being tagged).
- **Exported functions** (everything else is module-private): `setAutoCollapsePreviousGroup`,
  `resetStreamView`, `expandAllCollapsed`, `collapseAllExpanded`, `prependHistory`,
  `renderMessage`, `isScrolledToBottom`.
- `history-pane.js`'s modal reuses this same renderer (`resetStreamView` + `renderMessage`
  per historical message) — the redesign should decide whether the new one-line+detail-pane
  UX applies there too (likely yes, for consistency) or whether history view stays as-is.

### `public/index.html` layout — no side-panel infrastructure exists
- `body { display:flex; flex-direction:column; height:100vh }` — strictly single-column,
  top to bottom: `header` → `#loadHistoryBar` → `#stream` (the only flex:1 growing region)
  → `#approvalBanner` → `#agentsBar` → `#taskPanel` → `#queuePanel` → `#turnChartPanel` →
  `#activityBar` → `#compose`. All "optional panels" are horizontal strips docked above
  `#compose`, toggled via plain `display` flips in JS closures + `settings.js` localStorage
  persistence (pattern to copy for the new pane's toggle button, per Decision #3 — see
  `#turnChartPanel`/`turn-chart.js`'s `setEnabled()` and `#turnChartToggleBtn`).
- **Zero `@media` queries anywhere in the stylesheet** — no responsive breakpoint
  convention exists at all. Adding a permanent right-docked pane requires: a new
  horizontal flex/grid wrapper around `#stream` (and likely the bars above `#compose`),
  plus a first narrow-viewport fallback, since nothing like that exists today.
- Nearest prior art for "list + detail" is NOT a docked pane — it's either
  `#fileSuggestions` (a floating two-column popup near the compose box, absolutely
  positioned) or the modal system (`#diffModal`, `#historyModal`, full-screen dim overlay,
  centered `.modal-box`). Neither is a layout-level dock; this will be a genuinely new
  layout pattern for the app.

### `public/app.js` — call site for the renderer
- Only calls the exported `stream-view.js` functions listed above, never the internal
  `appendBlock`/group functions.
- Per-message call site (~line 1503-1513):
  ```js
  const hasUsagePoint = payload.message.type === 'assistant' && payload.message._usageInfo;
  const turnPointIndex = hasUsagePoint ? turnChart.nextPointIndex() : null;
  renderMessage(streamEl, payload.message, { onRewindClick, hasFileCheckpointing, turnIndexUnreliable, turnPointIndex, assistantLabel: sessionProviderLabel(), rewindLabel: rewindButtonLabel(), receivedAtMs: Date.now() });
  if (hasUsagePoint) turnChart.addPoint(payload.message._usageInfo);
  ```
- `_usageInfo` shape: `{ costUsd, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cacheMiss }`.

## Suggested skills for the next session

- **`Plan` agent / `EnterPlanMode`** — this feature was deliberately routed through plan
  mode last time (multi-file, new layout pattern, architectural decision on the
  collapse-machinery rewrite). Re-enter plan mode before writing code; Phase 1
  (exploration) is already done — this doc supersedes re-running it. Go straight to
  Phase 2 (Plan agent for concrete design) using the facts above, then Phase 4 (write
  the actual plan file — this was never done last time) and `ExitPlanMode`.
- **`code-review`** (medium or high effort) — run after the implementation, before
  merging `new-presentation` back to `main`, given the scope (layout change, rip-out of
  an existing interaction pattern used app-wide, new client-side timing instrumentation).
- **`run`** — use to launch the app and visually verify the new one-line rows + detail
  pane against `docs/deepseek.jpg` before calling it done; this is a UI-shape feature,
  screenshots matter more than unit tests here.
- **`backlog`** — if any part of the reference screenshot's UX gets deliberately deferred
  (e.g. was already true for image-paste in an earlier round), log it there rather than
  letting it silently drop.

## Explicit non-goals / already-decided-against

- Do not flatten tool-call grouping to one-row-per-call everywhere (screenshot shows
  that, user rejected it — see Decision #1).
- Do not add a Schema tab (Decision #4).
- Do not make the detail pane closed-by-default/slide-in (Decision #3).
- Do not fabricate per-tool cost/token breakdowns beyond what the SDK actually provides
  (the shared-`_usageInfo`-per-API-call limitation above is real, not a gap to paper over).
