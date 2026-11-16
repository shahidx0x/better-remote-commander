
/** Verify a first-time MCP client sees useful tools even before any Windows/Linux agent connects. */
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const [base, username, password] = process.argv.slice(2);
const step = (label, pass) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + label); assert.ok(pass, label); };
const form = values => new URLSearchParams(values);
async function rpc(endpoint, headers, method, params, id) {
  const response = await fetch(endpoint, {
    method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  const raw = await response.text();
  const msg = raw.trim().startsWith('{') ? JSON.parse(raw) : raw.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6))).find(msg => msg.result || msg.error);
  return { status: response.status, msg };
}
const health = await (await fetch(base + '/health')).json();
step('testing while zero devices are connected', health.devices === 0);
step('health advertises stable tool count for deployment diagnostics', health.mcpTools === 87);
const reg = await (await fetch(base + '/register', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({
    client_name: 'offline-catalog-e2e', redirect_uris: ['https://tools.example.test/oauth/callback'],
    grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none',
  }) })).json();
step('create test OAuth registration before agent exists', !!reg.client_id);
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const authUrl = new URL(base + '/authorize');
for (const [k, v] of Object.entries({
  response_type: 'code', client_id: reg.client_id, redirect_uri: 'https://tools.example.test/oauth/callback',
  code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp:tools', resource: base + '/mcp',
})) authUrl.searchParams.set(k, v);
let r = await fetch(authUrl, { redirect: 'manual' });
const loginPath = r.headers.get('location');
step('OAuth starts without agent', r.status === 302 && loginPath.startsWith('/auth/login?'));
r = await fetch(base + '/auth/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ username, password, returnTo: new URL(loginPath, base).searchParams.get('returnTo') }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
step('owner login works without an online agent', r.status === 302 && cookie.startsWith('brc_session='));
const consent = await (await fetch(new URL(r.headers.get('location'), base), { headers: { cookie } })).text();
const pending = consent.match(/name="pending" value="([^"]+)"/)?.[1];
step('consent page works', !!pending);
r = await fetch(base + '/auth/consent', { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ pending, decision: 'allow' }) });
const code = new URL(r.headers.get('location')).searchParams.get('code');
step('authorization code returned', !!code);
const tok = await (await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ grant_type: 'authorization_code', client_id: reg.client_id, code, code_verifier: verifier, redirect_uri: 'https://tools.example.test/oauth/callback', resource: base + '/mcp' }) })).json();
step('token exchange works without agent', !!tok.access_token);
const H = { authorization: 'Bearer ' + tok.access_token };
const listed = await rpc(base + '/mcp', H, 'tools/list', {}, 1);
const publishedTools = listed.msg?.result?.tools ?? [];
const names = publishedTools.map(t => t.name);
step('all 87 tools describe WHEN to use them and WHAT to use instead',
  publishedTools.length === 87 && publishedTools.every(t => t.description.startsWith('USE WHEN: ') && t.description.includes('USE INSTEAD: ')));
step('a single-run command is not confused with an interactive process',
  publishedTools.find(t => t.name === 'run_command')?.description.includes('ONE-SHOT command')
  && publishedTools.find(t => t.name === 'start_process')?.description.includes('run_command'));
step('first connection advertises file and terminal tools while agent is offline',
  listed.status === 200 && names.length >= 60 && names.includes('list_devices') && names.includes('read_file') && names.includes('write_file') && names.includes('start_process') && names.includes('workspace_batch'));
const offline = await rpc(base + '/mcp', H, 'tools/call', { name: 'read_file', arguments: { path: '/fake/offline/path' } }, 2);
step('advertised offline tools fail safely instead of claiming to run',
  offline.status === 200 && offline.msg?.result?.isError === true && /No device is online/i.test(offline.msg?.result?.content?.[0]?.text ?? ''));

const manager = await (await fetch(base + '/auth/links', { headers: { cookie } })).text();
const csrf = manager.match(/name="csrf" value="([^"]+)"/)?.[1];
r = await fetch(base + '/auth/links', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ csrf, name: 'offline-readonly-e2e', mode: 'read', days: '1' }) });
const html = await r.text();
const privateUrl = html.match(/id="new-connection-url"[^>]+value="([^"]+)"/)?.[1];
step('private no-OAuth URL can be generated while offline', !!privateUrl);
const ro = await rpc(privateUrl, {}, 'tools/list', {}, 3);
const roNames = (ro.msg?.result?.tools ?? []).map(t => t.name);
step('read-only link sees permitted file tools but never write or terminal',
  ro.status === 200 && roNames.length > 10 && roNames.includes('read_file') && !roNames.includes('write_file') && !roNames.includes('start_process'));
