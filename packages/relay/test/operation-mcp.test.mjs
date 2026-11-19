import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';
import {buildRelay} from '../dist/app.js';

const secret='stable-key-used-for-relay-result-encryption-64-chars-long';
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function rpc(base,key,name,args={},list=false){
 const body={jsonrpc:'2.0',id:randomUUID(),method:list?'tools/list':'tools/call',
  params:list?{}:{name,arguments:args}};
 const res=await fetch(base+'/mcp',{method:'POST',headers:{
  authorization:'Bearer '+key,'content-type':'application/json',
  accept:'application/json, text/event-stream'
 },body:JSON.stringify(body)});
 const raw=await res.text();
 assert.equal(res.status,200,raw.slice(0,300));
 const frames=raw.trim().startsWith('{')?[JSON.parse(raw)]:
  raw.split('\n').filter(x=>x.startsWith('data: ')).map(x=>JSON.parse(x.slice(6)));
 const frame=frames.find(x=>x.result!==undefined||x.error!==undefined);
 assert.ok(frame,raw.slice(0,300));
 assert.equal(frame.error,undefined,JSON.stringify(frame.error));
 return frame.result;
}
async function waitFor(predicate,ms=5000){
 const start=Date.now();
 while(Date.now()-start<ms){if(predicate())return;await sleep(15);}
 throw new Error('Fixture timed out');
}
test('public MCP operation recovery survives lost agent connection and relay restart; duplicate calls are not dispatched',{timeout:35000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'brc-relay-mcp-recovery-'));
 const config={port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3210',
  trustProxy:false,dbFile:path.join(dir,'relay.sqlite'),sessionSecret:secret,
  adminUser:'admin',adminPassword:'test-only',relayVersion:'recovery-fixture'};
 let relay,ws;
 try{
  relay=await buildRelay(config,()=>{});
  await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
  let base='http://127.0.0.1:'+relay.http.address().port;
  const user=relay.store.getUserByName('admin');
  const agentToken=relay.store.issueDeviceToken('fixture-pc',user.id,'Fixture PC','win32');
  const key=relay.store.createApiKey(user.id,'Client 1');
  const otherKey=relay.store.createApiKey(user.id,'Client 2');
  const deviceCalls=[],acks=[];
  ws=new WebSocket(base.replace(/^http/,'ws')+'/ws',{headers:{Authorization:'Bearer '+agentToken}});
  ws.on('message',raw=>{
   const msg=JSON.parse(raw.toString());
   if(msg.type==='result_ack')acks.push(msg);
   if(msg.type==='call'){
    deviceCalls.push(msg);
    ws.send(JSON.stringify({type:'result',id:msg.id,result:{
     content:[{type:'text',text:'BUILD_FINISHED_SECRET_54'}],
     structuredContent:{ok:true,exitCode:0}
    }}));
   }
  });
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'hello',protocol:1,device:{
   deviceId:'fixture-pc',name:'Fixture PC',platform:'win32',arch:'x64',
   hostname:'fixture',agentVersion:'test',coreVersion:'test'},
   tools:[{name:'run_command',description:'test command',inputSchema:{type:'object',properties:{command:{type:'string'}}}}]}));
  await waitFor(()=>relay.hub.list(user.id).length===1);
  const listing=await rpc(base,key.raw,null,{},true);
  assert.ok(listing.tools.find(t=>t.name==='recover_operation'));
  assert.ok(listing.tools.find(t=>t.name==='run_command').inputSchema.properties.operationId);
  const id=randomUUID(),args={command:'node -e "console.log(1)"',operationId:id};
  const first=await rpc(base,key.raw,'run_command',args);
  assert.equal(first.isError,false,JSON.stringify(first));
  assert.equal(first._meta.operationId,id);
  assert.equal(first._meta.relayJournalSettled,true);
  assert.equal(first._meta.recoverableResult,true);
  assert.equal(deviceCalls.length,1);
  assert.equal(deviceCalls[0].id,id);
  assert.equal(deviceCalls[0].args.operationId,undefined);
  await waitFor(()=>acks.some(a=>a.id===id));
  assert.equal(acks.find(a=>a.id===id).relayPersisted,true);
  const duplicate=await rpc(base,key.raw,'run_command',args);
  assert.equal(duplicate.isError,false);
  assert.equal(duplicate._meta.recoveredFromRelay,true);
  assert.equal(deviceCalls.length,1);
  const conflict=await rpc(base,key.raw,'run_command',{operationId:id,command:'unsafe other command'});
  assert.equal(conflict.isError,true);
  assert.equal(deviceCalls.length,1);
  const denied=await rpc(base,otherKey.raw,'recover_operation',{operationId:id});
  assert.equal(denied.structuredContent.found,false);
  const before=await rpc(base,key.raw,'recover_operation',{operationId:id});
  assert.equal(before.structuredContent.found,true);
  assert.match(before.structuredContent.resultText,/BUILD_FINISHED_SECRET/);
  ws.close(); await new Promise(resolve=>ws.once('close',resolve));
  await waitFor(()=>relay.hub.list(user.id).length===0);
  const offline=await rpc(base,key.raw,'recover_operation',{operationId:id});
  assert.equal(offline.structuredContent.found,true);
  await relay.close();relay=null;
  relay=await buildRelay(config,()=>{});
  await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
  base='http://127.0.0.1:'+relay.http.address().port;
  const after=await rpc(base,key.raw,'recover_operation',{operationId:id});
  assert.equal(after.structuredContent.found,true);
  assert.equal(after.structuredContent.state,'settled');
  assert.match(after.structuredContent.resultText,/BUILD_FINISHED_SECRET/);
  const recent=await rpc(base,key.raw,'recover_operation',{});
  assert.ok(recent.structuredContent.operations.some(x=>x.operationId===id));
 }finally{
  try{ws?.terminate();}catch{}
  if(relay)await relay.close();
  await rm(dir,{recursive:true,force:true});
 }
});
