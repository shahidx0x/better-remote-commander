// Unit tests for the plugin system on the relay side: registry mapping, definition validation,
// registry client (cache/timeout/errors), request lifecycle, hub protocol, CSRF, AI tools.
// Run after build: node --test packages/relay/test/plugins.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapServer, buildDefinition, RegistryClient, RegistryError } from '../dist/plugins/registry.js';
import { registryValues, extraEnv } from '../dist/plugins/admin-routes.js';
import { handlePluginRelayTool } from '../dist/mcp/plugin-tools.js';
import { SqliteStore, MAX_PENDING_PLUGIN_REQUESTS } from '../dist/store/sqlite.js';
import { DeviceHub } from '../dist/device-hub.js';
import { Sessions } from '../dist/auth/sessions.js';
import { validatePluginDefinition, parseCustomSpec, splitCommandLine, pluginIdFrom, pluginIdForSource, sanitizePluginSummary } from 'brc-shared';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixtureFile = path.resolve(here, '../../../scripts/fixtures/mcp-registry.json');
const fixture = JSON.parse(readFileSync(fixtureFile, 'utf8')).servers.map((s) => s.server);
const byName = (n) => mapServer(fixture.find((s) => s.name === n));

test('registry mapping: npm stdio -> npm source with fixed env/args and secret input', () => {
  const e = byName('io.example/echo-npm');
  assert.equal(e.namespace, 'io.example');
  assert.equal(e.suggestedId, 'echo-npm');
  assert.deepEqual(e.option.source, { type: 'npm', package: '@example/echo-mcp', version: '1.0.0', args: ['serve'] });
  assert.deepEqual(e.option.fixedEnv, { ECHO_MODE: 'stdio' });
  assert.deepEqual(e.requiredInputs, ['ECHO_API_KEY']);
  assert.equal(e.option.inputs[0].secret, true);
  assert.throws(() => buildDefinition(e, {}), /ECHO_API_KEY/);
  const { definition, env } = buildDefinition(e, { env: { ECHO_API_KEY: 'k' } });
  assert.deepEqual(env, { ECHO_MODE: 'stdio', ECHO_API_KEY: 'k' });
  assert.equal(definition.origin, 'marketplace');
  assert.equal(definition.registryName, 'io.example/echo-npm');
  assert.equal(validatePluginDefinition(definition), null);
});

test('registry mapping: pypi, remote with variables/headers, oci and unpinned versions', () => {
  assert.deepEqual(byName('io.example/echo-py').option.source, { type: 'pypi', package: 'echo-mcp-server', version: '0.2.0' });

  const r = byName('io.example/echo-remote');
  assert.equal(r.option.kind, 'remote');
  assert.deepEqual(r.requiredInputs.sort(), ['Authorization', 'tenant']);
  const { definition, env } = buildDefinition(r, { vars: { tenant: 'a b/../x' }, headers: { Authorization: 'Bearer t' } });
  assert.equal(definition.source.url, 'https://echo.example.com/a%20b%2F..%2Fx/mcp', 'variables are URL-encoded');
  assert.deepEqual(definition.source.headers, { Authorization: 'Bearer t' });
  assert.deepEqual(env, {});

  const d = byName('io.example/echo-docker');
  assert.equal(d.option, undefined);
  assert.equal(d.unsupported, 'not supported (Docker)');
  assert.throws(() => buildDefinition(d, {}), /Docker/);
  assert.match(byName('io.example/echo-latest').unsupported, /no exact package version/);

  // http remotes, sse remotes and non-stdio packages are not installable
  assert.equal(mapServer({ name: 'a/b', remotes: [{ type: 'streamable-http', url: 'http://x/mcp' }] }).option, undefined);
  assert.equal(mapServer({ name: 'a/b', remotes: [{ type: 'sse', url: 'https://x/sse' }] }).option, undefined);
  assert.equal(mapServer({ name: 'a/b', packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0', transport: { type: 'streamable-http' } }] }).option, undefined);
  // npm preferred over remote when both exist
  assert.equal(mapServer({ name: 'a/b', remotes: [{ type: 'streamable-http', url: 'https://x/mcp' }], packages: [{ registryType: 'npm', identifier: 'x', version: '1.0.0', transport: { type: 'stdio' } }] }).option.kind, 'npm');
  assert.equal(mapServer({}), null);
  assert.equal(mapServer({ name: 'x', packages: 'garbage' }).option, undefined, 'never throws on odd shapes');
});

test('definition validation: ids, versions, https, headers, env', () => {
  const ok = { id: 'my-plugin', name: 'X', source: { type: 'npm', package: '@s/p', version: '1.2.3' } };
  assert.equal(validatePluginDefinition(ok), null);
  assert.match(validatePluginDefinition({ ...ok, id: 'Bad_Id' }), /plugin id/);
  assert.match(validatePluginDefinition({ ...ok, id: '../x' }), /plugin id/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'npm', package: 'p', version: '^1.2.3' } }), /exact/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'npm', package: 'p', version: 'latest' } }), /exact/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'npm', package: 'P A', version: '1.0.0' } }), /npm package/);
  assert.equal(validatePluginDefinition({ ...ok, source: { type: 'pypi', package: 'mcp-server-fetch', version: '2025.1.17' } }), null);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'pypi', package: 'x', version: '>=1.0' } }), /exact/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'remote', url: 'http://x/mcp' } }), /https/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'remote', url: 'https://u:p@x/mcp' } }), /credentials/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'remote', url: 'https://x/mcp', headers: { 'X-A': 'a\r\nInjected: 1' } } }), /header/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'binary', binName: 'x', version: '1' } }), /source.type/);
  assert.match(validatePluginDefinition({ ...ok, source: { type: 'command', command: '' } }), /command/);
});

test('custom specs and command-line splitting', () => {
  assert.deepEqual(parseCustomSpec('npm', '@scope/pkg@1.0.0'), { type: 'npm', package: '@scope/pkg', version: '1.0.0' });
  assert.deepEqual(parseCustomSpec('pypi', 'mcp-server-git==0.6.2'), { type: 'pypi', package: 'mcp-server-git', version: '0.6.2' });
  assert.deepEqual(parseCustomSpec('remote', 'https://h/mcp'), { type: 'remote', url: 'https://h/mcp' });
  assert.throws(() => parseCustomSpec('npm', 'pkg'), /package@/);
  assert.throws(() => parseCustomSpec('remote', 'http://h/mcp'), /https/);
  assert.throws(() => parseCustomSpec('docker', 'x'), /type/);
  assert.deepEqual(splitCommandLine('"C:\\Program Files\\nodejs\\node.exe" C:\\x\\s.mjs --a "b c" \'d e\''), ['C:\\Program Files\\nodejs\\node.exe', 'C:\\x\\s.mjs', '--a', 'b c', 'd e']);
  assert.throws(() => splitCommandLine('"open'), /quote/);
  const cmd = parseCustomSpec('command', '"/usr/bin/node" /opt/echo-mcp.mjs');
  assert.equal(pluginIdForSource(cmd), 'echo-mcp');
  assert.equal(pluginIdFrom('io.github.Foo/Bar_Baz MCP'), 'bar-baz-mcp');
});

test('admin form helpers: registry inputs and extra env rows', () => {
  assert.deepEqual(registryValues({ in_env_A: '1', in_header_Authorization: 'x', in_var_t: 'v', in_arg_p: '3', other: 'y' }),
    { env: { A: '1' }, header: { Authorization: 'x' }, var: { t: 'v' }, arg: { p: '3' } });
  assert.deepEqual(extraEnv({ xenv_name_1: 'K', xenv_value_1: 'v', xenv_name_2: '', xenv_value_2: 'ignored' }), { K: 'v' });
  assert.throws(() => extraEnv({ xenv_name_1: 'BAD-NAME', xenv_value_1: 'v' }), /invalid/);
});

test('registry client: fixture search/get, cache, timeout, HTTP errors', async () => {
  const fx = new RegistryClient({ fixtureFile });
  const s = await fx.search('echo', 2);
  assert.equal(s.entries.length, 2);
  assert.equal(s.nextCursor, '2');
  assert.equal((await fx.search('echo', 10, s.nextCursor)).entries.length, 3);
  assert.equal((await fx.get('io.example/echo-py')).option.kind, 'pypi');
  assert.equal(await fx.get('nope/nope'), null);

  let hits = 0;
  const srv = createServer((req, res) => {
    hits++;
    const u = new URL(req.url, 'http://x');
    if (u.searchParams.get('search') === 'hang') return; // never answers
    if (u.searchParams.get('search') === 'boom') { res.writeHead(500); return res.end('x'); }
    if (u.pathname.startsWith('/v0/servers/') ) {
      if (decodeURIComponent(u.pathname).includes('io.example/echo-npm')) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ server: fixture[0] })); }
      res.writeHead(404); return res.end('{}');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ servers: fixture.map((server) => ({ server })), metadata: { nextCursor: 'c1', count: fixture.length } }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${srv.address().port}`;
  try {
    const live = new RegistryClient({ baseUrl, timeoutMs: 300 });
    const a = await live.search('echo', 5);
    assert.equal(a.entries.length, fixture.length);
    assert.equal(a.nextCursor, 'c1');
    await live.search('echo', 5);
    assert.equal(hits, 1, 'second identical search served from cache');
    assert.equal((await live.get('io.example/echo-npm')).name, 'io.example/echo-npm');
    assert.equal(await live.get('io.example/missing'), null);
    await assert.rejects(live.search('hang', 5), (e) => e instanceof RegistryError && /did not answer/.test(e.message));
    await assert.rejects(live.search('boom', 5), /HTTP 500/);
    await assert.rejects(new RegistryClient({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 2000 }).search('x', 1), RegistryError);
  } finally {
    srv.closeAllConnections?.();
    srv.close();
  }
});

test('store: plugin request lifecycle, dedupe, limits, last-known plugin lists', () => {
  const s = new SqliteStore(':memory:');
  const u = s.upsertUser('admin', 'pw');
  const base = { user_id: u.id, device_id: 'd1', client: 'claude', registry_name: 'io.example/echo-npm', custom_type: null, custom_spec: null, plugin_id: null, reason: 'need it' };
  const r = s.createPluginRequest(base);
  assert.equal(r.status, 'pending');
  assert.match(r.id, /^pr_/);
  assert.equal(s.findPendingPluginRequest(u.id, 'd1', 'io.example/echo-npm', null, null)?.id, r.id);
  assert.equal(s.findPendingPluginRequest(u.id, null, 'io.example/echo-npm', null, null), undefined, 'device is part of the identity');
  assert.ok(!s.setPluginRequestStatus(r.id, 'installed', null, ['approved']), 'cannot skip approval');
  assert.ok(s.setPluginRequestStatus(r.id, 'approved', null, ['pending']));
  assert.ok(!s.setPluginRequestStatus(r.id, 'approved', null, ['pending']), 'cannot approve twice');
  assert.ok(s.setPluginRequestStatus(r.id, 'installed', 'ok', ['approved']));
  assert.equal(s.getPluginRequest(r.id).status, 'installed');
  assert.ok(s.getPluginRequest(r.id).decided_at > 0);

  const r2 = s.createPluginRequest({ ...base, registry_name: null, custom_type: 'npm', custom_spec: 'x@1.0.0' });
  assert.ok(s.setPluginRequestStatus(r2.id, 'rejected', 'no', ['pending']));
  assert.ok(!s.setPluginRequestStatus(r2.id, 'approved', null, ['pending']), 'rejected stays rejected');
  assert.equal(s.listPluginRequests(u.id, { status: 'pending' }).length, 0);
  assert.equal(s.listPluginRequests(u.id).length, 2);

  for (let i = 0; i < MAX_PENDING_PLUGIN_REQUESTS; i++) s.createPluginRequest({ ...base, plugin_id: `p${i}` });
  assert.throws(() => s.createPluginRequest(base), /too many pending/);

  s.issueDeviceToken('d1', u.id, 'PC', 'win32');
  s.saveDevicePlugins('d1', [{ id: 'a' }]);
  s.saveDevicePlugins('d1', [{ id: 'b' }]);
  assert.deepEqual(s.getDevicePlugins('d1').plugins, [{ id: 'b' }]);
  s.deleteDevice('d1');
  assert.equal(s.getDevicePlugins('d1'), undefined, 'removed with the device');
  s.close();
});

class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.closed = null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006, ''); }
  recv(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}
const hello = (id) => ({ type: 'hello', protocol: 1, device: { deviceId: id, name: id, platform: 'linux', arch: 'x64', hostname: 'h', agentVersion: '1', coreVersion: '1' }, tools: [] });

test('device hub: plugins report, plugin_admin round trip, old agents, disconnects', async () => {
  const hub = new DeviceHub('t', () => {});
  const saved = [];
  hub.onPlugins = (id, list) => saved.push([id, list]);
  const a = new FakeSocket();
  hub.attach(a, 'u1', 'devA');
  a.recv(hello('devA'));

  await assert.rejects(hub.pluginAdmin('devA', { action: 'refresh' }), /PLUGINS_UNSUPPORTED/, 'agent that never reported plugins');
  await assert.rejects(hub.pluginAdmin('devX', { action: 'refresh' }), /DEVICE_OFFLINE/);

  a.recv({ type: 'plugins', plugins: [{ id: 'p1', name: 'P', type: 'npm', enabled: true, status: 'installed', envKeys: ['K', 42], extra: 'x', error: 'e'.repeat(5000) }, { nope: 1 }] });
  const list = hub.plugins('devA');
  assert.equal(list.length, 1, 'invalid entries dropped');
  assert.deepEqual(list[0].envKeys, ['K']);
  assert.equal(list[0].error.length, 1000, 'long strings truncated');
  assert.equal(list[0].extra, undefined, 'unknown fields dropped');
  assert.equal(saved.length, 1);

  const p = hub.pluginAdmin('devA', { action: 'install', plugin: { id: 'p2' }, env: { K: 'v' } }, 2000);
  const msg = a.sent.find((m) => m.type === 'plugin_admin');
  assert.equal(msg.action, 'install');
  assert.deepEqual(msg.env, { K: 'v' });
  const b = new FakeSocket();
  hub.attach(b, 'u1', 'devB');
  b.recv(hello('devB'));
  b.recv({ type: 'plugin_admin_result', id: msg.id, ok: true }); // wrong device: ignored
  a.recv({ type: 'plugin_admin_result', id: msg.id, ok: false, error: 'boom', plugin: { id: 'p2', status: 'failed' } });
  const out = await p;
  assert.equal(out.ok, false);
  assert.equal(out.error, 'boom');
  assert.equal(out.plugin.status, 'failed');

  await assert.rejects(hub.pluginAdmin('devA', { action: 'refresh' }, 50), /ADMIN_TIMEOUT/);
  const pending = hub.pluginAdmin('devA', { action: 'remove', pluginId: 'p1' }, 5000);
  a.close(1000, 'bye');
  await assert.rejects(pending, /DEVICE_OFFLINE/, 'disconnect fails pending admin requests immediately');
  hub.close();
});

test('sanitizePluginSummary rejects junk', () => {
  assert.equal(sanitizePluginSummary(null), null);
  assert.equal(sanitizePluginSummary({ name: 'no id' }), null);
  assert.equal(sanitizePluginSummary({ id: 'x', enabled: 'yes' }).enabled, false);
});

test('sessions: CSRF token is valid only for a correctly signed live session cookie', () => {
  const s = new Sessions('secret', false);
  let cookieA = '', cookieB = '';
  s.issue({ cookie: (_name, value) => { cookieA = value; } }, 'owner-a');
  s.issue({ cookie: (_name, value) => { cookieB = value; } }, 'owner-b');
  const req = (cookie) => ({ cookies: cookie ? { brc_session: cookie } : {} });
  const t = s.csrfToken(req(cookieA));
  assert.ok(t && t.length > 20);
  assert.ok(s.checkCsrf(req(cookieA), t));
  assert.ok(!s.checkCsrf(req(cookieB), t), 'other session');
  assert.ok(!s.checkCsrf(req(''), ''), 'no session');
  assert.equal(s.csrfToken(req('u.1.sig')), null, 'forged cookie cannot get a CSRF token');
  assert.ok(!s.checkCsrf(req(cookieA), undefined));
  assert.ok(!s.checkCsrf(req(cookieA), t.slice(1)));
});

test('AI tools: request_plugin_install only records a pending request; search is read-only', async () => {
  const store = new SqliteStore(':memory:');
  const u = store.upsertUser('admin', 'pw');
  store.issueDeviceToken('devA', u.id, 'PC', 'linux');
  const hub = new DeviceHub('t', () => {});
  const sock = new FakeSocket();
  hub.attach(sock, u.id, 'devA');
  sock.recv(hello('devA'));
  sock.recv({ type: 'plugins', plugins: [] });
  const deps = { hub, store, registry: new RegistryClient({ fixtureFile }), publicUrl: 'https://relay.example' };
  const ctx = { userId: u.id, clientId: 'claude' };
  const call = (name, args) => handlePluginRelayTool(deps, ctx, name, args);

  let r = await call('search_mcp_registry', { query: 'echo', limit: 3 });
  assert.ok(!r.isError);
  assert.match(r.content[0].text, /io\.example\/echo-npm/);

  r = await call('request_plugin_install', { registryName: 'io.example/echo-npm', deviceId: 'devA', reason: 'tests' });
  assert.ok(!r.isError, r.content[0].text);
  assert.match(r.content[0].text, /waiting for owner approval in \/admin \(https:\/\/relay\.example\/admin/);
  assert.equal(store.listPluginRequests(u.id, { status: 'pending' }).length, 1);
  assert.equal(sock.sent.filter((m) => m.type === 'plugin_admin').length, 0, 'nothing sent to the agent');

  assert.ok((await call('request_plugin_install', { registryName: 'io.example/echo-docker', reason: 'x' })).isError);
  assert.ok((await call('request_plugin_install', { registryName: 'nope/nope', reason: 'x' })).isError);
  assert.ok((await call('request_plugin_install', { registryName: 'io.example/echo-npm' })).isError, 'reason required');
  assert.ok((await call('request_plugin_install', { registryName: 'io.example/echo-npm', custom: { type: 'npm', spec: 'a@1.0.0' }, reason: 'x' })).isError, 'one of');
  assert.ok((await call('request_plugin_install', { custom: { type: 'remote', spec: 'http://insecure/mcp' }, reason: 'x' })).isError);
  assert.ok((await call('request_plugin_install', { custom: { type: 'npm', spec: 'a@1.0.0' }, deviceId: 'someone-else', reason: 'x' })).isError);
  assert.ok((await call('request_plugin_install', { custom: { type: 'npm', spec: 'a@1.0.0' }, pluginId: 'BAD', reason: 'x' })).isError);
  r = await call('request_plugin_install', { custom: { type: 'command', spec: 'node server.mjs' }, reason: 'x' });
  assert.ok(!r.isError);
  assert.equal(await call('list_devices', {}), null, 'other tools fall through');
  assert.equal(sock.sent.filter((m) => m.type === 'plugin_admin').length, 0);
  hub.close();
  store.close();
});
