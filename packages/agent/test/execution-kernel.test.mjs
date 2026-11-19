import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync} from 'node:fs';

const tmp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-execution-kernel-'));
const root=path.join(tmp,'allowed'),outside=path.join(tmp,'outside');
process.env.BRC_HOME=path.join(tmp,'home');
process.env.BRC_OPERATION_RECEIPTS='1';
await fs.mkdir(root,{recursive:true});
await fs.mkdir(outside,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {withCallContext}=await import('../dist/context.js');
const {AgentError}=await import('../dist/runtime/errors.js');
const kernel=await import('../dist/runtime/execution-kernel.js');
const receipts=await import('../dist/runtime/operation-receipts.js');
const success=()=>({content:[{type:'text',text:'done'}],structuredContent:{ok:true}});
const failure=code=>({isError:true,content:[{type:'text',text:code}],structuredContent:{error:{code,retryable:false}}});
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
after(async()=>{
 await configManager.close();delete process.env.BRC_OPERATION_RECEIPTS;
 await fs.rm(tmp,{recursive:true,force:true,maxRetries:6,retryDelay:120});
});

test('the common outcome contract distinguishes completed, failed, pending and uncertain',()=>{
 const states=[
  [success(),'read','completed'],
  [failure('EDIT_TEXT_NOT_FOUND'),'filesystem_mutation','failed'],
  [failure('PLUGIN_CALL_OUTCOME_UNCERTAIN'),'external_mutation','uncertain'],
  [failure('CANCELLED'),'filesystem_mutation','uncertain'],
  [failure('CANCELLED'),'read','failed'],
  [{...success(),structuredContent:{pending:true,jobId:'jtest'}},'external_mutation','pending'],
 ];
 for(const [value,kind,expected]of states){
   assert.equal(kernel.classifyExecution(value,kind),expected);
   const classified=kernel.attachExecutionOutcome(value,'test_tool','call-123',kind);
   assert.equal(classified._meta.executionOutcome.state,expected);
   assert.equal(classified._meta.executionOutcome.automaticRetry,false);
 }
 assert.ok(kernel.executionKernelStatus().automaticMutationReplay===false);
});

test('concurrent writes to the same canonical target remain serialized',async()=>{
 const target=path.join(root,'serialized.txt');
 await fs.writeFile(target,'0');
 const events=[];
 await Promise.all(Array.from({length:9},(_,i)=>withCallContext({
  id:'serialize-'+i,remote:false,client:null
 },()=>kernel.executeToolKernel({
  name:'write_file',callId:'serialize-'+i,kind:'filesystem_mutation',
  paths:[target],recordReceipt:false,preflight:async()=>{},
  perform:async()=>{
   const n=Number(await fs.readFile(target,'utf8'));
   events.push('start-'+i);
   await delay(5);
   await fs.writeFile(target,String(n+1));
   events.push('end-'+i);
   return success();
  }
 }))));
 assert.equal((await fs.readFile(target,'utf8')),'9');
 assert.equal(events.filter(v=>v.startsWith('start')).length,9);
 for(let i=0;i<18;i+=2){
  assert.equal(events[i].slice(0,5),'start');
  assert.equal(events[i+1].slice(0,3),'end');
 }
});

test('a preflight cancellation prevents the mutating tool from starting',async()=>{
 const abort=new AbortController();
 let calls=0;
 await assert.rejects(withCallContext({id:'preflight-cancel',remote:false,client:null,signal:abort.signal},
   ()=>kernel.executeToolKernel({
    name:'write_file',callId:'preflight-cancel',kind:'filesystem_mutation',
    paths:[path.join(root,'never.txt')],recordReceipt:true,
    preflight:async()=>abort.abort(new AgentError('CANCELLED','cancelled before execution')),
    perform:async()=>{calls++;return success();}
   })),/cancelled before execution/);
 assert.equal(calls,0);
 await assert.rejects(fs.stat(path.join(root,'never.txt')),{code:'ENOENT'});
});

test('an uncertain plugin call is recorded as uncertain, never falsely as ordinary failure',async()=>{
 const callId='plugin-uncertain-once';
 const result=await kernel.executeToolKernel({
  name:'call_plugin_tool',callId,kind:'external_mutation',recordReceipt:true,
  perform:async()=>failure('PLUGIN_CALL_OUTCOME_UNCERTAIN')
 });
 assert.equal(kernel.classifyExecution(result,'external_mutation'),'uncertain');
 const rec=(await receipts.recentMutationReceipts(30)).find(v=>v.tool==='call_plugin_tool');
 assert.equal(rec?.outcome,'uncertain');
 assert.equal(rec?.recoveredUncertain,false);
});

test('after an exception following a side effect, the receipt is uncertain and no retry is attempted',async()=>{
 const target=path.join(root,'uncertain-target.txt');
 let calls=0;
 await assert.rejects(kernel.executeToolKernel({
  name:'write_file',callId:'write-then-crash',kind:'filesystem_mutation',
  paths:[target],recordReceipt:true,
  perform:async()=>{calls++;await fs.writeFile(target,'already changed');throw new Error('simulated tool crash');}
 }),/simulated tool crash/);
 assert.equal(calls,1);
 assert.equal(await fs.readFile(target,'utf8'),'already changed');
 const rec=(await receipts.recentMutationReceipts(30)).find(v=>v.tool==='write_file'&&v.outcome==='uncertain');
 assert.ok(rec);
 assert.ok(rec.before?.includes('missing'));
});

test('junction/symlink to disallowed directory cannot be used for a write',async t=>{
 const link=path.join(root,'external-alias');
 try{await fs.symlink(outside,link,process.platform==='win32'?'junction':'dir');}
 catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('OS does not permit junction creation');return;}throw e;}
 let called=false;
 try{
  await assert.rejects(kernel.executeToolKernel({
   name:'write_file',callId:'blocked-alias',kind:'filesystem_mutation',
   paths:[path.join(link,'escaped.txt')],recordReceipt:true,
   perform:async()=>{called=true;await fs.writeFile(path.join(link,'escaped.txt'),'bad');return success();}
  }),/Path not allowed|PATH_POLICY_UNAVAILABLE/);
  assert.equal(called,false);
  await assert.rejects(fs.stat(path.join(outside,'escaped.txt')),{code:'ENOENT'});
 }finally{await fs.unlink(link).catch(()=>{});}
});

test('retargeting a junction while waiting for its canonical lock is rejected',async t=>{
 const inside=path.join(root,'inside-target');
 await fs.mkdir(inside,{recursive:true});
 const alias=path.join(root,'swappable');
 try{await fs.symlink(inside,alias,process.platform==='win32'?'junction':'dir');}
 catch(e){if(['EPERM','EACCES','ENOTSUP'].includes(e.code)){t.skip('OS does not permit junction creation');return;}throw e;}
 let release,entered;
 const held=new Promise(resolve=>{release=resolve;});
 const started=new Promise(resolve=>{entered=resolve;});
 const canonical=path.join(inside,'target.txt');
 const first=kernel.executeToolKernel({
  name:'write_file',callId:'held-lock',kind:'filesystem_mutation',
  paths:[canonical],recordReceipt:false,
  perform:async()=>{entered();await held;return success();}
 });
 await started;
 let secondCalled=false;
 const blocked=kernel.executeToolKernel({
  name:'write_file',callId:'blocked-lock',kind:'filesystem_mutation',
  paths:[path.join(alias,'target.txt')],recordReceipt:false,
  perform:async()=>{secondCalled=true;return success();}
 });
 await delay(75);
 try{
  await fs.unlink(alias);
  await fs.symlink(outside,alias,process.platform==='win32'?'junction':'dir');
 }finally{release();}
 await first;
 try{
  await assert.rejects(blocked,/Path not allowed|PATH_CHANGED|PATH_POLICY_UNAVAILABLE/);
  assert.equal(secondCalled,false);
 }finally{await fs.unlink(alias).catch(()=>{});}
});
