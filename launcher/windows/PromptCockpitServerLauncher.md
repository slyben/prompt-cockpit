# PromptCockpitServerLauncher

Pulls the repo, runs `npm start`, opens the detected URL, and cleans up on
Ctrl+C.

## Behavior

1. Kills any other running instance of this launcher (any `powershell.exe`
   whose command line contains the script name) and its process tree.
2. `git pull`. Aborts if it fails (conflicts/uncommitted changes).
3. Checks every listener on the server port (`PORT`; blank or 0 means 4317,
   as in the server; aborts if it is not a whole number up to 65535). Kills a
   listener only when it is `node src/server.js` and its working directory
   is this repo root, e.g. a server orphaned by a crashed launcher. Aborts,
   naming the process, if the port can't be checked, any listener is
   something else, its working directory can't be read, or the port is
   still in use 5s after the kill.
4. Runs `npm start` inside a kill-on-close Windows Job Object (aborts if the
   job can't be created), waits for the server's
   `prompt-cockpit listening on <url>` line (up to 60s, then keeps waiting).
   Other URLs in the output are ignored.
5. Opens that URL with the OS default handler (outside the job, so the
   browser is unaffected).
6. On Ctrl+C, kills the tracked process tree and frees the port. If the
   launcher exits any other way (window closed, crash, killed), Windows
   closes the job and kills the server tree anyway.

The `.bat` exits with the launcher's exit code, so callers see `1` when it
aborts with an `[ERROR]`.
