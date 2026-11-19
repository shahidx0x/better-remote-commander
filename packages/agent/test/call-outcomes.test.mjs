// Phase 10: durable metadata-only call outcome recovery, never replay.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-call-outcome-'));
process.env.BRC_HOME=path.join(temp,'home');
const previous=process.env.BRC_CALL_OUTCOME_RECEIPTS;
delete process.env.BRC_CALL_OUTCOME_RECEIPTS;
const {beginCallOutcome,settleCallOutcome,lookupCallOutcome,callOutcomeStatus}=
 await import('../dist/runtime/call-outcomes.js');
const dir=path.join(process.env.BRC_HOME,'call-outcomes');
const hash=id=>createHash('sha256').update(id).digest('hex');
const file=id=>path.join(dir,hash(id)+'.json');
const module=pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)),
  '../dist/runtime/call-outcomes.js')).href;
after(async()=>{
 if(previous===undefined)delete process.env.BRC_CALL_OUTCOME_RECEIPTS;
 else process.env.BRC_CALL_OUTCOME_RECEIPTS=previous;
 await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:80});
});
test('durable outcome is default-on, stores only hashed call ID and metadata, never secret payloads',async()=>{
 assert.equal(callOutcomeStatus().enabled,true);
 const id=randomUUID();
 const record=await beginCallOutcome(id,'run_command');
 assert.ok(record);
 const secret='SECRET_OUTPUT_DO_NOT_PERSIST_8b2731';
 await settleCallOutcome(record,{isError:false,structuredContent:{
  exitCode:0,stdout:secret,command:'never persist this command',path:'C:\\sensitive\\project'
 }},120);
 const raw=await fs.readFile(file(id),'utf8');
 assert.ok(raw.includes('"returned_success"'));
 assert.equal(raw.includes(id),false,'raw call ID must not be persisted');
 assert.equal(raw.includes(secret),false,'command result must not be persisted');
 assert.equal(raw.includes('C:\\sensitive'),false,'file path must not be persisted');
 assert.equal(raw.includes('never persist this command'),false,'argument values must not be persisted');
 const restored=await lookupCallOutcome(id);
 assert.equal(restored.found,true);
 assert.equal(restored.tool,'run_command');
 assert.equal(restored.outcome,'returned_success');
 assert.equal(restored.durationMs,120);
 assert.equal(restored.deliveryToRelayConfirmed,false);
 assert.equal(restored.fullResultStored,false);
 assert.equal(restored.automaticReplay,false);
});
test('an interrupted call remains UNCERTAIN after a fresh Node process',async()=>{
 const id=randomUUID();
 assert.ok(await beginCallOutcome(id,'git_push'));
 const snapshot=spawnSync(process.execPath,['--input-type=module','-e',
  'import {lookupCallOutcome} from '+JSON.stringify(module)+';\n'+
  'process.stdout.write(JSON.stringify(await lookupCallOutcome('+JSON.stringify(id)+')));'
 ],{encoding:'utf8',timeout:12000,env:{...process.env}});
 assert.equal(snapshot.status,0,snapshot.stderr);
 const status=JSON.parse(snapshot.stdout.trim());
 assert.equal(status.found,true);
 assert.equal(status.outcome,'uncertain');
 assert.equal(status.recoveredUncertain,true);
 assert.equal(status.automaticReplay,false);
 assert.match(status.guidance,/Inspect the actual state/);
});
test('failure receipts retain safe error codes only, not error messages',async()=>{
 const id=randomUUID(),record=await beginCallOutcome(id,'run_command');
 await settleCallOutcome(record,{isError:true,structuredContent:{
  error:{code:'TOOL_OUTCOME_UNCERTAIN',message:'bad password NEVER_STORE_ME'}
 }},901);
 const info=await lookupCallOutcome(id);
 assert.equal(info.outcome,'reported_failure');
 assert.equal(info.errorCode,'TOOL_OUTCOME_UNCERTAIN');
 assert.ok(!JSON.stringify(info).includes('NEVER_STORE_ME'));
 assert.ok(!(await fs.readFile(file(id),'utf8')).includes('NEVER_STORE_ME'));
});
test('missing, expired or corrupted receipts never imply the remote call was not executed',async()=>{
 const absent=await lookupCallOutcome(randomUUID());
 assert.equal(absent.found,false);
 assert.equal(absent.automaticReplay,false);
 const id=randomUUID();
 const started=await beginCallOutcome(id,'worker_integrate');
 assert.ok(started);
 const past=new Date(Date.now()-8*86400000);
 await fs.utimes(file(id),past,past);
 assert.equal((await lookupCallOutcome(id)).found,false);
 const corruptedId=randomUUID();
 await fs.writeFile(file(corruptedId),'{bad json','utf8');
 assert.equal((await lookupCallOutcome(corruptedId)).found,false);
});
test('explicit opt-out disables durable recording without breaking callers',async()=>{
 process.env.BRC_CALL_OUTCOME_RECEIPTS='0';
 try{
  const id=randomUUID();
  assert.equal(callOutcomeStatus().enabled,false);
  assert.equal(await beginCallOutcome(id,'run_command'),null);
  assert.equal((await lookupCallOutcome(id)).found,false);
 }finally{delete process.env.BRC_CALL_OUTCOME_RECEIPTS;}
});
test('receipt retention is bounded and does not persist unlimited call metadata',async()=>{
 for(let i=0;i<143;i++){
  const id=randomUUID();
  const record=await beginCallOutcome(id,'run_command');
  assert.ok(record);
  await settleCallOutcome(record,{isError:false,structuredContent:{exitCode:0}},i);
 }
 const names=(await fs.readdir(dir)).filter(x=>x.endsWith('.json'));
 assert.ok(names.length<=128,'hard on-disk receipt cap should not be breached');
 assert.ok(names.length>0);
 assert.ok(names.every(n=>/^[a-f0-9]{64}\.json$/.test(n)));
 const status=callOutcomeStatus();
 assert.ok(status.prunes>0);
 assert.equal(status.storesArguments,false);
 assert.equal(status.storesPaths,false);
 assert.equal(status.storesRawCallIds,false);
});


test('disk failure cannot accidentally claim an outcome was recorded or abort local execution',async()=>{
 const previous=process.env.BRC_HOME;
 const blocker=path.join(temp,'blocker-file');
 await fs.writeFile(blocker,'not a directory');
 process.env.BRC_HOME=blocker;
 try{
  const id=randomUUID();
  assert.equal(await beginCallOutcome(id,'run_command'),null);
  assert.equal((await lookupCallOutcome(id)).found,false);
  assert.ok(callOutcomeStatus().failedWrites>0);
 }finally{process.env.BRC_HOME=previous;}
});
test('a duplicate remote mutation call ID after agent re-instantiation is never executed twice',async()=>{
 const {WsClient}=await import('../dist/transport/ws-client.js');
 const id=randomUUID(),sent=[];
 let runs=0;
 const opts={
  relayUrl:'http://127.0.0.1:3000',deviceId:'fixture-agent',
  name:'fixture',token:'fixture',agentVersion:'test',coreVersion:'test',
  tools:[{name:'run_command',annotations:{readOnlyHint:false}}],
  callTool:async()=>{runs++;return {
    isError:false,content:[{type:'text',text:'COMPLETED_ONCE'}],
    structuredContent:{exitCode:0}
  }}
 };
 const socket={
  readyState:1,bufferedAmount:0,send:s=>sent.push(JSON.parse(s)),
  terminate:()=>{throw new Error('Unexpected socket termination');}
 };
 const first=new WsClient(opts);
 first.ws=socket;
 await first.handleCall({type:'call',id,tool:'run_command',args:{}},socket);
 assert.equal(runs,1);
 assert.equal(sent.at(-1).result.isError,false);
 assert.equal((await lookupCallOutcome(id)).outcome,'returned_success');
 const restarted=new WsClient(opts);
 restarted.ws=socket;
 await restarted.handleCall({type:'call',id,tool:'run_command',args:{}},socket);
 assert.equal(runs,1,'an identical remote call ID must not replay after restart');
 assert.equal(sent.at(-1).result.isError,true);
 assert.equal(sent.at(-1).result.structuredContent.error.code,'DUPLICATE_CALL');
});
