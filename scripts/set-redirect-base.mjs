// Set the after-consent redirect base on a client and verify where Allow redirects.
// node scripts/set-redirect-base.mjs http://localhost:3000 <pass> <client_id> <redirect_base> <registered_callback>
const [base, pass, clientId, redirectBase, callback] = process.argv.slice(2);
const form = (o) => new URLSearchParams(o);
let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: 'admin', password: pass, returnTo: '/' }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
const page = await (await fetch(`${base}/auth/clients/edit?client_id=${clientId}`, { headers: { cookie } })).text();
const name = page.match(/name="name" value="([^"]*)"/)?.[1] ?? 'client';
const uris = (page.match(/<textarea name="redirect_uris"[^>]*>([\s\S]*?)<\/textarea>/)?.[1] ?? '').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&');
r = await fetch(`${base}/auth/clients/edit`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ client_id: clientId, name, redirect_uris: uris, redirect_base: redirectBase }) });
console.log('edit:', r.status);
r = await fetch(`${base}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(callback)}&state=test123&scope=mcp:tools`, { redirect: 'manual', headers: { cookie } });
const pending = (await r.text()).match(/name="pending" value="([^"]+)"/)?.[1];
r = await fetch(`${base}/auth/consent`, { method: 'POST', redirect: 'manual', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ pending, decision: 'allow' }) });
console.log('after Allow ->', r.headers.get('location'));
