# Prompt Cockpit

A browser app for driving agent coding sessions - "I don't prompt a terminal directly, I use an app to prompt a specific session" - plus a live cost/token readout, borrowed from `claude-realtime-usage`.

The cockpit drives Claude Code sessions through `@anthropic-ai/claude-agent-sdk` and Grok sessions through the Grok CLI's JSON-RPC stdio interface, rendering the message stream itself. It does not wrap a pty and pipe raw bytes to `xterm.js`.

## Run

```
npm install   # first time only, to fetch dependencies
npm start
```

Open `http://localhost:4317` (set `PORT` to use a different port).

## Requirements

The cockpit does not manage auth itself - it just drives CLIs that are already logged in on the machine running the server:

- **Claude**: the `@anthropic-ai/claude-agent-sdk` uses your existing Claude Code login (`claude login`).
- **Grok**: the `grok` binary must be on `PATH` (or set `GROK_BIN`) and already logged in; session history is read from `~/.grok/sessions`.

## Status

- **MVP1 - a session in a browser.** Shipped.
- **MVP2 - plan mode, mode cycling, rewind, `@` autocomplete, diff viewer.** Shipped.
- **MVP3 - client robustness** (reconnect, tab chrome, activity state). Shipped.
- **MVP4 - live stats panel.** Shipped. Header strip: cost, tokens in/out, cache hit rate, context percentage, live off the message stream. Read-only history viewer for any past session via the resume list's "View" button. Grok backend wired in alongside Claude Code at the end of this milestone.
- MVP5-MVP7 (Windows-hosted sessions, cross-session messaging, phone approvals) not started.

See `tests/README.md` for what is covered by automated tests versus hand-verified only.

## License

MIT - see `LICENSE`. Use at your own risk.
