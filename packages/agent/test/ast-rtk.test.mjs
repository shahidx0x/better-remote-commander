// ast-grep tools (ast_search / ast_rewrite) and rtk output compression for run_command.
// Runs against the built agent (pnpm build first). Pure decision/format helpers are tested
// without any binaries. Real runs use binaries from:
//   ast-grep: BRC_TEST_AST_GREP_PREFIX (an npm prefix with @ast-grep/cli installed) or ast-grep on PATH
//   rtk:      BRC_TEST_RTK (path to an rtk executable) or rtk on PATH
// and are skipped when none is available. Nothing is downloaded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'brc-astrtk-'));
const home = path.join(scratch, 'home');
fs.mkdirSync(home, { recursive: true });
process.env.BRC_HOME = home;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const dist = (p) => pathToFileURL(path.join(repo, 'packages/agent/dist', p)).href;
const { callTool, listTools } = await import(dist('index.js'));
const rtk = await import(dist('tools/rtk.js'));
const ag = await import(dist('tools/ast-grep.js'));
const { findOnPath } = await import(dist('tools/fast-exec.js'));
const { resetPluginsCache } = await import(dist('plugins/store.js'));
const out = (r) => r.content.map((c) => c.text ?? '').join('\n');
const isWindows = process.platform === 'win32';
const exe = (n) => (isWindows ? `${n}.exe` : n);

function writePlugins(plugins) {
  fs.writeFileSync(path.join(home, 'plugins.json'), JSON.stringify({ version: 1, plugins }, null, 2));
  resetPluginsCache();
  rtk.resetRtkCache();
  ag.resetAstGrepCache();
}
const binRecord = (id, enabled = true, status = 'installed') => ({
  id, name: id, enabled, status, origin: 'default',
  source: { type: 'binary', binName: id, version: '0' },
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
test('ast tools are registered; run_command has raw', () => {
  const tools = listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes('ast_search'));
  assert.ok(names.includes('ast_rewrite'));
  const rc = tools.find((t) => t.name === 'run_command');
  assert.ok(rc.inputSchema.properties.raw, 'raw argument');
  assert.match(tools.find((t) => t.name === 'ast_search').description, /\$\$\$/);
});

test('parseSimpleCommand accepts plain commands only', () => {
  const p = (c, posix = false) => rtk.parseSimpleCommand(c, { posix });
  assert.deepEqual(p('git status'), ['git', 'status']);
  assert.deepEqual(p('  git   log  -5 '), ['git', 'log', '-5']);
  assert.deepEqual(p('git commit -m "fix the thing"'), ['git', 'commit', '-m', 'fix the thing']);
  assert.deepEqual(p('git diff HEAD~1 -- src\\a.ts'), ['git', 'diff', 'HEAD~1', '--', 'src\\a.ts']);
  assert.equal(p('git diff src\\a.ts', true), null, 'backslash is an escape in posix shells');
  for (const bad of [
    'git status | head', 'git log && ls', 'git log; ls', 'git log > out.txt', 'git log $(x)', 'git log `x`',
    'echo $HOME', 'git log %PATH%', "git commit -m 'x'", 'git log -- *.ts', 'git log a,b', 'git log ^HEAD',
    'git log "a"b', 'git log "unbalanced', 'git log ""', 'FOO=1 git status', 'git log ~/x', 'git log --x=~/y',
    'git @args', 'git log #c', 'git log\nls', '', '   ',
  ]) assert.equal(p(bad), null, bad);
});

test('rtk allow-list decides by program and subcommand', () => {
  const plan = (command, extra = {}) => rtk.planRtkCommand({ command, posix: false, env: {}, ...extra });
  assert.deepEqual(plan('git status'), ['git', 'status']);
  assert.deepEqual(plan('git log -5 --oneline'), ['git', 'log', '-5', '--oneline']);
  assert.deepEqual(plan('cargo test --release'), ['cargo', 'test', '--release']);
  assert.deepEqual(plan('eslint src'), ['lint', 'src']);
  assert.deepEqual(plan('npm run build'), ['npm', 'run', 'build']);
  assert.deepEqual(plan('tsc --noEmit'), ['tsc', '--noEmit']);
  assert.deepEqual(plan('pnpm list --depth 0'), ['pnpm', 'list', '--depth', '0']);
  if (isWindows) assert.deepEqual(plan('Git.exe status'), ['git', 'status']);
  for (const no of ['git checkout main', 'git rev-parse HEAD', 'git', 'git -C x status', 'npm test', 'npm install',
    'cargo run', 'cat x', 'ls -la', 'grep foo .', 'curl https://example.com', 'node -e 1', 'docker run x',
    'cargo test --help', 'git log --version', './gradlew build', 'C:/tools/git status', 'git status | head']) {
    assert.equal(plan(no), null, no);
  }
  assert.equal(plan('git status', { raw: true }), null, 'raw bypasses rtk');
  assert.equal(plan('git status', { env: { BRC_RTK: '0' } }), null, 'BRC_RTK=0 disables');
  assert.deepEqual(plan('git status', { env: { BRC_RTK: '1' } }), ['git', 'status']);
});

test('annotateRtkOutput strips rtk hints and produces one note line', () => {
  const tee = isWindows ? 'C:\\brc\\tee\\1_cargo_test.log' : '/brc/tee/1_cargo_test.log';
  const shown = isWindows ? '"C:/brc/tee\\\\1_cargo_test.log"' : '"/brc/tee/1_cargo_test.log"';
  const a = rtk.annotateRtkOutput(
    `fail 1\n\n[full output: ${shown}]\n`,
    '[rtk] /!\\ No hook installed — run `rtk init -g` for automatic token savings\ntest result: FAILED\n',
    (p) => path.normalize(p) === path.normalize(tee),
  );
  assert.equal(a.teePath, path.normalize(tee));
  assert.equal(a.note, `[compressed by rtk; full output: ${path.normalize(tee)}]`);
  assert.doesNotMatch(a.stdout, /full output/);
  assert.match(a.stdout, /fail 1/);
  assert.equal(a.stderr, 'test result: FAILED\n');

  const b = rtk.annotateRtkOutput('ok\n[full output: rtk recall 3fa9c1]\n', '', () => true);
  assert.equal(b.teePath, undefined);
  assert.equal(b.note, '[compressed by rtk; rerun with raw=true for full output]');
  assert.equal(b.stdout, 'ok\n');

  const c = rtk.annotateRtkOutput('diff\n[full diff: rtk git diff --no-compact]\n', '', () => false);
  assert.equal(c.stdout, 'diff\n');
  const d = rtk.annotateRtkOutput('x\n[full output: "/nope.log"]\n', '', () => false);
  assert.equal(d.note, '[compressed by rtk; rerun with raw=true for full output]');
});

test('isRtkUsageError only matches rtk argument errors', () => {
  assert.equal(rtk.isRtkUsageError(2, "error: unrecognized subcommand 'x'\n\nUsage: rtk.exe [OPTIONS] <COMMAND>\n"), true);
  assert.equal(rtk.isRtkUsageError(2, 'error: some tool failed\n'), false);
  assert.equal(rtk.isRtkUsageError(1, 'error: x\nUsage: rtk'), false);
});

test('applyEdits makes a unified diff with correct line numbers', () => {
  const src = Buffer.from('a\nfoo(1)\nb\nc\nd\ne\nf\ng\nfoo(2)\nh\n');
  const at = (s) => src.indexOf(s);
  const edits = [
    { start: at('foo(1)'), end: at('foo(1)') + 6, replacement: Buffer.from('bar(1)\n// x') },
    { start: at('foo(2)'), end: at('foo(2)') + 6, replacement: Buffer.from('bar(2)') },
  ];
  const r = ag.applyEdits(src, edits, 'x.ts', 1);
  assert.equal(r.applied, 2);
  assert.equal(r.content.toString(), 'a\nbar(1)\n// x\nb\nc\nd\ne\nf\ng\nbar(2)\nh\n');
  assert.equal(r.diff, [
    '--- a/x.ts', '+++ b/x.ts',
    '@@ -1,3 +1,4 @@', ' a', '-foo(1)', '+bar(1)', '+// x', ' b',
    '@@ -8,3 +9,3 @@', ' g', '-foo(2)', '+bar(2)', ' h', '',
  ].join('\n'));
  // overlapping edits: the later one is skipped; CRLF kept in content
  const crlf = Buffer.from('x = 1;\r\ny = 2;\r\n');
  const r2 = ag.applyEdits(crlf, [{ start: 0, end: 5, replacement: Buffer.from('x = 9') }, { start: 2, end: 3, replacement: Buffer.from('?') }], 'y.ts');
  assert.equal(r2.applied, 1);
  assert.equal(r2.content.toString(), 'x = 9;\r\ny = 2;\r\n');
  assert.match(r2.diff, /-x = 1;\n\+x = 9;\n/);
});

test('formatMatchLine shows 1-based position and captures', () => {
  const line = ag.formatMatchLine({
    text: 'callTool(name, args)', file: '.\\src\\d.ts',
    range: { byteOffset: { start: 0, end: 1 }, start: { line: 86, column: 48 }, end: { line: 86, column: 68 } },
    metaVariables: { single: { B: { text: 'args' }, A: { text: 'name' } }, multi: { R: [{ text: 'x' }, { text: ',' }, { text: 'y' }] } },
  });
  assert.equal(line, 'src/d.ts:87:49: callTool(name, args)  [$A=name $B=args $$$R=x, y]');
});

// ---------------------------------------------------------------------------
// run_command with rtk disabled / enabled
// ---------------------------------------------------------------------------
test('run_command is unchanged when the rtk plugin is disabled', async () => {
  writePlugins({ rtk: binRecord('rtk', false) });
  const r = await callTool('run_command', { command: 'git --version' });
  assert.doesNotMatch(out(r), /rtk/);
  const s = await callTool('run_command', { command: 'git status', cwd: repo });
  assert.doesNotMatch(out(s), /compressed by rtk/);
  assert.match(out(s), /exit code 0/);
});

function findRtk() {
  if (process.env.BRC_TEST_RTK && fs.existsSync(process.env.BRC_TEST_RTK)) return process.env.BRC_TEST_RTK;
  return findOnPath('rtk', process.env.PATH ?? process.env.Path, isWindows ? ['.exe'] : ['']);
}

function placeFile(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try { fs.linkSync(src, dest); } catch { fs.copyFileSync(src, dest); }
  if (!isWindows) fs.chmodSync(dest, 0o755);
}

test('run_command goes through rtk for supported commands and keeps exit codes', async (t) => {
  const src = findRtk();
  if (!src) { t.skip('rtk not available (set BRC_TEST_RTK or put rtk on PATH)'); return; }
  placeFile(src, path.join(home, 'bin', exe('rtk')));
  writePlugins({ rtk: binRecord('rtk') });
  assert.equal(path.resolve(rtk.resolveRtk()), path.resolve(path.join(home, 'bin', exe('rtk'))));

  const viaRtk = out(await callTool('run_command', { command: 'git log -3', cwd: repo }));
  const raw = out(await callTool('run_command', { command: 'git log -3', cwd: repo, raw: true }));
  assert.match(viaRtk, /exit code 0/);
  assert.match(viaRtk, /\[compressed by rtk; (rerun with raw=true for full output|full output: .+)\]/);
  assert.doesNotMatch(raw, /compressed by rtk/);
  assert.doesNotMatch(viaRtk, /No hook installed/);
  assert.ok(viaRtk.length < raw.length, `rtk output (${viaRtk.length}) should be smaller than raw (${raw.length})`);

  // exit code of the wrapped command is preserved
  const bad = out(await callTool('run_command', { command: 'git log --no-such-flag-xyz', cwd: repo }));
  assert.match(bad, /exit code 128/);
  assert.match(bad, /compressed by rtk/);
  // job steps use runCommandCore too: a failing step fails the job
  const j = await callTool('run_parallel', { calls: [{ command: 'git log --no-such-flag-xyz', cwd: repo, label: 'bad' }] });
  assert.match(out(j), /FAILED/);

  // not on the allow-list / not simple: no rtk
  const piped = out(await callTool('run_command', { command: 'git rev-parse HEAD', cwd: repo }));
  assert.doesNotMatch(piped, /compressed by rtk/);
});

test('run_command falls back to a normal run when rtk cannot start', async () => {
  // Installed record but the binary is not executable: spawn fails -> normal run.
  const dest = path.join(home, 'bin', exe('rtk'));
  fs.rmSync(dest, { force: true });
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, 'not a program');
  writePlugins({ rtk: binRecord('rtk') });
  try {
    const r = out(await callTool('run_command', { command: 'git status', cwd: repo }));
    assert.match(r, /exit code 0/);
    assert.doesNotMatch(r, /compressed by rtk/);
  } finally {
    fs.rmSync(dest, { force: true });
  }
});

// ---------------------------------------------------------------------------
// ast-grep
// ---------------------------------------------------------------------------
test('ast tools report a clear error when ast-grep is missing', async () => {
  writePlugins({ 'ast-grep': binRecord('ast-grep', true, 'installing') });
  const saved = { PATH: process.env.PATH, Path: process.env.Path };
  process.env.PATH = '';
  if ('Path' in process.env) process.env.Path = '';
  ag.resetAstGrepCache();
  try {
    const r = await callTool('ast_search', { pattern: 'foo($A)', path: scratch });
    assert.equal(r.isError, true);
    assert.match(out(r), /not installed on this device yet.*background.*list_plugin_tools/s);
  } finally {
    process.env.PATH = saved.PATH;
    if (saved.Path !== undefined) process.env.Path = saved.Path;
    ag.resetAstGrepCache();
  }
  writePlugins({ 'ast-grep': binRecord('ast-grep', false) });
  const d = await callTool('ast_search', { pattern: 'foo($A)', path: scratch });
  assert.match(out(d), /disabled/);
});

function setupAstGrep() {
  const prefix = process.env.BRC_TEST_AST_GREP_PREFIX;
  if (prefix && fs.existsSync(path.join(prefix, 'node_modules', '@ast-grep'))) {
    const link = path.join(home, 'plugins', 'node');
    fs.mkdirSync(path.dirname(link), { recursive: true });
    if (!fs.existsSync(link)) fs.symlinkSync(prefix, link, isWindows ? 'junction' : 'dir');
    writePlugins({ 'ast-grep': binRecord('ast-grep') });
    return ag.resolveAstGrep();
  }
  writePlugins({}); // no record: PATH fallback
  return ag.resolveAstGrep();
}

test('ast_search and ast_rewrite with a real ast-grep', async (t) => {
  const found = setupAstGrep();
  if (!found) { t.skip('ast-grep not available (set BRC_TEST_AST_GREP_PREFIX or put ast-grep on PATH)'); return; }
  const dir = path.join(scratch, 'code');
  fs.mkdirSync(path.join(dir, 'sub'), { recursive: true });
  const a = 'import { callTool } from "./x";\n\nexport async function go() {\n  await callTool("a", { x: 1 });\n  // callTool(fake, call) in a comment\n  const s = "callTool(in, string)";\n  return callTool(name, args, extra);\n}\n';
  fs.writeFileSync(path.join(dir, 'a.ts'), a);
  fs.writeFileSync(path.join(dir, 'sub', 'b.ts'), 'callTool(one, two);\n');

  const s = out(await callTool('ast_search', { pattern: 'callTool($A, $B)', lang: 'ts', path: dir }));
  assert.match(s, /2 match\(es\) in 2 file\(s\)/);
  assert.match(s, /a\.ts:4:9: callTool\("a", \{ x: 1 \}\)  \[\$A="a" \$B=\{ x: 1 \}\]/);
  assert.match(s, /sub\/b\.ts:1:1: callTool\(one, two\)/);
  assert.doesNotMatch(s, /fake|in, string/);

  const v = out(await callTool('ast_search', { pattern: 'callTool($$$ARGS)', path: path.join(dir, 'a.ts'), contextLines: 1, maxResults: 1 }));
  assert.match(v, /1\+ match/);
  assert.match(v, />4\| {3}await callTool/);

  const none = out(await callTool('ast_search', { pattern: 'zzzNope($A)', lang: 'ts', path: dir }));
  assert.match(none, /No matches/);
  const badLang = await callTool('ast_search', { pattern: 'x', lang: 'no-such-lang', path: dir });
  assert.equal(badLang.isError, true);

  const dry = out(await callTool('ast_rewrite', { pattern: 'callTool($A, $B)', rewrite: 'invoke($B, $A)', lang: 'ts', path: dir }));
  assert.match(dry, /DRY RUN: 2 replacement\(s\) in 2 file\(s\)/);
  assert.match(dry, /-  await callTool\("a", \{ x: 1 \}\);\n\+  await invoke\(\{ x: 1 \}, "a"\);/);
  assert.equal(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), a, 'dry run must not write');

  const rule = 'id: r\nlanguage: ts\nrule:\n  pattern: callTool($A, $B)\nfix: invoke($B, $A)';
  const viaRule = out(await callTool('ast_rewrite', { rule, path: dir }));
  assert.match(viaRule, /DRY RUN: 2 replacement/);

  const applied = out(await callTool('ast_rewrite', { pattern: 'callTool($A, $B)', rewrite: 'invoke($B, $A)', lang: 'ts', path: dir, dry_run: false }));
  assert.match(applied, /APPLIED: 2 replacement\(s\) written to 2 file\(s\)/);
  assert.match(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), /await invoke\(\{ x: 1 \}, "a"\);/);
  assert.match(fs.readFileSync(path.join(dir, 'a.ts'), 'utf8'), /callTool\(name, args, extra\)/);
  assert.equal(fs.readFileSync(path.join(dir, 'sub', 'b.ts'), 'utf8'), 'invoke(two, one);\n');

  const missingLang = await callTool('ast_rewrite', { pattern: 'a($X)', rewrite: 'b($X)', path: dir });
  assert.equal(missingLang.isError, true);
});
