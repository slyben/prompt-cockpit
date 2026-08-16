# Grok backend - findings

Written 2026-08-16 against cockpit `main` and local `grok 1.0.4`, originally as assessment only. Slices 1 and 2 have since landed (`757d031..40e5a23`): `src/grok-acp.js`, `src/grok-session.js`, `src/grok-messages.js`, `src/pricing_grok.json`, plus `provider` wiring in `server.js` / `session-registry.js` / `usage.js` / `public/app.js`. See "Review of the landed slices" below for what that pass got wrong. Slices 3-5 are still open.

## Goal

The cockpit should drive Grok Build sessions the same way it drives Claude Code sessions. Both providers stay available. A session picks a provider at launch and keeps it for its lifetime. A Claude tab and a Grok tab can run at the same time.

This is not "use Grok TUI to work on this repo" - that already works. Grok reads `CLAUDE.md` and `.claude/settings.local.json`. The gap is the cockpit itself: every live-session path talks only to `@anthropic-ai/claude-agent-sdk`.

## What the cockpit is today

A loopback browser app (`127.0.0.1:4317`) that drives a long-lived coding-agent session. It does not wrap a pty. It feeds `@anthropic-ai/claude-agent-sdk` `query()` from a push-queue, then renders the SDK message stream itself.

Shipped: live session, plan mode, mode cycling, rewind, `@` autocomplete, diffs, reconnect/tabs, live cost/token stats, resume + read-only history.

### Claude-only coupling

| Layer | File | What it assumes |
|---|---|---|
| Live session | `src/session.js` | `query()`, `canUseTool`, `setPermissionMode`, priming sentinel |
| Registry | `src/session-registry.js` | `handle.query.setModel` / `setMaxThinkingTokens` / `mcpServerStatus` / `rewindFiles` |
| History | `src/session-history.js` | `getSessionMessages()` |
| Rewind | `src/rewind.js` | `forkSession()` + `rewindFiles()` |
| Resume list | `src/session-launcher.js` | `~/.claude/projects/**/*.jsonl` |
| Cost | `src/usage.js` + `src/pricing.json` | Anthropic rates |
| Plugins | `src/plugin-settings.js` | `.claude/settings.local.json` `enabledPlugins` |
| UI | `public/stream-view.js` | Claude `system` / `assistant` / `user` / `result` shapes |

Already backend-agnostic: `@` file walk and `git diff` in `src/sdk-adapter.js`, HTTP/WS server, event log, tab chrome, compose box.

`POST /api/sessions` today accepts `{ cwd, resume, name, model }`. There is no provider field. The launcher model select (`#startModelSelect`) and resume list (`/api/resumable`) are Claude-only.

## Do not bolt Grok onto `query()`

`grok -p` is one prompt, then exit. Resume with `-r` is a new process per turn. The cockpit's design is a long-lived session: type while a turn is running, approve tools, cycle modes, switch model, rewind.

Grok's own docs (`~/.grok/docs/user-guide/14-headless-mode.md`, `15-agent-mode.md`) say the bidirectional path is ACP (`grok agent stdio`). Headless `streaming-messages-json` mimics Claude's wire format for *read* streams and is useful as a translation target, but "tool approvals and other bidirectional flows use the ACP interface."

Also not a solution:

- `query({ model: 'grok-4.5' })` - still the Claude Code process
- Rewriting `stream-view.js` for ACP natively - translation at the adapter is cheaper and keeps one UI

Auth is already present on this machine: `grok login` / `~/.grok/auth.json`, or `XAI_API_KEY`. Local CLI: `grok 1.0.4 (d846eb93d9) [stable]`.

## Recommended backend

```
cockpit registry
  -> grok adapter
    -> spawn: grok agent stdio
      -> ACP JSON-RPC
        session/new | session/load | session/prompt
        session/update (stream)
        requestPermission (approvals)
        x.ai/session/fork, x.ai/rewind/*, x.ai/prompt_history
```

Official TS client: `@agentclientprotocol/sdk`. Grok extension methods live under the `x.ai/` prefix and should be treated as non-exhaustive; discover them from the agent's `initialize` response.

Keep Claude as the existing path. Add `provider: 'claude' | 'grok'` on the registry row.

1. `src/backends/claude.js` - today's `session.js` / rewind / history / launcher, moved, behavior unchanged.
2. `src/backends/grok.js` - ACP client around `grok agent stdio`. Same handle surface the registry already uses: `pushInput`, `close`, `setMode`, `resolveApproval`, plus optional `query.*` methods that Grok can implement or reject clearly.
3. Launcher - provider toggle next to `#startModelSelect`. Resume list tagged Claude vs Grok, or two lists. `POST /api/sessions` grows `{ provider }`.
4. Capabilities on `cockpit:hello` - `{ fileRewind, thinkingBudget, autoContinue, mcpToggle, effort }` so the UI hides what that backend cannot do, instead of showing dead buttons.

Do not try to make one process speak both SDKs.

Translate ACP `session/update` into the existing Claude-shaped `sdk:message` objects (text / thinking / tool_use / tool_result / result). Grok already documents this mapping for `--output-format streaming-messages-json`.

## What maps, and what does not

### Maps cleanly

- Long-lived session, send, close
- Permission modes: Grok documents the same six names (`default`, `acceptEdits`, `plan`, `bypassPermissions`, `dontAsk`, `auto`) and Claude-compat settings
- Plan mode (Grok has its own state machine + `exit_plan_mode`)
- Resume / fork (ACP `session/load`, `x.ai/session/fork`)
- MCP, skills, plugins (different APIs, same product idea)
- Usage on the stream (`usage`, `num_turns`, sometimes `total_cost_usd`)
- `@` picker and diff viewer (already local)

### Different enough to design around

| Cockpit feature | Claude | Grok |
|---|---|---|
| Transcripts | `~/.claude/projects/**/*.jsonl` | `~/.grok/sessions/<encoded-cwd>/<id>/` (`summary.json` + `updates.jsonl`) |
| History API | `getSessionMessages()` | Parse `updates.jsonl`, or `session/load` + `x.ai/prompt_history` |
| File rewind | `enableFileCheckpointing` + `rewindFiles` | Conversation-only. Disk is left as-is. Disable the file half, same as today's no-checkpoint resume path |
| Thinking | `setMaxThinkingTokens` + display mode | `/effort` tiers: `none` ... `max`. Not a token budget |
| Cost | Local Anthropic `pricing.json` | Prefer Grok's stamped `total_cost_usd` when present. OAuth/pool traffic often omits it |
| Rate-limit auto-continue | Claude `rate_limit_event` | No equivalent event. Hide or no-op on Grok sessions |
| Tasks | `TaskCreate` / `TaskUpdate` / `TaskList` | `todo_write` + `plan.json` |
| Model list | `Query.supportedModels()` | `grok models` / ACP initialize |
| Mid-session model | `query.setModel()` | Need to confirm the ACP method; TUI uses `/model` |
| Priming sentinel | Required or Claude `query()` hangs | Not needed for ACP |

Grok session storage (from `17-sessions.md`):

```
~/.grok/sessions/<encoded-cwd>/<session-id>/
  summary.json            # title, timestamps, model, message counts
  updates.jsonl           # ACP session update stream (source of truth)
  chat_history.jsonl      # raw chat messages
  plan.json               # TODO/task list
  rewind_points.jsonl     # rewind points
  signals.json            # token usage, tool/turn counters
```

`grok sessions list` lists sessions for the current working directory. `GROK_HOME` overrides `~/.grok`.

## Review of the landed slices (2026-08-16)

Code review of `757d031..40e5a23`. Tests pass (142/142). The seams are right: the ACP client is clean, the handle contract matches `session.js`, `provider` is threaded end to end, and Grok correctly disables file checkpointing and rewind. The items below are what the pass got wrong, ordered by severity. Items 1-3 are blockers: do not run Grok on a repo you care about until they land.

### [H] R1 - `acceptEdits` on Grok auto-allows everything, including Bash - FIXED

`grok-session.js:105`. `if (AUTO_ALLOW_MODES.has(currentMode))` approves every `session/request_permission` regardless of tool. On Claude that set is safe because the CLI itself decides what `acceptEdits` covers and only calls back for the rest; Grok has no such server-side policy. One Shift+Tab from default silently becomes full `bypassPermissions` on Grok.

Same root cause for `plan`: it is not in the auto-allow set so Grok does prompt, but nothing stops Grok from writing files once approved. The UI says Plan and means nothing.

Fix: for grok, branch on tool kind. Allow only edit-shaped calls (`toolCall.kind === 'edit'`) under `acceptEdits`, and hard-deny non-read tools in `plan`.

### [H] R2 - Denying a tool can silently allow it - FIXED

`grok-messages.js:123-128`. `pickPermissionOption` falls back to `list[0]` when no `reject_*` kind matches, and ACP option lists conventionally lead with `allow_once`. An agent that labels its options with non-standard kinds turns a Deny click into Allow. A refusal must never fall back to a permissive option: return `null` (which maps to `cancelled`) when no reject option exists.

### [H] R3 - Spawn failure crashes the whole server, and will always fire on Windows - FIXED

`grok-acp.js:90`. There is no `proc.on('error')` listener anywhere. A `ChildProcess` 'error' event with no listener throws, and the async IIFE's try/catch in `grok-session.js` cannot catch it because it fires later. That kills the process and every other live session, not just the Grok tab. Same class of bug on `proc.stdin.write` (`grok-acp.js:105`): an EPIPE after the agent dies is an unhandled stream error.

And it will fire on this machine: `spawn('grok', ...)` with no `shell` cannot execute `grok.cmd`, which is what an npm-installed CLI is on Windows. Grok start equals ENOENT equals server death.

Fix: add `proc.on('error')` and `proc.stdin.on('error')` routed to `onError`, and resolve the binary per platform (`process.platform === 'win32' ? 'grok.cmd' : 'grok'`). Do not use `shell: true` as the Windows workaround: `body.model` is unvalidated and goes straight into argv, so a shell hands you command injection.

### [M] R4 - Grok cost tracking does not exist - FIXED (usage events + model stamp; still no stamped total_cost_usd)

Commit `40e5a23` claims "Price Grok sessions from pricing_grok.json", but nothing emits usage. `acpUpdateToMessages` builds assistant messages with no `usage` and no `model`, so `addAssistantMessage` returns at its first guard. Cost reads $0 forever, and because `message.model` is absent the id never lands in `unpriced` either, so the "cost may be understated" flag never lights up. `pricing_grok.json` is currently unreachable code, and the header is confidently wrong instead of visibly unknown.

Fix: plumb token counts off the ACP stream (Slice 5 already calls for preferring Grok's stamped `total_cost_usd`), or stamp grok sessions as unpriced until that exists.

### [M] R5 - No request timeout in the ACP client - FIXED

`grok-acp.js:59-68`. A `request()` promise settles only on a matching response or on process exit. `promptTail` (`grok-session.js:146`) is a serial chain, so one lost `session/prompt` reply wedges the session in "running" permanently with no recovery short of closing the tab. Add a timeout that rejects the pending entry.

### [M] R6 - Approval ids can collide and strand a prompt - FIXED

`grok-session.js:110`. `perm-${pendingApprovals.size}` is not unique over time: resolve one and the next unidentified approval reuses `perm-0`. Two in flight means the second overwrites the first in the Map and that first promise never resolves, hanging the agent. Use a monotonic counter.

### [L] R7 - Grok sessions cannot actually be resumed - FIXED (list + view + resume; rewind still Slice 4)

`session/load` (`grok-session.js:77`) is unreachable from the UI. The resume list is Claude-only and `startSession` sends no `provider` on resume, so an attempt would build a Claude session against a Grok id. Dead path until Slice 3.

### [L] R8 - Cosmetics - FIXED

- `stream-view.js:210` renamed every assistant label "Claude" to "Assistant", including on Claude sessions. `session.provider` is already on the summary; use it instead of flattening both.
- `fillStartModels()` is never called at init (`public/app.js`). Browsers restore `<select>` state on reload, so refreshing with Grok selected shows the Claude model list.
- Model picker, MCP panel and plugin panel still render on Grok sessions where every action is an `unsupported()` throw. Slice 1's capability flags (`cockpit:hello`) would close this.

## Implementation slices

Ordered. Slice 1 is the real product question. 2-5 are feature parity.

### [H] Slice 1 - Drive a Grok session

New + send + stream + close + model at start. Translate ACP to existing `sdk:message`. Enough to use the cockpit on Grok.

- Spawn `grok agent stdio` (do not pass `--always-approve` by default; the cockpit already has an approval UI)
- `initialize` + `session/new` with `cwd`, optional model
- `session/prompt` for each `pushInput`
- Map `agent_message_chunk` / `agent_thought_chunk` / `tool_call` / `tool_call_update` / `end` into Claude-shaped messages so `stream-view.js` and the usage header keep working
- Provider toggle on the launcher; `POST /api/sessions` accepts `{ provider: 'grok' }`
- Claude path untouched

Open questions to resolve while building, not before:

- Exact ACP method (if any) for mid-session model switch. Slice 1 only needs model-at-start (`grok agent --model ...` or `session/new` `_meta`).
- Whether one `grok agent stdio` process can host multiple cockpit sessions, or one process per session. Start with one process per session; it matches how Claude `query()` works today.

### [H] Slice 2 - Approvals and mode cycle

ACP `requestPermission` wired to the existing approval banner. Mode cycling through Grok's six permission-mode names.

- Default/plan must actually prompt; do not launch Grok sessions in yolo just to skip this
- Confirm how mid-session mode changes are sent (Claude uses `setPermissionMode`; Grok ACP `_meta.yoloMode` / `autoMode` is documented on `session/new` only)
- Plan-mode exit (`exit_plan_mode`) should reuse the existing approval surface

### [M] Slice 3 - Resume list and history

Read Grok transcripts so the launcher and "View" history pane work.

- Scan `~/.grok/sessions/<encoded-cwd>/<id>/summary.json` (and/or `grok sessions list`) for the resume list
- Tag each row with `provider` so resume/view hit the right backend
- History backfill: parse `updates.jsonl` into the same renderable message list `fetchSessionHistory` returns today
- `session/load` to resume a live session by id

### [M] Slice 4 - Conversation rewind and fork - PARTIAL (rewind/execute in place; stdio fork params still unknown)

- Rewind via `x.ai/rewind/*` (conversation truncate only)
- Fork via `x.ai/session/fork`
- `hasFileCheckpointing` stays false for every Grok session; UI already knows how to hide the file half
- Turn targeting: Grok rewind points live in `rewind_points.jsonl` (one per user prompt). Do not reuse Claude's `getSessionMessages` + `turnIndex` uuid lookup without verifying they agree

### [L] Slice 5 - Parity polish - DONE (effort picker, stamped cost, todo_write; MCP/plugin stay hidden)

- Effort picker instead of thinking-token budget
- Prefer Grok stamped `total_cost_usd` / `modelUsage` when present; flag unpriced when omitted (same `unpriced` pattern `usage.js` already has)
- MCP / plugin panels against Grok's ACP / `grok mcp` / `grok plugin` surfaces
- `todo_write` + `plan.json` into the task panel
- Hide auto-continue on Grok sessions

### [L] Slice 6 - Mid-session model and effort - PARTIAL (`session/set_model` works; mid-session effort ACP params still unknown, `--effort` at spawn works)

- Effort picker instead of thinking-token budget
- Prefer Grok stamped `total_cost_usd` / `modelUsage` when present; flag unpriced when omitted (same `unpriced` pattern `usage.js` already has)
- MCP / plugin panels against Grok's ACP / `grok mcp` / `grok plugin` surfaces
- `todo_write` + `plan.json` into the task panel
- Hide auto-continue on Grok sessions

## Files that will have to change (later)

Do not touch these while `backlog.md` work is in flight. Several are on that list too (`server.js`, `session-registry.js`, `settings-file.js`).

**New**

- `src/backends/claude.js` (move)
- `src/backends/grok.js`
- `src/grok-launcher.js` (or fold provider into `session-launcher.js`)
- `src/grok-history.js`
- tests for the Grok adapter (stdio stub, no live `grok` process in unit tests)

**Existing, Claude path must keep working**

- `src/session.js` - become the Claude backend, or a thin re-export
- `src/session-registry.js` - `provider` on the row, dispatch to the right handle
- `src/session-launcher.js` / `src/server.js` - `/api/resumable` and `POST /api/sessions`
- `src/session-history.js` / `src/rewind.js` - provider-aware, or Grok-specific siblings
- `src/usage.js` / `src/pricing.json` - accept Grok spend fields without inventing Anthropic rates for `grok-*` ids
- `public/app.js` / `public/index.html` - provider toggle, capability-gated chrome
- `package.json` - add `@agentclientprotocol/sdk`; keep `@anthropic-ai/claude-agent-sdk`

## Out of scope

- Replacing Claude. This is add, not swap.
- Headless `grok -p` as the session transport.
- File-content rewind on Grok (the product does not offer it).
- Cross-provider resume (a Claude transcript cannot be opened as a Grok session).
- Renaming the repo / product. Fine to keep `claude-prompt-cockpit` until someone decides otherwise.

## References

- `~/.grok/docs/user-guide/14-headless-mode.md` - output formats, session flags, why ACP is required for approvals
- `~/.grok/docs/user-guide/15-agent-mode.md` - `grok agent stdio`, ACP lifecycle, `x.ai/*` extensions
- `~/.grok/docs/user-guide/17-sessions.md` - on-disk layout, resume/fork/rewind, `grok sessions list`
- `~/.grok/docs/user-guide/19-plan-mode.md` - plan state machine, `exit_plan_mode`
- `~/.grok/docs/user-guide/22-permissions-and-safety.md` - the six modes, Claude-compat settings
- `~/.grok/docs/user-guide/11-custom-models.md` - `grok models`, `/model`, default `grok-4.5`
- ACP TS SDK: https://www.npmjs.com/package/@agentclientprotocol/sdk
- ACP prompt-turn spec: https://agentclientprotocol.com/protocol/prompt-turn
