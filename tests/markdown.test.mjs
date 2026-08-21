import { test } from 'node:test';
import assert from 'node:assert/strict';
import { installDomStub } from './helpers/dom-stub.mjs';

installDomStub();
const { renderMarkdown, isSafeHref } = await import('../public/markdown.js');

function html(text) { return renderMarkdown(text).toHTML(); }

test('renderMarkdown wraps plain prose in a single <p>', () => {
  assert.equal(html('just some text'), '<p>just some text</p>');
});

test('renderMarkdown blank line breaks paragraphs', () => {
  assert.equal(html('one\n\ntwo'), '<p>one</p><p>two</p>');
});

test('renderMarkdown renders bold, italic, and inline code', () => {
  assert.equal(html('**bold**'), '<p><strong>bold</strong></p>');
  assert.equal(html('*italic*'), '<p><em>italic</em></p>');
  assert.equal(html('_italic_'), '<p><em>italic</em></p>');
  assert.equal(html('`code`'), '<p><code>code</code></p>');
});

test('renderMarkdown nests inline marks (bold containing code)', () => {
  assert.equal(html('**bold `code`**'), '<p><strong>bold <code>code</code></strong></p>');
});

test('renderMarkdown renders links with target/rel set for safety', () => {
  assert.equal(
    html('[text](https://example.com)'),
    '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">text</a></p>',
  );
});

test('renderMarkdown does not turn a javascript: link into a real href', () => {
  assert.equal(html("[click me](javascript:document.title='pwned')"), '<p>click me</p>');
});

test('renderMarkdown does not turn a data: link into a real href', () => {
  assert.equal(html('[x](data:text/html,evil)'), '<p>x</p>');
});

test('renderMarkdown strips whitespace/tab/newline before checking the link scheme', () => {
  assert.equal(html("[x](java\tscript:document.title='p')"), '<p>x</p>');
});

test('renderMarkdown allows mailto: links', () => {
  assert.equal(
    html('[mail](mailto:a@b.com)'),
    '<p><a href="mailto:a@b.com" target="_blank" rel="noopener noreferrer">mail</a></p>',
  );
});

test('isSafeHref allows http/https/mailto and rejects everything else', () => {
  assert.equal(isSafeHref('https://example.com'), 'https://example.com');
  assert.equal(isSafeHref('http://example.com'), 'http://example.com');
  assert.equal(isSafeHref('mailto:a@b.com'), 'mailto:a@b.com');
  assert.equal(isSafeHref('javascript:alert(1)'), null);
  assert.equal(isSafeHref('data:text/html,evil'), null);
  assert.equal(isSafeHref('vbscript:msgbox(1)'), null);
  assert.equal(isSafeHref(''), null);
  assert.equal(isSafeHref(undefined), null);
});

test('renderMarkdown renders a fenced code block verbatim, no inline parsing inside', () => {
  const out = html('```js\nconst x = **not bold**;\n```');
  assert.equal(out, '<pre><code data-lang="js">const x = **not bold**;</code></pre>');
});

test('renderMarkdown keeps c++-style language tags that are not just word chars', () => {
  const out = html('```c++\nint x = 1;\n```');
  assert.equal(out, '<pre><code data-lang="c++">int x = 1;</code></pre>');
});

test('renderMarkdown treats leftover text on a fence opener as the first code line, not a language tag', () => {
  const out = html('```Mode   LastWriteTime          Length Name\n----   -------------\n```');
  assert.equal(
    out,
    '<pre><code>Mode   LastWriteTime          Length Name\n----   -------------</code></pre>',
  );
});

test('renderMarkdown renders ATX headings h1-h6', () => {
  for (let n = 1; n <= 6; n++) {
    assert.equal(html(`${'#'.repeat(n)} Heading`), `<h${n}>Heading</h${n}>`);
  }
});

test('renderMarkdown renders a horizontal rule', () => {
  assert.equal(html('---'), '<hr>');
});

test('renderMarkdown renders a blockquote', () => {
  assert.equal(html('> quoted text'), '<blockquote>quoted text</blockquote>');
});

test('renderMarkdown renders a flat unordered list', () => {
  assert.equal(html('- one\n- two'), '<ul><li>one</li><li>two</li></ul>');
});

test('renderMarkdown renders a flat ordered list', () => {
  assert.equal(html('1. one\n2. two'), '<ol><li>one</li><li>two</li></ol>');
});

test('renderMarkdown nests an indented sub-list inside its parent <li>', () => {
  const out = html('- top one\n- top two\n  - nested a\n  - nested b\n- top three');
  assert.equal(
    out,
    '<ul><li>top one</li><li>top two<ul><li>nested a</li><li>nested b</li></ul></li><li>top three</li></ul>',
  );
});

test('renderMarkdown nests an indented sub-list under an ordered list item too', () => {
  const out = html('1. first\n2. second\n   1. sub one\n   2. sub two');
  assert.equal(
    out,
    '<ol><li>first</li><li>second<ol><li>sub one</li><li>sub two</li></ol></li></ol>',
  );
});

test('renderMarkdown renders GFM task-list checkboxes, checked and unchecked', () => {
  const out = html('- [ ] todo\n- [x] done');
  const boxes = renderMarkdown('- [ ] todo\n- [x] done').querySelectorAll('input');
  assert.equal(boxes.length, 2);
  assert.equal(boxes[0]._checked, false);
  assert.equal(boxes[0]._disabled, true);
  assert.equal(boxes[1]._checked, true);
  assert.match(out, /class="task-list-item"/);
  assert.match(out, /todo/);
  assert.match(out, /done/);
});

test('renderMarkdown renders GFM strikethrough', () => {
  assert.equal(html('~~gone~~'), '<p><s>gone</s></p>');
});

test('renderMarkdown honors backslash-escaped markers as literal characters', () => {
  assert.equal(html('\\*not bold\\*'), '<p>*not bold*</p>');
});

test('renderMarkdown renders *** as bold italic', () => {
  assert.equal(html('***both***'), '<p><strong><em>both</em></strong></p>');
});

test('renderMarkdown nests italic inside bold', () => {
  assert.equal(html('**bold *italic* still**'), '<p><strong>bold <em>italic</em> still</strong></p>');
});

test('renderMarkdown does not italicize snake_case identifiers', () => {
  assert.equal(html('see file_name_here please'), '<p>see file_name_here please</p>');
});

test('renderMarkdown still italicizes flanking underscore words', () => {
  assert.equal(html('say _this_ please'), '<p>say <em>this</em> please</p>');
});

test('renderMarkdown does not treat mid-identifier __ as bold', () => {
  assert.equal(html('foo__bar__baz'), '<p>foo__bar__baz</p>');
});

test('renderMarkdown strips a GFM link title out of href', () => {
  assert.equal(
    html('[x](https://example.com "t")'),
    '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">x</a></p>',
  );
});

test('renderMarkdown turns image markup into a labeled link, without a leftover bang', () => {
  assert.equal(
    html('![alt](https://example.com/a.png)'),
    '<p><a href="https://example.com/a.png" target="_blank" rel="noopener noreferrer">alt</a></p>',
  );
});

test('renderMarkdown does not turn a javascript: image into a real href', () => {
  assert.equal(html('![x](javascript:alert(1))'), '<p>x</p>');
});

test('renderMarkdown renders a tilde-fenced code block verbatim', () => {
  const out = html('~~~\nconst x = **not bold**;\n~~~');
  assert.equal(out, '<pre><code>const x = **not bold**;</code></pre>');
});

test('renderMarkdown does not close a backtick fence with tildes', () => {
  const out = html('```\n~~~\nstill code\n```');
  assert.equal(out, '<pre><code>~~~\nstill code</code></pre>');
});

test('renderMarkdown renders a GFM pipe table with column alignment', () => {
  const md = '| A | B |\n| :-- | --: |\n| a1 | b1 |';
  const out = html(md);
  assert.match(out, /^<table>/);
  assert.match(out, /<th style="text-align:left">A<\/th>/);
  assert.match(out, /<th style="text-align:right">B<\/th>/);
  assert.match(out, /<td style="text-align:left">a1<\/td>/);
  assert.match(out, /<td style="text-align:right">b1<\/td>/);
});

test('renderMarkdown table cells tolerate an escaped pipe', () => {
  const md = '| A |\n| --- |\n| a\\|b |';
  const out = html(md);
  assert.match(out, /<td[^>]*>a\|b<\/td>/);
});

test('renderMarkdown does not treat a lone pipe-containing line as a table without a delimiter row', () => {
  const out = html('a | b');
  assert.equal(out, '<p>a | b</p>');
});

test('Grok-streamed table/list/fence chunks still render as markdown after joinStreamText', async () => {
  const { joinStreamText } = await import('../src/grok-messages.js');
  const table = ['| A | B |\n', '| --- | --- |\n', '| 1 | 2 |\n'].reduce((acc, chunk) => joinStreamText(acc, chunk), '');
  const tableHtml = html(table);
  assert.match(tableHtml, /^<table>/);
  assert.match(tableHtml, /<th>A<\/th>/);
  assert.match(tableHtml, /<td>1<\/td>/);

  const list = ['- one\n', '- two\n'].reduce((acc, chunk) => joinStreamText(acc, chunk), '');
  assert.equal(html(list), '<ul><li>one</li><li>two</li></ul>');

  const fence = ['```\n', 'code line\n', '```\n', '## After\n'].reduce((acc, chunk) => joinStreamText(acc, chunk), '');
  const fenceHtml = html(fence);
  assert.match(fenceHtml, /<pre><code>code line<\/code><\/pre>/);
  assert.match(fenceHtml, /<h2>After<\/h2>/);
  assert.doesNotMatch(fenceHtml, /## After/);

  // Directory-listing rows are not markdown structure; they still have to
  // survive joinStreamText as separate lines inside the fence.
  const listing = [
    'Listed files:\n\n',
    '```\n',
    'Mode   LastWriteTime          Length Name\n',
    '----   -------------          ------ ----\n',
    'd----- 2026-08-21 12:34:48 AM        .claude\n',
    '```\n',
  ].reduce((acc, chunk) => joinStreamText(acc, chunk), '');
  const listingHtml = html(listing);
  assert.match(listingHtml, /<p>Listed files:<\/p>/);
  assert.match(
    listingHtml,
    /<pre><code>Mode   LastWriteTime          Length Name\n----   -------------          ------ ----\nd----- 2026-08-21 12:34:48 AM        \.claude<\/code><\/pre>/,
  );
});

test('renderMarkdown builds elements via textContent, never HTML injection, even for angle-bracket text', () => {
  const out = html('<img src=x onerror=alert(1)>');
  assert.equal(out, '<p>&lt;img src=x onerror=alert(1)&gt;</p>');
});

test('renderMarkdown escapes ampersand/angle-brackets inside inline code too', () => {
  const out = html('`<b>&x</b>`');
  assert.equal(out, '<p><code>&lt;b&gt;&amp;x&lt;/b&gt;</code></p>');
});
