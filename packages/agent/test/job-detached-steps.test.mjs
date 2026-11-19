import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-job-detached-'));
process.env.BRC_HOME=path.join(scratch,'home');
process.env.BRC_JOB_CANCEL_GRACE_MS='180';
const {withCallContext,getCallContext}=await import('../dist/context.js');
const {handleSpawnJob,handleCancelJob,handleWaitJobs,handleGetJob,handleListJobs,setJobToolExecutor}=await import('../dist/tools/jobs.js');
const text=r=>r.content.map(c=>c.text??'').join('\n');
const idOf=r=>{const id=/Started job (j[a-z0-9]+)/.exec(text(r))?.[1];assert.ok(id,text(r));return id;};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
after(async()=>{await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:100});});

test('background tool keeps caller identity but uses its own lifetime and cancellation',async()=>{
 const controller=new AbortController();
 const seen=[];
 setJobToolExecutor(async(tool)=>{
   const ctx=getCallContext();
   seen.push({id:ctx?.id,remote:ctx?.remote,client:ctx?.client,signal:ctx?.signal});
   await sleep(180);
   return {content:[{type:'text',text:'finished'}]};
 });
 const parent={id:'original-chat-call',remote:true,client:{name:'ChatGPT'},signal:controller.signal,deadline:Date.now()+30};
 const started=await withCallContext(parent,()=>handleSpawnJob({steps:[{tool:'mock_delayed_read',args:{}}],timeout_ms:5000}));
 const id=idOf(started);
 controller.abort(new Error('parent MCP response ended'));
 await handleWaitJobs({ids:[id],timeout_ms:2000});
 const final=await handleGetJob({id});
 assert.match(text(final),/SUCCEEDED/);
 assert.equal(seen.length,1);
 assert.equal(seen[0].remote,true);
 assert.equal(seen[0].client?.name,'ChatGPT');
 assert.notEqual(seen[0].signal,controller.signal);
 assert.equal(seen[0].signal.aborted,false);
 const saved=JSON.parse(await fs.readFile(path.join(process.env.BRC_HOME,'jobs',id+'.json'),'utf8'));
 assert.equal(saved.status,'succeeded');
 assert.equal(saved.ownerClient,undefined);
});

test('uncancellable nested mutation becomes interrupted rather than falsely cancelled',async()=>{
 let dispatched=0,trigger;
 const seen=new Promise(resolve=>trigger=resolve);
 setJobToolExecutor(async()=>{
   dispatched++;trigger();
   return await new Promise(()=>{});
 });
 const started=await handleSpawnJob({steps:[{tool:'mock_unresponsive_mutation',args:{}}],timeout_ms:2500});
 const id=idOf(started);
 await seen;
 const cancelled=await handleCancelJob({ids:[id]});
 assert.match(text(cancelled),/Cancelled 1 job/);
 await handleWaitJobs({ids:[id],timeout_ms:1000});
 const result=await handleGetJob({id});
 assert.match(text(result),/INTERRUPTED/);
 assert.match(text(result),/TOOL_OUTCOME_UNCERTAIN/);
 assert.equal(dispatched,1);
 const summary=await handleListJobs({status:'interrupted'});
 assert.match(text(summary),new RegExp(id));
});


test('continue_on_error does not run later steps after an uncertain mutation',async()=>{
 const dispatched=[];
 setJobToolExecutor(async(tool)=>{
   dispatched.push(tool);
   if(tool==='possible_external_write')return{
     isError:true,
     content:[{type:'text',text:'PLUGIN_CALL_OUTCOME_UNCERTAIN: transport dropped after dispatch'}],
     structuredContent:{error:{code:'PLUGIN_CALL_OUTCOME_UNCERTAIN',retryable:false},
       executionOutcome:{state:'uncertain',automaticRetry:false}}
   };
   return {content:[{type:'text',text:'should not execute'}]};
 });
 const started=await handleSpawnJob({
   steps:[
     {tool:'possible_external_write',args:{}},
     {tool:'next_unrelated_mutation',args:{}}
   ],
   continue_on_error:true,timeout_ms:4000
 });
 const id=idOf(started);
 await handleWaitJobs({ids:[id],timeout_ms:3000});
 const result=await handleGetJob({id});
 assert.match(text(result),/INTERRUPTED/);
 assert.deepEqual(dispatched,['possible_external_write']);
 assert.match(text(result),/1 step\(s\) not run/);
});
