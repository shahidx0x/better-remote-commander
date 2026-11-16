
import assert from 'node:assert/strict';
import path from 'node:path';
const [base, username, password] = process.argv.slice(2);
const step = (name, pass) => { console.log((pass ? 'PASS' : 'FAIL') + '  ' + name); assert.ok(pass, name); };
const form = (body) => new URLSearchParams(body);
async function rpc(url, method, params, id) {
  const response = await fetch(url, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
  const body = await response.text();
  const messages = body.trim().startsWith('{') ? [JSON.parse(body)] : body.split('\n').filter(l => l.startsWith('data: ')).map(l => JSON.parse(l.slice(6)));
  return { status: response.status, result: messages.find(m => m.result !== undefined || m.error !== undefined) };
}

const anonymous = await fetch(base + '/auth/links', { redirect: 'manual' });
step('connection manager requires login', anonymous.status === 302 && (anonymous.headers.get('location') ?? '').startsWith('/auth/login'));

const login = await fetch(base + '/auth/login', { method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: form({ username, password, returnTo: '/auth/links' }) });
const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0];
step('owner can log in', login.status === 302 && cookie.startsWith('brc_session='));
const headers = { cookie, 'content-type': 'application/x-www-form-urlencoded' };
const manager = await fetch(base + '/auth/links', { headers: { cookie } });
let html = await manager.text();
const csrf = html.match(/name="csrf" value="([^"]+)"/)?.[1];
step('form has CSRF protection', manager.status === 200 && !!csrf);

let r = await fetch(base + '/auth/links', { method: 'POST', headers, redirect: 'manual',
  body: form({ name: 'CSRF attack', mode: 'full', days: '90', csrf: 'incorrect' }) });
step('invalid CSRF cannot create a connection', r.status === 403);

r = await fetch(base + '/auth/links', { method: 'POST', headers,
  body: form({ name: 'read-only e2e', mode: 'read', days: '7', csrf }) });
html = await r.text();
const readUrl = html.match(/id="new-connection-url"[^>]+value="([^"]+)"/)?.[1];
const readId = html.match(/name="link_id" value="([^"]+)"/)?.[1];
step('owner creates one-time read-only URL', r.status === 200 && !!readUrl && readUrl.startsWith(base + '/c/brc_link_') && readUrl.endsWith('/mcp') && !!readId);
const stored = await (await fetch(base + '/auth/links', { headers: { cookie } })).text();
step('private URL is never shown again in dashboard list', !stored.includes(readUrl) && stored.includes('read-only e2e'));

const initialize = await rpc(readUrl, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'no-auth-mcp-client', version: '1' } }, 1);
step('URL-only MCP initialize needs no OAuth or headers', initialize.status === 200 && initialize.result?.result?.serverInfo?.name === 'brc');
const tools = await rpc(readUrl, 'tools/list', {}, 2);
const names = (tools.result?.result?.tools ?? []).map(t => t.name);
step('read-only link advertises only safe non-retired tools',
  tools.status === 200 && names.includes('read_file') && names.includes('read_multiple_files') &&
  names.includes('list_devices') && !names.includes('write_file') &&
  !names.includes('start_process') && !names.includes('batch_tools'));
const denied = await rpc(readUrl, 'tools/call', { name: 'start_process', arguments: { command: 'echo should-not-run' } }, 3);
step('direct write or terminal invocation is rejected on read-only link', denied.status === 200 && denied.result?.result?.isError === true);
const knownFile = path.join(process.cwd(), 'package.json');
const secondFile = path.join(process.cwd(), 'pnpm-workspace.yaml');
const safeBatch = await rpc(readUrl, 'tools/call', { name: 'batch_tools', arguments: {
  calls: [
    { tool: 'read_multiple_files', arguments: { paths: [knownFile, secondFile] } },
    { tool: 'get_file_info', arguments: { path: knownFile } },
  ],
  mode: 'auto',
} }, 15);
step('read-only capability can batch independent file inspection in one MCP call',
  safeBatch.status === 200 && !safeBatch.result?.result?.isError && safeBatch.result?.result?.structuredContent?.executed === 2);
const rejectedNested = await rpc(readUrl, 'tools/call', { name: 'batch_tools', arguments: {
  calls: [{ tool: 'read_file', arguments: { path: knownFile } }, { tool: 'write_file', arguments: { path: knownFile, content: 'should-not-run' } }],
} }, 16);
step('read-only batch rejects hidden writes before dispatch', rejectedNested.status === 200 && rejectedNested.result?.result?.isError === true);
const rejectedNestedBatch = await rpc(readUrl, 'tools/call', { name: 'batch_tools', arguments: {
  calls: [{ tool: 'batch_tools', arguments: { calls: [{ tool: 'read_file', arguments: { path: knownFile } }] } }],
} }, 17);
step('read-only batch rejects recursively nested batches', rejectedNestedBatch.status === 200 && rejectedNestedBatch.result?.result?.isError === true);
const inventory = await rpc(readUrl, 'tools/call', { name: 'list_devices', arguments: {} }, 4);
step('read-only link can access its owner devices', inventory.status === 200 && JSON.parse(inventory.result.result.content[0].text).devices.some(d => d.online));

r = await fetch(base + '/auth/links', { method: 'POST', headers, body: form({ name: 'full-access e2e', mode: 'full', days: '1', csrf }) });
const fullHtml = await r.text();
const fullUrl = fullHtml.match(/id="new-connection-url"[^>]+value="([^"]+)"/)?.[1];
const fullId = fullHtml.match(/name="link_id" value="([^"]+)"/)?.[1];
step('separate full-access link is generated', r.status === 200 && !!fullUrl && fullUrl !== readUrl && !!fullId);
const fullTools = await rpc(fullUrl, 'tools/list', {}, 5);
step('full link exposes terminal tools without OAuth', fullTools.result?.result?.tools?.some(t => t.name === 'start_process'));
const command = await rpc(fullUrl, 'tools/call', { name: 'start_process', arguments: { command: 'echo brc-capability-link-ok', timeout_ms: 8000 } }, 6);
step('real agent command runs through URL-only MCP', command.status === 200 && JSON.stringify(command.result).includes('brc-capability-link-ok'));

const invalidUrl = readUrl.replace('/c/brc_link_', '/c/brc_link_X');
const bad = await fetch(invalidUrl, { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: '{}' });
step('guessed or invalid URL is rejected', bad.status === 404);
const regular = await fetch(base + '/mcp', { method: 'POST', headers: { accept: 'application/json, text/event-stream', 'content-type': 'application/json' }, body: '{}' });
step('ordinary OAuth MCP endpoint still requires authorization', regular.status === 401);

r = await fetch(base + '/auth/links/revoke', { method: 'POST', headers, redirect: 'manual',
  body: form({ csrf: 'wrong', link_id: readId }) });
step('revoke form requires CSRF', r.status === 403);
r = await fetch(base + '/auth/links/revoke', { method: 'POST', headers, redirect: 'manual',
  body: form({ csrf, link_id: readId }) });
step('owner can revoke link instantly', r.status === 302);
const revoked = await rpc(readUrl, 'tools/list', {}, 7);
step('revoked URL cannot access tools', revoked.status === 404);
const stillValid = await rpc(fullUrl, 'tools/list', {}, 8);
step('revoking one URL does not revoke another', stillValid.status === 200 && stillValid.result?.result?.tools?.some(t => t.name === 'start_process'));
r = await fetch(base + '/auth/links/revoke', { method: 'POST', headers, redirect: 'manual',
  body: form({ csrf, link_id: fullId }) });
step('second connection cleanup', r.status === 302);
