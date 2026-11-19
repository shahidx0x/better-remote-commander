import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync} from 'node:fs';
import {rm,readdir} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {buildRelay} from '../dist/app.js';
import {OperationJournal} from '../dist/mcp/operation-journal.js';
import {invokeTool} from '../dist/mcp/invoke.js';
import {WsClient} from '../../agent/dist/transport/ws-client.js';
import {lookupCallOutcome} from '../../agent/dist/runtime/call-outcomes.js';

async function until(fn,limit=12000){
 const start=Date.now();
 while(Date.now()-start<limit){if(await fn())return;await new Promise(r=>setTimeout(r,45));}
 throw new Error('Timed out waiting for reconnection/reconciliation');
}
test('real agent automatically resends completed encrypted result after relay crash before journal settle; never executes twice',
 {timeout:35000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'brc-fault-recovery-'));
 const originalHome=process.env.BRC_HOME;
 process.env.BRC_HOME=path.join(dir,'agent-home');
 const secret='test-only-stable-relay-key-is-long-enough-123456789';
 const cfg={port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3210',trustProxy:false,
  dbFile:path.join(dir,'relay.sqlite'),sessionSecret:secret,
  adminUser:'admin',adminPassword:'test-password',relayVersion:'test-faults'};
 let relay=null,agent=null;
 let executions=0;
 try{
  relay=await buildRelay(cfg,()=>{});
  await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
  const port=relay.http.address().port;
  const user=relay.store.getUserByName('admin');
  const token=relay.store.issueDeviceToken('fault-device',user.id,'Fault PC','win32');
  const ctx={userId:user.id,clientId:'fault-client'};
  const tool={name:'run_command',description:'safe fake test tool',inputSchema:{type:'object',properties:{command:{type:'string'}}},
   annotations:{readOnlyHint:false}};
  agent=new WsClient({relayUrl:'http://127.0.0.1:'+port,deviceId:'fault-device',token,
   name:'Fault PC',agentVersion:'test',coreVersion:'test',tools:[tool],
   callTool:async()=>{executions++;return {content:[{type:'text',text:'COMPLETED_PRIVATE_RESULT_FOR_REDELIVERY'}]};}});
  agent.start();
  await until(()=>agent.status().online);
  const operationId=randomUUID();
  const journal=new OperationJournal(relay.store,secret);
  const oldSettle=relay.store.settleOperation;
  relay.store.settleOperation=()=>{throw new Error('SIMULATED_PERSISTENCE_CRASH');};
  const original=await invokeTool(relay.hub,relay.store,ctx,'run_command',
   {command:'fixture-only',operationId},{journal});
  assert.equal(original.ok,true,JSON.stringify(original));
  assert.equal(original.result._meta.relayJournalSettled,false);
  assert.equal(executions,1);
  const spoolDir=path.join(process.env.BRC_HOME,'result-spool');
  assert.equal((await readdir(spoolDir)).length,1);
  relay.store.settleOperation=oldSettle;
  await relay.close();relay=null;
  // Cold startup uses same SQLite file, device token, session secret and port.
  cfg.publicUrl='http://127.0.0.1:'+port;
  relay=await buildRelay(cfg,()=>{});
  await new Promise(r=>relay.http.listen(port,'127.0.0.1',r));
  await until(()=>agent.status().online);
  await until(async()=>{
   const row=await relay.store.getOperation(operationId);
   return row?.state==='settled'&&!!row.encrypted_result;
  },16000);
  await until(async()=>(await lookupCallOutcome(operationId)).deliveryToRelayConfirmed===true,9000);
  const after=await new OperationJournal(relay.store,secret).recovery(ctx,{operationId});
  assert.equal(after.found,true);
  assert.equal(after.state,'settled');
  assert.match(after.resultText,/COMPLETED_PRIVATE_RESULT_FOR_REDELIVERY/);
  assert.equal(executions,1);
  await until(async()=>(await readdir(spoolDir)).filter(n=>n.endsWith('.json')).length===0);
 }finally{
  agent?.stop();
  if(relay)await relay.close().catch(()=>{});
  if(originalHome===undefined)delete process.env.BRC_HOME;else process.env.BRC_HOME=originalHome;
  await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:50});
 }
});

test('lost relay acknowledgement is retried as an ID-only probe without re-executing the command',
 {timeout:30000},async()=>{
 const dir=mkdtempSync(path.join(os.tmpdir(),'brc-ack-loss-'));
 const oldHome=process.env.BRC_HOME;
 process.env.BRC_HOME=path.join(dir,'agent-home');
 const secret='test-only-stable-relay-key-is-long-enough-123456789';
 const cfg={port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3210',trustProxy:false,
  dbFile:path.join(dir,'relay.sqlite'),sessionSecret:secret,
  adminUser:'admin',adminPassword:'test-only-password',relayVersion:'test-ack'};
 let relay=null,agent=null,executed=0;
 try{
  relay=await buildRelay(cfg,()=>{});
  await new Promise(resolve=>relay.http.listen(0,'127.0.0.1',resolve));
  const port=relay.http.address().port;
  const user=relay.store.getUserByName('admin');
  const token=relay.store.issueDeviceToken('ack-device',user.id,'Ack PC','win32');
  agent=new WsClient({relayUrl:'http://127.0.0.1:'+port,deviceId:'ack-device',token,
   name:'Ack PC',agentVersion:'test',coreVersion:'test',
   tools:[{name:'run_command',description:'fixture',inputSchema:{type:'object'},
    annotations:{readOnlyHint:false}}],
   callTool:async()=>{executed++;return {content:[{type:'text',text:'ack-lost-verified'}]};}});
  agent.start();
  await until(()=>agent.status().online);
  const operationId=randomUUID(),journal=new OperationJournal(relay.store,secret);
  const normalAck=relay.hub.acknowledgeResult.bind(relay.hub);
  relay.hub.acknowledgeResult=()=>false; // Simulate lost ACK, not failed persistence.
  const response=await invokeTool(relay.hub,relay.store,{userId:user.id,clientId:'ack-client'},
   'run_command',{operationId,command:'fixture-only'},{journal});
  assert.equal(response.ok,true);
  assert.equal(response.result._meta.recoverableResult,true);
  assert.equal(executed,1);
  assert.equal((await lookupCallOutcome(operationId)).deliveryToRelayConfirmed,false);
  relay.hub.acknowledgeResult=normalAck;
  relay.hub.get('ack-device').socket.terminate();
  await until(()=>agent.status().online,16000);
  await until(async()=>(await lookupCallOutcome(operationId)).deliveryToRelayConfirmed===true,15000);
  assert.equal(executed,1);
  assert.equal((await readdir(path.join(process.env.BRC_HOME,'result-spool'))).filter(f=>f.endsWith('.json')).length,0);
 }finally{
  agent?.stop();
  if(relay)await relay.close().catch(()=>{});
  if(oldHome===undefined)delete process.env.BRC_HOME;else process.env.BRC_HOME=oldHome;
  await rm(dir,{recursive:true,force:true,maxRetries:4,retryDelay:50});
 }
});
