# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Prompt Cockpit: a local browser UI for driving a Claude Code, Grok, or Codex CLI session against a project folder. Plain Node.js server (no framework, no bundler) + vanilla JS frontend (no build step). It talks to the CLIs over their SDKs/protocols, not by wrapping a terminal. The server binds to `127.0.0.1` only and is not meant to be exposed to the network.

## Commands

```
npm install       # first time only
npm start          # runs src/server.js, http://localhost:4317 (PORT env overrides)
npm test           # node --test tests/*.test.mjs - fast, no network, no CLI spawned
node --test tests/session.test.mjs          # run a single test file
node tests/integration.manual.mjs           # NOT part of npm test - spawns a real Haiku session via the SDK, costs a few cents, ~10-20s. Run by hand after touching src/session.js.
```

Other `tests/*.manual.mjs` files (`grok-rewind-strings.manual.mjs`, `grok-rewind-probe.manual.mjs`, `grok-live.manual.mjs`, `thinking-default-probe.manual.mjs`) are similarly excluded from `npm test` and require a real CLI/session - run individually with `node tests/<file>`.

Read `tests/README.md` before touching test coverage - it documents, feature by feature, exactly what's unit-tested vs hand-verified-only and why (mostly: anything that touches the real SDK's non-injectable functions, like `getSessionMessages`/`forkSession`, or is pure client-side DOM/websocket behavior with no jsdom in this project).

## Architecture

**Three providers, one shape.** Claude (`src/session.js`, via `@anthropic-ai/claude-agent-sdk`'s `query()`), Grok (`src/grok-session.js`, via `grok agent stdio` / ACP), and Codex (`src/codex-session.js`, via `codex app-server`'s JSON-RPC, `src/codex-app-server.js`) are driven by structurally parallel modules and normalized into the same handle shape by `src/session-registry.js`, so the rest of the server and the entire frontend mostly don't care which provider a session uses. `src/provider-registry.js` is the descriptor boundary between that shared lifecycle and each provider's native transport/storage - adding a provider means adding one descriptor there (start/list/history/rewind functions, `capabilities`, `efforts`, static launch-time model/effort catalogs), not teaching every route or the client a new `if (provider === ...)` branch; no code outside that file and the provider's own module should ever compare against a provider id string. Provider-specific quirks live in `grok-*.js` files (`grok-acp.js` protocol plumbing, `grok-messages.js` message translation, `grok-rewind.js`, `grok-history.js`, `grok-extensions.js`, `grok-launcher.js`) and `codex-*.js` files (`codex-app-server.js` JSON-RPC client/process manager, `codex-messages.js`, `codex-history.js`), mirroring their Claude counterparts (`rewind.js`, `session-history.js`, `session-launcher.js`).

**`src/session-registry.js` is the live in-memory hub.** One row per running cockpit session, keyed by a cockpit-minted UUID (not the provider's own session id, which is mutable and refreshed as messages arrive). Rows are purely ephemeral - nothing here touches disk, and a row disappears when its session closes or the process restarts.

**`src/routes/*.js` hold the HTTP route handlers**, registered onto `src/router.js`'s hand-rolled dispatcher by `server.js` (`sessions.js` for session create/list, `session-actions.js` for the `/api/sessions/:id/:action` per-session dispatcher - mode, interrupt, model, thinking budget, MCP/plugin toggles, permissions, rewind, etc, `history.js` for read-only past-session/subagent-transcript routes, `system.js` for `/healthz` and memory introspection).

**Three separate settings stores, deliberately not unified** (see the boundary comment atop `session-registry.js`):
- In-memory registry rows (above) - live SDK-reported state (model, mode, thinking budget, usage).
- `public/settings.js` (browser `localStorage`) - per-browser UI prefs, never sent to the server.
- `session-defaults.js` + `plugin-settings.js` + `session-titles.js` + `permission-rules.js` + `git-commit-guard.js` (all under the target project's own `.claude/settings.local.json`) - per-project prefs that survive a restart and are shared across every tab/browser pointed at that cwd. `server.js` is what bridges live registry state into this store (see `seedSessionDefaults()` and the `thinking`/`auto-continue`/`title` routes) - it's the only layer that's supposed to know both stores exist.

**`src/server.js`** is the whole HTTP + WebSocket surface, hand-rolled (no router library). Two auth layers stacked: (1) every request is checked against `Host`/`Origin` allowlists (`isSpoofedRequest`) since `127.0.0.1` binding alone doesn't stop a browser page from making cross-origin requests to it or defeat DNS rebinding; (2) session-scoped routes additionally require a per-session bearer token minted at session creation (`registry.checkToken`). `/api/browse`, `/api/resumable`, `/api/history/*` are intentionally token-free (read-only, no live session to gate against) but still Origin/Host-checked. Live turns stream over one WebSocket per session (`/ws?id&token`), with `since=<seq>` supporting gapless reconnect via `src/event-log.js`'s replay buffer.

**Input is a push-queue, not a call-and-response.** `session.js`'s `createInputQueue()` feeds `query()`'s `AsyncIterable` prompt; sending a message while a turn is still running just enqueues it (visible client-side as the queue panel) rather than dropping or interleaving. A known SDK quirk this works around: `query()` never emits `system/init` until the iterable's first `.next()` resolves, so a startup sentinel is pushed immediately to unblock it (see `.claude/memory/sdk-streaming-input-gotchas.md` for this and a second uuid-related gotcha - re-read that note before touching `session.js`/`rewind.js`, especially across an SDK version bump, since these are undocumented internals with no deprecation contract).

**Rewind = fork, not mutate.** `rewind()` (`rewind.js` for Claude, `grok-rewind.js`/`grok-session.js`'s `rewindGrokSession` for Grok) forks the underlying conversation at a target turn into a *new* provider-side session, which `server.js`'s rewind route then wraps in a brand-new cockpit registry row (inheriting model/mode/thinking-budget/auto-continue from the row being forked, not the cwd's persisted defaults - see `seedSessionDefaults`'s call in that route). The original session and its row are untouched.

**Frontend (`public/`)** is one `app.js` entry point wiring together focused, dependency-injected-by-import modules - no bundler, loaded as native ES modules directly by `index.html`. Rough split: `stream-view.js` (rendering), `compose.js`/`file-picker.js` (input), `dir-browser.js`/`diff-view.js` (modals), `stats-panel.js`/`turn-chart.js` (live cost/token strip), `history-pane.js`/`history-search.js` (past sessions), `queue-panel.js`, `mcp-panel.js`/`plugin-panel.js`/`settings.js` (gear menu). `detail-pane.js` docks beside the transcript and, beyond its original Summary/Payload/Result/Timing tabs for the selected tool call, also hosts two independent tabs unrelated to tool-call selection: Tasks (the live task list, entry point next to the cost-graph toggle) and Agent (a subagent's own transcript, tailed live in place of the old `agent-view.html` pop-out tab). `src/permissions.js` (permission-mode cycle order) and `src/stream-join.js` (Grok token-join whitespace) are shared verbatim between server and browser (see `SHARED_SRC_FILES` in `src/static-files.js`) rather than duplicated.

**Pricing** (`src/pricing.json`, `src/pricing_grok.json`) is a static local copy, not fetched live - `usage.js`'s `costForUsage` returns the real token breakdown with `cost: null` (not a guess, and not dropping the tokens) for a model missing from both tables; it only returns `null` outright when there's no usage to report at all. Codex has no pricing table yet (tracked in `backlog.md`), so its turns always take this "tokens real, cost unpriced" path today.

## Status / where to look next

See `README.md`'s Status section and `backlog.md` for what's shipped (MVP1-5) vs open (MVP6 Windows-hosted sessions over SSH, MVP7 phone approvals) and outstanding follow-ups.
