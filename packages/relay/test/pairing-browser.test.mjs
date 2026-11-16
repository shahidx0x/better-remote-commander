import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { buildRelay } from '../dist/app.js';

const params = (value) => new URLSearchParams(value);
const scratch = mkdtempSync(path.join(os.tmpdir(), 'brc-verify-flow-'));

test('autolink verification skips redundant login and opens owner-reviewed device approval', {timeout:25000}, async () => {
  const relay = await buildRelay({
    host: '127.0.0.1', port: 0, publicUrl: 'http://127.0.0.1:31001',
    trustProxy: false, dbFile: path.join(scratch, 'relay.sqlite'),
    sessionSecret: 'test-pairing-secret', adminUser: 'admin', adminPassword: 'test-pairing-password',
    relayVersion: 'pairing-test',
  }, () => {});
  await new Promise(resolve => relay.http.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + relay.http.address().port;
  const cookieReq = async (pathname, cookie = '', options = {}) =>
    fetch(base + pathname, { redirect: 'manual', ...options,
      headers: { ...(cookie ? { cookie } : {}), ...(options.headers ?? {}) } });
  try {
    const row = await relay.store.createDeviceCode('My actual workstation', 120000);
    const verification = '/device/verify?user_code=' + row.user_code;
    let res = await cookieReq(verification);
    assert.equal(res.status, 302, 'anonymous browsers still require owner login');
    const signIn = res.headers.get('location');
    assert.equal(new URL(signIn, base).pathname, '/auth/login');
    assert.equal(new URL(signIn, base).searchParams.get('returnTo'), verification, 'preserves the one-time code across login');

    // Authenticate once, then verify the same cookie is accepted on direct links.
    res = await cookieReq('/auth/login', '', {
      method: 'POST', headers: { 'content-type':'application/x-www-form-urlencoded' },
      body: params({ username:'admin', password:'test-pairing-password', returnTo: verification }),
    });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), verification);
    const cookie = (res.headers.get('set-cookie') ?? '').split(';')[0];
    assert.match(cookie, /^brc_session=/);

    res = await cookieReq('/auth/login?returnTo=' + encodeURIComponent(verification), cookie);
    assert.equal(res.status, 302, 'already signed-in user bypasses login form');
    assert.equal(res.headers.get('location'), verification);
    res = await cookieReq('/auth/login', cookie);
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/admin');

    res = await cookieReq(verification, cookie);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /class="auth-root"/, 'dedicated branded pairing page');
    assert.match(html, /My actual workstation/);
    assert.ok(html.includes(row.user_code), 'code is visible for human review');
    assert.match(html, /Approve &amp; connect/);
    assert.match(html, /name="decision" value="deny"/);
    assert.doesNotMatch(html, /name="username"|name="password"/);
    const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
    assert.ok(csrf, 'signed-in form includes CSRF');

    res = await cookieReq('/device/approve', cookie, {
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:params({user_code:row.user_code,decision:'allow',csrf:'invalid'}),
    });
    assert.equal(res.status,403,'invalid CSRF rejected');
    assert.equal((await relay.store.getDeviceCodeByUserCode(row.user_code)).approved,0);

    res = await cookieReq('/device/approve', cookie, {
      method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},
      body:params({user_code:row.user_code,decision:'allow',csrf}),
    });
    assert.equal(res.status,200);
    assert.match(await res.text(),/Device approved/);
    const saved = await relay.store.getDeviceCodeByUserCode(row.user_code);
    assert.equal(saved.approved,1,'only an explicit POST approves a device');

    res = await cookieReq(verification,cookie);
    assert.equal(res.status,200);
    assert.match(await res.text(), /Already approved/);

    const denied = await relay.store.createDeviceCode('Unknown device',120000);
    await relay.store.denyDeviceCode(denied.device_code);
    res = await cookieReq('/device/verify?user_code='+denied.user_code,cookie);
    assert.equal(res.status,404);
    assert.match(await res.text(), /invalid, denied or expired/);

    res = await cookieReq('/device/verify',cookie);
    assert.equal(res.status,200);
    const enter = await res.text();
    assert.match(enter,/name="user_code"/);
    assert.match(enter,/class="pairing-input"/);
    assert.match(enter,/name="csrf" value="/);

    // A signed-in session on one origin cannot be inferred from another origin.
    // The local client must open the same origin that the user authenticated on.
    res = await cookieReq('/device/verify');
    assert.equal(res.status,302);
  } finally {
    relay.http.closeAllConnections();
    await relay.close();
    await fs.rm(scratch,{recursive:true,force:true,maxRetries:4,retryDelay:60});
  }
});
