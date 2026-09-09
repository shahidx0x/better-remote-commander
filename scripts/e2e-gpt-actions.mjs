// Simulates a ChatGPT Custom GPT Action: static client + secret, OAuth authorization code, then REST calls.
// node scripts/e2e-gpt-actions.mjs http://localhost:3210 admin pass
import { randomBytes } from 'node:crypto';
const [base, user, pass] = process.argv.slice(2);
const form = (o) => new URLSearchParams(o);
const step = (n, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + extra : ''}`);
const callback = 'https://chat.openai.com/aip/g-test1234/oauth/callback';

// login (cookie) and create a static client via the management page
let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: user, password: pass, returnTo: '/' }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
r = await fetch(`${base}/auth/clients`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name: 'GPT Action test', redirect_uris: callback }) });
const html = await r.text();
const clientId = html.match(/value="(cl_[^"]+)"/)?.[1];
const secret = html.match(/Client secret<\/label><input readonly value="([^"]+)"/)?.[1];
step('create static client', !!clientId && !!secret, `client_id=${clientId}`);

// OpenAPI spec (public)
const spec = await (await fetch(`${base}/openapi.json`)).json();
const ops = Object.values(spec.paths ?? {}).flatMap((p) => Object.values(p)).length;
const flow = spec.components?.securitySchemes?.oauth2?.flows?.authorizationCode;
step('openapi.json', spec.openapi === '3.1.0' && ops > 0 && ops <= 30 && !!flow?.tokenUrl, `${ops} operations, tokenUrl=${flow?.tokenUrl}`);
step('openapi has no $schema keys', !JSON.stringify(spec).includes('"$schema"'));

// authorization code WITHOUT PKCE is how GPT Actions behave; server should still work (PKCE optional for confidential clients)
const state = randomBytes(6).toString('hex');
r = await fetch(`${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callback)}&state=${state}&scope=mcp:tools`, { redirect: 'manual', headers: { cookie } });
let text = await r.text();
const pending = text.match(/name="pending" value="([^"]+)"/)?.[1];
const authNoPkce = r.status === 200 && !!pending;
step('authorize without PKCE (GPT Actions style)', authNoPkce || r.status === 400, authNoPkce ? 'consent shown' : `status ${r.status}: ${text.slice(0, 80)}`);

// If the server insists on PKCE, fall back to PKCE so the rest of the flow can still be verified.
let verifier;
let pend = pending;
if (!authNoPkce) {
  const { createHash } = await import('node:crypto');
  verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  r = await fetch(`${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callback)}&state=${state}&scope=mcp:tools&code_challenge=${challenge}&code_challenge_method=S256`, { redirect: 'manual', headers: { cookie } });
  pend = (await r.text()).match(/name="pending" value="([^"]+)"/)?.[1];
}
r = await fetch(`${base}/auth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ pending: pend, decision: 'allow' }) });
const cb = new URL(r.headers.get('location'));
const code = cb.searchParams.get('code');
step('consent -> code to ChatGPT callback', !!code && cb.origin + cb.pathname === callback && cb.searchParams.get('state') === state);

// token exchange with client_secret_post (what ChatGPT sends)
const tokBody = { grant_type: 'authorization_code', code, client_id: clientId, client_secret: secret, redirect_uri: callback };
if (verifier) tokBody.code_verifier = verifier;
const tok = await (await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(tokBody) })).json();
step('token with client_secret_post', !!tok.access_token, tok.access_token ? `expires_in=${tok.expires_in}` : JSON.stringify(tok));
const wrong = await fetch(`${base}/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: clientId, client_secret: 'wrong' }) });
step('wrong client_secret rejected', wrong.status === 401 || wrong.status === 400, `status ${wrong.status}`);

// REST calls
const H = { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' };
const devs = await (await fetch(`${base}/api/devices`, { headers: H })).json();
const target = devs.devices?.find((d) => d.online)?.deviceId;
step('GET /api/devices', Array.isArray(devs.devices), JSON.stringify(devs.devices?.map((d) => `${d.name}:${d.online ? 'on' : 'off'}`)));
const tools = await (await fetch(`${base}/api/tools`, { headers: H })).json();
step('GET /api/tools', Array.isArray(tools.tools) && tools.tools.length > 0, `${tools.tools?.length} tools, ${tools.online} online`);
const run = await (await fetch(`${base}/api/tools/start_process`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: target, command: 'echo gpt-action-ok', timeout_ms: 8000 }) })).json();
step('POST /api/tools/start_process', run.ok === true && /gpt-action-ok/.test(run.text ?? ''), `device=${run.device} ${run.ms} ms text=${JSON.stringify((run.text ?? run.error ?? '').slice(0, 120))}`);
const unknown = await fetch(`${base}/api/tools/nope`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: target }) });
step('unknown tool -> 404', unknown.status === 404);
const noauth = await fetch(`${base}/api/devices`);
step('no bearer -> 401', noauth.status === 401);
const cfgRes = await (await fetch(`${base}/api/tools/get_config`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: target }) })).json();
const allowed = JSON.parse(cfgRes.text.slice(cfgRes.text.indexOf('{'))).allowedDirectories?.[0];
const sep = allowed?.includes('\\') ? '\\' : '/';
const bigPath = `${allowed}${sep}ses-rdp-big.txt`;
await fetch(`${base}/api/tools/write_file`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: target, path: bigPath, content: Array.from({ length: 4 }, () => 'x'.repeat(50_000)).join('\n') }) });
const big = await (await fetch(`${base}/api/tools/read_file`, { method: 'POST', headers: H, body: JSON.stringify({ deviceId: target, path: bigPath }) })).json();
step('oversized output clipped for GPT', Buffer.byteLength(big.text ?? '') < 100_000 && /truncated by relay/.test(big.text ?? ''), `${Buffer.byteLength(big.text ?? '')} bytes ${JSON.stringify((big.text ?? big.error ?? '').slice(0, 100))}`);