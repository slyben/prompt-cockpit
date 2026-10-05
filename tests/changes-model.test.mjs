import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldFileEdits, segmentsToLines, parseUnifiedDiff, countLines, diffFromResponse } from '../public/changes-model.js';

const edit = (file_path, old_string, new_string) => ({ name: 'Edit', input: { file_path, old_string, new_string } });

test('chained edits on the same region collapse to one old->new segment', () => {
  const folded = foldFileEdits([edit('a.js', 'foo', 'bar'), edit('a.js', 'bar', 'baz')]);
  assert.deepEqual(folded.get('a.js'), [{ old: 'foo', new: 'baz' }]);
});

test('edits in unrelated regions stay separate segments, in order', () => {
  const folded = foldFileEdits([edit('a.js', 'x', 'y'), edit('a.js', 'p', 'q')]);
  assert.equal(folded.get('a.js').length, 2);
});

test('an edit that is undone by a later one drops out entirely', () => {
  const folded = foldFileEdits([edit('a.js', 'foo', 'bar'), edit('a.js', 'bar', 'foo')]);
  assert.equal(folded.has('a.js'), false);
});

test('MultiEdit folds like sequential edits; Write resets the file to full content', () => {
  const multi = { name: 'MultiEdit', input: { file_path: 'a.js', edits: [{ old_string: 'a', new_string: 'b' }, { old_string: 'b', new_string: 'c' }] } };
  assert.deepEqual(foldFileEdits([multi]).get('a.js'), [{ old: 'a', new: 'c' }]);
  const write = { name: 'Write', input: { file_path: 'a.js', content: 'one\ntwo' } };
  const folded = foldFileEdits([edit('a.js', 'a', 'b'), write]);
  assert.deepEqual(folded.get('a.js'), [{ old: null, new: 'one\ntwo' }]);
});

test('calls without old/new text (multi-file changes payloads) are skipped', () => {
  assert.equal(foldFileEdits([{ name: 'Edit', input: { changes: [{ path: 'a.js' }] } }]).size, 0);
});

test('segmentsToLines labels regions only when there are several; Write renders as all-added', () => {
  const two = segmentsToLines([{ old: 'x', new: 'y' }, { old: 'p', new: 'q' }]);
  assert.equal(two.filter((l) => l.cls === 'diff-hunk').length, 2);
  const one = segmentsToLines([{ old: null, new: 'a\nb' }]);
  assert.deepEqual(countLines(one), { added: 2, removed: 0 });
  assert.equal(one.some((l) => l.cls === 'diff-hunk'), false);
});

test('parseUnifiedDiff splits per file and counts +/- without counting ---/+++ headers', () => {
  const text = [
    'diff --git a/a.js b/a.js', 'index 1..2 100644', '--- a/a.js', '+++ b/a.js', '@@ -1,2 +1,2 @@', ' keep', '-old', '+new',
    'diff --git a/b.js b/b.js', 'index 3..4 100644', '--- a/b.js', '+++ b/b.js', '@@ -1 +1,2 @@', ' keep', '+added', '',
  ].join('\n');
  const files = parseUnifiedDiff(text);
  assert.deepEqual(files.map((f) => [f.path, f.added, f.removed]), [['a.js', 1, 1], ['b.js', 1, 0]]);
  assert.equal(files[0].lines.find((l) => l.text === '-old').cls, 'diff-del');
  assert.deepEqual(parseUnifiedDiff(''), []);
});

test('parseUnifiedDiff counts removed/added lines that look like ---/+++ headers', () => {
  const text = ['diff --git a/q.sql b/q.sql', 'index 1..2 100644', '--- a/q.sql', '+++ b/q.sql', '@@ -1,2 +1,2 @@', '--- a comment', '+++ b comment', ' keep', ''].join('\n');
  const [file] = parseUnifiedDiff(text);
  assert.deepEqual([file.added, file.removed], [1, 1]);
  assert.equal(file.lines.find((l) => l.text === '--- a comment').cls, 'diff-del');
});

test('parseUnifiedDiff keeps files whose paths are quoted or contain spaces', () => {
  const text = [
    'diff --git "a/tab\\tname.js" "b/tab\\tname.js"', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/my file.js b/my file.js', '@@ -1 +1 @@', '-a', '+b',
    'diff --git "a/caf\\303\\251.js" "b/caf\\303\\251.js"', '@@ -1 +1 @@', '-a', '+b',
    'diff --git a/old.js "b/new\\"q.js"', 'similarity index 100%', '',
  ].join('\n');
  assert.deepEqual(parseUnifiedDiff(text).map((f) => f.path), ['tab\tname.js', 'my file.js', 'café.js', 'new"q.js']);
});

test('a Write whose content ends in a newline does not add a phantom empty line', () => {
  const lines = segmentsToLines([{ old: null, new: 'one\ntwo\n' }]);
  assert.deepEqual(lines.map((l) => l.text), ['one', 'two']);
  assert.deepEqual(countLines(lines), { added: 2, removed: 0 });
});

const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => { if (body === undefined) throw new SyntaxError('bad json'); return body; } });

test('diffFromResponse passes an OK body through and turns failures into errors', async () => {
  assert.deepEqual(await diffFromResponse(reply(200, { diff: 'x', mode: 'head' })), { diff: 'x', mode: 'head' });
  assert.equal((await diffFromResponse(reply(401, { error: 'invalid or missing session token' }))).error, 'invalid or missing session token');
  assert.equal((await diffFromResponse(reply(500, { message: 'x' }))).error, 'HTTP 500');
  assert.equal((await diffFromResponse(reply(502, undefined))).error, 'HTTP 502');
});
