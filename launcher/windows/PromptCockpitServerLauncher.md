# PromptCockpitServerLauncher

Pulls the repo, runs `npm start`, opens the detected URL, and cleans up on
Ctrl+C.

## Behavior

1. Kills any leftover process tracked from a previous run (in case the
   window was force-closed instead of Ctrl+C'd).
2. `git pull`. Aborts if it fails (conflicts/uncommitted changes).
3. If the server port (`PORT`, default 4317) is already listening: kills it
   when it is a prompt-cockpit server (`node src/server.js`, e.g. orphaned
   by a crashed launcher), otherwise aborts naming the process holding it.
4. Runs `npm start` inside a kill-on-close Windows Job Object, waits for a
   URL in its output (up to 60s, then keeps waiting).
5. Opens the URL with the OS default handler (outside the job, so the
   browser is unaffected).
6. On Ctrl+C, kills the tracked process tree and frees the port. If the
   launcher exits any other way (window closed, crash, killed), Windows
   closes the job and kills the server tree anyway.
