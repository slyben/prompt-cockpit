# DeepSeek Harness - functionality notes

Scouting notes on https://github.com/deepseek-ai/deepseek-harness (`dsh`), for picking pieces
worth porting into Prompt Cockpit. No action taken yet - this is a summary only.

## What it is

DeepSeek Harness is DeepSeek AI's open-source agent harness. "Everything is a plugin," built on
[Cordis](https://github.com/cordiverse/cordis) (a TypeScript DI/plugin runtime - Service classes,
`ctx.effect()`, `ctx.on()`, `ctx.waterfall()`). Developer preview, breaking changes expected.
Run via `npx @deepseek-ai/dsh web` (Web UI at `http://127.0.0.1:3080`) or from source with pnpm.

Monorepo under `packages/@deepseek-ai/dsh-*`, organized into capability "families" (Service
Definition / Service Provider / Consumer split so extension plugins depend on interfaces, not
concrete impls).

## Package groups (potential feature parallels to Prompt Cockpit)

- **core** - sessions, prompts, tools, agent services, the concrete agent loop
- **llm** - abstract LLM service + provider adapters (multi-model support)
- **session** / **session-query** - durable session persistence (JSONL/SQLite backends),
  retrieval, lineage, event relationships, full-text search, log-backed titles, session reporting
- **client** / **host** - the Web GUI: browser shell + wire protocol + API gateway/HTTP server
- **sdk** - out-of-process runtime SDK: JSON-RPC protocol, TS client, server plugin
- **acp** - Agent Client Protocol server (automation-only)
- **hooks** - hook bridges + shared Claude Code / Codex wire-protocol library
- **interaction** - approval/interaction seams, permission presets, ask-user tool, commands
- **plan** - plan-mode collaboration state (entry command + reviewed exit) - direct analog to
  our plan mode
- **subagent** - provider-registry contract + model-facing delegation tool (subagent spawning)
- **jobs** / **workflow** - background job runtime + model-facing `job_*` control tools;
  workflow engine with `workflow`/`ralph` tools
- **schedule** - session-local scheduled follow-ups
- **todo** - model-facing `todo_write` tool
- **compaction** - compaction capability family (context compaction, like our `/compact`)
- **guard** - loop-hygiene guards: repeat-call reminders, `tools/execute` deadline enforcement
- **skill** - skill capability family: provider registry, catalog/loader tools
- **shell** / **terminal** / **fs** / **lsp** / **web** / **code-runtime** - model-facing tool
  families (bash, persistent PTY, filesystem, LSP, web search/fetch, sandboxed code execution)
- **sandbox** - process confinement (bwrap/Landlock/Seatbelt backends)
- **credentials** / **settings** / **storage** - user settings, credential refs, non-session
  storage hub
- **extensions** - agent runtime self-modification: live plugin/service inspection, model-written
  plugin mount/unmount
- **preset** / **bundle** - per-session agent composition from `cordis.yml` presets; installable
  `--profile` patch layers
- **feedback** / **identity** - human feedback capture, shared anonymous identity
- **attachment** / **spill** - durable attachment storage; tool-result spill-to-disk policy

## Where it overlaps with Prompt Cockpit

Prompt Cockpit already covers: session-in-browser, plan mode, mode cycling, rewind, `@`
autocomplete, diff viewer, reconnect/tab chrome, live cost/token stats, read-only history viewer,
dual Claude Code + Grok backends.

Closest overlaps worth a look if we want ideas (not full ports - architectures differ a lot,
dsh is a Node/Cordis plugin runtime, we drive CLIs directly):

- **session-query** - lineage/relationship/full-text search over past sessions could inform a
  richer history viewer than our current "View" button.
- **jobs/workflow** - background job + `job_*` control tools, for tasks that outlive one turn.
- **schedule** - session-local scheduled follow-ups, similar in spirit to our `/loop`.
- **extensions** - live plugin inspection/mount-unmount is DSH's whole "everything is a plugin"
  pitch; not directly portable since we don't have a plugin runtime, but worth knowing about if
  we ever want session-side extensibility.
- **acp / sdk** - Agent Client Protocol + out-of-process JSON-RPC SDK, relevant if we ever want
  to drive sessions from something other than our own browser client.

## Caveat

This is API-surface reconnaissance from READMEs only (repo's own docs are thin - main README is
mostly install instructions; package list and one-line roles came from `packages/README.md`).
Haven't read implementation code, so "what it does" here is at the level of names and one-liners,
not verified behavior. Next step if we want to actually port something: pick one package group
above, read its own README/source, and scope a concrete change.
