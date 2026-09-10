// End-to-end OAuth + MCP client test against a running relay (simulates claude.ai).
// node scripts/e2e-oauth.mjs http://localhost:3210 admin test-pass-123
import { createHash, randomBytes } from 'node:crypto';
const [base, user, pass] = process.argv.slice(2);
const b64 = (b) => b.toString('base64url');
const j = async (r) => { const t = await r.text(); try { return JSON.parse(t); } catch { return t; } };
const step = (n, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);

// 1. discovery
const prm = await j(await fetch(`${base}/.well-known/oauth-protected-resource/mcp`));
const meta = await j(await fetch(`${base}/.well-known/oauth-authorization-server`));
step('discovery', !!meta.authorization_endpoint && !!prm.resource, `auth=${meta.authorization_endpoint} token=${meta.token_endpoint} reg=${meta.registration_endpoint}`);

// 2. dynamic client registration
const redirect = 'https://claude.ai/api/mcp/auth_callback';
const reg = await j(await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'Claude', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: 'none' }) }));
step('register', !!reg.client_id, `client_id=${reg.client_id}`);

// 3. authorize with PKCE -> expect redirect to login
const verifier = b64(randomBytes(32)); const challenge = b64(createHash('sha256').update(verifier).digest());
const state = b64(randomBytes(8));
const authUrl = `${meta.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=${encodeURIComponent(redirect)}&code_challenge=${challenge}&code_challenge_method=S256&state=${state}&scope=mcp:tools&resource=${encodeURIComponent(prm.resource)}`;
let r = await fetch(authUrl, { redirect: 'manual' });
const loginLoc = r.headers.get('location') ?? '';
step('authorize -> login redirect', r.status === 302 && loginLoc.startsWith('/auth/login'), loginLoc);

// 4. login (cookie), then follow returnTo to consent
r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ username: user, password: pass, returnTo: new URL(loginLoc, base).searchParams.get('returnTo') }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
const consentLoc = r.headers.get('location') ?? '';
step('login', r.status === 302 && cookie.startsWith('brc_session='), consentLoc);
r = await fetch(new URL(consentLoc, base), { headers: { cookie } });
const html = await r.text();
const pending = html.match(/name="pending" value="([^"]+)"/)?.[1];
step('consent page', r.status === 200 && !!pending, `pending=${pending}`);

// 5. allow -> code
r = await fetch(`${base}/auth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ pending, decision: 'allow' }) });
const cb = new URL(r.headers.get('location'));
const code = cb.searchParams.get('code');
step('consent -> code', r.status === 302 && !!code && cb.searchParams.get('state') === state, `${cb.origin}${cb.pathname}`);

// 6. token exchange
const tok = await j(await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: redirect, resource: prm.resource }) }));
step('token', !!tok.access_token && !!tok.refresh_token, `expires_in=${tok.expires_in} scope=${tok.scope}`);

// 7. MCP: initialize, tools/list, tools/call
const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` };
const rpc = async (method, params, id) => {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const ct = res.headers.get('content-type') ?? '';
  const text = await res.text();
  if (ct.includes('text/event-stream')) { const m = text.match(/^data: (.+)$/m); return { status: res.status, body: m ? JSON.parse(m[1]) : null }; }
  return { status: res.status, body: text ? JSON.parse(text) : null };
};
const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } }, 1);
step('mcp initialize', init.status === 200 && init.body?.result?.serverInfo?.name === 'brc', `server=${init.body?.result?.serverInfo?.name}@${init.body?.result?.serverInfo?.version}`);

const list = await rpc('tools/list', {}, 2);
const names = (list.body?.result?.tools ?? []).map((t) => t.name);
step('mcp tools/list', names.includes('list_devices') && names.includes('read_file') && names.includes('start_process'), `${names.length} tools`);

const devs = await rpc('tools/call', { name: 'list_devices', arguments: {} }, 3);
const devJson = JSON.parse(devs.body?.result?.content?.[0]?.text ?? '{}');
step('mcp list_devices', devJson.devices?.some((d) => d.online), JSON.stringify(devJson.devices?.map((d) => `${d.name}:${d.online ? 'online' : 'offline'}`)));

const call = await rpc('tools/call', { name: 'start_process', arguments: { command: 'echo brc-mcp-ok', timeout_ms: 8000 } }, 4);
const out = call.body?.result?.content?.[0]?.text ?? '';
step('mcp start_process via device', out.includes('brc-mcp-ok'), `isError=${call.body?.result?.isError} device=${call.body?.result?._meta?.deviceName}`);

// 8. unauthorized / refresh
const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, authorization: 'Bearer nope' }, body: '{}' });
step('mcp rejects bad token', bad.status === 401, `www-authenticate=${bad.headers.get('www-authenticate')?.slice(0, 60)}`);
const ref = await j(await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) }));
step('refresh token', !!ref.access_token && ref.refresh_token !== tok.refresh_token);
const reuse = await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: reg.client_id }) });
step('old refresh token rotated out', reuse.status === 400);
