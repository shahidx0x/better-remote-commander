// Multi-device routing test: node scripts/e2e-multidevice.mjs http://localhost:3300 admin pass
import { createHash, randomBytes } from 'node:crypto';
const [base, user, pass] = process.argv.slice(2);
const b64 = (x) => x.toString('base64url');
const form = (o) => new URLSearchParams(o);

const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
const reg = await (await fetch(meta.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ client_name: 'multidev', redirect_uris: ['https://x/cb'], token_endpoint_auth_method: 'none' }) })).json();
const verifier = b64(randomBytes(32)); const challenge = b64(createHash('sha256').update(verifier).digest());
let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: user, password: pass, returnTo: '/' }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
r = await fetch(`${meta.authorization_endpoint}?response_type=code&client_id=${reg.client_id}&redirect_uri=https%3A%2F%2Fx%2Fcb&code_challenge=${challenge}&code_challenge_method=S256&scope=mcp:tools`, { redirect: 'manual', headers: { cookie } });
const pending = (await r.text()).match(/name="pending" value="([^"]+)"/)[1];
r = await fetch(`${base}/auth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ pending, decision: 'allow' }) });
const code = new URL(r.headers.get('location')).searchParams.get('code');
const tok = await (await fetch(meta.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://x/cb' }) })).json();

const H = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${tok.access_token}` };
const rpc = async (method, params, id) => {
  const t = await (await fetch(`${base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) })).text();
  const d = t.match(/^data: (.+)$/m); return JSON.parse(d ? d[1] : t).result;
};
const devs = JSON.parse((await rpc('tools/call', { name: 'list_devices', arguments: {} }, 1)).content[0].text).devices;
console.log('devices:', devs.map((d) => `${d.name}:${d.online ? 'online' : 'offline'}`).join(', '));
const amb = await rpc('tools/call', { name: 'list_sessions', arguments: {} }, 2);
console.log('call without deviceId ->', amb.isError ? `refused (${amb.content[0].text})` : 'ran (UNEXPECTED with 2 devices)');
for (const d of devs.filter((x) => x.online)) {
  const cmd = d.platform?.startsWith('win') ? '(Get-CimInstance Win32_OperatingSystem).Caption' : 'uname -sr';
  const o = await rpc('tools/call', { name: 'start_process', arguments: { deviceId: d.deviceId, command: cmd, timeout_ms: 8000 } }, 3);
  const line = o.content[0].text.split('\n').find((l) => /Linux|Windows/.test(l)) ?? o.content[0].text.slice(0, 80);
  console.log(`${d.name} [${d.platform}] ->`, line.trim());
}
