# Changelog

All notable changes to this project are documented here.

## [0.1.6]
- Security: CSP/X-Frame-Options/nosniff headers, 1MB request/WS payload
  caps, timing-safe token comparisons
- `pricing_codex.json` added: Codex cost/tokens now show instead of
  dropping silently for unpriced models; Global Stats tab labeled
  Claude-only
- Grok Stop button now drains queued prompts, not just the in-flight turn
- Task/Agent panes folded into the docked detail pane, replacing the old
  `agent-view.html` pop-out tab
- Edit/Write/Bash tool payloads syntax-highlighted (Prism.js); Edit/MultiEdit
  diffs rendered CLI-style with a gutter and block tint
- Subagent-aware spinner and highlighting; turn-chart keeps a
  chart-selected tool group open
- `/healthz` liveness check and `/api/system/memory` introspection added
- `session-registry.js`/`app.js` split into focused modules
  (`delegation.js`, `approval-panel.js`, per-concern CSS files, etc.)
- `result-epoch.js` unifies turn-tracking, replacing duplicated FIFO logic
  between `session-registry.js` and each provider's handle
- `session-actions.js` refactored from a 520-line if-chain to a
  lookup-table dispatcher; dead code and duplicate `escapeHtml` removed

## [0.1.5]
- Widened slash-command dropdown; sorted alphabetically, substring match
- Fixed account-limits tests hanging on Windows (injectable execFile)
- Gate every `/api` and `ws` route behind a process operator token
- `/ask` delegation trust anchor and picker; settings modal split into tabs

**Note:** commit history on `main` was rewritten (all commit messages
reformatted to scoped-commit style) for this release. If you already have
a clone, sync it with:
```
git fetch origin
git checkout main
git reset --hard origin/main
```
Any local branches based on the old commits will need rebasing onto the
new history, or just re-cloning.

## [0.1.4]
- Codex added as a third session provider, alongside Claude and Grok
- Provider architecture refactored; Codex wired into launcher and UI
- Codex session lifecycle, rewind, and effort-validation fixes
- Security review fixes: ReDoS, delegation FIFO desync, route hammering

## [0.1.3]
- Cross-session delegation: relay, message rendering, handshake secret
- Per-tool cost breakdown, session-count fixes, tooltips
- Split server routing; stuck-session recovery and debug tooling

## [0.1.2]
- Grok fork/effort support, MVP5 `/ask` delegation, Grok stream fixes
- Live Grok turn cost forwarded via `session_notification`
- Markdown renderer extensions; MCP "needs auth" Authenticate link
- General quality-of-life improvements

## [0.1.1]
- Grok-CLI-parity session controls: cancel turn, `/compact`, visible input
  queue, permission always-allow, plan review, persisted prompt history
- Claude replies rendered as Markdown
- Redesigned tool-call rendering with a docked detail pane
- Fixed `@` file picker gap and cost-graph slider; closed test gaps
- README cleanup (screenshot added, Plan section removed)

## [0.1.0] - Initial release
- Local browser UI for driving a Claude Code session against a project folder
- Initial README with Run instructions
