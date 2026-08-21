# Tests

`npm test` runs the unit suite (`session-registry.test.mjs`, `session-launcher.test.mjs`,
`server-auth.test.mjs`, `permissions.test.mjs`, `sdk-adapter.test.mjs`,
`session-history.test.mjs`, `session.test.mjs`, `event-log.test.mjs`, `usage.test.mjs`,
`context-usage.test.mjs`) via
Node's built-in test runner. Fast, free, no network calls, no Claude CLI
spawned - the registry tests inject a stubbed `startSessionImpl`, and
`session.test.mjs` injects a stubbed `queryImpl` (same pattern, one level
deeper - `startSession` now takes it the same way `createSession` takes
`startSessionImpl`) instead of the real SDK-backed ones.

## MVP4 - live stats panel

`usage.test.mjs` covers `src/usage.js` directly: `costForUsage` against the
copied `src/pricing.json` (input/output/cache-read/cache-write, the legacy
`cache_creation_input_tokens` field, an unpriced model returning `null`
rather than guessing), and `createUsageAccumulator`'s running totals and
cache hit rate. `session-registry.test.mjs` covers the wiring one layer up:
an assistant message with `usage` broadcasts `cockpit:usage` with updated
totals, a fresh `attachClient` gets a zeroed snapshot immediately (not a
blank panel until the first message), and an unpriced model's tokens still
accumulate but get flagged in `usage.unpriced` instead of costing silently
at $0.

**Not covered by unit tests, hand-verified only:** `refreshContextUsage`'s
`getContextUsage()` round trip (same tradeoff as `rewind()`/
`loadEarlierHistory()` - it calls the SDK's `Query` handle directly, not
through an injectable stub) and everything client-side in
`public/stats-panel.js`/`public/history-pane.js` (real websocket messages,
DOM rendering). Verified by hand per the plan's MVP4 Verification section:
cost/tokens/context percentage track a live turn and the header strip
updates as it runs; two sessions open at once each show their own numbers;
`/api/history/:sessionId` renders a past (non-resumed) session read-only
via the resume list's "View" button, with no rewind affordance since
there's no live registry row backing it.

## Auto-compact status precision

`context-usage.test.mjs` covers the pure transform in `src/context-usage.js`
directly: `normalizeAutoCompactThreshold`'s three unit interpretations
(fraction, percent, absolute token count via `maxTokens`), its
plausibility-band rejection (both an out-of-band percent and an
out-of-band token/maxTokens conversion), the one-time-warn latch, and
`contextPayload`'s `source: 'sdk' | 'fallback'` branching. The round trip
one layer up (`refreshContextUsage` calling the real SDK `getContextUsage()`,
and `usagePayload` forwarding its result) is still hand-verified only, per
the MVP4 note above - only the transform itself is unit-covered. Verified
by hand: `compactBtn`'s red state and tooltip, and `stats-panel.js`'s
context bar color, both track `context.autoCompact.warnPercent` instead of
the old independently-hardcoded 80/20/50 constants.

## Message timestamps toggle

Entirely client-side (`public/settings.js`, `public/stream-view.js`,
`public/app.js`, `public/history-pane.js`) - hand-verified only, per the
"hand-verified only" convention above. Checked: the Settings checkbox
retroactively stamps/unstamps every message already on screen (a CSS class
toggle, not a re-render); a resumed live Claude session shows real
per-message clock times with the full date in the tooltip; a live Grok
session (no `timestamp` field on its messages) shows receive-time instead;
a past session opened via the resume list's "View" button shows real times
when the transcript has them and none when it doesn't (no fabricated "now"
on old messages); the setting persists across a reload.

## Copy-last-reply / export-session

`transcript-markdown.test.mjs` covers `src/transcript-markdown.js`'s
`messagesToMarkdown` directly: every message type (user text, assistant
text/thinking/tool_use, tool_result, a result error, an unknown type),
heading structure, the truncation marker, and fence-widening when content
already contains a run of backticks. `server-auth.test.mjs` covers the
`/api/history/:sessionId/markdown` route's content-type and
content-disposition headers and its graceful-empty behavior on an unknown
session id (same as the underlying SDK read - it doesn't throw, so neither
does this route).

**Not covered by unit tests, hand-verified only:** `#copyLastBtn`/
`#exportBtn` (`public/app.js`) and the history pane's export link
(`public/history-pane.js`). Verified via Playwright against this session's
own real transcript: the export link's href carries the right session
id/cwd/provider and downloading it returns real transcript content with
the correct headers; copy-last-reply reads the *last* `.msg.assistant
.body` node specifically (not the first) and writes its exact text to the
clipboard. Copy reads `dataset.rawText` when the body was markdown-rendered
(so block structure is not smashed by `textContent`), falling back to
`textContent` for non-markdown bodies.

## Markdown rendering (assistant replies)

`markdown.test.mjs` covers `public/markdown.js`'s `renderMarkdown` directly,
via a hand-rolled DOM stub (`tests/helpers/dom-stub.mjs` - this project
ships no jsdom dependency, so the stub implements just the handful of DOM
primitives markdown.js actually touches: createElement/createTextNode/
createDocumentFragment, textContent, append, classList.add, dataset,
style.textAlign). Covered: paragraphs and paragraph breaks, bold/italic/
inline-code (including nesting, e.g. bold containing code, and `***` as
bold+italic), links (target/rel set, GFM title stripped from href), image
markup as a labeled link (never `<img>`, no leftover `!`), fenced code
blocks (verbatim, no inline parsing inside, language in `data-lang`,
including tags like `c++` that are not just word chars, plus `~~~` tilde
fences that do not close a backtick fence), a fence opener with extra text
after the first token recovered as the first code line rather than a
language tag, ATX headings h1-h6, horizontal rules, blockquotes, flat
unordered/ordered lists, nested sub-lists under both list types, GFM
task-list checkboxes (checked and unchecked), GFM strikethrough, backslash-
escaped markers, word-boundary-only underscore italic/bold (so
`file_name_here` stays literal), GFM pipe tables (column alignment, escaped-pipe cells, and
that a bare pipe-containing line without a delimiter row stays a plain
paragraph instead of misfiring as a table), and the safety property the
module's own top comment calls out - text is built via textContent, never
innerHTML, so literal `<img onerror=...>`-shaped text renders as escaped
text, not markup, both in prose and inside inline code spans.

**Not covered by unit tests, hand-verified only:** the actual browser
integration in `stream-view.js` (that assistant text blocks and delegated
`/ask` replies get run through `renderMarkdown` and mounted under
`.markdown-body`; tool args/results/thinking/plain user messages do not)
and the CSS in `style.css` (`.markdown-body p`'s `white-space: pre-wrap`,
which is what makes multi-line paragraphs break visually - the renderer
itself just joins lines with `\n` and relies on that CSS, so a
soft-break-vs-hard-break distinction was deliberately not implemented; see
git history for the reasoning). Verified by hand: real streamed replies with tables, checklists,
and nested bullets render correctly in the app itself. `joinStreamText`
is a single shared module (`src/stream-join.js`, re-exported from
`grok-messages.js`, imported by `stream-view.js` as `/stream-join.js`);
`grok-messages.test.mjs` covers it, then re-rendered here. Also
covers a fenced directory listing streamed one row per chunk - those rows
are not markdown structure, so they used to flatten into one `<pre>` line.

## Persistent session title

`session-titles.test.mjs` covers `src/session-titles.js` directly:
`setSessionTitle`/`getSessionTitle` round-trip (with trimming and a
120-char cap), an empty/whitespace title deleting the entry rather than
storing `""`, sibling `sessionDefaults`/`enabledPlugins` keys surviving a
title write, a concurrency case interleaving `setSessionTitle` with
`setSessionDefaults`/`setPluginEnabled` on the same cwd (same shape as
`session-defaults.test.mjs`'s own), and `attachTitles`'s join logic in
isolation (matching session, no titles for that cwd, `cwd: null`, unknown
session id within a cwd that has other titles). `server-auth.test.mjs`
covers both new routes: `POST /api/sessions/:id/title`'s 401 (parametrized
alongside the other newer routes), 409 when `claudeSessionId` isn't known
yet, and its happy path persisting to `settings.local.json`; and
`POST /api/session-title`'s 400 on an invalid cwd and its happy path for a
past session with no live registry row.

**Not covered by unit tests, hand-verified only:** the resume list's rename
button and the live-session rename prompt (`public/app.js`). Verified via
Playwright against this session's own real transcript: renaming from the
resume list updates the primary line immediately, survives a full page
reload (confirmed both in the DOM and by reading the resulting
`settings.local.json` directly), and the original transcript-derived label
survives as the row's tooltip rather than being discarded.

## Permission always-allow, wider scope

`permission-rules.test.mjs` covers `src/permission-rules.js` directly:
`formatRule`'s bare-vs-parenthesized shapes, `addAllowRule`/`readAllowRules`
round-trip, dedupe on exact string match, `removeAllowRule` (including the
no-op case for an unknown rule), `permissions.deny`/`ask` and
`sessionDefaults` surviving a write, and a concurrency case interleaving
`addAllowRule` with `setSessionDefaults` on the same cwd (same shape as
`session-defaults.test.mjs`/`session-titles.test.mjs`'s own). `session.test.mjs`
extends the existing `canUseTool`/`resolveApproval` coverage for both new
scope strings (`'session'` and `'project'` both auto-allow in-session
immediately; the legacy boolean `true` still coerces to `'session'`; a
deny never carries a scope even if `alwaysAllow` were set; an unknown
requestId returns `false`). `server-auth.test.mjs` covers the route layer:
401 on the two new `permissions` routes (parametrized alongside the other
newer routes for `approval-decision`, plus dedicated GET/DELETE 401
coverage since the shared parametrized list is POST-only), 400 on an
invalid `alwaysAllow` value, 404 on an unknown approval requestId, and that
`alwaysAllow: 'project'` persists a rule to `settings.local.json` while
`'session'` does not.

**Not covered by unit tests, hand-verified only (partially):** the approval
banner's `<select>` and the Settings modal's revoke list
(`public/app.js`/`index.html`) - Playwright confirmed both render with the
correct structure (the select's three options, the rules-list container).
The full live flow (choosing "always in this project" on a real approval,
seeing it land in the Settings list, revoking it) is not hand-verified
live - reaching a real approval prompt requires a live CLI session
mid-tool-call, which isn't a quick manual pass - but every step of that
flow's server-side logic (scope persistence, the list GET, the revoke
DELETE) is exercised by the integration tests above against the real
`server.js` route dispatch, just with a stubbed session in place of a live
CLI process.

Root cause (found by an investigation agent, confirmed against the running
process and the CLI's own tool definition): `AskUserQuestion` is an ordinary
`canUseTool` round trip whose answer rides back as `updatedInput.answers`,
keyed by the *exact* question text - it isn't special-cased by the SDK at
all. Two bugs compounded: `AUTO_ALLOW_MODES` (acceptEdits, bypassPermissions,
etc.) auto-allowed it like any other tool, passing `input` straight back
unmodified - which the tool reads as an empty `answers`, i.e. "the user did
not answer the questions" - and even in `default`/`plan` mode, the client's
approval banner rendered a generic allow/deny with no questions or options
visible, so a click still sent no `updatedInput`. Net effect: calls either
parked forever (nothing ever resolved them) or resolved to an empty answer.

`session.test.mjs` covers the fix at the `canUseTool` layer: `AskUserQuestion`
always reaches `onApprovalRequest` regardless of mode (a new test drives this
under `acceptEdits` specifically, the mode most likely to have silently
swallowed it), while every other tool's auto-allow behavior is unchanged
(also directly tested, so the fix couldn't accidentally widen into "nothing
auto-allows anymore"). **Not covered by unit tests, hand-verified only:**
`public/app.js`'s `renderQuestionForm` (the actual question/option UI,
single- vs multi-select toggling, the free-text "Other" fallback, and that
`answers` is built keyed by exact question text) - same client-side tradeoff
as the rest of this app. Verify by hand: trigger a real `AskUserQuestion`
call and confirm the form renders with real options, an answer round-trips
correctly, and Skip denies cleanly instead of parking.

## MVP3 - reconnect, tab chrome

`event-log.test.mjs` covers `src/event-log.js` directly: seq assignment,
replay-from-seq, the byte-cap eviction, and the gap case (`sinceSeq` older
than what the log still holds - the caller gets a full resend instead of a
replay with a hole in it). `session-registry.test.mjs` covers the same
thing one layer up: `attachClient(id, ws, sinceSeq)` sends only the delta
on a reconnect, and a fresh attach still gets everything. `server-auth.test.mjs`
covers the new `GET /api/sessions/:id` route's auth (used by the client to
check a remembered session is still live before rejoining it) and its 404
on an unknown id.

**Not covered by unit tests, hand-verified only:** everything client-side -
`public/app.js`'s actual websocket reconnect-with-backoff loop,
`localStorage`-based rejoin-on-reload (`cockpit:activeSession`), and
`public/tab-chrome.js`'s title/favicon/needs-attention behavior. These need
a real browser (jsdom doesn't cover WebSocket/localStorage/document.hidden
convincingly enough to be worth the harness). Manually verified per the
plan's MVP3 Verification section: closing and reopening a tab mid-turn
rejoins the same session with no gap or duplicate messages; a killed
connection auto-reconnects with backoff and catches up; two tabs on one
session both render and either can send; an unfocused tab whose turn
finishes shows the needs-attention favicon/title, cleared on refocus.

**Not covered by unit tests:** `registry.rewind()` and `registry.loadEarlierHistory()`
(both call SDK functions - `forkSession`, `getSessionMessages` - imported
directly rather than dependency-injected like `startSessionImpl` is), and
the live `canUseTool`/plan-mode wiring in `src/session.js` itself. Both
were verified by hand against a real session while building MVP2 - see the
session.js comment above `canUseTool` for what was confirmed live (default
mode auto-denies with no callback configured; `acceptEdits`/`bypassPermissions`
resolve without ever calling the callback; every gated tool call routes
through it now, not just `ExitPlanMode`). `countWithinTokenBudget` (the
pure logic behind the resume tail) and `createSession`'s seeding *are*
covered - only the actual `getSessionMessages` fetch inside
`loadEarlierHistory` isn't. Worth a scripted regression test if this area
gets touched again.

The turn-index math `resolveTurnUuid` depends on **is** covered even though
`resolveTurnUuid` itself isn't: `isRealUserTurn`/`countRealUserTurns`
(`session-history.test.mjs`) is the shared definition of "what counts as a
turn" that both it and `session.js`'s `turnCounter` seeding must agree on,
and `createSession`'s `turnIndexOffset` threading is asserted directly
(`session-registry.test.mjs`). That was the actual bug (turnCounter reset
to 0 on every resume, drifting out of sync with the full-transcript index)
- the untested part now is only the `getSessionMessages` fetch plumbing
around it, same as `loadEarlierHistory`.

Two residual edges on the turn-index fix, known and accepted rather than
silently unhandled: a resumed session whose history fetch fails (network
blip, wrong cwd) is caught and flagged `turnIndexUnreliable` - `rewind()`
refuses to run on it rather than mistargeting, covered in
`session-registry.test.mjs`. A `/clear` mid-session resets `turnCounter`
in `session.js` on the SDK's `conversation_reset` message - covered now in
`session.test.mjs` (added the `queryImpl` injection point specifically for
this). What that test does **not** verify - because it's a property of the
real SDK's transcript storage, not of this code - is whether
`resolveTurnUuid`'s `getSessionMessages` read is itself scoped to the
post-clear conversation or still spans pre-clear history too; see the
comment in `session.js` for what's actually unverified there. Worth a
manual check against a real session if rewind-after-`/clear` matters in
practice.

`integration.manual.mjs` is **not** part of `npm test`. It spawns a real
Haiku session through the actual Claude Agent SDK, so it costs a few cents
and takes ~10-20s. Run it by hand after touching `src/session.js`:

```
node tests/integration.manual.mjs
```

It's the regression test for the streaming-input priming-sentinel fix (see
the comment in `src/session.js`): without it, `system/init` never arrives
when `query()` is fed an `AsyncIterable` prompt, and the session hangs
forever. It also checks the compose box's most interesting failure mode
per the plan's Verification section - sending a second message while the
first turn is still running queues it rather than dropping or interleaving it.
