// Grok streams BPE pieces (Rac + oon). Inventing a space between every
// bare pair is what turned "Racoon" into "Rac oon". A single trailing
// newline is usually a word boundary rather than a paragraph (thinking
// chunks are often "The\n" + "user\n"); a real blank line (\n\n) is kept.
//
// Exception: that word-boundary rewrite destroys markdown. Table rows,
// list items, fences, and headings are each one line with a trailing \n,
// and turning those into spaces is what flattened Grok replies into one
// giant paragraph (and let an unclosed fence swallow the rest of the turn).
// A fenced body is worse: those lines are deliberately NOT markdown
// structure (a directory listing, Format-Table output), so the block-line
// check never fires - stripping them is what collapsed a <pre> listing
// into one horizontally-scrolling row. Keep newlines while a fence is
// still open.
//
// Shared verbatim with the browser (stream-view.js) via static-files.js
// SHARED_SRC_FILES - no Node-only imports.

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

// Same openers markdown.js uses (a line starting with ``` or ~~~). An
// unmatched opener means the cursor is still inside verbatim content.
// A ``` fence is not closed by ~~~ and vice versa.
function isInsideFence(s) {
  let open = null;
  const str = String(s);
  let lineStart = 0;
  for (let i = 0; i <= str.length; i++) {
    if (i === str.length || str[i] === '\n') {
      const opener = fenceOpenerAt(str, lineStart);
      if (opener) {
        if (open === null) open = opener;
        else if (open === opener) open = null;
      }
      lineStart = i + 1;
    }
  }
  return open !== null;
}

export function joinStreamText(existing, next) {
  const left = existing ?? '';
  const right = next ?? '';
  if (!left) return right;
  if (!right) return left;
  let a = left;
  if (a.endsWith('\n') && !a.endsWith('\n\n') && !right.startsWith('\n')) {
    const withoutNl = a.slice(0, -1);
    if (isInsideFence(withoutNl) || isMarkdownBlockLine(withoutNl) || isMarkdownBlockLine(right)) {
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
