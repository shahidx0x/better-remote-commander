// Unit tests for relay internals. Run after build: node --test packages/relay/test/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { SqliteStore, verifyPassword, hashPassword } from '../dist/store/sqlite.js';
import { LoginLimiter } from '../dist/auth/rate-limit.js';
import { DeviceHub } from '../dist/device-hub.js';

test('password hashing round-trips and rejects wrong password', () => {
  const h = hashPassword('s3cret');
  assert.ok(verifyPassword('s3cret', h));
  assert.ok(!verifyPassword('S3cret', h));
  assert.ok(!verifyPassword('s3cret', 'garbage'));
});

test('store: device token issue / lookup / revoke, pairing codes, audit', () => {
  const s = new SqliteStore(':memory:');
  const u = s.upsertUser('admin', 'pw');
  const raw = s.issueDeviceToken('dev1', u.id, 'PC', 'win32');
  assert.equal(s.getDeviceByToken(raw)?.device_id, 'dev1');
  assert.equal(s.getDeviceByToken(raw + 'x'), undefined);
  const raw2 = s.issueDeviceToken('dev1', u.id, 'PC', 'win32');
  assert.equal(s.getDeviceByToken(raw), undefined, 're-issue invalidates old token');
  assert.equal(s.getDeviceByToken(raw2)?.device_id, 'dev1');
  s.deleteDevice('dev1');
  assert.equal(s.getDeviceByToken(raw2), undefined);

  const dc = s.createDeviceCode('agent', 60_000);
  assert.match(dc.user_code, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  assert.equal(s.getDeviceCodeByUserCode(dc.user_code.toLowerCase().replace('-', ''))?.device_code, dc.device_code, 'user code lookup is lenient');
  s.approveDeviceCode(dc.device_code, u.id, '');
  assert.equal(s.getDeviceCode(dc.device_code)?.approved, 1);

  s.audit({ ts: Date.now(), user_id: u.id, device_id: 'dev1', client: 'c', tool: 'read_file', args_hash: 'ab', ok: 1, ms: 5, error: null });
  s.audit({ ts: Date.now(), user_id: u.id, device_id: 'dev1', client: 'c', tool: 'read_file', args_hash: 'ab', ok: 0, ms: 5, error: 'x' });
  assert.deepEqual(s.auditStats(u.id), { total: 2, failed: 1, last24h: 2 });
  s.close();
});

test('store: tokens expire and revoke', () => {
  const s = new SqliteStore(':memory:');
  const now = Date.now();
  const h = (t) => createHash('sha256').update(t).digest('hex');
  s.insertToken({ token_hash: h('t1'), kind: 'access', client_id: 'c', user_id: 'u', scopes: 'mcp:tools', resource: null, expires_at: now + 1000, created_at: now, revoked: 0 });
  s.insertToken({ token_hash: h('t2'), kind: 'access', client_id: 'c', user_id: 'u', scopes: 'mcp:tools', resource: null, expires_at: now - 1, created_at: now, revoked: 0 });
  assert.ok(s.getToken('t1', 'access'));
  assert.equal(s.getToken('t2', 'access'), undefined, 'expired');
  assert.equal(s.getToken('t1', 'refresh'), undefined, 'kind mismatch');
  s.revokeToken('t1');
  assert.equal(s.getToken('t1', 'access'), undefined, 'revoked');
  s.close();
});

test('login limiter locks after N failures and clears on success', () => {
  const l = new LoginLimiter(3, 60_000);
  assert.equal(l.locked('k'), 0);
  l.fail('k'); l.fail('k');
  assert.equal(l.locked('k'), 0);
  l.fail('k');
  assert.ok(l.locked('k') > 0);
  assert.equal(l.locked('other'), 0);
  l.ok('k');
  assert.equal(l.locked('k'), 0);
});

// Fake ws socket: EventEmitter with send/close/terminate and OPEN state
import { EventEmitter } from 'node:events';
class FakeSocket extends EventEmitter {
  constructor() { super(); this.OPEN = 1; this.readyState = 1; this.sent = []; this.closed = null; }
  send(s) { this.sent.push(JSON.parse(s)); }
  close(code, reason) { this.closed = { code, reason }; this.readyState = 3; this.emit('close', code, reason); }
  terminate() { this.close(1006, ''); }
  recv(obj) { this.emit('message', Buffer.from(JSON.stringify(obj))); }
}
const hello = (id, tools = [{ name: 'echo', description: 'x', inputSchema: {} }]) => ({ type: 'hello', protocol: 1, device: { deviceId: id, name: id, platform: 'linux', arch: 'x64', hostname: 'h', agentVersion: '1', coreVersion: '1' }, tools });

test('device hub: hello/welcome, call/result matching, protocol + id checks, default resolution', async () => {
  const hub = new DeviceHub('t', () => {});
  const a = new FakeSocket();
  hub.attach(a, 'u1', 'devA');
  a.recv({ ...hello('wrong-id') });
  assert.equal(a.closed?.code, 4403, 'hello deviceId must match paired token');

  const b = new FakeSocket();
  hub.attach(b, 'u1', 'devA');
  b.recv(hello('devA'));
  assert.equal(b.sent[0]?.type, 'welcome');
  assert.equal(hub.resolveDefault('u1'), 'devA');
  assert.equal(hub.resolveDefault('u2'), null, 'other user sees nothing');

  const p = hub.call('devA', 'echo', { x: 1 }, { timeoutMs: 2000 });
  const callMsg = b.sent.find((m) => m.type === 'call');
  assert.equal(callMsg.tool, 'echo');
  b.recv({ type: 'result', id: callMsg.id, result: { content: [{ type: 'text', text: 'ok' }] } });
  assert.equal((await p).content[0].text, 'ok');

  await assert.rejects(hub.call('devA', 'nope', {}), /UNKNOWN_TOOL/);
  await assert.rejects(hub.call('devB', 'echo', {}), /DEVICE_OFFLINE/);
  const t = hub.call('devA', 'echo', {}, { timeoutMs: 50 });
  await assert.rejects(t, /CALL_TIMEOUT/);

  const c = new FakeSocket();
  hub.attach(c, 'u1', 'devB');
  c.recv(hello('devB'));
  assert.equal(hub.resolveDefault('u1'), null, 'two devices -> ambiguous');

  const old = new FakeSocket();
  hub.attach(old, 'u1', 'devA');
  old.recv({ ...hello('devA'), protocol: 99 });
  assert.equal(old.closed?.code, 1002, 'protocol mismatch rejected');
  hub.close();
});

test('URL-only MCP credentials: hashed storage, owner-scoped revoke, expiry and limits', () => {
  const s = new SqliteStore(':memory:');
  try {
    const first = s.upsertUser('first-user', 'test-pw');
    const other = s.upsertUser('other-user', 'test-pw');
    const created = s.createConnectionLink(first.id, 'my client', 'read', 1);
    assert.match(created.key, /^brc_link_[A-Za-z0-9_-]{43}$/);
    assert.equal(s.listConnectionLinks(first.id).length, 1);
    assert.equal(s.listConnectionLinks(other.id).length, 0);
    assert.equal(s.getConnectionLink(created.key)?.user_id, first.id);
    assert.equal(s.getConnectionLink(created.key)?.mode, 'read');
    assert.equal(s.getConnectionLink(created.key + 'x'), undefined);
    assert.equal(s.getConnectionLink('invalid'), undefined);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
    const record = s.db.prepare('SELECT key_hash FROM connection_links WHERE id=?').get(created.id);
    assert.equal(record.key_hash, createHash('sha256').update(created.key).digest('hex'));
    assert.notEqual(record.key_hash, created.key);
    assert.equal(s.revokeConnectionLink(other.id, created.id), false, 'another account cannot revoke this URL');
    assert.equal(s.getConnectionLink(created.key)?.id, created.id);
    assert.equal(s.revokeConnectionLink(first.id, created.id), true);
    assert.equal(s.getConnectionLink(created.key), undefined, 'revoke takes effect without cache');
    assert.equal(s.revokeConnectionLink(first.id, created.id), false);

    const expires = s.createConnectionLink(first.id, 'short-lived', 'full', 7);
    s.db.prepare('UPDATE connection_links SET expires_at = ? WHERE id = ?').run(Date.now() - 5, expires.id);
    assert.equal(s.getConnectionLink(expires.key), undefined);
    s.vacuumExpired();
    assert.equal(s.listConnectionLinks(first.id).length, 0);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM connection_links').get().n, 0);
    // Long-lived URLs must work while remaining immediately revocable.
    for (const days of [365, 730]) {
      const before = Date.now();
      const annual = s.createConnectionLink(first.id, 'annual link', 'full', days);
      assert.ok(annual.expiresAt >= before + days * 86_400_000);
      assert.ok(annual.expiresAt <= Date.now() + days * 86_400_000);
      assert.equal(s.getConnectionLink(annual.key)?.expires_at, annual.expiresAt);
      assert.equal(s.revokeConnectionLink(first.id, annual.id), true);
      assert.equal(s.getConnectionLink(annual.key), undefined);
    }
    assert.throws(() => s.createConnectionLink(first.id, 'x', 'full', 731), /Invalid connection lifetime/);
    assert.throws(() => s.createConnectionLink(first.id, 'x', 'full', 366), /Invalid connection lifetime/);
    assert.throws(() => s.createConnectionLink(first.id, 'x', 'nope', 7));
    assert.throws(() => s.createConnectionLink(first.id, '', 'read', 7));
    for (let i = 0; i < 20; i++) s.createConnectionLink(first.id, 'test ' + i, 'read', 7);
    assert.throws(() => s.createConnectionLink(first.id, 'too-many', 'read', 7), /Maximum 20/);
    assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n, 0);
  } finally { s.close(); }
});

test('manual OAuth recovery validates issuer, callback, PKCE and explicit owner approval', async () => {
  const { parseAuthorizeRequest, validateRedirectUri, approveCallback } = await import('../dist/auth/client-recovery.js');
  const base = 'https://my-relay.example';
  const challenge = 'a'.repeat(43);
  const make = (callback = 'https://arbitrary-wrapper.example/oauth/cb') =>
    base + '/authorize?response_type=code&client_id=cl_oldWrapper99&redirect_uri=' + encodeURIComponent(callback)
    + '&code_challenge=' + challenge + '&code_challenge_method=S256&resource=' + encodeURIComponent(base + '/mcp');
  const known = make();
  const parsed = parseAuthorizeRequest(known, base);
  assert.equal(parsed.clientId, 'cl_oldWrapper99');
  assert.equal(parsed.redirectUri, 'https://arbitrary-wrapper.example/oauth/cb');
  assert.throws(() => parseAuthorizeRequest(make('https://user:pw@evil.example/cb'), base), /credentials/);
  assert.throws(() => parseAuthorizeRequest(make('https://evil.example/cb#fragment'), base), /fragments/);
  assert.throws(() => parseAuthorizeRequest(make('http://example.com/cb'), base), /HTTPS/);
  assert.equal(validateRedirectUri('http://127.0.0.1:7821/callback'), 'http://127.0.0.1:7821/callback');
  assert.throws(() => parseAuthorizeRequest(known.replace('code_challenge_method=S256', 'code_challenge_method=plain'), base), /S256/);
  assert.throws(() => parseAuthorizeRequest(known.replace('/authorize?', '/random?'), base), /not an authorization/);
  assert.throws(() => parseAuthorizeRequest(known.replace('/authorize?', '/authorize?client_id=duplicate&'), base), /duplicate/);
  assert.throws(() => parseAuthorizeRequest(known.replace('my-relay.example', 'foreign.example'), base), /not an authorization/);
  assert.throws(() => parseAuthorizeRequest(known.replace('my-relay.example%2Fmcp', 'another.example%2Fmcp'), base), /resource/);
  const store = new SqliteStore(':memory:');
  try {
    assert.equal(await approveCallback(store, parsed, 'Wrapper'), 'registered');
    const row = store.getClient(parsed.clientId);
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.token_endpoint_auth_method, 'none');
    assert.deepEqual(metadata.redirect_uris, [parsed.redirectUri]);
    assert.equal(await approveCallback(store, parsed, 'Wrapper'), 'already_registered');
    assert.equal(await approveCallback(store, { clientId: parsed.clientId, redirectUri: 'https://another.example/cb' }, 'Other'), 'added_callback');
    assert.deepEqual(JSON.parse(store.getClient(parsed.clientId).metadata).redirect_uris, [parsed.redirectUri, 'https://another.example/cb']);
    await assert.rejects(() => approveCallback(store, { clientId: parsed.clientId, redirectUri: 'http://remote.example/cb' }, 'Bad'), /HTTPS/);
  } finally { store.close(); }
});

test('MCP catalog is stable before agent connects, while online, and after disconnect', async () => {
  const { liveTools, BUNDLED_AGENT_TOOL_CATALOG } = await import('../dist/mcp/server.js').then(async m => ({
    ...m, BUNDLED_AGENT_TOOL_CATALOG: (await import('../dist/mcp/agent-tools.catalog.js')).BUNDLED_AGENT_TOOL_CATALOG,
  }));
  const hub = new DeviceHub('test', () => {});
  const store = new SqliteStore(':memory:');
  try {
    const owner = store.upsertUser('owner', 'secret');
    const offline = await liveTools(hub, store, owner.id);
    const names = offline.tools.map(t => t.name);
    assert.equal(offline.online, 0);
    assert.equal(names.length, BUNDLED_AGENT_TOOL_CATALOG.length);
    assert.ok(names.includes('read_file') && names.includes('write_file') && names.includes('run_command') && names.includes('workspace_batch'));
    assert.ok(offline.tools.every(t => t.inputSchema?.properties?.deviceId), 'all tools have device targeting property');
    const readFile = offline.tools.find(t => t.name === 'read_file');
    assert.equal(typeof readFile.description, 'string');
    const socket = new FakeSocket();
    hub.attach(socket, owner.id, 'device');
    store.issueDeviceToken('device', owner.id, 'PC', 'win32');
    socket.recv(hello('device', [
      { name: 'read_file', description: 'agent-specific live schema', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'find_references', description: 'WRONG: this is a guaranteed semantic language-server reference search', inputSchema: { type: 'object', properties: { path: { type: 'string' } } } },
      { name: 'device_extra', description: 'newer agent extra', inputSchema: { type: 'object', properties: {} } },
    ]));
    const online = await liveTools(hub, store, owner.id);
    assert.equal(online.online, 1);
    assert.ok(online.tools.some(t => t.name === 'device_extra'));
    assert.match(online.tools.find(t => t.name === 'read_file').description, /ONE FILE OR URL ONLY/, 'relay overrides stale agent description with recommended multi-file routing');
    assert.equal(online.tools.find(t => t.name === 'read_file').inputSchema.properties.path.type, 'string', 'live device input schema still wins');
    assert.match(online.tools.find(t => t.name === 'find_references').description, /^USE WHEN: /, 'older agents cannot override reviewed tool-choice rules');
    assert.doesNotMatch(online.tools.find(t => t.name === 'find_references').description, /WRONG: this is a guaranteed semantic/, 'incorrect claims from older agents are not advertised');
    assert.ok(names.every(n => online.tools.some(t => t.name === n)), 'online does not hide stable tools');
    socket.close(1000, 'done');
    const recovered = await liveTools(hub, store, owner.id);
    assert.equal(recovered.online, 0);
    assert.deepEqual(recovered.tools.map(t => t.name), names, 'offline and reconnect states keep the same base catalog');
    assert.equal(hub.resolveDefault(owner.id), null, 'advertised offline tools are not executable on an offline device');
  } finally { hub.close(); store.close(); }
});

test('LLM routing guidance chooses batches for known files and read-only batching cannot mutate', async () => {
  const { TOOL_ROUTING_GUIDANCE, readOnlyToolAllowed } = await import('../dist/mcp/server.js');
  const { BUNDLED_AGENT_TOOL_CATALOG } = await import('../dist/mcp/agent-tools.catalog.js');
  const { ReadMultipleFilesArgsSchema } = await import('../../agent/dist/core/tools/schemas.js');
  const definitions = new Map(BUNDLED_AGENT_TOOL_CATALOG.map(t => [t.name, t]));
  assert.deepEqual(BUNDLED_AGENT_TOOL_CATALOG.slice(0, 3).map(t => t.name),
    ['read_multiple_files', 'batch_tools', 'workspace_batch'], 'batch-first discovery order');
  assert.match(TOOL_ROUTING_GUIDANCE, /2\+ known files.*read_multiple_files/);
  assert.match(TOOL_ROUTING_GUIDANCE, /batch_tools/);
  assert.match(TOOL_ROUTING_GUIDANCE, /workspace_batch/);
  assert.match(definitions.get('read_multiple_files').description, /PREFERRED FOR 2 OR MORE KNOWN FILE PATHS/);
  assert.match(definitions.get('read_file').description, /ONE FILE OR URL ONLY/);
  assert.doesNotMatch(definitions.get('write_file').description, /CHUNKING IS STANDARD PRACTICE|25-30 lines/);
  assert.doesNotMatch(definitions.get('start_process').description, /CRITICAL RULE: For ANY local file work|ALWAYS USE FOR:/);
  assert.doesNotMatch(definitions.get('interact_with_process').description, /FILE ANALYSIS PRIORITY ORDER \(MANDATORY\)/);
  assert.ok(definitions.get('read_multiple_files').inputSchema.anyOf?.length === 2,
    'The cross-field one-or-more file requirement must be visible in JSON Schema');
  assert.equal(ReadMultipleFilesArgsSchema.safeParse({}).success, false);
  assert.equal(ReadMultipleFilesArgsSchema.safeParse({ paths: ['a.ts', 'b.rs'] }).success, true);
  assert.equal(ReadMultipleFilesArgsSchema.safeParse({ files: [{path: 'a.ts'}] }).success, true);
  assert.equal(ReadMultipleFilesArgsSchema.safeParse({ paths: Array(65).fill('test.txt') }).success, false);
  assert.equal(ReadMultipleFilesArgsSchema.safeParse({ paths: Array(40).fill('a'), files: Array(25).fill({path:'b'}) }).success, false);

  assert.equal(readOnlyToolAllowed('read_multiple_files', { paths: ['/a', '/b'] }), true);
  assert.equal(readOnlyToolAllowed('batch_tools', { calls: [
    { tool: 'read_multiple_files', arguments: { paths: ['/a', '/b'] } },
    { tool: 'read_file', arguments: { path: '/c' } },
  ] }), true);
  for (const bad of [
    {calls: [{ tool: 'write_file', arguments: {path:'/x',content:'changed'} }]},
    {calls: [{ tool: 'start_process', arguments: {command:'echo danger'} }]},
    {calls: [{ tool: 'batch_tools', arguments: {calls: [{tool: 'read_file'}]} }]},
    {calls: [{ tool: 'read_file' }, { tool: 'edit_block', arguments: {} }]},
    {calls: Array(65).fill({tool: 'read_file', arguments: {path:'/x'}})},
    {calls: []}, {calls: [{ tool: 'read_file', arguments: 'not-an-object' }]}, null,
  ]) assert.equal(readOnlyToolAllowed('batch_tools', bad), false);
});

test('MongoDB is opt-in, no silent SQLite fallback on bad URI', async () => {
  const { buildRelay, loadConfig } = await import('../dist/app.js');
  const { MongoStore } = await import('../dist/store/mongo.js');
  const { mkdtempSync, existsSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const folder = mkdtempSync(join(tmpdir(), 'brc-mongo-select-'));
  try {
    const dbFile = join(folder, 'must-not-exist.sqlite');
    const cfg = { ...loadConfig(), dbFile, mongoUri: 'not-a-mongodb-uri', adminPassword: 'strong-test-pass', sessionSecret: 'only-for-tests' };
    await assert.rejects(() => buildRelay(cfg, () => {}), /MONGODB_URI/);
    assert.equal(existsSync(dbFile), false, 'selection failure must not create an empty SQLite database');
    await assert.rejects(() => MongoStore.connect('http://not-a-database'), /MONGODB_URI/);
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('SQLite-to-Mongo migration dry run preserves auth state but excludes audit logs', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { spawnSync } = await import('node:child_process');
  const folder = mkdtempSync(join(tmpdir(), 'brc-sqlite-migrate-'));
  try {
    const file = join(folder, 'previous-relay.sqlite');
    const s = new SqliteStore(file);
    const user = s.upsertUser('admin', 'original-secret');
    const pairedToken = s.issueDeviceToken('pc-001', user.id, 'My PC', 'win32');
    s.insertClient({ client_id: 'client-a', client_secret: null, metadata: '{"client_name":"AI"}', created_at: Date.now() });
    s.createConnectionLink(user.id, 'backup', 'read', 7);
    s.audit({ ts: Date.now(), user_id: user.id, device_id: 'pc-001', client: 'chat', tool: 'read_file', args_hash: null, ok: 1, ms: 1, error: null });
    s.close();
    const res = spawnSync(process.execPath, ['packages/relay/dist/store/migrate.js', '--dry-run'], {
      cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, BRC_DB: file, MONGODB_URI: '' },
    });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /users: 1/);
    assert.match(res.stdout, /oauth_clients: 1/);
    assert.match(res.stdout, /devices: 1/);
    assert.match(res.stdout, /connection_links: 1/);
    assert.doesNotMatch(res.stdout, /audit:\s*\d+|original-secret|brc_dev_/i);
    assert.ok(pairedToken.startsWith('brc_dev_'));
  } finally { rmSync(folder, { recursive: true, force: true }); }
});

test('connection page displays one- and two-year expiration choices', async () => {
  const { connectionLinksPage } = await import('../dist/pages/admin.js');
  const page = connectionLinksPage([], 'test-csrf');
  assert.match(page, /<option value="365">1 year \(365 days\)<\/option>/);
  assert.match(page, /<option value="730">2 years \(730 days\)<\/option>/);
  assert.match(page, /<option value="7" selected>7 days<\/option>/);
  assert.match(page, /<option value="90">90 days<\/option>/);
});
