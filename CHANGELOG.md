# Changelog

All notable changes to this project are documented here.

## [0.2.0]
- Global Stats heatmap now colors cells by provider (Claude/Grok/Codex) and
  adds an on-demand last-7-day cost split by provider
- Usage-stats scanning cached and bounded: mtime-keyed memoization across
  Claude, Grok, and Codex transcripts, stale-while-revalidate, no more
  blocking rescans
- Streaming render performance: markdown re-renders coalesced to one rAF
  per block, `cockpit:usage` broadcasts throttled, history prepends chunked
  across animation frames to stop full-tab freezes on large sessions
- Tool result syntax highlighting improved, including PowerShell and batch
  detection
- Turn-chart axis and cost labels switched to a nice-scale, 4-decimal
  format for Grok-scale (sub-dollar) bars
- New offline `codex_usage.py`: reads Codex rollout JSONL directly for a
  cost/token report with no server or network involved
- Pricing kept current: GPT-6 Astra/Sol/Luna, Claude Opus 5.5, Fable 5.1,
  Mythos 5/5.1, and Grok 4.7 all added as each became available

## [0.1.7]
- Codex reaches feature parity with Claude and Grok: rewind (forks through
  the selected completed turn, including its response), native MCP and
  plugin controls, MCP OAuth login, and slash commands from `skills/list`
- Codex models discovered live from `model/list` instead of a static
  catalog; the effort picker narrows to what the selected model supports
- Codex token usage normalized into the shared cost accounting, with
  cumulative thread totals converted to per-turn deltas and a resume
  baseline so a resumed thread is not charged twice
- Codex plan quota shown in the cost strip, alongside a new 7-day window
  chip for every provider
- Approvals: `requestUserInput` questions, legacy exec/patch approval
  shapes, and cross-tab resolution so a decision in one tab clears the
  banner in the others
- Tool rows stream live on `item/started` and close on `item/completed`
  instead of appearing only once finished
- Windows tool rows show the real command and basename instead of an
  escaped path or a `powershell.exe -Command` prefix
- Turn ownership hardened for multiple sessions sharing one Codex thread:
  no dropped events during the `turn/start` race, no cross-session
  interrupts, and bounded retention of turn/item ids
- `pricing_codex.json` gained gpt-5.5 and gpt-5.6 rates
- Renamed from `claude-prompt-cockpit` to `prompt-cockpit`: the npm package
  name and Grok's ACP handshake both dropped the `claude-` prefix left over
  from before Grok and Codex existed. Both Grok and Codex now read their
  reported version from `package.json` instead of a hardcoded copy

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
