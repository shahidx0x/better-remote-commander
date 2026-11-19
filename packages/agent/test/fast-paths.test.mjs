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
 const fastCmd = await planFastExec('cmd.exe','node -v',{...process.env});
 assert.equal(fastCmd?.kind,'native','plain native executables skip cmd.exe shell startup');
 assert.equal(await planFastExec('cmd.exe','node -p "1 + 2"',{...process.env}),null,'quoted commands retain shell semantics');
 assert.equal(await planFastExec('cmd.exe','dir',{...process.env}),null,'shell built-ins are not rewritten');
 assert.equal(path.extname(simple.executable).toLowerCase(),'.exe');
 assert.deepEqual(simple.args,['-v']);
 const quoted=await planFastExec('powershell.exe','node -p "1 + 2"',{...process.env});
 assert.equal(quoted,null,'quoted commands retain the configured shell');
 // A .cmd script must never be silently routed away from PowerShell.
 const scriptDir = path.join(scratch, 'script-bin');
 const { mkdirSync } = await import('node:fs');
 mkdirSync(scriptDir, {recursive: true});
 writeFileSync(path.join(scriptDir, 'brc-script-only.cmd'), '@echo off\\r\\necho ok\\r\\n');
 const oldPath = process.env.PATH;
 try {
   process.env.PATH = scriptDir + path.delimiter + oldPath;
   assert.equal(await planFastExec('powershell.exe', 'brc-script-only arg', {...process.env}), null);
 } finally {process.env.PATH = oldPath;}
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
  // Streaming directory pages are live filesystem views, not one giant
  // snapshot or a guaranteed sorted order. Check complete top-level coverage
  // without assuming a fixed OS enumeration order.
  const expected = (await ref(target,1)).sort();
  const actual = [];
  let offset=0,pages=0;
  for(;;){
    const result=await callTool('list_directory',{path:target,depth:1,offset,limit:50});
    assert.notEqual(result.isError,true,out(result));
    const page=result.structuredContent?.directory;
    assert.ok(page);
    actual.push(...page.entries);
    assert.ok(++pages<100,'pagination cursor must make progress');
    if(!page.hasMore)break;
    assert.ok(page.nextOffset>offset);
    offset=page.nextOffset;
  }
  assert.deepEqual(actual.sort(),expected,'paginated listings include each top-level entry');
});

test('missing edit text returns quickly without CPU-heavy fuzzy scanning', async () => {
  const p = path.join(scratch, 'no-fuzzy.js');
  const original = 'export const ready = true;\n'.repeat(300);
  writeFileSync(p, original);
  const result = await callTool('edit_block', { file_path: p,
    old_string: 'export const ready = false;', new_string: 'changed' });
  assert.equal(result.isError, true);
  assert.equal(result.structuredContent?.error?.code, 'EDIT_TEXT_NOT_FOUND');
  assert.doesNotMatch(out(result), /closest match|similarity|fuzzy worker/i);
  const { readFileSync } = await import('node:fs');
  assert.equal(readFileSync(p, 'utf8'), original);
});
