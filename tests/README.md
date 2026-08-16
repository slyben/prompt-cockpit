# Tests

`npm test` runs the unit suite (`session-registry.test.mjs`, `session-launcher.test.mjs`,
`server-auth.test.mjs`, `permissions.test.mjs`, `sdk-adapter.test.mjs`,
`session-history.test.mjs`, `session.test.mjs`, `event-log.test.mjs`, `usage.test.mjs`) via
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

## AskUserQuestion fix

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
