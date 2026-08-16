// Mode cycling order plus the policy for which modes canUseTool can
// auto-allow without a client round-trip. session.js consults
// AUTO_ALLOW_MODES; server.js/app.js consult PERMISSION_MODES for the
// Shift+Tab cycle. Kept separate from session.js so both ends share one
// source of truth without importing the SDK-touching module.

// All six PermissionMode values (see plan Spike B), in cycle order. Loosest
// build-breaking modes (bypassPermissions) sit after the common ones so a
// stray extra Shift+Tab doesn't land you somewhere dangerous by surprise.
export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions', 'dontAsk', 'auto'];

export function nextMode(current) {
  const i = PERMISSION_MODES.indexOf(current);
  if (i === -1) return PERMISSION_MODES[0];
  return PERMISSION_MODES[(i + 1) % PERMISSION_MODES.length];
}

// Modes where the CLI resolves tool permission itself, without ever
// calling our canUseTool (confirmed live: acceptEdits allowed a Write with
// no callback configured at all). 'default' and 'plan' fall through to
// canUseTool, which now gives every gated call a real one-off decision
// (the terminal's own "proceed? y/n"), not an immediate deny.
export const AUTO_ALLOW_MODES = new Set(['acceptEdits', 'bypassPermissions', 'dontAsk', 'auto']);
