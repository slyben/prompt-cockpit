// Dump nearby ASCII around rewind/fork method names in grok.exe.
import { createReadStream } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

const exe = path.join(homedir(), '.grok', 'bin', 'grok.exe');
const needles = ['newSessionId', 'fork failed', 'no_worktree', 'noWorktree', 'use_worktree', 'directive', 'mode":"conversation', 'conversation-only'];
const chunks = [];
for await (const chunk of createReadStream(exe)) chunks.push(chunk);
const buf = Buffer.concat(chunks);
const text = buf.toString('latin1');

for (const needle of needles) {
  let from = 0;
  let n = 0;
  while (n < 4) {
    const idx = text.indexOf(needle, from);
    if (idx < 0) break;
    const start = Math.max(0, idx - 40);
    const slice = text.slice(start, idx + needle.length + 60).replace(/[^\x20-\x7E]/g, '.');
    console.log(`\n[${needle} #${n} @${idx}]`);
    console.log(slice);
    from = idx + needle.length;
    n += 1;
  }
}
