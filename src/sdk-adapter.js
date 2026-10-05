// Fallback implementations for `file_suggestions`/`get_workspace_diff`:
// these are protocol-only requests with no public method on the Query
// interface, so this *is* the adapter's path, not a degraded mode of it.
// If a public surface appears later, swap the implementation here without
// touching callers.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__']);
const MAX_RESULTS = 50;
const MAX_ENTRIES_SCANNED = 20000;

// Extra folders (e.g. Screenshots, plus user-added ones) rarely live under
// the project tree, so the cwd walk below never finds them - each needs its
// own walk. Capped smaller than the cwd budget: each is one flat folder,
// not a codebase, and shouldn't crowd out real project files if huge.
const EXTRA_FOLDER_MAX_RESULTS = 12;
const EXTRA_FOLDER_MAX_ENTRIES_SCANNED = 2000;
// Hard ceiling on how many extra folders get walked per request, independent
// of how many a user has configured - a request-smuggled or just very long
// folders list shouldn't be able to turn one keystroke into dozens of walks.
const MAX_EXTRA_FOLDERS = 20;

/**
 * @param cwd, queryText, extraFolders - search root, partial filename
 *   typed after `@`, optional `{id,path}` folders outside cwd
 * @returns `{path,source}` - source is 'cwd' or the folder's id, for
 *   grouping/coloring results by origin */
export async function fileSuggestions(cwd, queryText, extraFolders) {
  const needle = (queryText || '').toLowerCase();

  async function walk(dir, root, results, maxResults, maxScanned, scannedRef, source) {
    if (results.length >= maxResults || scannedRef.count >= maxScanned) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= maxResults || scannedRef.count >= maxScanned) return;
      scannedRef.count += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || IGNORED_DIRS.has(entry.name)) continue;
        await walk(full, root, results, maxResults, maxScanned, scannedRef, source);
      } else {
        const rel = path.relative(root, full);
        if (!needle || rel.toLowerCase().includes(needle)) results.push({ path: rel, source });
      }
    }
  }

  // Walked one level only, so a nested archive dir can't crowd out the
  // folder's own files. Sorted newest-first by mtime (not readdir order)
  // since the point of offering these folders is picking something recent.
  async function listFlatFolderNewestFirst(dir, root, maxResults, maxScanned, source) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const fileEntries = entries.filter((e) => e.isFile()).slice(0, maxScanned);
    const withMtime = await Promise.all(
      fileEntries.map(async (entry) => {
        const full = path.join(dir, entry.name);
        let mtimeMs = 0;
        try {
          mtimeMs = (await stat(full)).mtimeMs;
        } catch {
          // Disappeared/unreadable mid-scan - still list it, just unordered
          // relative to entries whose mtime we did get.
        }
        return { path: path.relative(root, full), mtimeMs };
      })
    );
    withMtime.sort((a, b) => b.mtimeMs - a.mtimeMs);
    const matched = needle ? withMtime.filter((f) => f.path.toLowerCase().includes(needle)) : withMtime;
    return matched.slice(0, maxResults).map(({ path: rel }) => ({ path: rel, source }));
  }

  const results = [];
  await walk(cwd, cwd, results, MAX_RESULTS, MAX_ENTRIES_SCANNED, { count: 0 }, 'cwd');

  const folders = (Array.isArray(extraFolders) ? extraFolders : []).slice(0, MAX_EXTRA_FOLDERS);
  for (const folder of folders) {
    if (!folder || !folder.path || !folder.id) continue;
    // Skip if already inside cwd, unless it's nested under a dir the cwd
    // walk prunes (dot-dirs, IGNORED_DIRS) - e.g. `<cwd>/build/artifacts` -
    // since that was never actually visited despite being "inside cwd".
    // Check relToCwd's own path segments, not folder.path's leaf name, so
    // e.g. `<cwd>/src/dist-notes` isn't wrongly pruned as a substring match.
    const relToCwd = path.relative(cwd, folder.path);
    const insideCwd = relToCwd === '' || (!relToCwd.startsWith('..') && !path.isAbsolute(relToCwd));
    const prunedByCwdWalk = insideCwd && relToCwd
      .split(path.sep)
      .some((segment) => segment.startsWith('.') || IGNORED_DIRS.has(segment));
    const alreadyCovered = insideCwd && !prunedByCwdWalk;
    if (alreadyCovered) continue;
    const folderResults = await listFlatFolderNewestFirst(
      folder.path,
      cwd,
      EXTRA_FOLDER_MAX_RESULTS,
      EXTRA_FOLDER_MAX_ENTRIES_SCANNED,
      folder.id
    );
    results.push(...folderResults);
  }

  return results.slice(0, MAX_RESULTS + folders.length * EXTRA_FOLDER_MAX_RESULTS);
}

// `git diff` argument sets per source: unstaged (default), staged, or
// everything against HEAD. quotepath=false keeps non-ASCII paths readable.
const GIT = ['-c', 'core.quotepath=false'];
const DIFF_MODE_ARGS = {
  unstaged: [...GIT, 'diff', '--no-color'],
  staged: [...GIT, 'diff', '--no-color', '--cached'],
  head: [...GIT, 'diff', '--no-color', 'HEAD'],
};
// A staged-only view can't contain untracked files; the other two should.
const MODES_WITH_UNTRACKED = new Set(['unstaged', 'head']);
const DEFAULT_MAX_BUFFER = 10 * 1024 * 1024;

export function isDiffMode(mode) {
  return Object.hasOwn(DIFF_MODE_ARGS, mode);
}

// `git diff` never lists untracked files, so a file just created would be
// invisible. Diff each one against /dev/null (--no-index exits 1 when the
// files differ, which execFile surfaces as an error carrying stdout). A file
// whose diff overflows maxBuffer becomes a header-only stub: the truncated
// text would end mid-line and swallow the next file's header.
async function untrackedDiff(cwd, maxBuffer) {
  const { stdout: list } = await execFileAsync('git', [...GIT, 'ls-files', '--others', '--exclude-standard', '-z'], { cwd, maxBuffer });
  let out = '';
  for (const file of list.split('\0').filter(Boolean)) {
    try {
      const { stdout } = await execFileAsync('git', [...GIT, 'diff', '--no-color', '--no-index', '--', '/dev/null', file], { cwd, maxBuffer });
      out += stdout;
    } catch (err) {
      if (err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
        out += `diff --git a/${file} b/${file}\nnew file mode 100644\nFile too large to diff.\n`;
      } else if (typeof err?.stdout === 'string') {
        out += err.stdout;
      }
    }
  }
  return out;
}

/**
 * @param cwd - project root
 * @param mode - 'unstaged' | 'staged' | 'head'
 * @returns unified diff text, `git diff` fallback
 */
export async function workspaceDiff(cwd, mode = 'unstaged', { maxBuffer = DEFAULT_MAX_BUFFER } = {}) {
  if (!isDiffMode(mode)) return { diff: '', source: 'git', error: `unknown diff mode: ${mode}` };
  try {
    const { stdout } = await execFileAsync('git', DIFF_MODE_ARGS[mode], { cwd, maxBuffer });
    const untracked = MODES_WITH_UNTRACKED.has(mode) ? await untrackedDiff(cwd, maxBuffer) : '';
    return { diff: stdout + untracked, source: 'git', mode };
  } catch (err) {
    return { diff: '', source: 'git', mode, error: String((err && err.message) || err) };
  }
}
