// Wrapper for the two internal-only control requests (`file_suggestions`,
// `get_workspace_diff` - plan Spike B: protocol-only, not on the public
// Query interface). Both are implemented as fallback-only for MVP2: there
// is no public method to reach the real internal handler from outside the
// CLI's own request loop, so this *is* the adapter's fallback path, not a
// degraded mode of it. If a public surface appears later, swap the
// implementation here without touching callers.
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.venv', '__pycache__']);
const MAX_RESULTS = 50;
const MAX_ENTRIES_SCANNED = 20000;

// Extra folders (Screenshots by default, plus whatever a user adds in
// Settings - see settings.js's customFolders) rarely live under the project
// tree, so the cwd walk below never finds them - a separate walk per folder
// is the only way "@" can offer one. Capped much smaller than the cwd
// budget per folder: each is one flat folder, not a codebase, and shouldn't
// be able to crowd out real project files if it happens to be huge.
const EXTRA_FOLDER_MAX_RESULTS = 12;
const EXTRA_FOLDER_MAX_ENTRIES_SCANNED = 2000;
// Hard ceiling on how many extra folders get walked per request, independent
// of how many a user has configured - a request-smuggled or just very long
// folders list shouldn't be able to turn one keystroke into dozens of walks.
const MAX_EXTRA_FOLDERS = 20;

/**
 * @param cwd - project root to search under
 * @param queryText - partial path/filename typed after `@`
 * @param extraFolders - optional array of { id, path } folders to search
 *   outside cwd (results come back relative to cwd via `..` segments - see
 *   module doc), e.g. Screenshots plus whatever else Settings has added.
 * @returns { path, source } objects, cwd-glob fallback - `source` is 'cwd'
 *   or the matching extraFolders entry's `id`, so the client can group/color
 *   each origin instead of showing one flat list where an extra folder's
 *   entries (often `..\..\Screenshots\...` or, cross-drive on Windows, a
 *   bare absolute path - see the relToCwd comment below) are indistinguishable
 *   from real project files.
 */
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

  // Extra folders are "one flat folder, not a codebase" (see doc comment
  // above): walked one level only, so a nested archive dir (e.g. an "old\"
  // subfolder someone dumped years of past screenshots into) can't crowd out
  // the folder's own files. Sorted newest-first by mtime rather than
  // readdir's filesystem order, since the whole point of offering these
  // folders is picking something *recent* (a screenshot just taken, say) -
  // alphabetical order buries that at the bottom for date-stamped filenames.
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
    // Skip if already inside (or equal to) cwd - the walk above already
    // covers that case and a second pass would just duplicate it. But the
    // cwd walk prunes dot-dirs and IGNORED_DIRS entirely (see walk() above),
    // so a folder nested under one of those - e.g. `<cwd>/build/artifacts`
    // or `<cwd>/.screenshots` - was never actually visited despite being
    // "inside cwd" by plain path containment. Walk relToCwd's own segments
    // (not folder.path's leaf name) so a folder that merely lives *next to*
    // an ignored name, e.g. `<cwd>/src/dist-notes`, isn't wrongly treated as
    // pruned just because "dist" is a substring.
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

/**
 * @param cwd - project root
 * @returns unified diff text, `git diff` fallback
 */
export async function workspaceDiff(cwd) {
  try {
    const { stdout } = await execFileAsync('git', ['diff', '--no-color'], {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { diff: stdout, source: 'git' };
  } catch (err) {
    return { diff: '', source: 'git', error: String((err && err.message) || err) };
  }
}
