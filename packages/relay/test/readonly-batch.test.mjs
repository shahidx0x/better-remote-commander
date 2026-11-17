import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,rmSync} from 'node:fs';
import WebSocket from 'ws';
import {buildRelay} from '../dist/app.js';
import {BRC_PROTOCOL_VERSION} from 'brc-shared';

const dir=mkdtempSync(path.join(os.tmpdir(),'brc-rob-'));
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
const tools=['read_file','write_file','run_command','git_status','call_plugin_tool','batch_tools','project_map'].map(name=>({name,description:name,inputSchema:{type:'object',properties:{}}}));
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

import {readOnlyToolAllowed,readOnlyToolListed} from '../dist/mcp/server.js';
const call=(tool,args)=>({tool,arguments:args});
const batch=(...calls)=>({calls});

test('readOnlyToolAllowed: batch_tools only when EVERY nested call is a plain read tool (fails closed)',()=>{
  assert.equal(readOnlyToolAllowed('batch_tools',batch(call('read_file',{path:'/a'}),call('project_map',{path:'/'}))),true);
  assert.equal(readOnlyToolAllowed('batch_tools',{calls:[{tool:'read_file'}]}),true,'missing arguments is fine');
  const bad=[
    undefined,null,'x',[],{},{calls:'x'},{calls:[]},{calls:Array.from({length:65},()=>call('read_file',{}))},
    batch(call('read_file',{}),call('write_file',{})),                 // one write poisons the batch
    batch(call('run_command',{})),batch(call('batch_tools',batch(call('read_file',{})))), // nested batch
    batch(call('list_devices',{})),batch(call('call_plugin_tool',{})),  // relay tools are not nestable
    batch(call('read_file',{isUrl:true})),                              // URL fetch flag nested
    batch(call('read_file',[])),batch(call('read_file','x')),batch(call(' read_file',{})),batch(call('READ_FILE',{})),batch(call(5,{})),batch(null),batch('read_file'),
  ];
  bad.forEach((a,i)=>assert.equal(readOnlyToolAllowed('batch_tools',a),false,'case '+i));
  assert.equal(readOnlyToolAllowed('batch_tools'),false,'no args at all');
  assert.equal(readOnlyToolListed('batch_tools'),true);
  assert.equal(readOnlyToolAllowed('read_file',{path:'/x'}),true);
  assert.equal(readOnlyToolAllowed('read_file',{isUrl:true}),false);
  assert.equal(readOnlyToolAllowed('write_file',{}),false);
});

test('read-only link: batch_tools is listed, read-only batches pass, any write inside is blocked at call time',async()=>{
  const url=(await mint('read'))[1];
  const list=(await rpc(url,'tools/list',{})).body.result.tools;
  const bt=list.find(t=>t.name==='batch_tools');
  assert.ok(bt&&/READ-ONLY/.test(bt.description));
  const before=calls.length;
  const good=await rpc(url,'tools/call',{name:'batch_tools',arguments:batch(call('read_file',{path:'/a'}),call('project_map',{path:'/'}))});
  assert.equal(good.body.result.content[0].text,'ok:batch_tools');
  assert.equal(calls.length,before+1);
  const attempts=[
    batch(call('read_file',{path:'/a'}),call('write_file',{path:'/a',content:'x'})),
    batch(call('run_command',{command:'id'})),
    batch(call('batch_tools',batch(call('read_file',{path:'/a'})))),
    batch(call('read_file',{path:'http://x',isUrl:true})),
    {calls:[]},{},
  ];
  for(const a of attempts){
    const r=await rpc(url,'tools/call',{name:'batch_tools',arguments:a});
    assert.equal(r.body.result.isError,true);assert.match(r.body.result.content[0].text,/READ_ONLY_CONNECTION/);
  }
  const noArgs=await rpc(url,'tools/call',{name:'batch_tools'});
  assert.equal(noArgs.body.result.isError,true);
  assert.equal(calls.length,before+1,'blocked batches never reached the device');
});

test('full link: batch_tools with writes is forwarded untouched',async()=>{
  const url=(await mint('full'))[1];
  const before=calls.length;
  const r=await rpc(url,'tools/call',{name:'batch_tools',arguments:batch(call('write_file',{path:'/a',content:'x'}))});
  assert.equal(r.body.result.content[0].text,'ok:batch_tools');assert.equal(calls.length,before+1);
});