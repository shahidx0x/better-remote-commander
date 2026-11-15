
/** Run only against an explicitly supplied TEST MongoDB endpoint. Uses a random,
 * dedicated database; never touches the user's BRC production database. */
import { strict as assert } from 'node:assert';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { MongoClient } from 'mongodb';
import WebSocket from 'ws';
import { createServer as createTcpServer } from 'node:net';
import { MongoStore } from '../dist/store/mongo.js';
import { SqliteStore, verifyPassword } from '../dist/store/sqlite.js';
import { buildRelay } from '../dist/app.js';

const uri = process.env.BRC_TEST_MONGODB_URI;
if (!uri) throw new Error('Set BRC_TEST_MONGODB_URI to an isolated disposable MongoDB TEST server');
const dbName = 'brc_relay_e2e_' + randomBytes(7).toString('hex');
const migrationDb = dbName + '_migration';
const hash = raw => createHash('sha256').update(raw).digest('hex');
const client = new MongoClient(uri, { serverSelectionTimeoutMS: 8000 });
const temp = mkdtempSync(join(tmpdir(), 'brc-mongo-e2e-'));
let store;
let relay;
try {
  await client.connect();
  await client.db('admin').command({ ping: 1 });
  console.log('MongoDB e2e: using a new disposable database (no existing BRC data touched)');
  store = await MongoStore.connect(uri, dbName);
  const user = await store.upsertUser('admin', 'a-strong-secret');
  assert.ok(verifyPassword('a-strong-secret', (await store.getUserByName('admin')).password_hash));
  const clientId = 'client-one';
  await store.insertClient({ client_id: clientId, client_secret: null, metadata: '{"client_name":"real-mongo"}', created_at: Date.now() });
  const code = { code: 'authorization-one', client_id: clientId, user_id: user.id,
    code_challenge: 'challenge', redirect_uri: 'https://example.test/cb', scopes: 'mcp:tools', resource: null,
    expires_at: Date.now() + 60000 };
  await store.insertAuthCode(code);
  assert.equal((await store.peekAuthCode(code.code)).client_id, clientId);
  assert.equal((await store.takeAuthCode(code.code)).code, code.code);
  assert.equal(await store.takeAuthCode(code.code), undefined, 'auth codes may be redeemed only once');
  const access = 'access-e2e';
  await store.insertToken({ token_hash: hash(access), kind: 'access', client_id: clientId, user_id: user.id,
    scopes: 'mcp:tools', resource: null, expires_at: Date.now() + 60000, created_at: Date.now(), revoked: 0 });
  assert.ok(await store.getToken(access, 'access'));
  const originalDeviceToken = await store.issueDeviceToken('workstation', user.id, 'My Windows PC', 'win32');
  assert.equal((await store.getDeviceByToken(originalDeviceToken)).name, 'My Windows PC');
  const pairing = await store.createDeviceCode('agent', 60000);
  assert.equal((await store.getDeviceCodeByUserCode(pairing.user_code.toLowerCase().replace('-', ''))).device_code, pairing.device_code);
  await store.approveDeviceCode(pairing.device_code, user.id, 'workstation');
  assert.equal((await store.getDeviceCode(pairing.device_code)).approved, 1);
  const key = await store.createApiKey(user.id, 'coding-client');
  assert.equal((await store.getApiKey(key.raw)).user_id, user.id);
  const link = await store.createConnectionLink(user.id, 'Coding MCP', 'full', 7);
  assert.equal((await store.getConnectionLink(link.key)).user_id, user.id);
  store.audit({ ts: Date.now(), user_id: user.id, device_id: 'workstation', client: 'test',
    tool: 'read_file', args_hash: null, ok: 1, ms: 1, error: null });
  assert.equal(store.auditStats(user.id).total, 1);
  await store.close(); store = undefined;

  // Cold restart: the exact identity, OAuth, device pairing, keys and links survive.
  store = await MongoStore.connect(uri, dbName);
  assert.equal((await store.getUserByName('admin')).id, user.id);
  assert.ok(await store.getClient(clientId));
  assert.equal((await store.getToken(access, 'access')).user_id, user.id);
  assert.equal((await store.getDeviceByToken(originalDeviceToken)).device_id, 'workstation');
  assert.ok(await store.getApiKey(key.raw));
  assert.ok(await store.getConnectionLink(link.key));
  assert.equal(store.recentAudit(user.id).length, 0, 'tool call activity is RAM-only, not persisted');
  await store.revokeConnectionLink(user.id, link.id);
  assert.equal(await store.getConnectionLink(link.key), undefined, 'revocation persists');
  await store.revokeToken(access);
  assert.equal(await store.getToken(access, 'access'), undefined);
  await store.close(); store = undefined;
  console.log('PASS Mongo persists account, OAuth, paired device, keys and links after restart; logs are volatile');

  // Integration-level boot + health. Reserve an ephemeral port so the OAuth
  // issuer and the actual HTTP origin match in this real-server test.
  const reservation = createTcpServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const listenPort = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  relay = await buildRelay({ port: listenPort, host: '127.0.0.1',
    publicUrl: 'http://127.0.0.1:' + listenPort, trustProxy: false, dbFile: join(temp, 'should-not-create.sqlite'),
    mongoUri: uri, mongoDb: dbName, sessionSecret: 'mongo-e2e-secret',
    adminUser: 'admin', adminPassword: 'a-strong-secret', relayVersion: 'mongo-test' }, () => {});
  await new Promise(resolve => relay.http.listen(listenPort, '127.0.0.1', resolve));
  const port = relay.http.address().port;
  const base = 'http://127.0.0.1:' + port;
  const res = await fetch(base + '/health');
  const health = await res.json();
  assert.equal(health.ok, true); assert.equal(health.storage, 'mongodb'); assert.equal(health.mcpTools, 71);
  assert.equal((await relay.store.getDeviceByToken(originalDeviceToken)).device_id, 'workstation');

  // The complete HTTP OAuth dynamic-registration path must await Mongo writes.
  const registered = await fetch(base + '/register', { method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ client_name: 'mongo-e2e-wrapper',
      redirect_uris: ['https://wrapper.test/oauth/callback'],
      grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'none' }) });
  const clientData = await registered.json();
  assert.equal(registered.status, 201, JSON.stringify(clientData).slice(0, 300));
  assert.ok(clientData.client_id);
  assert.ok(await relay.store.getClient(clientData.client_id), 'OAuth client registration reached MongoDB');

  // Full Mongo-backed OAuth authorization/PKCE/token flow, not only direct store CRUD.
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const redirectUri = 'https://wrapper.test/oauth/callback';
  const resource = base + '/mcp';
  const authUrl = new URL(base + '/authorize');
  for (const [k, v] of Object.entries({ response_type: 'code', client_id: clientData.client_id,
    redirect_uri: redirectUri, code_challenge: challenge, code_challenge_method: 'S256',
    scope: 'mcp:tools', resource })) authUrl.searchParams.set(k, v);
  let auth = await fetch(authUrl, { redirect: 'manual' });
  assert.equal(auth.status, 302, 'OAuth should begin at login');
  const loginDestination = auth.headers.get('location');
  auth = await fetch(base + '/auth/login', { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: 'admin', password: 'a-strong-secret',
      returnTo: new URL(loginDestination, base).searchParams.get('returnTo') }) });
  assert.equal(auth.status, 302, 'Mongo-backed user credentials must authenticate');
  const cookie = (auth.headers.get('set-cookie') ?? '').split(';')[0];
  assert.match(cookie, /^brc_session=/);
  const consentPage = await (await fetch(new URL(auth.headers.get('location'), base), { headers: { cookie } })).text();
  const pending = consentPage.match(/name="pending" value="([^"]+)"/)?.[1];
  assert.ok(pending, 'Mongo-backed registration must support OAuth consent');
  const allowed = await fetch(base + '/auth/consent', { method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ pending, decision: 'allow' }) });
  const authCode = new URL(allowed.headers.get('location')).searchParams.get('code');
  assert.equal(allowed.status, 302); assert.ok(authCode);
  const tokenReply = await fetch(base + '/token', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: authCode, code_verifier: verifier,
      client_id: clientData.client_id, redirect_uri: redirectUri, resource }) });
  const credentials = await tokenReply.json();
  assert.equal(tokenReply.status, 200, JSON.stringify(credentials).slice(0, 300));
  assert.ok(credentials.access_token && credentials.refresh_token);
  const mcpResponse = await fetch(base + '/mcp', { method: 'POST',
    headers: { authorization: 'Bearer ' + credentials.access_token,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(mcpResponse.status, 200, 'MongoDB access-token authorization reaches MCP');
  assert.match(await mcpResponse.text(), /read_multiple_files/);
  assert.ok(await relay.store.getToken(credentials.access_token, 'access'));
  console.log('PASS MongoDB OAuth client registration, login, PKCE code exchange, token and MCP tools');

  // Critical: verify a previously paired device token authenticates the REAL
  // WebSocket upgrade after the store was reloaded from MongoDB.
  const socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
    headers: { Authorization: 'Bearer ' + originalDeviceToken },
  });
  await Promise.race([
    new Promise((resolve, reject) => {
      socket.once('error', reject);
      socket.once('open', () => socket.send(JSON.stringify({
        type: 'hello', protocol: 1, device: { deviceId: 'workstation', name: 'My Windows PC',
          platform: 'win32', hostname: 'mongo-test-pc', agentVersion: '2.0.5' },
        tools: [{ name: 'read_file', description: 'Read one file', inputSchema: { type: 'object', properties: {} } }],
      })));
      socket.on('message', raw => {
        const packet = JSON.parse(String(raw));
        if (packet.type === 'welcome') resolve();
      });
    }),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Mongo-backed WebSocket authentication timed out')), 3000)),
  ]);
  assert.ok(relay.hub.list(user.id).some(d => d.deviceId === 'workstation' && d.online));
  socket.close();
  await relay.close(); relay = undefined;
  store = await MongoStore.connect(uri, dbName);
  assert.ok(await store.getClient(clientData.client_id), 'DCR client survives server restart');
  await store.close(); store = undefined;
  console.log('PASS native Mongo HTTP, OAuth DCR registration, paired WebSocket login and restart');

  // Migration from the old SQLite format is verified using a DIFFERENT test DB.
  const sqliteFile = join(temp, 'legacy.sqlite');
  const sqlite = new SqliteStore(sqliteFile);
  const legacyUser = sqlite.upsertUser('old-admin', 'legacy-pass');
  const oldDeviceToken = sqlite.issueDeviceToken('old-pc', legacyUser.id, 'Old workstation', 'win32');
  sqlite.insertClient({ client_id: 'old-client', client_secret: null, metadata: '{"client_name":"old"}', created_at: Date.now() });
  const oldUrl = sqlite.createConnectionLink(legacyUser.id, 'old link', 'read', 7);
  sqlite.audit({ ts: Date.now(), user_id: legacyUser.id, device_id: 'old-pc', client: 'test', tool: 'read_file',
    args_hash: null, ok: 1, ms: 1, error: null });
  sqlite.close();
  const migration = spawnSync(process.execPath, ['dist/store/migrate.js'], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    encoding: 'utf8', env: { ...process.env, MONGODB_URI: uri, MONGODB_DB: migrationDb, BRC_DB: sqliteFile },
  });
  assert.equal(migration.status, 0, migration.stderr);
  store = await MongoStore.connect(uri, migrationDb);
  assert.equal((await store.getUserByName('old-admin')).id, legacyUser.id);
  assert.ok(await store.getClient('old-client'));
  assert.equal((await store.getDeviceByToken(oldDeviceToken)).device_id, 'old-pc');
  // Old capability token is known only to the owner, but the hash must survive migration.
  assert.ok((await store.listConnectionLinks(legacyUser.id)).some(l => l.key_hash === hash(oldUrl.key)));
  assert.equal(store.recentAudit(legacyUser.id).length, 0);
  await store.close(); store = undefined;
  console.log('PASS SQLite-to-Mongo migration retains legacy device identity/secret hash and excludes activity logs');
} finally {
  if (relay) await relay.close().catch(() => {});
  if (store) await store.close().catch(() => {});
  await client.db(dbName).dropDatabase().catch(() => {});
  await client.db(migrationDb).dropDatabase().catch(() => {});
  await client.close().catch(() => {});
  rmSync(temp, { recursive: true, force: true });
}
