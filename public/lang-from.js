// Prism language ids for tool payload/result highlighting. File-backed tools
// (Read/Write/Edit) key off an explicit path field. Shell tools have no
// file_path, so a conservative parse of the command decides whether stdout
// is the file (sed/cat/head on foo.cpp) rather than a program's own output
// (python foo.py, grep, echo). Unmapped extensions stay plain text.

const LANG_BY_EXT = {
  js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'jsx',
  ts: 'typescript', mts: 'typescript', cts: 'typescript', tsx: 'tsx',
  json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash',
  bat: 'batch', cmd: 'batch',
  ps1: 'powershell', psm1: 'powershell', psd1: 'powershell',
  py: 'python', pyw: 'python',
  c: 'c', h: 'c',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', hh: 'cpp', hxx: 'cpp',
  go: 'go', rs: 'rust', java: 'java', sql: 'sql', cs: 'csharp',
  yml: 'yaml', yaml: 'yaml',
  md: 'markdown', markdown: 'markdown',
  css: 'css',
  html: 'markup', htm: 'markup', xml: 'markup', svg: 'markup', vue: 'markup',
};

const PATH_KEYS = ['file_path', 'target_file', 'path', 'notebook_path'];

// Stdout is the file (or a transform of it), not a compiler/interpreter log.
const CONTENT_FILTERS = new Set([
  'cat', 'head', 'tail', 'sed', 'gsed', 'awk', 'gawk', 'nawk', 'mawk',
  'cut', 'nl', 'tac', 'rev', 'fmt', 'fold', 'expand', 'unexpand', 'tr',
  'tee', 'col', 'pr',
  'type', 'get-content', 'gc',
]);

const SEARCH_TOOLS = new Set(['Grep', 'Glob', 'WebSearch', 'WebFetch']);
const SHELL_TOOLS = new Set(['Bash', 'BashOutput', 'run_terminal_command', 'shell']);

const JSON_SNIFF_MAX = 200000;

export function langFromPath(filePath) {
  if (typeof filePath !== 'string') return null;
  const m = /\.([a-zA-Z0-9]+)$/.exec(filePath);
  return m ? (LANG_BY_EXT[m[1].toLowerCase()] || null) : null;
}

export function langFromInput(input) {
  if (!input || typeof input !== 'object') return null;
  for (const key of PATH_KEYS) {
    if (typeof input[key] === 'string') {
      const lang = langFromPath(input[key]);
      if (lang) return lang;
    }
  }
  return null;
}

export function langFromCommand(command) {
  if (typeof command !== 'string' || !command.trim()) return null;
  const inner = unwrapLauncher(command);
  const chain = splitOutsideQuotes(inner, chainSep);
  if (!chain.length) return null;
  const stages = splitOutsideQuotes(chain[chain.length - 1], pipeSep);
  if (!stages.length) return null;

  const lastArgv = tokenize(stages[stages.length - 1]);
  if (!CONTENT_FILTERS.has(commandVerb(lastArgv[0]))) return null;

  let langs = pathLangs(lastArgv);
  if (langs.size === 0) {
    for (let i = stages.length - 2; i >= 0; i--) {
      const argv = tokenize(stages[i]);
      if (!CONTENT_FILTERS.has(commandVerb(argv[0]))) break;
      langs = pathLangs(argv);
      if (langs.size) break;
    }
  }
  return langs.size === 1 ? langs.values().next().value : null;
}

export function langFromResultText(text) {
  if (typeof text !== 'string') return null;
  if (text.length > JSON_SNIFF_MAX) return null;
  const t = text.trim();
  if (!t) return null;
  const obj = t.startsWith('{') && t.endsWith('}');
  const arr = t.startsWith('[') && t.endsWith(']');
  if (!obj && !arr) return null;
  try {
    JSON.parse(t);
    return 'json';
  } catch {
    return null;
  }
}

export function langForToolResult(record) {
  if (!record) return null;
  const name = record.name;
  const input = record.input;
  if (!SEARCH_TOOLS.has(name)) {
    const fromPath = langFromInput(input);
    if (fromPath) return fromPath;
  }
  if (SHELL_TOOLS.has(name) && typeof input?.command === 'string') {
    const fromCmd = langFromCommand(input.command);
    if (fromCmd) return fromCmd;
  }
  return langFromResultText(record.resultText);
}

// Codex-on-Windows compact rows already unwrap this; reuse the same shape so
// `powershell.exe -Command "sed ... foo.cpp"` still sees the inner command.
export function unwrapLauncher(command) {
  if (typeof command !== 'string') return command;
  const match = /^\s*(?:"[^"]+"|'[^']+'|\S+)\s+-Command\s+([\s\S]*)$/i.exec(command);
  if (!match) return command;
  let inner = match[1].trim();
  const q = inner[0];
  if ((q === '"' || q === "'") && inner.length >= 2 && inner.endsWith(q)) {
    inner = inner.slice(1, -1);
  }
  return inner;
}

function chainSep(s, i) {
  if (s[i] === ';') return 1;
  if (s[i] === '&' && s[i + 1] === '&') return 2;
  if (s[i] === '|' && s[i + 1] === '|') return 2;
  return 0;
}

function pipeSep(s, i) {
  if (s[i] === '|' && s[i + 1] !== '|') return 1;
  return 0;
}

function splitOutsideQuotes(src, isSep) {
  const parts = [];
  let i = 0;
  let start = 0;
  let quote = null;
  const s = src;
  while (i < s.length) {
    const c = s[i];
    if (quote) {
      if (c === quote) quote = null;
      i += 1;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      i += 1;
      continue;
    }
    const n = isSep(s, i);
    if (n) {
      const piece = s.slice(start, i).trim();
      if (piece) parts.push(piece);
      i += n;
      start = i;
      continue;
    }
    i += 1;
  }
  const tail = s.slice(start).trim();
  if (tail) parts.push(tail);
  return parts;
}

function tokenize(src) {
  const tokens = [];
  let i = 0;
  const s = src;
  const isSpace = (c) => c === ' ' || c === '\t' || c === '\n' || c === '\r';
  while (i < s.length) {
    while (i < s.length && isSpace(s[i])) i += 1;
    if (i >= s.length) break;
    if (s[i] === '#') break;
    let quote = null;
    let tok = '';
    while (i < s.length) {
      const c = s[i];
      if (quote) {
        if (c === quote) {
          quote = null;
          i += 1;
          continue;
        }
        tok += c;
        i += 1;
        continue;
      }
      if (c === "'" || c === '"') {
        quote = c;
        i += 1;
        continue;
      }
      if (isSpace(c)) break;
      tok += c;
      i += 1;
    }
    if (tok) tokens.push(tok);
  }
  return tokens;
}

function commandVerb(token) {
  if (!token) return '';
  const base = token.replace(/\\/g, '/').split('/').pop();
  return base.replace(/\.exe$/i, '').toLowerCase();
}

function pathLangs(argv) {
  const langs = new Set();
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok || tok.startsWith('-')) continue;
    // sed/perl s/// scripts are not paths, even when they mention an extension.
    if (/^s[/:|#@]/.test(tok)) continue;
    const lang = langFromPath(tok);
    if (lang) langs.add(lang);
  }
  return langs;
}
