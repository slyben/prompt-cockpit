# PromptCockpitServerLauncher

Pulls the repo, runs `npm start`, opens the detected URL, and cleans up on
Ctrl+C.

## Behavior

1. Kills any leftover process tracked from a previous run (in case the
   window was force-closed instead of Ctrl+C'd).
2. `git pull`. Aborts if it fails (conflicts/uncommitted changes).
3. Checks every listener on the server port (`PORT`, default 4317; aborts
   if it is not a number from 1 to 65535). Kills a listener only when it is
   `node src/server.js` and its working directory is this repo root, e.g. a
   server orphaned by a crashed launcher. Aborts, naming the process, if any
   listener is something else, its working directory can't be read, or the
   port is still in use 5s after the kill.
4. Runs `npm start` inside a kill-on-close Windows Job Object (aborts if the
   job can't be created), waits for a URL in its output (up to 60s, then
   keeps waiting).
5. Opens the URL with the OS default handler (outside the job, so the
   browser is unaffected).
6. On Ctrl+C, kills the tracked process tree and frees the port. If the
   launcher exits any other way (window closed, crash, killed), Windows
   closes the job and kills the server tree anyway.
