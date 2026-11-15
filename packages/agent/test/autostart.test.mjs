// All credentials, relays and CLI processes in these tests are disposable.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-autostart-test-'));
process.env.BRC_HOME = path.join(scratch, 'agent');
process.env.BRC_LOG_LEVEL = 'silent';
const { waitForSavedConnection, listenForTerminalShortcuts, AUTO_CONNECT_DELAY_MS } = await import('../dist/terminal-shortcuts.js');
const { resolveStartupConnection, shouldPromptForConnection } = await import('../dist/terminal-setup.js');
const { ActivityLog } = await import('../dist/runtime/activity.js');
const { buildRelay } = await import('../../relay/dist/app.js');
const saved = { relayUrl: 'https://relay.example', deviceId: 'test-id', deviceToken: 'PRIVATE_AUTOSTART_TOKEN_741c', name: 'Test PC', pairedAt: 'test' };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const output = () => { const stream = new PassThrough(); let text = ''; stream.on('data', chunk => { text += chunk.toString(); }); return { stream, text: () => text }; };
class ConsoleInput extends PassThrough {
  isTTY = true; isRaw = false; changes = [];
  setRawMode(raw) { this.isRaw = raw; this.changes.push(raw); return this; }
}

test('saved startup connects without opening the menu or asking for Enter', async () => {
  let prompted = false, waited = false;
  const result = await resolveStartupConnection({ interactive: true, name: 'PC' }, { ask: async () => { prompted = true; return '0'; }, write: () => { prompted = true; } }, {
    load: () => saved, clear: () => { throw new Error('must not forget'); }, pair: async () => { throw new Error('must not pair'); },
    autostart: async current => { assert.equal(current, saved); waited = true; return 'connect'; },
  });
  assert.equal(result, saved); assert.equal(waited, true); assert.equal(prompted, false); assert.equal(AUTO_CONNECT_DELAY_MS, 4000);
});
test('M cancels automatic startup and opens existing change/forget settings', async () => {
  let prompts = 0;
  const result = await resolveStartupConnection({ interactive: true, name: 'PC' }, { ask: async () => { prompts++; return '0'; }, write: () => {} }, {
    load: () => saved, clear: () => false, pair: async () => saved, autostart: async () => 'settings',
  });
  assert.equal(result, null); assert.equal(prompts, 1);
});
test('explicit setup bypasses countdown and unattended startup bypasses all UI', async () => {
  const deps = { load: () => saved, clear: () => false, pair: async () => saved, autostart: async () => { throw new Error('must not wait'); } };
  const io = { ask: async () => '', write: () => {} };
  assert.equal(await resolveStartupConnection({ interactive: true, setup: true, name: 'PC' }, io, deps), saved);
  assert.equal(await resolveStartupConnection({ interactive: false, nonInteractive: true, autoConnect: true, name: 'PC' }, undefined, deps), saved);
  assert.equal(shouldPromptForConnection({ interactive: false, autoConnect: true, name: 'PC' }), true);
});
test('countdown expires without input and leaves no keyboard listeners or token output', async () => {
  const input = new ConsoleInput(), out = output(), start = performance.now();
  assert.equal(await waitForSavedConnection(saved, undefined, input, out.stream, 30), 'connect');
  assert.ok(performance.now() - start >= 20); assert.equal(input.listenerCount('data'), 0); assert.equal(input.isRaw, false);
  assert.ok(!out.text().includes(saved.deviceToken)); assert.ok(!out.text().includes('Choose [1]')); input.destroy(); out.stream.destroy();
});
test('Enter connects immediately and single-key M cancels the startup timer', async () => {
  for (const [key, expected] of [['\r', 'connect'], ['m', 'settings'], ['M', 'settings']]) {
    const input = new ConsoleInput(), out = output();
    const promise = waitForSavedConnection(saved, undefined, input, out.stream, 5000);
    input.write(key); assert.equal(await promise, expected); assert.equal(input.listenerCount('data'), 0); assert.equal(input.isRaw, false);
    input.destroy(); out.stream.destroy();
  }
});
test('Ctrl+C and abort cancel startup, restore raw mode, and never fall through to auto-connect', async () => {
  const input = new ConsoleInput(), out = output(), abort = new AbortController();
  const pending = waitForSavedConnection(saved, abort.signal, input, out.stream, 5000);
  abort.abort(); assert.equal(await pending, 'exit'); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0);
  const second = waitForSavedConnection(saved, undefined, input, out.stream, 5000); input.write('\x03'); assert.equal(await second, 'exit');
  input.destroy(); out.stream.destroy();
});
test('live shortcuts stay available after logs and ignore Enter/pasted text', async () => {
  const input = new ConsoleInput(), choices = [];
  const controls = listenForTerminalShortcuts(input, choice => choices.push(choice));
  input.write('\r'); input.write('this is pasted text with m'); await sleep(0); assert.deepEqual(choices, []);
  input.write('m'); await sleep(0); assert.deepEqual(choices, ['settings']);
  controls.close(); controls.close(); assert.equal(input.isRaw, false); assert.equal(input.listenerCount('data'), 0); input.destroy();
});
test('pipe controls have bounded input and do not treat a closed stdin as agent shutdown', async () => {
  const input = new PassThrough(), choices = [];
  const controls = listenForTerminalShortcuts(input, choice => choices.push(choice));
  input.write('x'.repeat(5000)); input.write('\nm\n'); await sleep(0); assert.deepEqual(choices, ['settings']);
  input.end(); await sleep(0); assert.deepEqual(choices, ['settings', 'closed']); controls.close();
});
test('settings temporarily holds only bounded live log output and never persists it', async () => {
  const log = new ActivityLog(path.join(scratch, 'logging'), false), chunks = [], original = process.stdout.write;
  process.stdout.write = function (chunk) { chunks.push(String(chunk)); return true; };
  try {
    const resume = log.pauseConsole();
    for (let i = 0; i < 250; i++) log.tool('OK', 'autostart_test', String(i), 1);
    assert.equal(chunks.length, 0); assert.equal(log.consoleQueue.length, 200); assert.equal(log.dropped, 50);
    resume(); resume(); assert.equal(chunks.length, 200); await log.close();
  } finally { process.stdout.write = original; }
  assert.equal(await fs.stat(path.join(scratch, 'logging')).catch(() => null), null);
});

const children = new Set();
function childCli(home, args) {
  const env = { ...process.env, BRC_HOME: home, BRC_LOG_LEVEL: 'info' };
  for (const key of ['BRC_RELAY', 'BRC_TOKEN', 'BRC_DEVICE_ID', 'BRC_NAME', 'NODE_TEST_CONTEXT']) delete env[key];
  const p = spawn(process.execPath, [path.resolve('packages/agent/dist/cli.js'), ...args], { env, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.output = ''; p.done = false; children.add(p);
  p.exited = new Promise(resolve => p.once('exit', code => { p.done = true; children.delete(p); resolve(code); }));
  for (const stream of [p.stdout, p.stderr]) stream.on('data', data => { p.output = (p.output + data.toString()).slice(-60000); });
  p.stdin.on('error', () => {}); return p;
}
async function until(fn, child, max = 15000) {
  const deadline = Date.now() + max;
  while (Date.now() < deadline) { if (await fn()) return; if (child?.done) throw new Error('CLI exited: ' + child.output); await sleep(15); }
  throw new Error('Timed out: ' + (child?.output ?? ''));
}
async function stop(p) { if (!p.done) p.kill('SIGTERM'); await Promise.race([p.exited, sleep(2000)]); if (!p.done) { p.kill('SIGKILL'); await p.exited; } }
after(async () => { for (const p of children) await stop(p); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); });

test('real CLI auto-connects after four seconds; live menu pauses only new calls and forget stops safely', { timeout: 30000 }, async () => {
  const home = path.join(scratch, 'live-agent'); await fs.mkdir(home);
  await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedDirectories: [home], telemetryEnabled: false }));
  const codeFile = path.join(home, 'sample.txt'); await fs.writeFile(codeFile, 'preserve this file');
  const relay = await buildRelay({ port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:3210', trustProxy: false, dbFile: path.join(scratch, 'relay.sqlite'), sessionSecret: 'autostart-test', adminUser: 'admin', adminPassword: 'autostart-test', relayVersion: 'autostart-test' }, () => {});
  await new Promise(resolve => relay.http.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${relay.http.address().port}`, user = relay.store.getUserByName('admin');
  const token = relay.store.issueDeviceToken('auto-pc', user.id, 'Auto PC', 'win32');
  const creds = { ...saved, relayUrl: url, deviceId: 'auto-pc', deviceToken: token };
  await fs.writeFile(path.join(home, 'device.json'), JSON.stringify(creds));
  let p = childCli(home, ['--auto-connect', '--no-browser']);
  try {
    await until(() => p.output.includes('Auto-connect in 4s.'), p); const t0 = performance.now();
    assert.equal(relay.hub.list().length, 0); assert.ok(!p.output.includes('Choose [1]:'));
    await until(() => p.output.includes('Ready: relay'), p); assert.ok(performance.now() - t0 >= 3800);
    assert.equal(relay.hub.list().length, 1); assert.ok(!p.output.includes('Choose [1]:')); assert.ok(!p.output.includes(token));
    const socket = relay.hub.get('auto-pc').socket;
    const read = await relay.hub.call('auto-pc', 'read_code_file', { path: codeFile }); assert.equal(read.isError, false);
    await until(() => /OK\s+read_code_file/.test(p.output), p);
    p.stdin.write('m\n'); await until(() => p.output.includes('Choose [1]:'), p);
    const paused = await relay.hub.call('auto-pc', 'write_file', { path: codeFile, content: 'should not write', mode: 'rewrite' });
    assert.equal(paused.isError, true); assert.equal(paused.structuredContent.error.code, 'SETTINGS_OPEN'); assert.equal(await fs.readFile(codeFile, 'utf8'), 'preserve this file');
    p.stdin.write('0\n'); await until(() => p.output.includes('Back to live logs.'), p); assert.equal(relay.hub.get('auto-pc').socket, socket);
    assert.equal((await relay.hub.call('auto-pc', 'read_code_file', { path: codeFile })).isError, false);
    // A settings keystroke during real running work must not cancel it or disconnect the client.
    const running = relay.hub.call('auto-pc', 'run_command', { cwd: home, command: 'node -e "setTimeout(()=>console.log(42),700)"', timeout_ms: 5000 });
    await until(() => /START\s+run_command/.test(p.output), p); p.stdin.write('m\n');
    await until(() => p.output.includes('no work was interrupted'), p); const completed = await running; assert.notEqual(completed.isError, true); assert.equal(completed.structuredContent.exitCode, 0);
    assert.equal((p.output.match(/Choose \[1\]:/g) ?? []).length, 1); assert.equal(relay.hub.get('auto-pc').socket, socket);
    p.stdin.write('m\n'); await until(() => (p.output.match(/Choose \[1\]:/g) ?? []).length === 2, p);
    p.stdin.write('3\n'); await until(() => p.output.includes('[y/N]:'), p); p.stdin.write('yes\n');
    await until(() => p.output.includes('Relay URL:'), p); p.stdin.write('q\n');
    assert.equal(await p.exited, 0); assert.equal(await fs.stat(path.join(home, 'device.json')).catch(() => null), null);
    assert.equal(await fs.readFile(codeFile, 'utf8'), 'preserve this file'); assert.ok(relay.store.getDevice('auto-pc'));
    assert.deepEqual(await fs.readdir(path.join(home, 'logs')).catch(() => []), []);
  } finally { await stop(p); relay.http.closeAllConnections(); await relay.close(); }
});

test('real CLI M during countdown cancels autostart until an explicit choice', { timeout: 12000 }, async () => {
  const home = path.join(scratch, 'startup-menu'); await fs.mkdir(home); await fs.writeFile(path.join(home, 'device.json'), JSON.stringify(saved));
  const p = childCli(home, ['--auto-connect', '--no-browser']);
  try {
    await until(() => p.output.includes('Auto-connect in 4s.'), p); p.stdin.write('m\n');
    await until(() => p.output.includes('Choose [1]:'), p); await sleep(4200);
    assert.ok(!p.output.includes('Connecting to')); p.stdin.write('0\n'); assert.equal(await p.exited, 0);
    assert.equal(JSON.parse(await fs.readFile(path.join(home, 'device.json'), 'utf8')).deviceToken, saved.deviceToken);
  } finally { await stop(p); }
});
