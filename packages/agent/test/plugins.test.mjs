// Plugin system: state, installer helpers, first run, AI plugin tools, CLI flags.
// Runs against the built agent (pnpm build first). Offline: downloads go to a local HTTP server,
// installs of default plugins use a stub installer.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scratch = fs.mkdtempSync(path.join(fs.realpathSync.native(tmpdir()), 'brc-plugins-'));
let homeN = 0;
/** Point BRC_HOME at a fresh directory and drop cached state. */
function freshHome() {
  process.env.BRC_HOME = path.join(scratch, `home${++homeN}`);
  fs.mkdirSync(process.env.BRC_HOME, { recursive: true });
  store.resetPluginsCache();
  return process.env.BRC_HOME;
}
// The agent's config manager binds to the first BRC_HOME it sees, so home0 must stay for the whole run.
process.env.BRC_HOME = path.join(scratch, 'home0');
fs.mkdirSync(process.env.BRC_HOME, { recursive: true });
delete process.env.BRC_PLUGINS;

const here = path.dirname(fileURLToPath(import.meta.url));
const dist = path.resolve(here, '../dist');
const load = (p) => import(pathToFileURL(path.join(dist, p)).href);
const store = await load('plugins/store.js');
const manager = await load('plugins/manager.js');
const host = await load('plugins/host.js');
const installer = await load('plugins/installer.js');
const locate = await load('plugins/locate.js');
const defaults = await load('plugins/defaults.js');
const firstRun = await load('plugins/first-run.js');
const python = await load('plugins/python.js');
const util = await load('plugins/util.js');
const { callTool, configManager } = await load('index.js');
const echoFixture = path.join(here, 'fixtures', 'echo-mcp.mjs');
const out = (r) => r.content.map((c) => c.text ?? '').join('\n');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const quiet = () => {};

// Local HTTP server for download tests.
const files = new Map();
const server = http.createServer((req, res) => {
  const body = files.get(req.url);
  if (!body) { res.writeHead(404).end(); return; }
  res.writeHead(200, { 'content-length': body.length }).end(body);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
after(async () => {
  await host.stopAllPlugins();
  server.close();
  server.closeAllConnections?.();
  // Persist the agent's debounced config writes now; the scratch dir is left in the OS temp
  // folder (deleting it would make those background writes retry forever).
  await configManager.flush().catch(() => {});
});

// Minimal archive builders (stored zip entry + deflated entry; ustar tar.gz).
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, data, deflate] of entries) {
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const n = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(n.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(n.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, n, body);
    centrals.push(ch, n);
    offset += lh.length + n.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
function makeTarGz(entries) {
  const blocks = [];
  for (const [name, data] of entries) {
    const h = Buffer.alloc(512);
    h.write(name, 0); h.write('0000755\0', 100); h.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
    h.write('0', 156); h.write('ustar\0', 257);
    blocks.push(h, data, Buffer.alloc((512 - (data.length % 512)) % 512));
  }
  blocks.push(Buffer.alloc(1024));
  return zlib.gzipSync(Buffer.concat(blocks));
}

test('plugins.json state transitions: define, install, fail, enable, remove', async () => {
  const home = freshHome();
  const calls = [];
  manager.setPluginInstaller(async (rec) => {
    calls.push(['install', rec.id, store.getPlugin(rec.id).status]);
    return rec.id === 'bad' ? { status: 'failed', error: 'boom' } : { status: 'installed', installedVersion: '1.0.0' };
  }, async (rec) => { calls.push(['uninstall', rec.id]); });

  const def = await manager.definePlugin({ id: 'good', name: 'Good', source: { type: 'command', command: 'x' }, enabled: true, origin: 'user' });
  assert.equal(def.status, 'pending');
  const ok = await manager.installPlugin('good');
  assert.equal(ok.status, 'installed');
  assert.equal(ok.installedVersion, '1.0.0');
  assert.ok(ok.installedAt);
  assert.deepEqual(calls[0], ['install', 'good', 'installing']);

  await manager.definePlugin({ id: 'bad', name: 'Bad', source: { type: 'command', command: 'y' }, enabled: true, origin: 'user' });
  const bad = await manager.installPlugin('bad');
  assert.equal(bad.status, 'failed');
  assert.equal(bad.error, 'boom');

  // redefining keeps the status
  assert.equal((await manager.definePlugin({ id: 'good', name: 'Good 2', source: { type: 'command', command: 'x' }, enabled: true, origin: 'user' })).status, 'installed');
  assert.equal((await manager.setPluginEnabled('good', false)).enabled, false);

  const onDisk = JSON.parse(fs.readFileSync(path.join(home, 'plugins.json'), 'utf8'));
  assert.equal(onDisk.plugins.good.status, 'installed');
  assert.equal(onDisk.plugins.good.enabled, false);
  assert.equal(onDisk.plugins.bad.status, 'failed');

  assert.equal(await manager.removePlugin('bad'), true);
  assert.deepEqual(calls.at(-1), ['uninstall', 'bad']);
  assert.equal(store.getPlugin('bad'), undefined);
  assert.equal(await manager.removePlugin('bad'), false);
});

test('command plugin: real installer + list_plugin_tools + call_plugin_tool via the echo fixture', async () => {
  freshHome();
  installer.registerInstaller();
  await manager.definePlugin({ id: 'echo', name: 'Echo', source: { type: 'command', command: process.execPath, args: [echoFixture] }, enabled: true, origin: 'user' });
  assert.equal((await manager.installPlugin('echo')).status, 'installed');

  const all = out(await callTool('list_plugin_tools', {}));
  assert.match(all, /- echo \[ready\] Echo/);
  const one = await callTool('list_plugin_tools', { plugin: 'echo' });
  assert.ok(!one.isError, out(one));
  assert.match(out(one), /### echo/);
  assert.match(out(one), /### add/);
  assert.equal(store.getPlugin('echo').toolsCache.length, 3);

  assert.equal(out(await callTool('call_plugin_tool', { plugin: 'echo', tool: 'echo', args: { text: 'hi' } })), 'echo: hi');
  assert.equal(out(await callTool('call_plugin_tool', { plugin: 'echo', tool: 'add', args: { a: 2, b: 3 } })), '5');

  await manager.setPluginEnabled('echo', false);
  const disabled = await callTool('call_plugin_tool', { plugin: 'echo', tool: 'echo', args: { text: 'x' } });
  assert.ok(disabled.isError);
  assert.match(out(disabled), /disabled/);
  await host.stopAllPlugins();
});

test('default plugin definitions follow the platform rules', () => {
  const ids = (ctx) => Object.fromEntries(defaults.defaultPluginDefs(ctx).map((d) => [d.id, d]));
  const win = ids({ platform: 'win32', env: {}, browser: 'msedge' });
  assert.deepEqual(Object.keys(win).sort(), [...defaults.DEFAULT_PLUGIN_IDS].sort());
  assert.equal(win['computer-use'].enabled, true);
  assert.equal(win['computer-use'].status, undefined);
  assert.ok(win.playwright.source.args.includes('msedge'));
  assert.ok(!win.playwright.source.args.includes('--headless'));
  for (const d of Object.values(win)) {
    if ('version' in d.source && d.source.type !== 'pypi') assert.match(d.source.version, /^\d+\.\d+\.\d+/, d.id);
  }
  for (const [key, a] of Object.entries(win.rtk.source.downloads)) {
    assert.match(a.sha256, /^[0-9a-f]{64}$/, key);
    assert.match(a.url, /^https:\/\/github\.com\/rtk-ai\/rtk\/releases\/download\//);
  }

  const mac = ids({ platform: 'darwin', env: {}, browser: 'chrome' });
  assert.equal(mac['computer-use'].enabled, false);
  assert.equal(mac['computer-use'].status, undefined);

  const headless = ids({ platform: 'linux', env: {}, browser: null });
  assert.equal(headless['computer-use'].status, 'unsupported');
  assert.match(headless['computer-use'].error, /display/);
  assert.ok(headless.playwright.source.args.includes('--headless'));
  assert.ok(headless.playwright.source.args.includes('chromium'));

  const desktop = ids({ platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' }, browser: 'chrome' });
  assert.equal(desktop['computer-use'].enabled, true);
  assert.equal(desktop['computer-use'].status, undefined);
});

test('first run defines defaults and installs in background; second run is offline and installs nothing', async () => {
  freshHome();
  const installed = [];
  let active = 0;
  let maxActive = 0;
  manager.setPluginInstaller(async (rec) => {
    active++; maxActive = Math.max(maxActive, active);
    installed.push(rec.id);
    await new Promise((r) => setTimeout(r, 20));
    const exe = locate.pluginExecutable(rec);
    if (exe) { fs.mkdirSync(path.dirname(exe), { recursive: true }); fs.writeFileSync(exe, 'fake'); }
    active--;
    return { status: 'installed', installedVersion: 'version' in rec.source ? rec.source.version : undefined };
  }, async () => {});

  const r1 = await firstRun.ensureDefaultPlugins(quiet);
  assert.equal(r1.firstRun, true);
  assert.deepEqual([...r1.defined].sort(), [...defaults.DEFAULT_PLUGIN_IDS].sort());
  const cu = store.getPlugin('computer-use');
  assert.equal(cu.enabled, process.platform !== 'darwin');
  assert.equal(store.loadPlugins().firstRunAt, undefined, 'firstRunAt is set only after the pass');
  await r1.done;
  assert.ok(store.loadPlugins().firstRunAt);
  assert.ok(maxActive <= 2, `concurrency ${maxActive}`);
  for (const id of r1.queued) assert.equal(store.getPlugin(id).status, 'installed', id);
  const firstCount = installed.length;
  assert.equal(firstCount, r1.queued.length);

  // Second start: reads plugins.json + existence checks only.
  store.resetPluginsCache();
  const t0 = performance.now();
  const r2 = await firstRun.ensureDefaultPlugins(quiet);
  const ms = performance.now() - t0;
  await r2.done;
  assert.equal(r2.firstRun, false);
  assert.deepEqual(r2.queued, []);
  assert.equal(installed.length, firstCount);
  // Generous limit (slow CI runners); the real check is that nothing was queued or installed above.
  assert.ok(ms < 2000, `second run took ${ms.toFixed(1)} ms`);

  // A plugin whose executable vanished is reinstalled, and only that one.
  fs.rmSync(locate.pluginExecutable(store.getPlugin('rtk')));
  await store.patchPlugin('markitdown', { status: 'installing' }); // interrupted run
  const r3 = await firstRun.ensureDefaultPlugins(quiet);
  await r3.done;
  assert.deepEqual([...r3.queued].sort(), ['markitdown', 'rtk']);
  assert.equal(store.getPlugin('rtk').status, 'installed');

  // BRC_PLUGINS=none skips everything.
  process.env.BRC_PLUGINS = 'none';
  try {
    const r4 = await firstRun.ensureDefaultPlugins(quiet);
    assert.equal(r4.skipped, 'BRC_PLUGINS=none');
  } finally { delete process.env.BRC_PLUGINS; }
});

test('downloads: sha256 mismatch fails and leaves nothing behind', async () => {
  const home = freshHome();
  const body = Buffer.from('pretend binary');
  files.set('/thing.bin', body);
  const dest = path.join(home, 'dl', 'thing.bin');
  await assert.rejects(util.downloadVerified(`${base}/thing.bin`, 'a'.repeat(64), dest), /sha256 mismatch/);
  assert.equal(fs.existsSync(dest), false);
  assert.deepEqual(fs.readdirSync(path.dirname(dest)), []);
  await util.downloadVerified(`${base}/thing.bin`, sha(body), dest);
  assert.equal(fs.readFileSync(dest, 'utf8'), 'pretend binary');
  await assert.rejects(util.downloadVerified('http://example.com/x', sha(body), dest), /non-https/);

  // Through the installer: a binary plugin with a wrong pinned hash ends up failed.
  installer.registerInstaller();
  const key = `${process.platform}-${process.arch}`;
  files.set('/tool.zip', makeZip([['tool.exe', body, true]]));
  await manager.definePlugin({
    id: 'tool', name: 'Tool', enabled: true, origin: 'user',
    source: { type: 'binary', binName: 'tool', version: '1.0.0', downloads: { [key]: { url: `${base}/tool.zip`, sha256: 'b'.repeat(64) } } },
  });
  const rec = await manager.installPlugin('tool');
  assert.equal(rec.status, 'failed');
  assert.match(rec.error, /sha256 mismatch/);
  assert.equal(fs.existsSync(path.join(home, 'bin')), false);

  // No asset for this platform: unsupported.
  await manager.definePlugin({ id: 'tool2', name: 'Tool 2', enabled: true, origin: 'user', source: { type: 'binary', binName: 'tool2', version: '1.0.0', downloads: {} } });
  assert.equal((await manager.installPlugin('tool2')).status, 'unsupported');
});

test('archives: one file is extracted from zip (stored and deflated) and tar.gz', async () => {
  const home = freshHome();
  const a = Buffer.from('A'.repeat(1000));
  const b = Buffer.from('#!/bin/sh\necho b\n');
  const zip = path.join(home, 'x.zip');
  fs.writeFileSync(zip, makeZip([['LICENSE', Buffer.from('mit'), false], ['dir/tool.exe', a, true], ['other', b, false]]));
  await util.extractOne(zip, 'zip', { baseName: 'tool.exe' }, path.join(home, 'out', 'tool.exe'));
  assert.deepEqual(fs.readFileSync(path.join(home, 'out', 'tool.exe')), a);
  await util.extractOne(zip, 'zip', { archivePath: 'other', baseName: 'x' }, path.join(home, 'out', 'other'));
  assert.deepEqual(fs.readFileSync(path.join(home, 'out', 'other')), b);
  await assert.rejects(util.extractOne(zip, 'zip', { baseName: 'missing' }, path.join(home, 'out', 'm')), /not found/);

  const tgz = path.join(home, 'x.tar.gz');
  fs.writeFileSync(tgz, makeTarGz([['pkg-1.0/README', Buffer.from('r')], ['pkg-1.0/tool', b]]));
  await util.extractOne(tgz, 'tar.gz', { archivePath: 'pkg-1.0/tool', baseName: 'tool' }, path.join(home, 'out', 'tool'));
  assert.deepEqual(fs.readFileSync(path.join(home, 'out', 'tool')), b);
  assert.equal(util.archiveKind('https://x/y/rtk-x86_64-apple-darwin.tar.gz'), 'tar.gz');
  assert.equal(util.archiveKind('rtk.zip'), 'zip');
  assert.equal(util.archiveKind('rtk'), null);
});

test('needs-user: the python.org installer is downloaded (verified, not run) and the user is told where', async () => {
  const home = freshHome();
  const fake = Buffer.from('MZ fake installer');
  files.set('/python-installer.exe', fake);
  const r = await python.pythonNeedsUser('no Python 3.10+ found', quiet, { url: `${base}/python-installer.exe`, sha256: sha(fake) });
  assert.equal(r.ok, false);
  const file = path.join(home, 'plugins', 'downloads', 'python-installer.exe');
  assert.ok(fs.existsSync(file));
  assert.ok(r.userAction.includes(file), r.userAction);
  assert.match(r.userAction, /Python 3\.10\+ is needed/);
  assert.match(r.userAction, /sha256 verified/);
  assert.match(r.userAction, /restart the BRC agent/);

  // Download impossible (bad hash): still a clear instruction with the python.org link.
  const r2 = await python.pythonNeedsUser('no Python', quiet, { url: `${base}/python-installer.exe`, sha256: 'c'.repeat(64) });
  assert.match(r2.userAction, /python\.org/);

  // A needs-user plugin shows its instruction to the AI.
  await manager.definePlugin({ id: 'py', name: 'Py', enabled: true, origin: 'user', source: { type: 'pypi', package: 'x', version: '1' }, status: 'needs-user', userAction: r.userAction });
  const listed = out(await callTool('list_plugin_tools', {}));
  assert.match(listed, /- py \[needs-user\]/);
  assert.match(listed, /needs user: Python 3\.10\+ is needed/);
});

test('installer helpers: npm bin choice, uv names, input validation', () => {
  assert.equal(installer.pickNpmBin({ bin: 'cli.js' }, '@playwright/mcp'), 'mcp');
  assert.equal(installer.pickNpmBin({ bin: { 'playwright-mcp': 'cli.js' } }, '@playwright/mcp'), 'playwright-mcp');
  assert.equal(installer.pickNpmBin({ bin: { sg: 'sg', 'ast-grep': 'ast-grep' } }, '@ast-grep/cli', 'ast-grep'), 'ast-grep');
  assert.equal(installer.pickNpmBin({}, 'x'), undefined);
  assert.equal(installer.uvToolName('Serena_Agent[extra]'), 'serena-agent');
  assert.equal(installer.pypiSpec({ type: 'pypi', package: 'markitdown-mcp', version: '0.0.1a8' }), 'markitdown-mcp==0.0.1a8');
  assert.equal(installer.pypiSpec({ type: 'pypi', package: 'git+https://github.com/oraios/serena@v1', version: '' }), 'git+https://github.com/oraios/serena@v1');
  assert.throws(() => installer.pypiSpec({ type: 'pypi', package: 'x; rm -rf /', version: '1' }), /invalid/);
  assert.throws(() => installer.validateNpm('@playwright/mcp', '^1.0.0'), /exact/);
  assert.throws(() => installer.validateNpm('a&b', '1.0.0'), /invalid/);
});

test('CLI: --add-plugin --command, --list-plugins, --disable-plugin, --remove-plugin', () => {
  const home = path.join(scratch, 'cli-home');
  const cli = path.join(dist, 'cli.js');
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, BRC_HOME: home }, encoding: 'utf8', timeout: 60_000 });
  let r = run('--add-plugin', 'echo', '--command', `"${process.execPath}" "${echoFixture}"`, '--env', 'FOO=bar');
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /echo\s+installed\s+enabled\s+command/);
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'plugins.json'), 'utf8')).plugins.echo;
  assert.deepEqual(rec.source, { type: 'command', command: process.execPath, args: [echoFixture] });
  assert.deepEqual(rec.env, { FOO: 'bar' });
  r = run('--disable-plugin', 'echo');
  assert.match(r.stdout, /disabled/);
  r = run('--list-plugins');
  assert.match(r.stdout, /echo\s+installed\s+disabled/);
  r = run('--add-plugin', 'nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /not a default plugin/);
  r = run('--remove-plugin', 'echo');
  assert.match(r.stdout, /Removed plugin "echo"/);
  r = run('--list-plugins');
  assert.match(r.stdout, /No plugins/);
});
