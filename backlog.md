# Backlog

Ordered by severity: [C] critical/crash, [H] potentially bad, [M] can wait, [L] cosmetic.

## [C] Critical / crash

(none open)

## [H] Potentially bad

(none open)

## [M] Can wait

- [2026-08-15] [M] Code review improvement: zero test coverage on turn-chart.js/mcp-panel.js/plugin-panel.js - client-side, no jsdom harness in this project (see tests/README.md's established "hand-verified only" convention for public/*.js), so this needs that harness built first, not just more node --test cases. The server-route half of this item (model/thinking/auto-continue/mcp/plugin-enabled/reload-plugins routes) is done - see server-auth.test.mjs.
- [2026-08-15] [M] MCP "needs-auth" badge has no way to actually authenticate from the panel - needs a design decision on what the auth flow even looks like (depends on what the SDK exposes per-server: a URL to open, a device code, something else) before this is buildable. selectThinking()'s alert() vs. MCP/plugin panels' inline errors is fixed - see mcp-panel.js's .mcp-error pattern, now reused for thinkingError in index.html/app.js.
- [2026-08-15] [M] data-turn-point index coupling between turn-chart.js and stream-view.js is comment-enforced ordering only across three files - fragile, but replacing it needs a real design call (explicit turn-uuid attributes instead of positional ordering? something else?), not a mechanical fix. The "Query method + row patch + broadcast" duplication half of this item is fixed - see session-registry.js's queryPassthrough().
- [2026-08-15] [M] session-launcher.js:119-120's comment on `/api/browse` claims "loopback-only, token-gated" but server.js:171-177 applies no session token to that route, only the Origin/Host spoof check - and that check deliberately allows a missing Origin (for curl). Any local process can enumerate the filesystem, including other drives via today's new DRIVES_SENTINEL path. Low severity for a local dev tool, but comment overstates the protection and the drive-listing feature widened the reach - worth at least fixing the comment, token-gating is a judgment call.
- [2026-08-15] [M] Test coverage gap: no test exists for `seedSessionDefaults` (server.js:111 fresh-session path, server.js:406 rewind/fork path) despite two commits today dedicated to this exact logic - this is where the cross-session cwd-carry-forward regression above lives untested. Also no concurrency test interleaving setPluginEnabled + setSessionDefaults on the same cwd (the specific race settings-file.js's queue exists to prevent), no test for the settings-file.js write-failure path (where the process-kill bug above lives), and no 401 coverage on the new model/thinking/mcp-toggle/mcp-reconnect/reload-plugins/plugin-enabled routes specifically (only exercised with valid tokens).

- [2026-08-16] [M] No warning before a cache-invalidating action. Prompt caching is a prefix match, so several cockpit controls silently throw away the session's warm cache and the user only finds out afterwards, via the stats strip's hit rate dropping. Three tiers, worst first: (a) tool-set changes - MCP toggle/reconnect (server.js:274) and reload-plugins (server.js:294) - tools render at prefix position 0, so any add/remove/reorder invalidates tools + system + messages, i.e. everything; (b) model switch (server.js:329) - caches are model-scoped, so the whole prefix is gone; (c) thinking budget/display (server.js:355) - invalidates the messages cache only, tools + system survive. usage.js's accumulator already tracks `cacheReadTokens`, so the cost of the impending re-write is computable at click time: warn (inline, `.mcp-error` pattern) when the session has more than some threshold of cached tokens, naming which of the three tiers applies. Scope/approach not designed: where the threshold sits, whether it's a confirm dialog or a passive note, and whether the warning belongs on the control or in the stats strip. Note the cockpit cannot set `cache_control` itself - prompt assembly belongs to the Agent SDK's `query()` - so avoiding needless invalidation is the only lever we have; do not let the copy imply we could extend the TTL. Separately, do not attribute plain idle-gap expiry (the default cache TTL is 5 minutes, refreshed on every read) to a user action - a warning that cries wolf after a coffee break is worse than none.

## Session QoL (Grok CLI parity review, 2026-08-17)

Ordered highest-win-first from a review comparing Grok CLI's session controls
against this cockpit; see conversation for the full comparison table. Shipped
items are removed from this list rather than marked DONE - check git log on
`feature/session-qol-controls` for what already landed (cancel-the-running-turn
was first).

- [2026-08-17] [M] Not started - auto-compact status precision. The Compact button/warning (shipped) triggers off the same `remaining < 20%` threshold stats-panel.js's context bar already turns red at - deliberately not off the SDK's own `getContextUsage().isAutoCompactEnabled`/`autoCompactThreshold` fields, since their units relative to `percentage` (confirmed 0-100) aren't confirmed anywhere in this codebase or its tests. If/when confirmed live, switch the trigger to the CLI's real threshold instead of the assumed 80%.
- [2026-08-17] [M] Not started - permission always-allow, wider scope. Shipped 2026-08-17 scoped to the smallest durable version: per-tool-name, in-memory, for the rest of the current session only (session.js's alwaysAllowTools, checked in canUseTool alongside AUTO_ALLOW_MODES). Not done: tool+cwd or input-pattern scoping, and persisting the choice to settings.local.json's `permissions` block so it survives a resume/reconnect - both still need their own design call before building.
- [2026-08-17] [M] Not started - copy-last-reply / export-session. No button for either; select-to-copy in the stream (app.js's mouseup handler, the terminal-style copy-on-select) is the only copy path today. Copy-last is one button; export is a markdown dump of what the history pane already has.
- [2026-08-17] [L] Not started - message timestamps toggle in Settings. Stream messages show none today; only the resume list has coarse "how long ago".
- [2026-08-17] [L] Not started - persistent session title (cockpit-side title map keyed by cwd+session id). Click-to-rename today only changes the browser tab; the resume list still shows raw cwd/label since the Claude JSONL transcript has no title field of its own (unlike Grok's summary.json).
- [2026-08-17] [L] Not started - image paste/attachments. Deferred deliberately (see plan doc) - drop-target.js is path-only on purpose since a browser tab can't see a dropped file's real path. query() does accept image content blocks per the SDK, but this needs a real server-side upload or file-read path, not another compose-side hack. Scoped as its own mini-project, not a quick win.

## [L] Cosmetic

- [2026-08-14] [L] In plan mode's end-of-plan display, add the ability to open the plan .md file in the default markdown opener (overridable in settings), and add the ability to append more to the plan before approving (e.g. "spawn opus high-effort agent to validate the plan").
- [2026-08-14] [L] Full project plan/roadmap doc: `~/.claude/plans/claude-prompt-cockpit.md`. MVP1-4 shipped; MVP5 (Windows-hosted session over SSH), MVP6 (cross-session messaging), and MVP7 (phone access/approvals) are designed there but not yet built - see that file for the full roadmap, decisions, and open questions.
- [2026-08-15] [L] Add a "/btw" slash command - idea only, scope/behavior not yet specified. Its prerequisite (a visible queue/steer UI, so an aside doesn't just look like another queued message) shipped 2026-08-17 - see queue-panel.js/session.js's listQueue/removeQueued/reorderQueue/sendNow.
- [2026-08-15] [L] In the message stream's viewable area, highlight the cost value (.usage-meta) of the single most costly call (by cost/tokens in/tokens out/cached - metric TBD, probably cost) in the same color as turn-chart.js's cost bar (`#f0b90b`), so the priciest turn stands out without opening the cost graph. Scope/approach not yet designed (recompute on every stream update? only within the current viewport? which of the four metrics wins if they disagree on which turn is "most costly"?).
