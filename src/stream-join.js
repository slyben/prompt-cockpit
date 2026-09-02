// Grok streams BPE pieces; a bare trailing newline is usually a word
// boundary, not a paragraph break, so it's rewritten to a space (a real
// blank line \n\n is kept). Markdown block lines (tables, lists, fences,
// headings) and anything inside an open fence keep their newlines.
// Shared verbatim with the browser (stream-view.js) - no Node imports.

const MARKDOWN_BLOCK_RE = /^\s*(```|~~~|#{1,6}\s|[-*+]\s|\d+\.\s|>\s?|\|)|^\s*(-{3,}|\*{3,}|_{3,})\s*$/;

function lastLine(s) {
  const trimmed = String(s).replace(/\n+$/, '');
  const idx = trimmed.lastIndexOf('\n');
  return idx === -1 ? trimmed : trimmed.slice(idx + 1);
}

function isMarkdownBlockLine(s) {
  return MARKDOWN_BLOCK_RE.test(lastLine(s));
}

function fenceOpenerAt(str, lineStart) {
  if (str.startsWith('```', lineStart)) return '```';
  if (str.startsWith('~~~', lineStart)) return '~~~';
  return null;
}

// A ``` fence isn't closed by ~~~ and vice versa. `tracker` ({committedLen,
// open}), when passed, resumes scanning from the last complete line
// instead of rescanning the whole buffer each chunk - without it a long
// reply becomes an O(n^2) walk. It only commits past a real newline, so
// an open final line is always rescanned, never double-counted.
function isInsideFence(s, tracker) {
  const str = String(s);
  let open = tracker ? tracker.open : null;
  let lineStart = tracker && tracker.committedLen <= str.length ? tracker.committedLen : 0;
  if (tracker && lineStart === 0) tracker.open = null;
  for (let i = lineStart; i <= str.length; i++) {
    if (i === str.length || str[i] === '\n') {
      const opener = fenceOpenerAt(str, lineStart);
      if (opener) {
        if (open === null) open = opener;
        else if (open === opener) open = null;
      }
      if (tracker && i < str.length) {
        tracker.committedLen = i + 1;
        tracker.open = open;
      }
      lineStart = i + 1;
    }
  }
  return open !== null;
}

// Per-buffer state for the `tracker` param above; create one per buffer
// that re-joins onto the same growing text each chunk. Omitting it just
// falls back to a full rescan, so it's always safe to leave out.
export function createFenceTracker() {
  return { committedLen: 0, open: null };
}

export function joinStreamText(existing, next, tracker) {
  const left = existing ?? '';
  const right = next ?? '';
  if (!left) return right;
  if (!right) return left;
  let a = left;
  if (a.endsWith('\n') && !a.endsWith('\n\n') && !right.startsWith('\n')) {
    const withoutNl = a.slice(0, -1);
    if (isInsideFence(withoutNl, tracker) || isMarkdownBlockLine(withoutNl) || isMarkdownBlockLine(right)) {
      return a + right;
    }
    a = withoutNl;
    if (/\s$/.test(a) || /^\s/.test(right) || /^[,.;:!?')\]}]/.test(right)) {
      return a + right;
    }
    return `${a} ${right}`;
  }
  return a + right;
}
