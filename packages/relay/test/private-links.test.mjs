import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import WebSocket from 'ws';
import {buildRelay} from '../dist/app.js';
import {BRC_PROTOCOL_VERSION} from 'brc-shared';

const dir=mkdtempSync(path.join(os.tmpdir(),'brc-links-'));
const relay=buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3299',trustProxy:false,dbFile:path.join(dir,'r.sqlite'),sessionSecret:'s',adminUser:'admin',adminPassword:'pw',relayVersion:'t'},()=>{});
await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
const base='http://127.0.0.1:'+relay.http.address().port;
const form=(o)=>new URLSearchParams(o).toString();
const post=(p,body,cookie)=>fetch(base+p,{method:'POST',redirect:'manual',headers:{...(cookie?{cookie}:{}),'content-type':'application/x-www-form-urlencoded'},body:form(body)});
let cookie,csrf,agent;
after(async()=>{agent?.terminate();relay.http.closeAllConnections();await relay.close();rmSync(dir,{recursive:true,force:true});});

const login=await post('/auth/login',{username:'admin',password:'pw',returnTo:'/admin'});
cookie=(login.headers.get('set-cookie')??'').split(';')[0];
const page=await (await fetch(base+'/auth/links',{headers:{cookie}})).text();
csrf=page.match(/name="csrf" value="([^"]+)"/)[1];
const user=relay.store.getUserByName('admin');
const token=relay.store.issueDeviceToken('pc1',user.id,'PC','linux');
const tools=['read_file','write_file','run_command','git_status','call_plugin_tool'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}));
agent=new WebSocket(base.replace('http','ws')+'/ws',{headers:{Authorization:'Bearer '+token}});
await new Promise(r=>agent.on('open',r));
agent.send(JSON.stringify({type:'hello',protocol:BRC_PROTOCOL_VERSION,device:{deviceId:'pc1',name:'PC',platform:'linux',arch:'x64',hostname:'h',agentVersion:'1',coreVersion:'1'},tools}));
const calls=[];
agent.on('message',d=>{const m=JSON.parse(d);if(m.type==='call'){calls.push(m.tool);agent.send(JSON.stringify({type:'result',id:m.id,result:{content:[{type:'text',text:'ok:'+m.tool}]}}));}});
await new Promise(r=>setTimeout(r,200));

async function mint(mode,days='7'){
  const r=await post('/auth/links',{csrf,name:'t-'+mode,mode,days},cookie);
  assert.equal(r.status,200);
  const html=await r.text();
  const m=html.match(/value="http[^"]+\/c\/(brc_link_[A-Za-z0-9_-]{43})\/mcp"/);return [m[0],base+'/c/'+m[1]+'/mcp',m[1]];
}
const rpc=(url,method,params)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})}).then(async r=>{const t=await r.text();const j=t.startsWith('event')?JSON.parse(t.split('data: ')[1]):JSON.parse(t);return {status:r.status,body:j};});

test('creating a link requires a CSRF token and a valid lifetime',async()=>{
  assert.equal((await post('/auth/links',{name:'x',mode:'read',days:'7'},cookie)).status,403);
  assert.equal((await post('/auth/links',{csrf,name:'x',mode:'read',days:'730'},cookie)).status,400,'730 days is not allowed');
  assert.equal((await post('/auth/links',{csrf,name:'x',mode:'root',days:'7'},cookie)).status,400);
});
test('only the hash of a link is stored',async()=>{
  const m=await mint('read');const key=m[2];
  const rows=relay.store.listConnectionLinks(user.id);
  assert.ok(rows.length>=1);assert.ok(rows.every(r=>!JSON.stringify(r).includes(key)));
});
test('read-only link lists only read tools and blocks writes by name',async()=>{
  const url=(await mint('read'))[1];
  const list=await rpc(url,'tools/list',{});
  const names=list.body.result.tools.map(t=>t.name);
  assert.ok(names.includes('read_file')&&names.includes('git_status'));
  for(const bad of ['write_file','run_command','call_plugin_tool'])assert.ok(!names.includes(bad),bad);
  const before=calls.length;
  for(const bad of ['write_file','run_command','call_plugin_tool']){
    const r=await rpc(url,'tools/call',{name:bad,arguments:{}});
    assert.equal(r.body.result.isError,true);assert.match(r.body.result.content[0].text,/READ_ONLY_CONNECTION/);
  }
  const url2=await rpc(url,'tools/call',{name:'read_file',arguments:{path:'/x',isUrl:true}});
  assert.equal(url2.body.result.isError,true);
  assert.equal(calls.length,before,'blocked calls never reached the device');
  const ok=await rpc(url,'tools/call',{name:'read_file',arguments:{path:'/x'}});
  assert.equal(ok.body.result.content[0].text,'ok:read_file');
});
test('full link exposes all tools',async()=>{
  const url=(await mint('full'))[1];
  const names=(await rpc(url,'tools/list',{})).body.result.tools.map(t=>t.name);
  assert.ok(names.includes('write_file')&&names.includes('run_command'));
});
test('revocation applies to the very next request; bad keys are 404',async()=>{
  const m=await mint('read');const url=m[1];
  assert.equal((await rpc(url,'tools/list',{})).status,200);
  const id=relay.store.listConnectionLinks(user.id).find(l=>l.name==='t-read').id;
  const rev=await post('/auth/links/revoke',{csrf,link_id:id},cookie);assert.equal(rev.status,302);
  assert.equal((await fetch(url,{method:'POST'})).status,404);
  assert.equal((await fetch(base+'/c/brc_link_'+'A'.repeat(43)+'/mcp',{method:'POST'})).status,404);
  assert.equal((await fetch(base+'/c/not-a-key/mcp',{method:'POST'})).status,404);
});
test('expired link is rejected',async()=>{
  const url=(await mint('read','1'))[1];
  relay.store.db.prepare('UPDATE connection_links SET expires_at = ?').run(Date.now()-1000);
  assert.equal((await fetch(url,{method:'POST'})).status,404);
});
test('repeated bad keys are rate limited',async()=>{
  let last;for(let i=0;i<35;i++)last=(await fetch(base+'/c/brc_link_'+'B'.repeat(43)+'/mcp',{method:'POST'})).status;
  assert.equal(last,429);
});
