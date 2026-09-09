// Phase 5 checks: admin dashboard, pause/resume/rename, client edit, login rate limit.
// node scripts/e2e-admin.mjs http://localhost:3000 admin pass
const [base, user, pass] = process.argv.slice(2);
const form = (o) => new URLSearchParams(o);
const step = (n, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
const post = (path, body, cookie) => fetch(`${base}${path}`, { method: 'POST', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: form(body) });

let r = await post('/auth/login', { username: user, password: pass, returnTo: '/admin' });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
step('login', r.status === 302 && r.headers.get('location') === '/admin');

r = await fetch(`${base}/admin`, { headers: { cookie } });
let html = await r.text();
const deviceId = html.match(/name="device_id" value="([^"]+)"/)?.[1];
step('admin page', r.status === 200 && !!deviceId && /Recent calls/.test(html), `device=${deviceId}`);

r = await post('/admin/device', { device_id: deviceId, action: 'pause' }, cookie);
html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
step('pause device', r.status === 302 && /paused/.test(html));

const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
const reg = await (await fetch(`${base}/register`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'admin-test', redirect_uris: ['https://x/cb'], token_endpoint_auth_method: 'none' }) })).json();
const { createHash, randomBytes } = await import('node:crypto');
const v = randomBytes(32).toString('base64url'); const ch = createHash('sha256').update(v).digest('base64url');
r = await fetch(`${base}/authorize?response_type=code&client_id=${reg.client_id}&redirect_uri=https%3A%2F%2Fx%2Fcb&code_challenge=${ch}&code_challenge_method=S256&scope=mcp:tools`, { redirect: 'manual', headers: { cookie } });
const pending = (await r.text()).match(/name="pending" value="([^"]+)"/)[1];
r = await post('/auth/consent', { pending, decision: 'allow' }, cookie);
const code = new URL(r.headers.get('location')).searchParams.get('code');
const tok = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'authorization_code', code, code_verifier: v, client_id: reg.client_id, redirect_uri: 'https://x/cb' }) })).json();
const H = { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' };
let call = await fetch(`${base}/api/tools/list_sessions`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId }) });
step('paused device refuses calls (423)', call.status === 423, `status ${call.status}`);

r = await post('/admin/device', { device_id: deviceId, action: 'resume' }, cookie);
call = await fetch(`${base}/api/tools/list_sessions`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId }) });
step('resume device -> calls work', call.status === 200, `status ${call.status}`);

r = await post('/admin/device', { device_id: deviceId, action: 'rename', name: 'Eraydin-PC (renamed)' }, cookie);
html = await (await fetch(`${base}/admin`, { headers: { cookie } })).text();
step('rename device', /Eraydin-PC \(renamed\)/.test(html));
await post('/admin/device', { device_id: deviceId, action: 'rename', name: 'Eraydin-PC' }, cookie);

r = await post('/auth/clients/edit', { client_id: reg.client_id, name: 'admin-test-edited', redirect_uris: 'https://x/cb\nhttps://y/cb' }, cookie);
html = await (await fetch(`${base}/auth/clients`, { headers: { cookie } })).text();
step('edit client', r.status === 302 && /admin-test-edited/.test(html) && /https:\/\/y\/cb/.test(html));
await post('/auth/clients/delete', { client_id: reg.client_id }, cookie);

let last;
for (let i = 0; i < 6; i++) last = await post('/auth/login', { username: 'admin', password: 'wrong-' + i, returnTo: '/' });
step('login rate limit after 5 failures', last.status === 429, `status ${last.status}`);
