// Fast paths: byte-indexed read_file and fast command start-up must not change results.
// Runs against the built agent (pnpm build first).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync, writeFileSync, createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-fast-'));
process.env.BRC_HOME = path.join(scratch, 'home');
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { callTool } = await import(pathToFileURL(path.join(repo, 'packages/agent/dist/index.js')).href);
const out = (r) => r.content.map((c) => c.text ?? '').join('\n');

async function readlineLines(p) {
  const rl = createInterface({ input: createReadStream(p), crlfDelay: Infinity });
  const lines = [];
  for await (const l of rl) lines.push(l);
  return lines;
}

const FILES = {
  lf: 'a\nb\nc\n',
  noTrailingNewline: 'a\nb\nc',
  crlf: 'one\r\ntwo\r\n\r\nfour\r\n',
  blankLines: '\n\n\nx\n\n',
  unicode: 'héllo\n日本語\n🙂 emoji\nend',
  bom: '﻿first\nsecond\n',
  empty: '',
  single: 'only line',
  loneCR: 'mac\rstyle\rlines\n',
  mixed: 'x\r\ny\nz\r\n',
};

test('read_file returns the same lines as readline', async () => {
  for (const [name, content] of Object.entries(FILES)) {
    const p = path.join(scratch, `${name}.txt`);
    writeFileSync(p, content);
    const ref = await readlineLines(p);
    for (const [offset, length] of [[0, 1000], [1, 2], [2, 1], [ref.length, 5], [ref.length + 3, 5], [-1], [-2], [-100]]) {
      const t = out(await callTool('read_file', { path: p, offset, ...(length ? { length } : {}) }));
      const body = t.slice(t.indexOf('\n\n') + 2);
      const expected = offset < 0 ? ref.slice(Math.max(0, ref.length + offset)) : ref.slice(offset, offset + length);
      assert.equal(body, expected.join('\n'), `${name} offset=${offset} length=${length}`);
    }
  }
});

test('read_file status line reports total lines', async () => {
  const p = path.join(scratch, 'crlf.txt');
  const t = out(await callTool('read_file', { path: p, offset: 1, length: 2 }));
  assert.match(t, /^\[Reading 2 lines from line 1 \(total: 4 lines, 1 remaining\)\]/);
});

test('read_file deep offset in a large file is exact', async () => {
  const p = path.join(scratch, 'large.txt');
  let s = '';
  for (let i = 0; i < 280_000; i++) s += `line ${i} ${'y'.repeat(i % 50)}\n`; // > 10 MB
  writeFileSync(p, s);
  const t = out(await callTool('read_file', { path: p, offset: 250_000, length: 3 }));
  const lines = t.slice(t.indexOf('\n\n') + 2).split('\n');
  assert.equal(lines.length, 3);
  assert.ok(lines[0].startsWith('line 250000 '), lines[0]);
  assert.ok(lines[2].startsWith('line 250002 '), lines[2]);
});

test('run_command keeps exit codes, quoting and shell features', async () => {
  let t = out(await callTool('run_command', { command: 'node -v' }));
  assert.match(t, /exit code 0/);
  assert.match(t, /v\d+\.\d+/);
  t = out(await callTool('run_command', { command: 'node -e "process.exit(7)"' }));
  assert.match(t, /exit code 7/);
  t = out(await callTool('run_command', { command: 'node -p "1 + 2"' }));
  assert.match(t, /--- stdout ---\n3/);
  t = out(await callTool('run_command', { command: 'node -e "console.log(process.argv.length)" a "b c" d' }));
  assert.match(t, /--- stdout ---\n4/);
  t = out(await callTool('run_command', { command: 'brc-no-such-program-xyz' }));
  assert.doesNotMatch(t, /exit code 0/);
});
