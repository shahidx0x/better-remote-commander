
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
  // Automatic MCP estimates are account-scoped aggregates, separate from provider usage.
  const estimateDay = new Date().toISOString().slice(0,10);
  await store.recordMcpEstimates([
    {user_id:user.id,day:estimateDay,input_tokens:230,output_tokens:35,calls:2,partial_calls:0,
      to_agent_bytes:160,from_agent_bytes:240,matched_calls:1,universal_calls:1},
    {user_id:user.id,day:estimateDay,input_tokens:20,output_tokens:5,calls:1,partial_calls:1,
      to_agent_bytes:16,from_agent_bytes:38,matched_calls:0,universal_calls:1},
  ]);
  const estimates = await store.mcpEstimateDays(user.id,estimateDay);
  assert.equal(estimates[0].input_tokens,250);
  assert.equal(estimates[0].output_tokens,40);
  assert.equal(estimates[0].reports,3);
  assert.equal(estimates[0].partial_calls,1);
  assert.equal(estimates[0].to_agent_bytes,176);
  assert.equal(estimates[0].from_agent_bytes,278);
  assert.equal(estimates[0].matched_calls,1);
  assert.equal(estimates[0].universal_calls,2);
  const key = await store.createApiKey(user.id, 'coding-client');
  assert.equal((await store.getApiKey(key.raw)).user_id, user.id);
  const link = await store.createConnectionLink(user.id, 'Coding MCP', 'full', 7);
  assert.equal((await store.getConnectionLink(link.key)).user_id, user.id);
  const annual = await store.createConnectionLink(user.id, 'Annual MCP', 'read', 365);
  const biennial = await store.createConnectionLink(user.id, 'Two-year MCP', 'full', 730);
  assert.ok(Math.abs(annual.expiresAt - (Date.now() + 365 * 86_400_000)) < 2000);
  assert.ok(Math.abs(biennial.expiresAt - (Date.now() + 730 * 86_400_000)) < 2000);
  assert.equal((await store.getConnectionLink(annual.key)).expires_at, annual.expiresAt);
  assert.equal((await store.getConnectionLink(biennial.key)).expires_at, biennial.expiresAt);
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
  const restoredEstimates = await store.mcpEstimateDays(user.id,estimateDay);
  assert.equal(restoredEstimates[0].input_tokens,250,'Mongo MCP daily estimates persist across process restart');
  assert.equal(restoredEstimates[0].partial_calls,1);
  assert.equal(restoredEstimates[0].to_agent_bytes,176);
  assert.equal(restoredEstimates[0].universal_calls,2);
  assert.ok(await store.getConnectionLink(link.key));
  assert.equal((await store.getConnectionLink(annual.key)).expires_at, annual.expiresAt);
  assert.equal((await store.getConnectionLink(biennial.key)).expires_at, biennial.expiresAt);
  await store.revokeConnectionLink(user.id, annual.id);
  assert.equal(await store.getConnectionLink(annual.key), undefined);
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
  assert.equal(health.ok, true); assert.equal(health.storage, 'mongodb'); assert.equal(health.mcpTools, 87);
  assert.equal(health.relayInstance, relay.hub.instanceId, 'health must identify the relay process handling device sockets');
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
  assert.ok(await relay.store.getToken(credentials.refresh_token, 'refresh'), 'refresh token must be durable before the OAuth token response');
  const mcpResponse = await fetch(base + '/mcp', { method: 'POST',
    headers: { authorization: 'Bearer ' + credentials.access_token,
      'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  assert.equal(mcpResponse.status, 200, 'MongoDB access-token authorization reaches MCP');
  assert.match(await mcpResponse.text(), /read_multiple_files/);
  assert.ok(await relay.store.getToken(credentials.access_token, 'access'));
  console.log('PASS MongoDB OAuth client registration, login, PKCE code exchange, token and MCP tools');

  // Reproduce the user's failure: OAuth stays connected while brc-agent exits,
  // reopens, and reuses its saved device token. Never reauthorize or re-pair.
  async function callMcp(name, args = {}) {
    const response = await fetch(base + '/mcp', { method: 'POST',
      headers: { authorization: 'Bearer ' + credentials.access_token,
        'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 20, method: 'tools/call',
        params: { name, arguments: args } }) });
    const raw = await response.text();
    const json = raw.trim().startsWith('{') ? JSON.parse(raw)
      : raw.split('\n').filter(l => l.startsWith('data: '))
        .map(l => JSON.parse(l.slice(6))).find(v => v.result || v.error);
    assert.equal(response.status, 200, raw.slice(0, 280));
    assert.ok(json?.result, 'MCP response must include a result');
    return json.result;
  }
  async function socketConnect() {
    const socket = new WebSocket('ws://127.0.0.1:' + port + '/ws', {
      headers: { Authorization: 'Bearer ' + originalDeviceToken },
    });
    await Promise.race([
      new Promise((resolve, reject) => {
        socket.once('error', reject);
        socket.once('open', () => socket.send(JSON.stringify({
          type: 'hello', protocol: 1,
          device: { deviceId: 'workstation', name: 'My Windows PC', platform: 'win32',
            hostname: 'mongo-test-pc', agentVersion: '2.0.5' },
          tools: [{ name: 'read_file', description: 'Read a file',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } } }],
        })));
        socket.on('message', raw => {
          const packet = JSON.parse(String(raw));
          if (packet.type === 'welcome') resolve();
          if (packet.type === 'call') socket.send(JSON.stringify({ type: 'result', id: packet.id,
            result: { content: [{ type: 'text', text: 'reconnected-agent-ok' }] } }));
        });
      }),
      new Promise((_, reject) => setTimeout(() =>
        reject(new Error('Mongo-backed WebSocket welcome timed out')), 3000)),
    ]);
    return socket;
  }
  async function waitFor(predicate, message) {
    for (let i = 0; i < 35; i++) {
      if (predicate()) return;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(message);
  }
  function onlineStatus(result) {
    return JSON.parse(result.content.find(c => c.type === 'text').text);
  }
  const first = await socketConnect();
  assert.equal(onlineStatus(await callMcp('list_devices')).status, 'ready');
  assert.equal(onlineStatus(await callMcp('list_devices')).relayInstance, health.relayInstance, 'OAuth must connect to same relay process as the agent');
  assert.equal((await callMcp('read_file', { path: '/test/code.ts' })).content[0].text,
    'reconnected-agent-ok');
  first.close(1000, 'agent shutdown');
  await waitFor(() => relay.hub.list(user.id).length === 0, 'agent did not disconnect');
  assert.equal(onlineStatus(await callMcp('list_devices')).status, 'paired_device_offline',
    'OAuth must remain authorized when agent is temporarily offline');

  const second = await socketConnect();
  assert.equal(onlineStatus(await callMcp('list_devices')).status, 'ready');
  assert.equal((await callMcp('read_file', { path: '/test/code.ts' })).content[0].text,
    'reconnected-agent-ok');
  assert.ok(await relay.store.getToken(credentials.access_token, 'access'),
    'OAuth bearer token must remain valid after agent restart');

  // Overlapping sockets: new hello must replace the previous socket atomically,
  // and the old socket's late close must NOT remove the new connection.
  const third = await socketConnect();
  await waitFor(() => relay.hub.list(user.id).length === 1, 'stale socket changed online count');
  // The relay's server-side socket is a different JS object from the client socket.
  assert.equal(relay.hub.get('workstation')?.socket.readyState, WebSocket.OPEN);
  assert.equal(onlineStatus(await callMcp('list_devices')).status, 'ready');
  assert.equal((await callMcp('read_file', { path: '/test/code.ts' })).content[0].text,
    'reconnected-agent-ok');
  second.terminate();

  // A different OAuth account must never inherit this device just because
  // the global relay shows "1 online".
  const other = await relay.store.upsertUser('another-user', 'other-strong-password');
  const { connectionStatus, invokeTool } = await import('../dist/mcp/invoke.js');
  const foreign = await connectionStatus(relay.hub, relay.store, other.id);
  assert.equal(foreign.status, 'no_devices_for_oauth_account');
  assert.equal(foreign.devices.length, 0);
  assert.ok(!JSON.stringify(foreign).includes('My Windows PC'));
  const forbidden = await invokeTool(relay.hub, relay.store,
    { userId: other.id, clientId: 'foreign-oauth' }, 'read_file', { path: '/test/code.ts' });
  assert.equal(forbidden.ok, false);
  assert.match(forbidden.message, /OAuth account/);

  third.close();
  await relay.close(); relay = undefined;
  store = await MongoStore.connect(uri, dbName);
  assert.ok(await store.getClient(clientData.client_id), 'DCR client survives relay restart');
  await store.close(); store = undefined;
  console.log('PASS OAuth stays authorized across agent stop/start, stale-socket takeover, and owner-isolated routing');

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
