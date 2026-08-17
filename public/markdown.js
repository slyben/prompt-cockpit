// Minimal Markdown -> DOM renderer for Claude's own reply text (stream-
// view.js's renderAssistant, text blocks only - not tool args/results, not
// thinking, not user messages). Hand-rolled like everything else in this
// app's public/*.js (no bundler, no npm deps shipped to the client) rather
// than pulling in marked/markdown-it - this only needs to cover what Claude
// actually produces in prose replies: headers, bold/italic, inline code,
// fenced code blocks, links, lists, blockquotes, horizontal rules,
// paragraphs. Not a spec-complete CommonMark implementation.
//
// Safety: every leaf is built via textContent/createElement, never
// innerHTML - so there's no HTML-injection surface even though the source
// text is model-generated and not sanitized upstream.

const INLINE_CODE_RE = /`([^`]+)`/;
const BOLD_RE = /\*\*([^*]+)\*\*|__([^_]+)__/;
const ITALIC_RE = /\*([^*]+)\*|_([^_]+)_/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;

// Finds the earliest-matching inline marker in `text` among the patterns
// above, applies it, and recurses on both sides - so e.g. "**bold `code`**"
// nests a <code> inside the <strong> instead of only matching the outermost
// pattern and giving up on the rest.
function renderInline(text, out) {
  if (!text) return;
  const candidates = [
    { re: INLINE_CODE_RE, tag: 'code' },
    { re: BOLD_RE, tag: 'strong' },
    { re: ITALIC_RE, tag: 'em' },
    { re: LINK_RE, tag: 'a' },
  ];
  let earliest = null;
  for (const c of candidates) {
    const m = c.re.exec(text);
    if (m && (!earliest || m.index < earliest.match.index)) earliest = { ...c, match: m };
  }
  if (!earliest) {
    out.append(document.createTextNode(text));
    return;
  }
  const { match, tag } = earliest;
  if (match.index > 0) out.append(document.createTextNode(text.slice(0, match.index)));
  if (tag === 'a') {
    const a = document.createElement('a');
    a.href = match[2];
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    renderInline(match[1], a);
    out.append(a);
  } else if (tag === 'code') {
    const code = document.createElement('code');
    code.textContent = match[1];
    out.append(code);
  } else {
    const el = document.createElement(tag);
    renderInline(match[1] ?? match[2], el);
    out.append(el);
  }
  renderInline(text.slice(match.index + match[0].length), out);
}

function appendInline(parent, text) {
  renderInline(text, parent);
}

// Groups raw lines into block-level chunks (paragraph/list/code-fence/
// blockquote/heading/hr), then renders each chunk to a DOM element appended
// to `root`. Line-based, single pass, no lookahead beyond "does the next
// line belong to the same block" - matches the flat structure of the prose
// Claude actually writes (no nested lists/blockquotes support).
export function renderMarkdown(text) {
  const root = document.createDocumentFragment();
  const lines = String(text ?? '').replace(/\r\n/g, '\n').split('\n');
  let i = 0;

  function flushParagraph(buf) {
    if (!buf.length) return;
    const p = document.createElement('p');
    appendInline(p, buf.join('\n'));
    root.append(p);
    buf.length = 0;
  }

  let paraBuf = [];
  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block - verbatim, no inline parsing inside.
    const fence = /^```(\w*)/.exec(line);
    if (fence) {
      flushParagraph(paraBuf);
      const codeLines = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) {
        codeLines.push(lines[i]);
        i++;
      }
      i++; // consume closing fence
      const pre = document.createElement('pre');
      const code = document.createElement('code');
      if (fence[1]) code.dataset.lang = fence[1];
      code.textContent = codeLines.join('\n');
      pre.append(code);
      root.append(pre);
      continue;
    }

    // ATX heading.
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph(paraBuf);
      const h = document.createElement(`h${heading[1].length}`);
      appendInline(h, heading[2]);
      root.append(h);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(line.trim())) {
      flushParagraph(paraBuf);
      root.append(document.createElement('hr'));
      i++;
      continue;
    }

    // Blockquote - consecutive '>' lines become one <blockquote>.
    if (/^>\s?/.test(line)) {
      flushParagraph(paraBuf);
      const quoteLines = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoteLines.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      const bq = document.createElement('blockquote');
      appendInline(bq, quoteLines.join('\n'));
      root.append(bq);
      continue;
    }

    // Unordered list.
    if (/^[-*+]\s+/.test(line)) {
      flushParagraph(paraBuf);
      const ul = document.createElement('ul');
      while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
        const li = document.createElement('li');
        appendInline(li, lines[i].replace(/^[-*+]\s+/, ''));
        ul.append(li);
        i++;
      }
      root.append(ul);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(line)) {
      flushParagraph(paraBuf);
      const ol = document.createElement('ol');
      while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
        const li = document.createElement('li');
        appendInline(li, lines[i].replace(/^\d+\.\s+/, ''));
        ol.append(li);
        i++;
      }
      root.append(ol);
      continue;
    }

    // Blank line - paragraph break.
    if (!line.trim()) {
      flushParagraph(paraBuf);
      i++;
      continue;
    }

    // Default: accumulate into the current paragraph.
    paraBuf.push(line);
    i++;
  }
  flushParagraph(paraBuf);
  return root;
}
