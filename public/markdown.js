// Minimal Markdown -> DOM renderer for Claude's own reply text (stream-
// view.js's renderAssistant, text blocks only - not tool args/results, not
// thinking, not user messages). Hand-rolled like everything else in this
// app's public/*.js (no bundler, no npm deps shipped to the client) rather
// than pulling in marked/markdown-it - this only needs to cover what Claude
// actually produces in prose replies: headers, bold/italic, inline code,
// fenced code blocks, links, lists, blockquotes, horizontal rules,
// GFM pipe tables, paragraphs. Not a spec-complete CommonMark implementation.
//
// Safety: every leaf is built via textContent/createElement, never
// innerHTML - so there's no HTML-injection surface even though the source
// text is model-generated and not sanitized upstream.

const INLINE_CODE_RE = /`([^`]+)`/;
const BOLD_RE = /\*\*([^*]+)\*\*|__([^_]+)__/;
const ITALIC_RE = /\*([^*]+)\*|_([^_]+)_/;
const STRIKE_RE = /~~([^~]+)~~/;
const LINK_RE = /\[([^\]]+)\]\(([^)]+)\)/;
// GFM backslash-escape: a backslash before ASCII punctuation is a literal
// escaped character, not a marker - e.g. "\*not bold\*" shouldn't italicize.
const ESCAPE_RE = /\\([\\`*_{}[\]()#+\-.!~>])/;

// Link destinations are model-generated text, not a trusted URL - without a
// protocol allowlist a reply (or a prompt-injected one) can turn
// "[click here](javascript:...)" into a real clickable anchor on this
// origin, which can then read the session bearer token out of
// sessionStorage and call the authenticated API. Strip stray whitespace/
// tab/newline characters first (browsers ignore them mid-URL, so
// "java" + tab + "script:" still parses as "javascript:"), then allow only
// the schemes a legitimate reply link or MCP auth link ever needs.
const SAFE_HREF_RE = /^(https?:|mailto:)/i;
const STRIP_CHARS = [9, 10, 13].map((code) => String.fromCharCode(code));
export function isSafeHref(raw) {
  let cleaned = String(raw ?? '');
  for (const ch of STRIP_CHARS) cleaned = cleaned.split(ch).join('');
  cleaned = cleaned.trim();
  return SAFE_HREF_RE.test(cleaned) ? cleaned : null;
}

// Finds the earliest-matching inline marker in `text` among the patterns
// above, applies it, and recurses on both sides - so e.g. "**bold `code`**"
// nests a <code> inside the <strong> instead of only matching the outermost
// pattern and giving up on the rest.
function renderInline(text, out) {
  if (!text) return;
  const candidates = [
    { re: ESCAPE_RE, tag: 'esc' },
    { re: INLINE_CODE_RE, tag: 'code' },
    { re: BOLD_RE, tag: 'strong' },
    { re: ITALIC_RE, tag: 'em' },
    { re: STRIKE_RE, tag: 's' },
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
  if (tag === 'esc') {
    out.append(document.createTextNode(match[1]));
  } else if (tag === 'a') {
    const href = isSafeHref(match[2]);
    if (href) {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      renderInline(match[1], a);
      out.append(a);
    } else {
      // Unsafe scheme (javascript:, data:, vbscript:, ...) - render the
      // link label as plain text instead of dropping the content.
      renderInline(match[1], out);
    }
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

// Splits one `| a | b |` row into trimmed cell strings, tolerant of a
// missing leading/trailing pipe and `\|` escaped inside a cell (the only
// way to get a literal pipe into a GFM table cell).
function splitTableRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let j = 0; j < s.length; j++) {
    if (s[j] === '\\' && s[j + 1] === '|') { cur += '|'; j++; continue; }
    if (s[j] === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += s[j];
  }
  cells.push(cur.trim());
  return cells;
}

// GFM's delimiter row: one `---`/`:--`/`--:`/`:-:` cell per column, nothing
// else - this is what disambiguates "a table" from an ordinary line that
// happens to contain a pipe.
function isTableDelimiterRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
}

function tableAlign(delimiterCell) {
  const left = delimiterCell.startsWith(':');
  const right = delimiterCell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return null;
}

const UL_ITEM_RE = /^(\s*)[-*+]\s+(.*)$/;
const OL_ITEM_RE = /^(\s*)\d+\.\s+(.*)$/;
const TASK_ITEM_RE = /^\[([ xX])\]\s+(.*)$/;

// Matches one list-item line regardless of nesting depth or marker type -
// returns its indent width (so callers can tell a nested item from a
// sibling) and whether it's ordered/unordered.
function listItemMatch(line) {
  const ul = UL_ITEM_RE.exec(line);
  if (ul) return { indent: ul[1].length, ordered: false, content: ul[2] };
  const ol = OL_ITEM_RE.exec(line);
  if (ol) return { indent: ol[1].length, ordered: true, content: ol[2] };
  return null;
}

// Consumes a run of same-indent, same-type list-item lines starting at
// `start` into one <ul>/<ol>. A line indented deeper than the current item
// recurses into a nested list appended inside that item's <li> - only two
// levels deep in practice (matches how Claude actually nests sub-bullets),
// but the recursion itself isn't depth-limited.
function parseList(lines, start, indent) {
  const first = listItemMatch(lines[start]);
  const ordered = first.ordered;
  const list = document.createElement(ordered ? 'ol' : 'ul');
  let i = start;
  while (i < lines.length) {
    const m = listItemMatch(lines[i]);
    if (!m || m.indent !== indent || m.ordered !== ordered) break;
    i++;
    const li = document.createElement('li');
    const task = TASK_ITEM_RE.exec(m.content);
    let content = m.content;
    if (task) {
      li.classList.add('task-list-item');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.disabled = true;
      cb.checked = /x/i.test(task[1]);
      li.append(cb);
      content = task[2];
    }
    appendInline(li, content);
    const next = i < lines.length ? listItemMatch(lines[i]) : null;
    if (next && next.indent > indent) {
      const nested = parseList(lines, i, next.indent);
      li.append(nested.node);
      i = nested.i;
    }
    list.append(li);
  }
  return { node: list, i };
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

    // List (ordered or unordered, nested, task-list-aware - see parseList).
    const listItem = listItemMatch(line);
    if (listItem) {
      flushParagraph(paraBuf);
      const { node, i: ni } = parseList(lines, i, listItem.indent);
      root.append(node);
      i = ni;
      continue;
    }

    // GFM table - header row immediately followed by a delimiter row
    // (checked one line ahead, since that's the only thing that tells a
    // table apart from a paragraph line that happens to contain a pipe).
    if (line.includes('|') && i + 1 < lines.length && isTableDelimiterRow(lines[i + 1])) {
      flushParagraph(paraBuf);
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[i + 1]).map(tableAlign);
      i += 2;
      const table = document.createElement('table');
      const thead = document.createElement('thead');
      const headRow = document.createElement('tr');
      headerCells.forEach((cell, idx) => {
        const th = document.createElement('th');
        if (aligns[idx]) th.style.textAlign = aligns[idx];
        appendInline(th, cell);
        headRow.append(th);
      });
      thead.append(headRow);
      table.append(thead);
      const tbody = document.createElement('tbody');
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        const cells = splitTableRow(lines[i]);
        const tr = document.createElement('tr');
        headerCells.forEach((_, idx) => {
          const td = document.createElement('td');
          if (aligns[idx]) td.style.textAlign = aligns[idx];
          appendInline(td, cells[idx] ?? '');
          tr.append(td);
        });
        tbody.append(tr);
        i++;
      }
      table.append(tbody);
      root.append(table);
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
