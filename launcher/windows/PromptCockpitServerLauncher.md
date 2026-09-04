# PromptCockpitServerLauncher

Pulls the repo, runs `npm start`, opens the detected URL, and cleans up on
Ctrl+C.

## Behavior

1. Kills any leftover process tracked from a previous run (in case the
   window was force-closed instead of Ctrl+C'd).
2. `git pull`. Aborts if it fails (conflicts/uncommitted changes).
3. Runs `npm start`, waits for a URL in its output (up to 60s, then keeps
   waiting).
4. Opens the URL with the OS default handler.
5. On Ctrl+C, kills the tracked process tree and frees the port.
