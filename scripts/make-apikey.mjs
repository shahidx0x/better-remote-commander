// Create an API key and verify bearer access on /mcp. node scripts/make-apikey.mjs http://localhost:3000 <pass> <name>
const [base, pass, name] = process.argv.slice(2);
const form = (o) => new URLSearchParams(o);
let r = await fetch(`${base}/auth/login`, { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form({ username: 'admin', password: pass, returnTo: '/' }) });
const cookie = (r.headers.get('set-cookie') ?? '').split(';')[0];
r = await fetch(`${base}/auth/apikeys`, { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: form({ name }) });
const raw = (await r.text()).match(/value="(brc_ak_[^"]+)"/)?.[1];
if (!raw) { console.log('key creation failed'); process.exit(1); }
const H = { authorization: `Bearer ${raw}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
const mcp = await (await fetch(`${base}/mcp`, { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'k', version: '0' } } }) })).text();
console.log('POST /mcp initialize ->', /brc/.test(mcp) ? 'ok' : mcp.slice(0, 80));
const bad = await fetch(`${base}/mcp`, { method: 'POST', headers: { ...H, authorization: 'Bearer brc_ak_wrong' }, body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'bad', version: '0' } } }) });
console.log('wrong key ->', bad.status);
console.log('\nAPI KEY (copy now):', raw);
