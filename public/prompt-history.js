// Persisted prompt history (backlog.md) - localStorage-backed, keyed per
// cwd since a prompt typed in one project is rarely useful in a different
// one. Single source of truth for both compose.js's Up/Down recall (already
// existed, in-memory only until now, lost on every reload) and
// history-search.js's Ctrl+R fuzzy search - one store, two ways to read it,
// so a prompt recorded by send() shows up in both immediately rather than
// each module keeping its own copy that can drift.
const STORAGE_PREFIX = 'cockpit:history:';
const MAX_ENTRIES = 300;

export function createPromptHistoryStore() {
  let cwd = null;
  let entries = [];

  function keyFor(c) {
    return STORAGE_PREFIX + (c || '');
  }

  // No-ops if the cwd hasn't actually changed - safe to call on every
  // cockpit:state broadcast (app.js's applySession), not just once per
  // connect, without re-reading localStorage or resetting Up/Down browsing
  // mid-session for no reason.
  function setCwd(nextCwd) {
    if (nextCwd === cwd) return;
    cwd = nextCwd;
    try {
      const raw = localStorage.getItem(keyFor(cwd));
      entries = raw ? JSON.parse(raw) : [];
    } catch {
      entries = []; // corrupt/blocked storage - start empty, not fatal
    }
  }

  function record(text) {
    if (!cwd) return; // no session yet - nothing to key this entry to
    if (entries[entries.length - 1] === text) return; // skip immediate repeats, same as the old in-memory history did
    entries.push(text);
    if (entries.length > MAX_ENTRIES) entries = entries.slice(-MAX_ENTRIES);
    try {
      localStorage.setItem(keyFor(cwd), JSON.stringify(entries));
    } catch {
      // private browsing / quota - this entry just won't survive reload
    }
  }

  // Oldest first, same order Up/Down recall has always assumed (compose.js
  // walks backward from the end for Up).
  function list() {
    return entries;
  }

  return { setCwd, record, list };
}

// Simple subsequence fuzzy match (the class of matcher most command
// palettes use, not full Levenshtein) - "do these characters appear in
// order, gaps allowed", case-insensitive. Returns a score (lower is
// better - the sum of gaps skipped over) or null for no match, so callers
// can rank results without a separate sort key.
export function fuzzyScore(text, query) {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  let ti = 0;
  let score = 0;
  for (const ch of q) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    score += idx - ti;
    ti = idx + 1;
  }
  return score;
}
