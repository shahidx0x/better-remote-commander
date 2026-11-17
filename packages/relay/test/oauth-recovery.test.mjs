import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import {buildRelay} from '../dist/app.js';

const dir=mkdtempSync(path.join(os.tmpdir(),'brc-oauthrec-'));
const relay=buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3298',trustProxy:false,dbFile:path.join(dir,'r.sqlite'),sessionSecret:'s',adminUser:'admin',adminPassword:'pw',relayVersion:'t'},()=>{});
await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+relay.http.address().port;
after(async()=>{relay.http.closeAllConnections();await relay.close();rmSync(dir,{recursive:true,force:true});});
const form=o=>new URLSearchParams(o).toString();
const post=(p,b,cookie)=>fetch(base+p,{method:'POST',redirect:'manual',headers:{...(cookie?{cookie}:{}),'content-type':'application/x-www-form-urlencoded'},body:form(b)});
const login=await post('/auth/login',{username:'admin',password:'pw',returnTo:'/admin'});
const cookie=(login.headers.get('set-cookie')??'').split(';')[0];
const csrf=(await (await fetch(base+'/auth/apikeys',{headers:{cookie}})).text()).match(/name="csrf" value="([^"]+)"/)[1];
const challenge='A'.repeat(43);
const authUrl=(client,redirect,extra={})=>{
  const u=new URL('http://127.0.0.1:3298/authorize');
  for(const [k,v] of Object.entries({response_type:'code',client_id:client,redirect_uri:redirect,code_challenge:challenge,code_challenge_method:'S256',...extra}))u.searchParams.set(k,v);
  return u;
};
const get=u=>fetch(base+u.pathname+u.search,{redirect:'manual'});

test('unknown client gets a recovery page and nothing is registered',async()=>{
  const r=await get(authUrl('lost-client','https://chat.example.com/cb'));
  assert.equal(r.status,400);const html=await r.text();
  assert.match(html,/Unregistered OAuth client/);assert.match(html,/chat\.example\.com/);
  assert.equal(relay.store.getClient('lost-client'),undefined);
});
test('malformed or non-S256 requests fall through to the standard OAuth errors',async()=>{
  const r=await get(authUrl('lost-client','https://chat.example.com/cb',{code_challenge_method:'plain'}));
  assert.ok(!(await r.text()).includes('Unregistered OAuth client'));
});
test('approval needs csrf, trust, and the admin password',async()=>{
  const url=authUrl('lost-client','https://chat.example.com/cb').toString();
  assert.equal((await post('/auth/clients/import',{authorization_url:url,trust:'yes',password:'pw'},cookie)).status,403,'no csrf');
  assert.equal((await post('/auth/clients/import',{csrf,authorization_url:url,password:'pw'},cookie)).status,400,'no trust');
  assert.equal((await post('/auth/clients/import',{csrf,authorization_url:url,trust:'yes'},cookie)).status,403,'no password');
  assert.equal((await post('/auth/clients/import',{csrf,authorization_url:url,trust:'yes',password:'wrong'},cookie)).status,403,'wrong password');
  assert.equal(relay.store.getClient('lost-client'),undefined);
  const ok=await post('/auth/clients/import',{csrf,authorization_url:url,trust:'yes',password:'pw',client_name:'Chat'},cookie);
  assert.equal(ok.status,303);assert.equal(ok.headers.get('location'),url);
  const row=relay.store.getClient('lost-client');assert.ok(row);
  assert.deepEqual(JSON.parse(row.metadata).redirect_uris,['https://chat.example.com/cb']);
  // now the standard flow takes over (login/consent redirect), not the recovery page
  const again=await get(authUrl('lost-client','https://chat.example.com/cb'));
  assert.ok(!(await again.text()).includes('Unregistered OAuth client'));
});
test('a different callback for a known client is still held for approval',async()=>{
  const r=await get(authUrl('lost-client','https://evil.example.net/cb'));
  assert.equal(r.status,400);assert.match(await r.text(),/Callback not approved/);
  assert.deepEqual(JSON.parse(relay.store.getClient('lost-client').metadata).redirect_uris,['https://chat.example.com/cb']);
});
test('unsafe callbacks and confidential clients are refused',async()=>{
  for(const bad of ['http://evil.example.net/cb','https://u:p@host.example/cb','https://host.example/cb#frag']){
    const url=authUrl('c2',bad).toString();
    const r=await post('/auth/clients/import',{csrf,authorization_url:url,trust:'yes',password:'pw'},cookie);
    assert.equal(r.status,400,bad);
  }
  relay.store.insertClient({client_id:'secret-client',client_secret:'s3',metadata:JSON.stringify({client_id:'secret-client',redirect_uris:['https://a.example/cb'],token_endpoint_auth_method:'client_secret_post'}),created_at:Date.now()});
  const r=await post('/auth/clients/import',{csrf,authorization_url:authUrl('secret-client','https://b.example/cb').toString(),trust:'yes',password:'pw'},cookie);
  assert.equal(r.status,400);assert.deepEqual(JSON.parse(relay.store.getClient('secret-client').metadata).redirect_uris,['https://a.example/cb']);
});
test('a foreign-origin or wrong-resource authorization link cannot be approved',async()=>{
  const foreign=authUrl('c3','https://ok.example/cb').toString().replace('127.0.0.1:3298','evil.example');
  assert.equal((await post('/auth/clients/import',{csrf,authorization_url:foreign,trust:'yes',password:'pw'},cookie)).status,400);
  const wrong=authUrl('c3','https://ok.example/cb',{resource:'https://other.example/mcp'}).toString();
  assert.equal((await post('/auth/clients/import',{csrf,authorization_url:wrong,trust:'yes',password:'pw'},cookie)).status,400);
  assert.equal(relay.store.getClient('c3'),undefined);
});
test('repeated wrong passwords are rate limited',async()=>{
  const url=authUrl('c4','https://ok.example/cb').toString();
  let last;for(let i=0;i<7;i++)last=(await post('/auth/clients/import',{csrf,authorization_url:url,trust:'yes',password:'bad'+i},cookie)).status;
  assert.equal(last,429);
});
