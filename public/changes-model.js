// Pure helpers behind the detail pane's Changes tab (no DOM): folding a
// session's Edit/MultiEdit/Write calls into one net diff per file, and
// splitting `git diff` output into per-file sections.
import { diffLines, countDiff } from './diff-lines.js';

const filePathOf = (input) => input.file_path || input.target_file || input.path || null;

// Replays edits in order. An edit whose old_string sits inside an earlier
// edit's result is merged into that region, so A->B followed by B->C reads
// as A->C. A Write replaces everything (old: null means "whole file new").
// Calls without old/new text (Grok/Codex multi-file `changes`) are skipped.
// Returns Map<path, [{ old, new }]>.
export function foldFileEdits(calls) {
  const byPath = new Map();
  const apply = (path, oldText, newText) => {
    const segments = byPath.get(path) || [];
    byPath.set(path, segments);
    const hit = oldText ? segments.findLast((s) => s.new.includes(oldText)) : null;
    if (hit) hit.new = hit.new.replace(oldText, () => newText);
    else segments.push({ old: oldText, new: newText });
  };
  for (const { name, input } of calls) {
    if (!input || typeof input !== 'object') continue;
    const path = filePathOf(input);
    if (!path) continue;
    if (name === 'Write' && typeof input.content === 'string') {
      byPath.set(path, [{ old: null, new: input.content }]);
    } else if (name === 'Edit' && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
      apply(path, input.old_string, input.new_string);
    } else if (name === 'MultiEdit' && Array.isArray(input.edits)) {
      for (const e of input.edits) {
        if (typeof e?.old_string === 'string' && typeof e?.new_string === 'string') apply(path, e.old_string, e.new_string);
      }
    }
  }
  for (const [path, segments] of byPath) {
    const live = segments.filter((s) => s.old !== s.new);
    if (live.length) byPath.set(path, live);
    else byPath.delete(path);
  }
  return byPath;
}

// Segments -> renderBody-style rows with a per-region @@ header.
export function segmentsToLines(segments) {
  const lines = [];
  segments.forEach((seg, i) => {
    if (segments.length > 1) lines.push({ text: `@@ region ${i + 1}/${segments.length} @@`, cls: 'diff-hunk' });
    if (seg.old == null) {
      // A trailing newline terminates the last line; it isn't an extra empty one.
      const text = seg.new.endsWith('\n') ? seg.new.slice(0, -1) : seg.new;
      text.split('\n').forEach((line, n) => lines.push({ text: line, cls: 'diff-add', lineNo: n + 1 }));
    } else {
      lines.push(...diffLines(seg.old, seg.new));
    }
  });
  return lines;
}

export const countLines = countDiff;

// /diff response -> { diff, error? }. A non-OK reply or a non-JSON body must
// surface as an error rather than read as an empty diff ("No changes.").
export async function diffFromResponse(res) {
  const data = await res.json().catch(() => null);
  if (res.ok && data && typeof data === 'object') return data;
  return { diff: '', error: data?.error || `HTTP ${res.status}` };
}

// Git C-quotes paths holding quotes, backslashes or control characters.
const ESCAPES = { n: '\n', t: '\t', '"': '"', '\\': '\\' };
function unquoteGitPath(token) {
  const enc = new TextEncoder();
  const body = token.slice(1, -1);
  const bytes = [];
  for (let i = 0; i < body.length; i++) {
    if (body[i] !== '\\') { bytes.push(...enc.encode(body[i])); continue; }
    const octal = /^[0-7]{3}/.exec(body.slice(i + 1));
    if (octal) { bytes.push(parseInt(octal[0], 8)); i += 3; }
    else { i += 1; bytes.push(...enc.encode(ESCAPES[body[i]] ?? body[i])); }
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

// `diff --git a/<x> b/<y>` -> y, handling quoted paths and spaces.
function pathFromDiffHeader(line) {
  const rest = line.slice('diff --git '.length);
  const quoted = /(?:^| )("b\/(?:[^"\\]|\\.)*")$/.exec(rest);
  if (quoted) return unquoteGitPath(quoted[1]).slice(2);
  const same = /^a\/(.+) b\/\1$/.exec(rest);
  if (same) return same[1];
  const split = /^(?:"a\/(?:[^"\\]|\\.)*"|a\/.+?) b\/(.+)$/.exec(rest);
  return split ? split[1] : null;
}

// `git diff` text -> [{ path, added, removed, lines: [{ text, cls }] }].
// Inside a hunk every +/- line is content, even one that reads `--- x`.
export function parseUnifiedDiff(text) {
  const files = [];
  let cur = null;
  let inHunk = false;
  for (const line of (text || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const path = pathFromDiffHeader(line);
      cur = path == null ? null : { path, added: 0, removed: 0, lines: [] };
      if (cur) files.push(cur);
      inHunk = false;
    }
    if (!cur) continue;
    let cls = '';
    if (line.startsWith('@@')) { cls = 'diff-hunk'; inHunk = true; }
    else if (inHunk && line.startsWith('+')) { cls = 'diff-add'; cur.added++; }
    else if (inHunk && line.startsWith('-')) { cls = 'diff-del'; cur.removed++; }
    else if (!inHunk) cls = 'diff-meta';
    cur.lines.push({ text: line, cls });
  }
  return files;
}
