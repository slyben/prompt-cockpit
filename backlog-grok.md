# Grok backend

Shipped on `main` / `feature/grok-fork-and-effort`: live session, approvals, resume/history, conversation rewind via fork, mid-session model and effort, cost/usage, todo_write, MCP/plugin panels via `grok inspect` + `grok mcp|plugin enable/disable`.

Claude stays the other provider. A session picks one at launch.

## Still out of scope

- File-content rewind (Grok does not offer it)
- Headless `grok -p` as the session transport
- Cross-provider resume
- Live MCP reconnect on an already-running Grok ACP session (toggle persists; start a new session to be sure)

## Known ACP shapes (Grok 1.0.4)

Confirmed live against `grok agent stdio`:

- Mid-session effort: `session/set_mode` `{ sessionId, modeId }` where `modeId` is `low` / `medium` / `high` / `xhigh` (the `x.ai/sessionConfig` options with `category: "mode"`)
- Fork: `_x.ai/session/fork` `{ sourceSessionId, sourceCwd, newCwd, newSessionId }`
- The forked child is not loaded in the parent process. Rewind it in a short-lived connection after fork (`rewindGrokSession` in `src/grok-session.js`)

## References

- `~/.grok/docs/user-guide/15-agent-mode.md`
- `~/.grok/docs/user-guide/17-sessions.md`
- `tests/grok-rewind-probe.manual.mjs`
