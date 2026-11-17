import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { mkdtempSync, rmSync } from 'node:fs';
import { buildRelay } from '../dist/app.js';
import { layout, loginPage, consentPage, deviceVerifyPage, deviceApprovePage, messagePage, homePage, clientsPage, oauthClientRecoveryPage } from '../dist/pages/html.js';
import { adminPage, apiKeysPage, connectionLinksPage } from '../dist/pages/admin.js';
import { skillsPage } from '../dist/pages/skills.js';
import { marketplacePage, installResultPage } from '../dist/pages/plugins.js';

const XSS = '<script>alert(1)</script>';
const ESCAPED = '&lt;script&gt;alert(1)&lt;/script&gt;';
const now = Date.now();

function commonChecks(name, html) {
  assert.match(html, /<meta name="viewport" content="width=device-width,initial-scale=1">/, name + ' viewport');
  assert.match(html, /<html lang="en">/, name + ' lang');
  assert.ok(!html.includes('<script'), name + ' must not contain any script element');
  assert.ok(!/https?:\/\/(fonts|cdn|unpkg|cdnjs)\b/i.test(html), name + ' external asset');
  assert.ok(!/<(link|img|iframe|script)\b[^>]*(src|href)="https?:/i.test(html), name + ' external resource');
  assert.ok(!/@import|url\(\s*['"]?https?:/i.test(html), name + ' css import');
  assert.ok(!/ on\w+="[^"]*\$\{/.test(html), name + ' interpolated handler');
}

test('shell has sidebar navigation, active item, skip link and responsive CSS', () => {
  const html = layout('API keys', '<span id="needle">x</span>');
  assert.match(html, /<nav class="nav" aria-label="Admin navigation">/);
  assert.match(html, /href="\/auth\/apikeys" aria-current="page"/);
  assert.match(html, /class="skip"/);
  assert.match(html, /@media\(max-width:640px\)/);
  assert.match(html, /prefers-color-scheme:dark/);
  assert.match(html, /:focus-visible/);
  assert.match(html, /id="needle"/);
  for (const href of ['/admin"', '/admin#devices', '/admin#activity', '/device/verify', '/admin/marketplace', '/auth/links', '/auth/clients', '/auth/apikeys']) assert.ok(html.includes(`href="${href.replace(/"$/, '')}`), href);
  commonChecks('layout', html);
  const auth = loginPage('/');
  assert.match(auth, /class="auth-card"/);
  assert.doesNotMatch(auth, /<aside/);
});

test('auth pages keep fields and escape hostile values', () => {
  const login = loginPage('/admin?x=1&y="2"', XSS);
  assert.match(login, /action="\/auth\/login"/);
  assert.match(login, /name="username"/);
  assert.match(login, /name="password" type="password"/);
  assert.match(login, /name="returnTo" value="\/admin\?x=1&amp;y=&quot;2&quot;"/);
  assert.ok(login.includes(ESCAPED) && !login.includes(XSS));
  assert.match(login, /<label for="login-user">/);

  const consent = consentPage('pend"1', XSS, 'https://app.example/cb', ['mcp:tools']);
  assert.match(consent, /name="pending" value="pend&quot;1"/);
  assert.match(consent, /name="decision" value="deny"/);
  assert.match(consent, /name="decision" value="allow"/);
  assert.ok(consent.includes(ESCAPED) && !consent.includes(XSS));

  const verify = deviceVerifyPage('ABCD-1234', 'Expired');
  assert.match(verify, /action="\/device\/verify"/);
  assert.match(verify, /name="user_code" value="ABCD-1234"/);
  const approve = deviceApprovePage('ABCD-1234', XSS);
  assert.match(approve, /action="\/device\/approve"/);
  assert.match(approve, /name="user_code" value="ABCD-1234"/);
  assert.ok(approve.includes(ESCAPED) && !approve.includes(XSS));

  const msg = messagePage(XSS, XSS, false);
  assert.ok(msg.includes(ESCAPED) && !msg.includes(XSS));
  const rec = oauthClientRecoveryPage(XSS, 'https://evil.example/cb?x=<b>', '/auth/clients?authorization_url=a&b', true);
  assert.ok(!rec.includes(XSS) && !rec.includes('<b>'));
  assert.match(rec, /Callback host: <strong>evil\.example<\/strong>/);
  for (const [n, h] of Object.entries({ login, consent, verify, approve, msg, rec })) commonChecks(n, h);
});

test('home, admin, clients, links, keys render forms, keep names, escape hostile data', () => {
  const devices = [{ device_id: 'd1"x', name: XSS, platform: XSS, online: true, paused: 1, last_seen: now, created_at: now }];
  const home = homePage('https://relay.example', true, devices);
  assert.ok(home.includes(ESCAPED) && !home.includes(XSS));
  assert.match(home, /<aside class="sidebar">/);
  assert.match(homePage('https://relay.example', false, []), /\/auth\/login\?returnTo=\//);

  const admin = adminPage('https://relay.example', devices, [{ ts: now, device: XSS, client: XSS, tool: XSS, ok: 0, ms: 3, error: XSS }], { total: 1, failed: 1, last24h: 1 });
  assert.ok(admin.includes(ESCAPED) && !admin.includes(XSS));
  for (const s of ['action="/admin/device"', 'name="device_id" value="d1&quot;x"', 'name="action" value="rename"', 'name="action" value="resume"', 'name="action" value="delete"', 'id="devices"', 'id="activity"', 'Recent MCP calls']) assert.ok(admin.includes(s), s);

  const clients = clientsPage([{ client_id: 'c"1', name: XSS, redirect_uris: [XSS], hasSecret: false, created_at: now }],
    { authorizeUrl: 'https://r/authorize?a=1&b="2"', clientId: XSS, redirectUri: 'https://cb.example/x' }, { ok: false, message: XSS });
  assert.ok(!clients.includes(XSS));
  for (const s of ['action="/auth/clients/import"', 'name="authorization_url"', 'name="password" type="password"', 'name="trust" value="yes"', 'name="client_name"', 'action="/auth/clients/delete"', 'name="client_id" value="c&quot;1"', 'Callback host: <strong>cb.example</strong>']) assert.ok(clients.includes(s), s);

  const links = connectionLinksPage([{ id: 'l1', name: XSS, mode: 'read', created_at: now, expires_at: now + 1e6 }], 'tok"en', { name: XSS, url: 'https://r/c/k"/mcp', expiresAt: now + 1e6 });
  assert.ok(!links.includes(XSS));
  for (const s of ['name="csrf" value="tok&quot;en"', 'name="mode"', 'name="days"', 'action="/auth/links"', 'action="/auth/links/revoke"', 'name="link_id" value="l1"', 'value="https://r/c/k&quot;/mcp"']) assert.ok(links.includes(s), s);

  const keys = apiKeysPage([{ prefix: 'p"1', name: XSS, created_at: now, last_used: null }], { name: XSS, raw: 'brc_ak_"raw' });
  assert.ok(!keys.includes(XSS));
  for (const s of ['action="/auth/apikeys"', 'name="name"', 'action="/auth/apikeys/revoke"', 'name="prefix" value="p&quot;1"', 'value="brc_ak_&quot;raw"']) assert.ok(keys.includes(s), s);

  for (const [n, h] of Object.entries({ home, admin, clients, links, keys })) commonChecks(n, h);
});

test('skills, marketplace and plugin pages use the shell and escape data', () => {
  const skill = { id: XSS, name: XSS, description: XSS, source: XSS, files: { 'SKILL.md': XSS }, created_at: now, updated_at: now };
  const skills = skillsPage({ skills: [skill], requests: [{ id: 'r"1', skill_id: XSS, client: XSS, reason: XSS, created_at: now, status: 'pending' }], prefill: XSS, error: XSS });
  assert.ok(!skills.includes(XSS), 'skills page leaked raw markup');
  for (const s of ['action="/admin/skills/import"', 'name="markdown"', 'name="trust" value="yes"', 'action="/admin/skills/delete"', 'action="/admin/skills/reject"', '<aside class="sidebar">']) assert.ok(skills.includes(s), s);
  commonChecks('skills', skills);

  const market = marketplacePage({ q: XSS, entries: [], registrySource: XSS, devices: [], selectedDevice: XSS, csrf: 'c' });
  assert.ok(!market.includes(XSS));
  assert.match(market, /<aside class="sidebar">/);
  commonChecks('market', market);
  const res = installResultPage('Installed', [{ device: XSS, ok: false, message: XSS }], XSS);
  assert.ok(!res.includes(XSS));
  commonChecks('install result', res);
});

// ---- live routes: every page responds, forms carry the session csrf field ----
const dir = mkdtempSync(path.join(os.tmpdir(), 'brc-adminui-'));
process.env.BRC_SKILLS = '1';
const relay = buildRelay({ port: 0, host: '127.0.0.1', publicUrl: 'http://127.0.0.1:3299', trustProxy: false, dbFile: path.join(dir, 'r.sqlite'), sessionSecret: 's', adminUser: 'admin', adminPassword: 'pw', relayVersion: 't' }, () => {});
await new Promise((r) => relay.http.listen(0, '127.0.0.1', r));
const base = 'http://127.0.0.1:' + relay.http.address().port;
after(async () => { delete process.env.BRC_SKILLS; relay.http.closeAllConnections(); await relay.close(); rmSync(dir, { recursive: true, force: true }); });
const post = (p, body, cookie) => fetch(base + p, { method: 'POST', redirect: 'manual', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(body).toString() });

test('live pages render with expected status, csrf fields and no external URLs', async () => {
  const anon = await fetch(base + '/auth/login?returnTo=/admin');
  assert.equal(anon.status, 200);
  commonChecks('login (live)', await anon.text());
  const login = await post('/auth/login', { username: 'admin', password: 'pw', returnTo: '/admin' });
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
  const user = relay.store.getUserByName('admin');
  relay.store.issueDeviceToken('dev"<x>', user.id, XSS, 'linux');
  const get = (p) => fetch(base + p, { headers: { cookie } });
  const withForms = ['/admin', '/auth/clients', '/auth/apikeys', '/auth/links', '/device/verify'];
  for (const p of ['/', '/admin', '/auth/clients', '/auth/apikeys', '/auth/links', '/device/verify', '/admin/skills', '/admin/marketplace?q=']) {
    const r = await get(p);
    assert.ok([200, 502, 503].includes(r.status), `${p} -> ${r.status}`);
    if (r.status !== 200) continue;
    const html = await r.text();
    commonChecks(p, html);
    assert.ok(!html.includes(XSS));
    if (withForms.includes(p)) {
      for (const form of html.match(/<form method="post"[^>]*>[\s\S]*?<\/form>/g) ?? []) assert.match(form, /name="csrf" value="[^"]+"/, `${p} form lacks csrf`);
    }
  }
  const blocked = await post('/auth/apikeys', { name: 'x' }, cookie);
  assert.equal(blocked.status, 403);
  assert.equal((await get('/admin')).status, 200);
});
