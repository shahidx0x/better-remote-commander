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

test('Windows native launch only bypasses cmd for unquoted literal executable argv', async () => {
 if (process.platform !== 'win32') return;
 const {planFastExec}=await import('../dist/tools/fast-exec.js');
 const simple=await planFastExec('powershell.exe','node -v',{...process.env});
 assert.equal(simple?.kind,'native');
 assert.equal(path.extname(simple.executable).toLowerCase(),'.exe');
 assert.deepEqual(simple.args,['-v']);
 const quoted=await planFastExec('powershell.exe','node -p "1 + 2"',{...process.env});
 assert.notEqual(quoted?.kind,'native');
 const pipeline=await planFastExec('powershell.exe','node -v | more',{...process.env});
 assert.equal(pipeline,null);
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

test('list_directory output matches a sequential walk', async () => {
  const { readdir } = await import('node:fs/promises');
  async function ref(p, depth, rel = '', top = true) {
    const out = [];
    if (depth <= 0) return out;
    const entries = await readdir(p, { withFileTypes: true });
    let show = entries, hidden = 0;
    if (!top && entries.length > 100) { show = entries.slice(0, 100); hidden = entries.length - 100; }
    for (const e of show) {
      const d = rel ? path.join(rel, e.name) : e.name;
      out.push(`${e.isDirectory() ? '[DIR]' : '[FILE]'} ${d}`);
      if (e.isDirectory() && depth > 1) out.push(...await ref(path.join(p, e.name), depth - 1, d, false));
    }
    if (hidden) out.push(`[WARNING] ${rel || path.basename(p)}: ${hidden} items hidden (showing first 100 of ${entries.length} total)`);
    return out;
  }
  const target = path.join(repo, 'packages');
  const expected = (await ref(target, 3)).join('\n');
  const t = out(await callTool('list_directory', { path: target, depth: 3 }));
  assert.ok(t.includes(expected), 'same lines in the same order');
});

test('edit_block fuzzy fallback gives the same answer inline and in the reused worker', async () => {
  const { runFuzzySearch } = await import(pathToFileURL(path.join(repo, 'packages/agent/dist/core/tools/fuzzySearchCore.js')).href);
  const query = 'export function handler77(req, res) { return res.json({ id: 77, ok: false }); }';
  for (const kb of [10, 300]) { // below and above the inline threshold
    const p = path.join(scratch, `fuzzy-${kb}.js`);
    let s = '';
    for (let i = 0; s.length < kb * 1024; i++) s += `export function handler${i}(req, res) { return res.json({ id: ${i}, ok: true }); }\n`;
    writeFileSync(p, s);
    const expected = runFuzzySearch(s, query).result.value; // the matcher run directly on this thread
    for (let round = 0; round < 2; round++) { // round 2 reuses the idle worker
      const t = out(await callTool('edit_block', { file_path: p, old_string: query, new_string: 'x' }));
      assert.match(t, /Search content not found/, `${kb} KB round ${round}`);
      assert.ok(t.includes(`closest match was "${expected}"`), `${kb} KB round ${round}: ${t.slice(0, 200)}`);
    }
  }
});
