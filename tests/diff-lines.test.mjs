import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffLines, countDiff, diffSummaryText, MAX_DIFF_CELLS } from '../public/diff-lines.js';

test('diffLines produces context/add/del rows with correct lineNo for a simple edit', () => {
  const before = 'one\ntwo\nthree';
  const after = 'one\ntwo-changed\nthree';
  const rows = diffLines(before, after);

  // 'one' is shared context, 'two' removed, 'two-changed' added, 'three' shared context.
  assert.deepEqual(rows, [
    { text: 'one', cls: 'diff-ctx', lineNo: 1 },
    { text: 'two', cls: 'diff-del', lineNo: 2 },
    { text: 'two-changed', cls: 'diff-add', lineNo: 2 },
    { text: 'three', cls: 'diff-ctx', lineNo: 3 },
  ]);
});

test('diffLines handles pure additions and pure removals', () => {
  const rows = diffLines('a\nb', 'a\nb\nc');
  assert.deepEqual(rows, [
    { text: 'a', cls: 'diff-ctx', lineNo: 1 },
    { text: 'b', cls: 'diff-ctx', lineNo: 2 },
    { text: 'c', cls: 'diff-add', lineNo: 3 },
  ]);

  const rows2 = diffLines('a\nb\nc', 'a\nb');
  assert.deepEqual(rows2, [
    { text: 'a', cls: 'diff-ctx', lineNo: 1 },
    { text: 'b', cls: 'diff-ctx', lineNo: 2 },
    { text: 'c', cls: 'diff-del', lineNo: 3 },
  ]);
});

test('diffLines treats null/undefined text as empty string', () => {
  // null splits to [''], so this is really a one-line diff: '' -> 'x'.
  const rows = diffLines(null, 'x');
  assert.deepEqual(rows, [
    { text: '', cls: 'diff-del', lineNo: 1 },
    { text: 'x', cls: 'diff-add', lineNo: 1 },
  ]);
});

test('countDiff and diffSummaryText tally added/removed rows and pluralize correctly', () => {
  const rows = diffLines('one\ntwo\nthree', 'one\ntwo-changed\nthree');
  const counts = countDiff(rows);
  assert.deepEqual(counts, { added: 1, removed: 1 });
  assert.equal(diffSummaryText(counts), 'Added 1 line, removed 1 line');

  assert.equal(diffSummaryText({ added: 0, removed: 0 }), 'Added 0 lines, removed 0 lines');
  assert.equal(diffSummaryText({ added: 2, removed: 3 }), 'Added 2 lines, removed 3 lines');
});

test('diffLines falls back to a plain before/after dump when a*b exceeds MAX_DIFF_CELLS', () => {
  // Construct inputs whose line-count product exceeds the guard so the O(n*m)
  // LCS table is skipped entirely - if it weren't, a table this big would be
  // slow/memory-heavy in a test run.
  const aLines = MAX_DIFF_CELLS + 1; // 200_001 old lines, 1 new line -> product > MAX_DIFF_CELLS
  const before = Array.from({ length: aLines }, (_, i) => `old${i}`).join('\n');
  const after = 'new0';

  const rows = diffLines(before, after);

  // Bailout shape: a '--- before' meta row, every old line as diff-del
  // (lineNo = its 1-based position in the old file), a '+++ after' meta row,
  // then every new line as diff-add (lineNo = its 1-based position in the
  // new file) - no LCS interleaving/context rows at all.
  assert.equal(rows[0].cls, 'diff-meta');
  assert.equal(rows[0].text, '--- before');

  assert.equal(rows.length, 1 /* meta */ + aLines + 1 /* meta */ + 1 /* one new line */);

  for (let i = 0; i < aLines; i++) {
    assert.deepEqual(rows[1 + i], { text: `old${i}`, cls: 'diff-del', lineNo: i + 1 });
  }

  const afterMetaIdx = 1 + aLines;
  assert.equal(rows[afterMetaIdx].cls, 'diff-meta');
  assert.equal(rows[afterMetaIdx].text, '+++ after');

  assert.deepEqual(rows[afterMetaIdx + 1], { text: 'new0', cls: 'diff-add', lineNo: 1 });
});

test('diffLines takes the full LCS path (not the bailout) right at the MAX_DIFF_CELLS boundary', () => {
  // a.length * b.length === MAX_DIFF_CELLS exactly stays on the "not >" side
  // of the guard, so this must produce diff-ctx rows, not a before/after dump.
  const rows = diffLines('shared', 'shared');
  assert.deepEqual(rows, [{ text: 'shared', cls: 'diff-ctx', lineNo: 1 }]);
});
