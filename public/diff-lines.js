// Self-contained line-level diff engine (LCS backtrack), no DOM/rendering
// dependency. Extracted from stream-view.js so it can carry its own unit
// tests (see tests/diff-lines.test.mjs) - see stream-view.js's formatToolInput
// for Edit/MultiEdit call sites.

export const MAX_DIFF_CELLS = 200_000; // guard the O(n*m) LCS below against pathological input sizes

// Minimal line-level diff (LCS backtrack) between two strings, rendered
// terminal-`/diff`-style. `lineNo` is the single-gutter-column line number:
// old-file position for a removed line, new-file position for an added or
// context line - they agree up to the first edit, so this reads naturally
// as "the line's position in whichever file has it".
export function diffLines(oldText, newText) {
  const a = (oldText ?? '').split('\n');
  const b = (newText ?? '').split('\n');

  if (a.length * b.length > MAX_DIFF_CELLS) {
    // Too big to diff cheaply - fall back to a plain before/after dump.
    return [
      { text: '--- before', cls: 'diff-meta' },
      ...a.map((l, idx) => ({ text: l, cls: 'diff-del', lineNo: idx + 1 })),
      { text: '+++ after', cls: 'diff-meta' },
      ...b.map((l, idx) => ({ text: l, cls: 'diff-add', lineNo: idx + 1 })),
    ];
  }

  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const lines = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { lines.push({ text: a[i], cls: 'diff-ctx', lineNo: j + 1 }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { lines.push({ text: a[i], cls: 'diff-del', lineNo: i + 1 }); i++; }
    else { lines.push({ text: b[j], cls: 'diff-add', lineNo: j + 1 }); j++; }
  }
  while (i < n) { lines.push({ text: a[i], cls: 'diff-del', lineNo: i + 1 }); i++; }
  while (j < m) { lines.push({ text: b[j], cls: 'diff-add', lineNo: j + 1 }); j++; }
  return lines;
}

export function countDiff(diffLineList) {
  let added = 0, removed = 0;
  for (const l of diffLineList) {
    if (l.cls === 'diff-add') added++;
    else if (l.cls === 'diff-del') removed++;
  }
  return { added, removed };
}

export function diffSummaryText({ added, removed }) {
  return `Added ${added} line${added === 1 ? '' : 's'}, removed ${removed} line${removed === 1 ? '' : 's'}`;
}
