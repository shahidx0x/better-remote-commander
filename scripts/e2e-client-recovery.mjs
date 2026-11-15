// End-to-end recovery of an OAuth client_id cached by a third-party ChatGPT/LLM wrapper.
// Runs against the temporary relay started by scripts/e2e-all.mjs; no external callbacks are contacted.
import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';

const [base, username, password] = process.argv.slice(2);
const form = (data) => new URLSearchParams(data);
const step = (title, ok) => { console.log((ok ? 'PASS' : 'FAIL') + '  ' + title); assert.ok(ok, title); };
const clientId = 'cl_legacyWrapperWithStaleId999';
const redirect = 'https://some-wrapper.example/oauth/callback';
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
const issuerUrl = new URL(base + '/authorize');
issuerUrl.searchParams.set('response_type', 'code');
issuerUrl.searchParams.set('client_id', clientId);
issuerUrl.searchParams.set('redirect_uri', redirect);
issuerUrl.searchParams.set('code_challenge', challenge);
issuerUrl.searchParams.set('code_challenge_method', 'S256');
issuerUrl.searchParams.set('resource', base + '/mcp');
issuerUrl.searchParams.set('scope', 'mcp:tools');
issuerUrl.searchParams.set('state', 'wrapper-state-123');
const authorize = issuerUrl.toString();

let r = await fetch(authorize, { redirect: 'manual' });
let html = await r.text();
step('unknown saved client renders a recovery link, without redirecting to its callback', r.status === 400 && html.includes('Unregistered OAuth client') && html.includes('/auth/clients?authorize=') && !r.headers.get('location'));
step('unknown client was not auto-registered', !(html.includes('name="pending"')));

r = await fetch(base + '/auth/clients?authorize=' + encodeURIComponent(authorize), { redirect: 'manual' });
step('recovery requires owner login', r.status === 302 && (r.headers.get('location') ?? '').startsWith('/auth/login'));
r = await fetch(base + '/auth/login', { method: 'POST', redirect: 'manual',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ username, password, returnTo: '/auth/clients' }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
step('owner login succeeds', r.status === 302 && cookie.startsWith('brc_session='));
const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' };
html = await (await fetch(base + '/auth/clients?authorize=' + encodeURIComponent(authorize), { headers: { cookie } })).text();
const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
step('recovery form is prefilled with wrapper details and CSRF', !!csrf && html.includes(clientId) && html.includes('some-wrapper.example'));

r = await fetch(base + '/auth/clients/import', { method: 'POST', redirect: 'manual', headers,
  body: form({ csrf: 'invalid', trust: 'yes', authorization_url: authorize }) });
step('missing CSRF blocks approval', r.status === 403);
r = await fetch(base + '/auth/clients/import', { method: 'POST', redirect: 'manual', headers,
  body: form({ csrf, trust: 'no', authorization_url: authorize }) });
step('owner must explicitly trust the callback', r.status === 400);

const wrongIssuer = authorize.replace('/authorize?', '/other-endpoint?');
r = await fetch(base + '/auth/clients/import', { method: 'POST', redirect: 'manual', headers,
  body: form({ csrf, trust: 'yes', authorization_url: wrongIssuer }) });
step('another issuer/path cannot be imported as a wrapper callback', r.status === 400);

r = await fetch(base + '/auth/clients/import', { method: 'POST', redirect: 'manual', headers,
  body: form({ csrf, trust: 'yes', authorization_url: authorize, client_name: 'Trusted wrapper' }) });
step('owner approval continues the original authorization flow', r.status === 303 && r.headers.get('location') === authorize);
r = await fetch(r.headers.get('location'), { headers: { cookie }, redirect: 'manual' });
html = await r.text();
const pending = html.match(/name="pending" value="([^"]+)"/)?.[1];
step('recovered client ID now reaches OAuth consent', r.status === 200 && !!pending && html.includes('Trusted wrapper'));

r = await fetch(base + '/auth/consent', { method: 'POST', redirect: 'manual', headers,
  body: form({ pending, decision: 'allow' }) });
const callback = new URL(r.headers.get('location'));
const code = callback.searchParams.get('code');
step('approved callback receives authorization code with state', r.status === 302 && callback.origin + callback.pathname === redirect && !!code && callback.searchParams.get('state') === 'wrapper-state-123');
const tok = await (await fetch(base + '/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ client_id: clientId, grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirect, resource: base + '/mcp' }) })).json();
step('recovered client obtains token with PKCE and exact callback', !!tok.access_token && !tok.error);
const reply = await fetch(base + '/mcp', { method: 'POST', headers: { authorization: 'Bearer ' + tok.access_token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
step('recovered token reaches real MCP endpoint', reply.status === 200 && (await reply.text()).includes('read_file'));

// A different callback on the same id must not be accepted without owner confirmation.
const otherCallback = 'https://another-trusted-wrapper.example/oauth/callback';
const secondUrl = new URL(authorize);
secondUrl.searchParams.set('redirect_uri', otherCallback);
r = await fetch(secondUrl, { redirect: 'manual' });
step('a new callback for the same client is still blocked', r.status === 400);
r = await fetch(base + '/auth/clients/import', { method: 'POST', headers, redirect: 'manual',
  body: form({ csrf, trust: 'yes', client_id: clientId, redirect_uri: otherCallback, client_name: 'Another wrapper' }) });
step('manual client ID + callback form approves another trusted website', r.status === 303 && r.headers.get('location') === '/auth/clients?added=1');
const clients = await (await fetch(base + '/auth/clients', { headers: { cookie } })).text();
step('both approved callbacks are listed', clients.includes(redirect) && clients.includes(otherCallback));
r = await fetch(base + '/auth/clients/delete', { method: 'POST', redirect: 'manual', headers,
  body: form({ csrf: 'invalid', client_id: clientId }) });
step('OAuth client deletion is CSRF-protected', r.status === 403);
r = await fetch(base + '/auth/clients/delete', { method: 'POST', redirect: 'manual', headers,
  body: form({ csrf, client_id: clientId }) });
step('owner may remove this client and revoke its credentials', r.status === 302);
r = await fetch(authorize, { redirect: 'manual' });
step('deleted client requires explicit approval again', r.status === 400);
