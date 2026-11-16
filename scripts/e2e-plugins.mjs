// Plugin admin + marketplace + AI install requests, end to end (no internet: the relay must run with
// BRC_MCP_REGISTRY_FIXTURE=scripts/fixtures/mcp-registry.json, as e2e-all.mjs does).
// node scripts/e2e-plugins.mjs http://localhost:3000 admin pass [path/to/relay.sqlite]
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [base, user, pass, dbFile] = process.argv.slice(2);
const step = (n, ok, extra = '') => console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${extra ? '  ' + String(extra).slice(0, 160) : ''}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fixture = path.resolve('packages/agent/test/fixtures/echo-mcp.mjs');
const cmdLine = `"${process.execPath}" "${fixture}"`;
const SECRET = 'e2e-secret-' + Math.random().toString(36).slice(2, 10);

const post = (p, body, cookie, extraHeaders = {}) => fetch(`${base}${p}`, { method: 'POST', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded', ...extraHeaders }, body: new URLSearchParams(body) });
const page = async (p, cookie) => (await fetch(`${base}${p}`, { headers: { cookie } })).text();
async function waitFor(fn, ms = 20_000) { const t0 = Date.now(); while (Date.now() - t0 < ms) { const v = await fn(); if (v) return v; await sleep(300); } return null; }
const pluginBlock = (html, id) => { const i = html.indexOf(`data-plugin="${id}"`); return i < 0 ? '' : html.slice(i, html.indexOf('class="plugin"', i + 10) >>> 0 || undefined); };
const requestStatus = (html, id) => html.match(new RegExp(`data-request="${id}" data-status="([a-z]+)"`))?.[1];

// --- login, csrf, device
let r = await post('/auth/login', { username: user, password: pass, returnTo: '/admin' });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
let html = await page('/admin', cookie);
// The marketplace page always carries a form (custom install), so the token is always there.
const csrf = (await page('/admin/marketplace', cookie)).match(/name="csrf" value="([^"]+)"/)?.[1];
const deviceId = html.match(/name="device_id" value="([^"]+)"/)?.[1];
step('admin page has Plugins section + csrf token', !!csrf && !!deviceId && /id="plugins"/.test(html), `device=${deviceId}`);
const supported = await waitFor(async () => (await page('/admin', cookie)).includes(`href="/admin/marketplace?device=${encodeURIComponent(deviceId)}"`));
step('agent reports plugins (protocol `plugins` frame)', !!supported);

// --- marketplace (fixture registry)
html = await page('/admin/marketplace?q=echo', cookie);
step('marketplace search lists registry entries', /data-name="io.example\/echo-npm"/.test(html) && /data-name="io.example\/echo-remote"/.test(html));
step('registry text is escaped', html.includes('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;') && !html.includes('<script>alert') && !html.includes('href="javascript:'));
step('Docker entry shown as not supported', /data-name="io.example\/echo-docker"[\s\S]*?not supported \(Docker\)/.test(html));
step('unpinned npm version not installable', /data-name="io.example\/echo-latest"[\s\S]*?no exact package version/.test(html));
html = await page('/admin/marketplace/install?name=io.example%2Fecho-remote', cookie);
step('install form collects URL variable + secret header', /name="in_var_tenant"/.test(html) && /name="in_header_Authorization" type="password"/.test(html));

// --- security: csrf, login required
r = await post('/admin/plugins/action', { device_id: deviceId, plugin_id: 'x', action: 'disable' }, cookie);
step('POST without csrf token -> 403', r.status === 403, `status ${r.status}`);
r = await post('/admin/plugins/install', { csrf, source: 'custom', custom_type: 'command', custom_spec: cmdLine, device_id: deviceId });
step('POST without session -> login redirect', r.status === 302 && /\/auth\/login/.test(r.headers.get('location') ?? ''), `status ${r.status}`);

// --- custom command install via plugin_admin
r = await post('/admin/plugins/install', { csrf, source: 'custom', custom_type: 'command', custom_spec: cmdLine, plugin_id: 'echo-e2e', name: 'Echo e2e', xenv_name_1: 'ECHO_SECRET', xenv_value_1: SECRET, device_id: deviceId }, cookie);
const installHtml = await r.text();
step('custom command install', r.status === 200 && /installed/.test(installHtml) && !/Not installed/.test(installHtml), installHtml.match(/<li>.*?<\/li>/)?.[0]);
html = await waitFor(async () => { const h = await page('/admin', cookie); return /installed/.test(pluginBlock(h, 'echo-e2e')) ? h : null; });
step('plugin visible in /admin as installed', !!html);
step('env key shown, value never rendered', !!html && /set_ECHO_SECRET/.test(html) && !html.includes(SECRET));

// --- MCP: api key, tools
html = await (await post('/auth/apikeys', { name: 'e2e-plugins', csrf: (await page('/auth/apikeys', cookie)).match(/name="csrf" value="([^"]+)"/)?.[1] ?? '' }, cookie)).text();
const apiKey = html.match(/value="(brc_ak_[^"]+)"/)?.[1];
const H = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
let rpcId = 0;
async function rpc(method, params) {
  const res = await fetch(`${base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
  const t = await res.text();
  const m = t.match(/^data: (.+)$/m);
  return m ? JSON.parse(m[1]) : JSON.parse(t);
}
const call = async (name, args) => { const b = await rpc('tools/call', { name, arguments: args }); const res = b.result ?? {}; return { isError: !!res.isError, text: (res.content ?? []).map((c) => c.text ?? '').join('\n') }; };
const tools = (await rpc('tools/list', {})).result?.tools?.map((t) => t.name) ?? [];
step('MCP lists marketplace tools', tools.includes('search_mcp_registry') && tools.includes('request_plugin_install') && tools.includes('list_plugin_tools'), tools.filter((t) => /plugin|registry/.test(t)).join(','));
let c = await call('list_plugin_tools', { deviceId, plugin: 'echo-e2e' });
step('list_plugin_tools shows plugin tools', !c.isError && /### echo/.test(c.text), c.text.slice(0, 80));
c = await call('call_plugin_tool', { deviceId, plugin: 'echo-e2e', tool: 'echo', args: { text: 'hi' } });
step('call_plugin_tool works', !c.isError && c.text === 'echo: hi', c.text);

// --- disable -> calls fail
r = await post('/admin/plugins/action', { csrf, device_id: deviceId, plugin_id: 'echo-e2e', action: 'disable' }, cookie);
step('disable via admin', r.status === 302 && /pok=1/.test(r.headers.get('location') ?? ''), decodeURIComponent(r.headers.get('location') ?? ''));
c = await call('call_plugin_tool', { deviceId, plugin: 'echo-e2e', tool: 'echo', args: { text: 'hi' } });
step('disabled plugin refuses calls', c.isError && /disabled/.test(c.text), c.text);
r = await post('/admin/plugins/action', { csrf, device_id: deviceId, plugin_id: 'echo-e2e', action: 'enable' }, cookie);
c = await call('call_plugin_tool', { deviceId, plugin: 'echo-e2e', tool: 'add', args: { a: 2, b: 3 } });
step('re-enabled plugin works', !c.isError && c.text === '5', c.text);

// --- set env (values only to the agent)
r = await post('/admin/plugins/env', { csrf, device_id: deviceId, plugin_id: 'echo-e2e', set_ECHO_SECRET: '', xenv_name_1: 'ECHO_OTHER', xenv_value_1: SECRET + '-2' }, cookie);
html = await waitFor(async () => { const h = await page('/admin', cookie); return /set_ECHO_OTHER/.test(pluginBlock(h, 'echo-e2e')) ? h : null; });
step('set env vars', r.status === 302 && !!html && /set_ECHO_SECRET/.test(html) && !html.includes(SECRET));

// --- AI: search + request (pending) + reject
c = await call('search_mcp_registry', { query: 'echo', limit: 10 });
step('search_mcp_registry (fixture)', !c.isError && /io\.example\/echo-npm/.test(c.text) && /"installable": false/.test(c.text));
c = await call('request_plugin_install', { registryName: 'io.example/echo-docker', reason: 'test' });
step('request for Docker-only server refused', c.isError && /Docker/.test(c.text), c.text);
c = await call('request_plugin_install', { registryName: 'io.example/echo-npm', deviceId, reason: 'need echo <b>now</b>' });
const reqA = c.text.match(/Request (pr_[A-Za-z0-9_-]+)/)?.[1];
step('request_plugin_install -> pending, nothing installed', !c.isError && !!reqA && /waiting for owner approval/.test(c.text), c.text.slice(0, 90));
html = await page('/admin', cookie);
step('pending request shown in /admin (escaped), plugin not installed', requestStatus(html, reqA) === 'pending' && html.includes('need echo &lt;b&gt;now&lt;/b&gt;') && !pluginBlock(html, 'echo-mcp') && !/data-plugin="echo-npm"/.test(html));
c = await call('request_plugin_install', { registryName: 'io.example/echo-npm', deviceId, reason: 'again' });
step('duplicate request is deduplicated', c.text.includes(reqA ?? '??'));
r = await post('/admin/plugins/request/reject', { csrf, id: reqA }, cookie);
html = await page('/admin', cookie);
step('reject request', r.status === 302 && requestStatus(html, reqA) === 'rejected');
html = await page(`/admin/plugins/request?id=${reqA}`, cookie);
step('rejected request cannot be approved', /already decided|Already decided/i.test(html));

// --- AI: custom request -> owner approves -> installs
c = await call('request_plugin_install', { custom: { type: 'command', spec: cmdLine }, pluginId: 'echo-approved', deviceId, reason: 'custom echo' });
const reqB = c.text.match(/Request (pr_[A-Za-z0-9_-]+)/)?.[1];
html = await page(`/admin/plugins/request?id=${reqB}`, cookie);
step('review page prefilled for approval', !!reqB && new RegExp(`name="request_id" value="${reqB}"`).test(html) && /value="echo-approved"/.test(html));
c = await call('call_plugin_tool', { deviceId, plugin: 'echo-approved', tool: 'echo', args: { text: 'x' } });
step('not callable before approval', c.isError && /Unknown plugin|not|unknown/i.test(c.text), c.text);
r = await post('/admin/plugins/install', { csrf, request_id: reqB, source: 'custom', custom_type: 'command', custom_spec: cmdLine, plugin_id: 'echo-approved', device_id: deviceId }, cookie);
const approveHtml = await r.text();
step('approve + install', r.status === 200 && /installed/.test(approveHtml), approveHtml.match(/<li>.*?<\/li>/)?.[0]);
html = await waitFor(async () => { const h = await page('/admin', cookie); return requestStatus(h, reqB) === 'installed' ? h : null; });
step('request marked installed', !!html);
c = await call('call_plugin_tool', { deviceId, plugin: 'echo-approved', tool: 'echo', args: { text: 'ok' } });
step('approved plugin callable', !c.isError && c.text === 'echo: ok', c.text);
r = await post('/admin/plugins/install', { csrf, request_id: reqB, source: 'custom', custom_type: 'command', custom_spec: cmdLine, plugin_id: 'echo-approved', device_id: deviceId }, cookie);
step('request cannot be approved twice', r.status === 409, `status ${r.status}`);

// --- audit
html = await page('/admin', cookie);
step('audit has request/approve/install rows', /plugin\.request\(echo-approved\)/.test(html) && /plugin\.approve\(echo-approved\)/.test(html) && /plugin\.install\(echo-e2e\)/.test(html));

// --- remove
for (const id of ['echo-e2e', 'echo-approved']) await post('/admin/plugins/action', { csrf, device_id: deviceId, plugin_id: id, action: 'remove' }, cookie);
html = await waitFor(async () => { const h = await page('/admin', cookie); return !/data-plugin="echo-e2e"/.test(h) && !/data-plugin="echo-approved"/.test(h) ? h : null; });
step('remove plugins', !!html);
c = await call('call_plugin_tool', { deviceId, plugin: 'echo-e2e', tool: 'echo', args: { text: 'x' } });
step('removed plugin refuses calls', c.isError, c.text);

// --- relay never stored secrets
if (dbFile) {
  const files = [dbFile, `${dbFile}-wal`].filter((f) => existsSync(f));
  const leaked = files.some((f) => readFileSync(f).includes(Buffer.from(SECRET)));
  step('relay database holds no plugin secrets', files.length > 0 && !leaked, files.map((f) => path.basename(f)).join(','));
}
