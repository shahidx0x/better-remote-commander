// Startup UI and credential changes use disposable homes only, never the real saved connection.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
const scratch = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-setup-test-'));
process.env.BRC_HOME = path.join(scratch, 'credentials');
process.env.BRC_LOG_LEVEL = 'silent';
const { normalizeRelayUrl } = await import('../dist/transport/relay-url.js');
const { shouldPromptForConnection, resolveStartupConnection, createTerminalPrompts } = await import('../dist/terminal-setup.js');
const { loadCredentials, saveCredentials, clearCredentials, pairDevice } = await import('../dist/transport/pairing.js');
const { buildRelay } = await import('../../relay/dist/app.js');
const baseOptions = { interactive: true, name: 'My PC', noBrowser: true };
const old = { relayUrl: 'https://old.example', deviceId: 'old-device', deviceToken: 'OLD_PRIVATE_TOKEN_863fe', name: 'Existing PC', pairedAt: '2026-11-01' };
function fixture(answers, initial = null, failCount = 0) {
  let saved = initial, clears = 0, calls = [];
  const output = [], prompts = [];
  const io = { write: s => output.push(s), ask: async s => { prompts.push(s); assert.ok(answers.length, `Unexpected prompt: ${s}`); return answers.shift(); } };
  const deps = { load: () => saved, clear: () => { clears++; const present = !!saved; saved = null; return present; }, pair: async o => { calls.push({ ...o, previouslySaved: saved }); if (failCount-- > 0) throw new Error('Relay unavailable.'); saved = { relayUrl: o.relayUrl, deviceId: 'new-device', deviceToken: 'NEW_PRIVATE_TOKEN_37df8', name: o.name, pairedAt: '2026-11-15' }; return saved; } };
  return { io, deps, output, prompts, calls, get saved() { return saved; }, get clears() { return clears; }, run: (opts = {}) => resolveStartupConnection({ ...baseOptions, setup: true, ...opts }, io, deps) };
}
test('normalizes pasted bases/endpoints and preserves reverse-proxy prefixes', () => {
  for (const [input, expected] of [['https://BRC.example/', 'https://brc.example'], ['https://brc.example/team/mcp/', 'https://brc.example/team'], ['https://brc.example/ws', 'https://brc.example'], ['brc.example:8443', 'https://brc.example:8443'], ['localhost:3000', 'http://localhost:3000'], ['[::1]:3000', 'http://[::1]:3000']]) assert.equal(normalizeRelayUrl(input, true), expected);
});
test('rejects credential-bearing, malformed and non-HTTP URLs without echoing their values', () => {
  for (const input of ['', 'ftp://example.com', 'javascript:alert(1)', 'https://a.invalid/?token=private', 'https://u:password@a.invalid', 'https://a.invalid/#secret', '/local/path', 'https://a.invalid:99999', 'https://a.invalid/x\ny', 'https://a.invalid\\evil']) assert.throws(() => normalizeRelayUrl(input, true));
});
test('menus are automatic only for foreground launches and explicit setup overrides environment', () => {
  assert.equal(shouldPromptForConnection(baseOptions), true);
  assert.equal(shouldPromptForConnection({ ...baseOptions, interactive: false }), false);
  assert.equal(shouldPromptForConnection({ ...baseOptions, relay: old.relayUrl }), false);
  assert.equal(shouldPromptForConnection({ ...baseOptions, nonInteractive: true }), false);
  assert.equal(shouldPromptForConnection({ ...baseOptions, setup: true, interactive: false, relay: old.relayUrl }), true);
  assert.throws(() => shouldPromptForConnection({ ...baseOptions, setup: true, nonInteractive: true }));
});
test('first run asks for URL/name and accepts the pasted MCP endpoint', async () => {
  const f = fixture(['https://new.example/mcp', '']);
  const c = await f.run(); assert.equal(c.relayUrl, 'https://new.example'); assert.equal(c.name, 'My PC'); assert.equal(f.clears, 0); assert.equal(f.calls.length, 1); assert.equal(f.calls[0].openBrowser, false);
});
test('saved-menu Enter connects immediately without pairing or logging a token', async () => {
  const f = fixture([''], old); assert.equal(await f.run(), old); assert.equal(f.calls.length, 0); assert.equal(f.clears, 0); assert.ok(!f.output.join('').includes(old.deviceToken));
});
test('changing a URL preserves the previous credentials until successful approval', async () => {
  const f = fixture(['2', 'new.example', 'New PC'], old); const next = await f.run();
  assert.equal(f.calls[0].previouslySaved, old); assert.equal(f.clears, 0); assert.equal(next.relayUrl, 'https://new.example'); assert.equal(f.saved.name, 'New PC');
});
test('failed changes can return to the saved connection without deleting it', async () => {
  const f = fixture(['2', 'new.example', '', 'b', '1'], old, 1);
  assert.equal(await f.run(), old); assert.equal(f.saved, old); assert.equal(f.clears, 0);
});
test('forget asks for confirmation, clears only pairing, then accepts a new URL', async () => {
  const f = fixture(['3', 'yes', 'new.example', ''], old); const next = await f.run();
  assert.equal(f.clears, 1); assert.equal(f.calls[0].previouslySaved, null); assert.equal(next.relayUrl, 'https://new.example'); assert.ok(f.output.some(s => s.includes('does not revoke')));
});
test('declining forget keeps pairing, and exiting after confirmed forget leaves it absent', async () => {
  const decline = fixture(['forget', 'n', '1'], old); assert.equal(await decline.run(), old); assert.equal(decline.clears, 0);
  const remove = fixture(['3', 'y', 'q'], old); assert.equal(await remove.run(), null); assert.equal(remove.saved, null); assert.equal(remove.calls.length, 0);
});
test('invalid URLs and insecure remote HTTP receive bounded corrective prompts', async () => {
  const f = fixture(['ftp://new.example', 'http://new.example', 'n', 'https://new.example', 'PC']);
  assert.equal((await f.run()).relayUrl, 'https://new.example'); assert.equal(f.calls.length, 1); assert.ok(f.output.some(s => s.includes('unencrypted HTTP')));
});
test('pairing errors can retry or choose another URL without touching projects', async () => {
  const f = fixture(['https://first.example', '', 'u', 'https://second.example', 'PC'], null, 1);
  assert.equal((await f.run()).relayUrl, 'https://second.example'); assert.equal(f.calls.length, 2);
});
test('forced setup ignores stale relay/token environment values for that run', async () => {
  const f = fixture(['new.example', '']);
  const next = await f.run({ setup: true, relay: old.relayUrl, token: old.deviceToken, deviceId: old.deviceId });
  assert.equal(next.relayUrl, 'https://new.example'); assert.equal(f.calls[0].deviceId, undefined);
});
test('unattended startup uses saved credentials and fails clearly when none exist', async () => {
  const saved = fixture([], old); assert.equal(await saved.run({ setup: false, interactive: false, nonInteractive: true }), old); assert.equal(saved.prompts.length, 0);
  const empty = fixture([]); await assert.rejects(empty.run({ setup: false, interactive: false, nonInteractive: true }), /No saved relay/); assert.equal(empty.prompts.length, 0);
});
test('manual tokens retain their noninteractive behavior and are not saved by the resolver', async () => {
  const f = fixture([]); const next = await f.run({ setup: false, relay: 'https://manual.example', token: 'manual-token', deviceId: 'device' });
  assert.equal(next.pairedAt, 'manual'); assert.equal(f.saved, null); assert.equal(f.calls.length, 0);
});
test('readline input queue is bounded, cancellable and released before live operation', async () => {
  const input = new PassThrough(), output = new PassThrough(), abort = new AbortController(); output.resume();
  const io = createTerminalPrompts(input, output, abort.signal);
  input.write('one\ntwo\n'); assert.equal(await io.ask('First: '), 'one'); assert.equal(await io.ask('Second: '), 'two');
  const pending = io.ask('Third: '); abort.abort(); assert.equal(await pending, null); assert.equal(io.signal.aborted, true); io.close(); assert.equal(input.isPaused(), true);
});
test('credential saving validates first, commits atomically and forgetting preserves unrelated state', async () => {
  const home = process.env.BRC_HOME; await fs.mkdir(home, { recursive: true });
  await fs.writeFile(path.join(home, 'config.json'), 'preserve-settings'); await fs.writeFile(path.join(home, 'project.txt'), 'preserve-project');
  saveCredentials(old); const previous = await fs.readFile(path.join(home, 'device.json'), 'utf8');
  assert.throws(() => saveCredentials({ ...old, relayUrl: 'https://user:secret@example.com' })); assert.equal(await fs.readFile(path.join(home, 'device.json'), 'utf8'), previous);
  saveCredentials({ ...old, relayUrl: 'https://new.example/mcp', deviceToken: 'new-token' }); assert.equal(loadCredentials().relayUrl, 'https://new.example');
  assert.equal((await fs.readdir(home)).filter(s => s.endsWith('.tmp')).length, 0);
  assert.equal(clearCredentials(), true); assert.equal(clearCredentials(), false); assert.equal(await fs.readFile(path.join(home, 'config.json'), 'utf8'), 'preserve-settings'); assert.equal(await fs.readFile(path.join(home, 'project.txt'), 'utf8'), 'preserve-project');
  await fs.writeFile(path.join(home, 'device.json'), '{"relayUrl":42}'); assert.equal(loadCredentials(), null); clearCredentials();
});
test('already-cancelled pairing makes no request and saves no credentials', async () => {
  const abort = new AbortController(); abort.abort(); await assert.rejects(pairDevice({ relayUrl: 'http://127.0.0.1:1', name: 'PC', openBrowser: false, log: () => {}, signal: abort.signal })); assert.equal(loadCredentials(), null);
});

const children = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function childCli(home, args = [], env = {}) {
  const clean = { ...process.env, BRC_HOME: home, BRC_LOG_LEVEL: 'info' };
  for (const key of ['BRC_RELAY', 'BRC_TOKEN', 'BRC_DEVICE_ID', 'BRC_NAME', 'NODE_TEST_CONTEXT']) delete clean[key];
  const child = spawn(process.execPath, [path.resolve('packages/agent/dist/cli.js'), ...args], { env: { ...clean, ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  children.add(child); child.output = ''; child.done = false; child.exited = new Promise(resolve => child.once('exit', code => { child.done = true; children.delete(child); resolve(code); }));
  for (const s of [child.stdout, child.stderr]) s.on('data', data => { child.output = (child.output + data.toString()).slice(-40000); });
  child.stdin.on('error', () => {}); return child;
}
async function until(fn, child, timeout = 15000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await fn()) return; if (child?.exitCode !== null && child?.exitCode !== undefined) throw new Error('CLI exited early: ' + child.output); await sleep(20); }
  throw new Error('Setup test timed out: ' + (child?.output ?? ''));
}
async function exited(child) { await until(() => child.done, null); return child.exited; }
async function stop(child) { if (!child.done) child.kill('SIGTERM'); await exited(child); }
after(async () => { for (const child of children) await stop(child); await fs.rm(scratch, { recursive: true, force: true, maxRetries: 6, retryDelay: 100 }); });

test('compiled CLI missing unattended configuration exits instead of waiting for a prompt', { timeout: 10000 }, async () => {
  const child = childCli(path.join(scratch, 'empty-cli'), ['--non-interactive']); assert.equal(await exited(child), 2); assert.match(child.output, /No saved relay/); assert.ok(!child.output.includes('Relay URL:'));
});
test('compiled setup EOF exits cleanly without starting an agent', { timeout: 10000 }, async () => {
  const child = childCli(path.join(scratch, 'eof-cli'), ['--setup', '--no-browser']); await until(() => child.output.includes('Relay URL:'), child); child.stdin.end(); assert.equal(await exited(child), 0); assert.ok(!child.output.includes('Connected')); assert.ok(!child.output.includes('Unhandled'));
});
test('compiled forget command deletes only the local pairing file', { timeout: 10000 }, async () => {
  const home = path.join(scratch, 'forget-cli'); await fs.mkdir(home); await fs.writeFile(path.join(home, 'device.json'), JSON.stringify(old)); await fs.writeFile(path.join(home, 'config.json'), 'leave-alone');
  const child = childCli(home, ['--forget-relay']); assert.equal(await exited(child), 0); assert.equal(await fs.stat(path.join(home, 'device.json')).catch(() => null), null); assert.equal(await fs.readFile(path.join(home, 'config.json'), 'utf8'), 'leave-alone'); assert.ok(!child.output.includes(old.deviceToken));
});
test('real CLI change failure preserves the old saved URL and token', { timeout: 15000 }, async () => {
  const home = path.join(scratch, 'failed-change'); await fs.mkdir(home); const before = JSON.stringify(old); await fs.writeFile(path.join(home, 'device.json'), before);
  const server = createServer((_req, res) => { res.writeHead(503, { 'content-type': 'application/json' }); res.end('{}'); }); await new Promise(r => server.listen(0, '127.0.0.1', r));
  const child = childCli(home, ['--setup', '--no-browser']);
  try {
    await until(() => child.output.includes('Choose [1]:'), child); child.stdin.write('2\n'); await until(() => child.output.includes('Relay URL:'), child); child.stdin.write(`http://127.0.0.1:${server.address().port}\n`); await until(() => child.output.includes('Device name ['), child); child.stdin.write('\n');
    await until(() => child.output.includes('Enter = retry'), child); child.stdin.write('b\n'); await until(() => (child.output.match(/Choose \[1\]:/g) ?? []).length === 2, child); child.stdin.write('0\n'); assert.equal(await exited(child), 0); assert.equal(await fs.readFile(path.join(home, 'device.json'), 'utf8'), before);
  } finally { await stop(child); server.closeAllConnections(); await new Promise(r => server.close(r)); }
});
test('first-run UI pairs with a loopback relay; saved connect and confirmed forgetting work', { timeout: 30000 }, async () => {
  const home = path.join(scratch, 'real-ui'); await fs.mkdir(home); await fs.writeFile(path.join(home, 'config.json'), JSON.stringify({ allowedDirectories: [home], telemetryEnabled: false }));
  const relay = buildRelay({ port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:3210', trustProxy: false, dbFile: path.join(scratch, 'ui-relay.sqlite'), sessionSecret: 'ui-fixture', adminUser: 'admin', adminPassword: 'ui-fixture', relayVersion: 'ui-fixture' }, () => {});
  await new Promise(r => relay.http.listen(0, '127.0.0.1', r)); const url = `http://127.0.0.1:${relay.http.address().port}`;
  let child = childCli(home, ['--setup', '--no-browser']);
  try {
    await until(() => child.output.includes('Relay URL:'), child); child.stdin.write(url + '/mcp\n'); await until(() => child.output.includes('Device name ['), child); child.stdin.write('Menu integration PC\n');
    await until(() => /code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.test(child.output), child); const code = /code: ([A-Z0-9]{4}-[A-Z0-9]{4})/.exec(child.output)[1], row = relay.store.getDeviceCodeByUserCode(code), user = relay.store.getUserByName('admin'); relay.store.approveDeviceCode(row.device_code, user.id, '');
    await until(() => child.output.includes('Ready: relay'), child); const saved = JSON.parse(await fs.readFile(path.join(home, 'device.json'), 'utf8')); assert.equal(saved.relayUrl, url); assert.equal(saved.name, 'Menu integration PC'); assert.ok(!child.output.includes(saved.deviceToken)); assert.equal(relay.hub.list().length, 1); await stop(child);
    child = childCli(home, ['--setup', '--no-browser']); await until(() => child.output.includes('Choose [1]:'), child); child.stdin.write('\n'); await until(() => child.output.includes('Ready: relay'), child); assert.ok(!child.output.includes('Pairing required')); await stop(child);
    child = childCli(home, ['--setup', '--no-browser']); await until(() => child.output.includes('Choose [1]:'), child); child.stdin.write('3\n'); await until(() => child.output.includes('[y/N]:'), child); child.stdin.write('yes\n'); await until(() => child.output.includes('Relay URL:'), child); child.stdin.write('q\n'); assert.equal(await exited(child), 0);
    assert.equal(await fs.stat(path.join(home, 'device.json')).catch(() => null), null); assert.ok(relay.store.getDevice(saved.deviceId), 'local forgetting does not revoke the server device'); assert.deepEqual(JSON.parse(await fs.readFile(path.join(home, 'config.json'), 'utf8')).allowedDirectories, [home]); assert.deepEqual(await fs.readdir(path.join(home, 'logs')).catch(() => []), []);
  } finally { await stop(child); relay.http.closeAllConnections(); await relay.close(); }
});
