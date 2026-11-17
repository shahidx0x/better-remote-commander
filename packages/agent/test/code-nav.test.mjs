import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, realpathSync } from 'node:fs';

const scratch = mkdtempSync(path.join(realpathSync.native(os.tmpdir()), 'brc-nav-test-'));
const root = path.join(scratch, 'workspace');
await fs.mkdir(root);
process.env.BRC_HOME = path.join(scratch, 'agent');
process.env.BRC_LOG_LEVEL = 'silent';
const { configManager } = await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories', [root]);
const { callTool, listTools } = await import('../dist/dispatcher.js');
const { codeGraph } = await import('../dist/runtime/code-graph.js');
const { projectIndex } = await import('../dist/runtime/project-index.js');
const { clearCodeCache } = await import('../dist/runtime/code-structure.js');
const ok = r => { assert.notEqual(r.isError, true, JSON.stringify(r)); return r.structuredContent; };
after(async () => {
  codeGraph.clear(); projectIndex.close(); clearCodeCache();
  await configManager.close();
  await fs.rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 50 });
});
const w = (name, text) => fs.writeFile(path.join(root, name), text);

test('navigation tools are advertised, read-only, and mention no missing tools', () => {
  const names = ['read_code_file', 'code_outline', 'find_symbols', 'read_symbol', 'find_references', 'related_files', 'project_context', 'project_map', 'context_pack', 'code_graph', 'language_capabilities'];
  const all = listTools(), have = new Set(all.map(t => t.name));
  for (const n of names) {
    const t = all.find(x => x.name === n);
    assert.ok(t, n);
    assert.equal(t.annotations.readOnlyHint, true);
    for (const m of t.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? [])
      if (/^(read|edit|replace|batch|verify|worker)_/.test(m)) assert.ok(have.has(m), `${n} mentions missing tool ${m}`);
  }
});

test('TS outline: verified syntax, symbols, read_symbol, syntax errors', async () => {
  await w('a.ts', "import { b } from './b.js';\nexport class Foo {\n  bar(n: number) { return n; }\n}\nexport function util() { return 1; }\n");
  await w('bad.ts', 'export function broken( {\n');
  const o = ok(await callTool('code_outline', { path: path.join(root, 'a.ts') }));
  assert.equal(o.syntaxVerified, true);
  assert.deepEqual(o.symbols.map(s => s.qualifiedName).sort(), ['Foo', 'Foo.bar', 'util']);
  assert.equal(o.imports[0].specifier, './b.js');
  const sym = ok(await callTool('read_symbol', { path: path.join(root, 'a.ts'), name: 'util' }));
  assert.match(sym.text, /return 1/);
  assert.equal(sym.sha256, o.sha256);
  const bad = ok(await callTool('code_outline', { path: path.join(root, 'bad.ts') }));
  assert.ok(bad.syntax.length > 0);
  const miss = await callTool('read_symbol', { path: path.join(root, 'a.ts'), name: 'nope' });
  assert.equal(miss.isError, true);
});

test('JSON verified; Python and unknown languages are flagged syntax not verified', async () => {
  await w('c.json', '{"name":"x","scripts":{"a":"b"}}');
  await w('broken.json', '{"a":');
  await w('m.py', 'import os\nfrom .util import helper\n\nclass A:\n    def run(self):\n        return 1\n\n    def stop(self):\n        pass\n\ndef top():\n    return 2\n');
  await w('x.zig', 'pub fn main() void {}\nconst std = @import("std");\n');
  const j = ok(await callTool('code_outline', { path: path.join(root, 'c.json') }));
  assert.equal(j.syntaxVerified, true);
  assert.deepEqual(j.symbols.map(s => s.name), ['name', 'scripts']);
  assert.ok(ok(await callTool('code_outline', { path: path.join(root, 'broken.json') })).syntax.length > 0);
  const p = ok(await callTool('code_outline', { path: path.join(root, 'm.py') }));
  assert.equal(p.syntaxVerified, false);
  assert.match(p.syntaxNote, /syntax not verified/);
  const byName = Object.fromEntries(p.symbols.map(s => [s.qualifiedName, s]));
  assert.ok(byName['A.run'] && byName['A.stop'] && byName.top);
  assert.equal(byName.A.line, 4); assert.equal(byName.A.endLine, 9); // indentation-aware range
  assert.equal(byName['A.run'].confidence, 'lexical-candidate');
  assert.deepEqual(p.imports.map(i => i.specifier), ['os', '.util']);
  const z = ok(await callTool('code_outline', { path: path.join(root, 'x.zig') }));
  assert.equal(z.syntaxVerified, false);
  assert.ok(z.symbols.some(s => s.name === 'main'));
  const caps = ok(await callTool('language_capabilities', {}));
  assert.equal(caps.languages.find(l => l.id === 'typescript').syntaxVerified, true);
  assert.equal(caps.languages.find(l => l.id === 'python').syntaxVerified, false);
  assert.equal(caps.semanticLanguageServer, false);
});

test('read_code_file paginates by line and by character with hash', async () => {
  await w('long.txt', Array.from({ length: 10 }, (_, i) => 'line' + i).join('\n'));
  const r = ok(await callTool('read_code_file', { path: path.join(root, 'long.txt'), offset: 2, length: 3 }));
  assert.equal(r.text, 'line2\nline3\nline4'); assert.equal(r.truncated, true);
  const c = ok(await callTool('read_code_file', { path: path.join(root, 'long.txt'), charOffset: 0, charLength: 8 }));
  assert.equal(c.nextCharOffset, 8);
  assert.match(c.sha256, /^[a-f0-9]{64}$/);
});

test('find_symbols, find_references, related_files, project_map and secrets', async () => {
  await w('.env', 'TOP_SECRET=1');
  await w('server.pem', 'KEY');
  const f = ok(await callTool('find_symbols', { path: root, query: 'util' }));
  assert.ok(f.matches.some(m => m.file === 'a.ts' && m.name === 'util'));
  const refs = ok(await callTool('find_references', { path: root, symbol: 'util' }));
  assert.ok(refs.matches.length >= 1);
  await w('b.ts', 'export const b = 1;\n');
  const rel = ok(await callTool('related_files', { path: root, file: 'a.ts' }));
  assert.equal(rel.imports[0].resolved, 'b.ts');
  const back = ok(await callTool('related_files', { path: root, file: 'b.ts' }));
  assert.ok(back.importers.includes('a.ts'));
  const map = ok(await callTool('project_map', { path: root }));
  assert.ok(map.files.includes('a.ts'));
  assert.ok(!map.files.includes('.env') && !map.files.includes('server.pem'));
  assert.ok(!JSON.stringify(ok(await callTool('code_graph', { path: root, maxFiles: 50 }))).includes('TOP_SECRET'));
});

test('project_context reads manifest and scoped instructions without executing anything', async () => {
  await w('package.json', JSON.stringify({ name: 'demo', packageManager: 'pnpm@9.0.0', scripts: { test: 'node t.js' }, devDependencies: { typescript: '^5' } }));
  await w('AGENTS.md', 'Use tabs.');
  await fs.mkdir(path.join(root, '.vscode'), { recursive: true });
  await w('.vscode/settings.json', '{\n // comment\n "editor.tabSize": 2,\n}\n');
  const c = ok(await callTool('project_context', { path: root }));
  assert.equal(c.package.name, 'demo'); assert.equal(c.package.packageManager, 'pnpm');
  assert.equal(c.package.scripts.test, 'node t.js');
  assert.ok(c.instructions.some(i => i.path === 'AGENTS.md' && i.trust === 'repository-data'));
  assert.equal(c.editor['editor.tabSize'], 2);
});

test('graph is compact, bounded, refreshed after edits, and invalidated by dispatcher mutations', { timeout: 30000 }, async () => {
  const dir = path.join(root, 'many'); await fs.mkdir(dir);
  for (let i = 0; i < 42; i++) {
    const prev = i === 0 ? '' : `import { compute${i - 1} } from './file${i - 1}.js';\n`;
    await fs.writeFile(path.join(dir, `file${i}.ts`), prev + `export function compute${i}(n: number) { return n + ${i}; }\nexport const answer${i} = ${i};\n`);
  }
  const outline = ok(await callTool('code_graph', { path: dir, action: 'refresh', maxFiles: 90, limit: 80, maxChars: 12000 }));
  assert.equal(outline.format, 'graph-outline-v1');
  assert.ok(outline.files.length >= 30);
  for (const [index, name, kind, start, end] of outline.declarations) {
    assert.ok(index >= 0 && index < outline.files.length); assert.ok(name && kind && start >= 1 && end >= start);
  }
  for (const [from, to] of outline.relations) { assert.ok(from < outline.files.length && to < outline.files.length); }
  const bounded = ok(await callTool('code_graph', { path: dir, limit: 80, maxFiles: 90, maxChars: 2000 }));
  assert.ok(JSON.stringify(bounded).length <= 2000);
  assert.ok(bounded.partial);
  const pack = ok(await callTool('context_pack', { path: dir, focus: 'file21.ts', query: 'compute21', maxFiles: 90, maxChars: 6000 }));
  assert.equal(pack.mode, 'outline'); assert.equal(pack.persistent, false);
  assert.ok(JSON.stringify(pack).length <= 6000);
  assert.ok(!JSON.stringify(pack).includes('return n + 21'), 'no raw source in outline mode');
  const hit = pack.graph.declarations.find(d => d[1].includes('compute21'));
  assert.ok(hit, 'focused symbol survives compression');
  const old = outline.files.find(f => f[0] === 'file21.ts')[1];
  // Mutation through the dispatcher dirties the graph; watcher is not required.
  ok(await callTool('edit_block', { file_path: path.join(dir, 'file21.ts'), old_string: 'return n + 21', new_string: 'return n + 2100' }));
  const fresh = ok(await callTool('code_graph', { path: dir, maxFiles: 90, limit: 80 }));
  assert.notEqual(fresh.files.find(f => f[0] === 'file21.ts')[1], old);
  assert.equal(fresh.stale, false);
  assert.equal(ok(await callTool('code_graph', { path: dir, action: 'status' })).graphs.length, 1);
  ok(await callTool('code_graph', { path: dir, action: 'clear' }));
});

test('project_index is opt-in and reflects mutations', async () => {
  const off = await callTool('project_index', { path: root, action: 'query' });
  assert.equal(off.isError, true);
  const on = ok(await callTool('project_index', { path: root, action: 'enable', watch: false, query: 'a.ts' }));
  assert.ok(on.files.includes('a.ts')); assert.equal(on.persistent, false);
  ok(await callTool('write_file', { path: path.join(root, 'zz-new.ts'), content: 'export {}', mode: 'rewrite' }));
  const q = ok(await callTool('project_index', { path: root, action: 'query', watch: false, query: 'zz-new' }));
  assert.ok(q.files.includes('zz-new.ts'));
  ok(await callTool('project_index', { path: root, action: 'disable' }));
});

test('paths outside allowed directories are refused', async () => {
  const outside = path.join(scratch, 'outside.ts'); await fs.writeFile(outside, 'export const x=1');
  assert.equal((await callTool('code_outline', { path: outside })).isError, true);
  assert.equal((await callTool('project_map', { path: scratch })).isError, true);
});
