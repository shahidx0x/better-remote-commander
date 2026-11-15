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
    assert.throws(() => s.createConnectionLink(first.id, 'x', 'full', 365));
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
    assert.equal(approveCallback(store, parsed, 'Wrapper'), 'registered');
    const row = store.getClient(parsed.clientId);
    const metadata = JSON.parse(row.metadata);
    assert.equal(metadata.token_endpoint_auth_method, 'none');
    assert.deepEqual(metadata.redirect_uris, [parsed.redirectUri]);
    assert.equal(approveCallback(store, parsed, 'Wrapper'), 'already_registered');
    assert.equal(approveCallback(store, { clientId: parsed.clientId, redirectUri: 'https://another.example/cb' }, 'Other'), 'added_callback');
    assert.deepEqual(JSON.parse(store.getClient(parsed.clientId).metadata).redirect_uris, [parsed.redirectUri, 'https://another.example/cb']);
    assert.throws(() => approveCallback(store, { clientId: parsed.clientId, redirectUri: 'http://remote.example/cb' }, 'Bad'), /HTTPS/);
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
    const offline = liveTools(hub, store, owner.id);
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
      { name: 'device_extra', description: 'newer agent extra', inputSchema: { type: 'object', properties: {} } },
    ]));
    const online = liveTools(hub, store, owner.id);
    assert.equal(online.online, 1);
    assert.ok(online.tools.some(t => t.name === 'device_extra'));
    assert.equal(online.tools.find(t => t.name === 'read_file').description, 'agent-specific live schema');
    assert.ok(names.every(n => online.tools.some(t => t.name === n)), 'online does not hide stable tools');
    socket.close(1000, 'done');
    const recovered = liveTools(hub, store, owner.id);
    assert.equal(recovered.online, 0);
    assert.deepEqual(recovered.tools.map(t => t.name), names, 'offline and reconnect states keep the same base catalog');
    assert.equal(hub.resolveDefault(owner.id), null, 'advertised offline tools are not executable on an offline device');
  } finally { hub.close(); store.close(); }
});
