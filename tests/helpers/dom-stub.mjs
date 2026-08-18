// Minimal DOM stub for testing public/markdown.js's renderMarkdown outside
// a browser. This project ships no jsdom dependency (see tests/README.md's
// "hand-verified only" convention for client-side code) - markdown.js only
// touches a handful of DOM primitives (createElement/createTextNode/
// createDocumentFragment, textContent, append, classList.add, dataset,
// style.textAlign), so a hand-rolled stub covering just those is enough to
// exercise the real rendering logic and assert on real output structure,
// in the same spirit as the rest of this app (hand-rolled over a dependency).
//
// installDomStub() installs `document` as a global and returns nothing;
// call it once per test file (or per test, it's cheap) before importing/
// using renderMarkdown. Elements expose `.toHTML()` for assertions and
// `.querySelectorAll(tag)` (flat, no CSS selector support) for structural
// checks.

class TextNode {
  constructor(text) { this.text = String(text); }
  get textContent() { return this.text; }
  toHTML() {
    return this.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
}

class Element {
  constructor(tag) {
    this.tag = tag;
    this.children = [];
    this.attrs = {};
    this.dataset = {};
    this.style = {};
    this._checked = false;
    this._disabled = false;
    this._type = '';
    this.classList = {
      add: (c) => { this.attrs.class = this.attrs.class ? `${this.attrs.class} ${c}` : c; },
    };
  }
  append(...nodes) { this.children.push(...nodes); }
  set textContent(v) { this.children = [new TextNode(v)]; }
  get textContent() {
    return this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('');
  }
  set href(v) { this.attrs.href = v; }
  set target(v) { this.attrs.target = v; }
  set rel(v) { this.attrs.rel = v; }
  set type(v) { this._type = v; }
  set checked(v) { this._checked = v; }
  set disabled(v) { this._disabled = v; }
  // Flat descendant search by tag name - enough for these tests, no nesting
  // scoping needed since markdown.js's own structures are shallow.
  querySelectorAll(tag) {
    const out = [];
    const walk = (node) => {
      for (const c of node.children || []) {
        if (c.tag === tag) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  toHTML() {
    const attrParts = Object.entries(this.attrs).map(([k, v]) => ` ${k}="${v}"`);
    if (this.dataset.lang) attrParts.push(` data-lang="${this.dataset.lang}"`);
    if (this.style.textAlign) attrParts.push(` style="text-align:${this.style.textAlign}"`);
    if (this.tag === 'input') {
      attrParts.push(` type="${this._type}"`);
      if (this._checked) attrParts.push(' checked');
      if (this._disabled) attrParts.push(' disabled');
      return `<input${attrParts.join('')}>`;
    }
    if (this.tag === 'hr') return `<hr${attrParts.join('')}>`;
    const inner = this.children.map((c) => c.toHTML()).join('');
    return `<${this.tag}${attrParts.join('')}>${inner}</${this.tag}>`;
  }
}

class Fragment {
  constructor() { this.children = []; }
  append(...nodes) { this.children.push(...nodes); }
  querySelectorAll(tag) { return Element.prototype.querySelectorAll.call(this, tag); }
  toHTML() { return this.children.map((c) => c.toHTML()).join(''); }
}

export function installDomStub() {
  globalThis.document = {
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new Fragment(),
  };
}
