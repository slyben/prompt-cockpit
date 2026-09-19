import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  langFromPath,
  langFromInput,
  langFromCommand,
  langFromResultText,
  langForToolResult,
} from '../public/lang-from.js';

test('langFromPath maps known extensions and ignores unknown ones', () => {
  assert.equal(langFromPath('src/foo.cpp'), 'cpp');
  assert.equal(langFromPath('D:\\Dev\\bar.hpp'), 'cpp');
  assert.equal(langFromPath('include/foo.h'), 'c');
  assert.equal(langFromPath('app.js'), 'javascript');
  assert.equal(langFromPath('pkg.json'), 'json');
  assert.equal(langFromPath('setup.sh'), 'bash');
  assert.equal(langFromPath('run.bat'), 'batch');
  assert.equal(langFromPath('run.cmd'), 'batch');
  assert.equal(langFromPath('build.ps1'), 'powershell');
  assert.equal(langFromPath('app.ts'), 'typescript');
  assert.equal(langFromPath('readme.txt'), null);
  assert.equal(langFromPath('Makefile'), null);
  assert.equal(langFromPath(null), null);
});

test('langFromInput reads file_path, target_file, path, notebook_path', () => {
  assert.equal(langFromInput({ file_path: 'a.rs' }), 'rust');
  assert.equal(langFromInput({ target_file: 'a.py' }), 'python');
  assert.equal(langFromInput({ path: 'a.go' }), 'go');
  assert.equal(langFromInput({ notebook_path: 'notes.md' }), 'markdown');
  assert.equal(langFromInput({ command: 'sed a.cpp' }), null);
});

test('langFromCommand highlights content filters aimed at one language', () => {
  assert.equal(langFromCommand("sed -n '1,80p' src/foo.cpp"), 'cpp');
  assert.equal(langFromCommand("sed 's/foo/bar/' src/foo.cpp"), 'cpp');
  assert.equal(langFromCommand('cat src/foo.cpp'), 'cpp');
  assert.equal(langFromCommand('head -n 20 "src/foo.cpp"'), 'cpp');
  assert.equal(langFromCommand('Get-Content src/foo.cpp'), 'cpp');
  assert.equal(langFromCommand('cd src && sed -n "1,80p" foo.cpp'), 'cpp');
  assert.equal(langFromCommand("cat src/foo.cpp | sed 's/a/b/'"), 'cpp');
  assert.equal(langFromCommand('cat pkg.json'), 'json');
  assert.equal(langFromCommand('cat app.js'), 'javascript');
  assert.equal(langFromCommand('cat include/foo.h'), 'c');
  assert.equal(langFromCommand('cat include/foo.hpp'), 'cpp');
  assert.equal(langFromCommand('cat setup.sh'), 'bash');
  assert.equal(langFromCommand('type run.bat'), 'batch');
  assert.equal(langFromCommand('Get-Content build.ps1'), 'powershell');
});

test('langFromCommand does not guess interpreter, grep, echo, or mixed langs', () => {
  assert.equal(langFromCommand('python src/foo.py'), null);
  assert.equal(langFromCommand('g++ src/foo.cpp'), null);
  assert.equal(langFromCommand('echo src/foo.cpp'), null);
  assert.equal(langFromCommand('grep foo src/foo.cpp'), null);
  assert.equal(langFromCommand('cat src/foo.cpp | grep bar'), null);
  assert.equal(langFromCommand('python src/foo.py | cat'), null);
  assert.equal(langFromCommand('cat a.cpp b.h'), null);
  assert.equal(langFromCommand("sed 's/foo.cpp/bar.cpp/' README.md"), 'markdown');
});

test('langFromCommand unwraps powershell.exe -Command launchers', () => {
  assert.equal(
    langFromCommand('powershell.exe -Command "sed -n \'1,80p\' src/foo.cpp"'),
    'cpp',
  );
});

test('langFromResultText sniffs JSON and ignores near-misses', () => {
  assert.equal(langFromResultText('{"a": 1}'), 'json');
  assert.equal(langFromResultText('  [1, 2, 3]\n'), 'json');
  assert.equal(langFromResultText('{not json'), null);
  assert.equal(langFromResultText('int main() {}'), null);
});

test('langForToolResult prefers path fields, then shell command, then JSON', () => {
  assert.equal(langForToolResult({ name: 'Read', input: { file_path: 'a.cpp' }, resultText: 'x' }), 'cpp');
  assert.equal(langForToolResult({ name: 'read_file', input: { path: 'a.ts' }, resultText: 'x' }), 'typescript');
  assert.equal(langForToolResult({
    name: 'Bash',
    input: { command: "sed -n '1,80p' src/foo.cpp" },
    resultText: 'int main() {}',
  }), 'cpp');
  assert.equal(langForToolResult({
    name: 'run_terminal_command',
    input: { command: 'cat pkg.json' },
    resultText: '{}',
  }), 'json');
  assert.equal(langForToolResult({
    name: 'Grep',
    input: { path: 'a.cpp', pattern: 'foo' },
    resultText: 'a.cpp:1: foo',
  }), null);
  assert.equal(langForToolResult({
    name: 'SomeMcp',
    input: {},
    resultText: '{"ok": true}',
  }), 'json');
});
