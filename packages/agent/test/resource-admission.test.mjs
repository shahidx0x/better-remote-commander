import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
import {CommandCpuAdmission,commandCpuAdmission} from '../dist/runtime/resource-admission.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const home=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-cpu-gate-'));
const project=path.join(home,'fixture');
await fs.mkdir(project);
const existing=process.env.BRC_SHARED_CPU_BUDGET;
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[project]);
const {runProgram}=await import('../dist/runtime/program-runner.js');
after(async()=>{
 if(existing===undefined)delete process.env.BRC_SHARED_CPU_BUDGET;
 else process.env.BRC_SHARED_CPU_BUDGET=existing;
 await configManager.close();
 await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

test('FIFO one-slot CPU admission never overlaps requested heavy work',async()=>{
 const a=new CommandCpuAdmission(()=>true);
 const events=[];
 const first=await a.acquire();
 const second=a.acquire().then(release=>{events.push('second');return release;});
 const third=a.acquire().then(release=>{events.push('third');return release;});
 await delay(10);
 assert.equal(a.status().active,1);
 assert.equal(a.status().queued,2);
 first();
 const r2=await second;
 assert.deepEqual(events,['second']);
 assert.equal(a.status().active,1);
 assert.equal(a.status().queued,1);
 r2();
 const r3=await third;
 assert.deepEqual(events,['second','third']);
 r3();r3();
 assert.equal(a.status().active,0);
 assert.equal(a.status().completed,3);
});

test('queued cancellation and admission timeout never occupy a slot',async()=>{
 const a=new CommandCpuAdmission(()=>true);
 const held=await a.acquire();
 const cancel=new AbortController();
 const pending=a.acquire(cancel.signal,5000);
 const timeout=a.acquire(undefined,45);
 cancel.abort(new Error('caller aborted before spawn'));
 await assert.rejects(pending,/caller aborted before spawn/);
 await assert.rejects(timeout,e=>e?.code==='RESOURCE_ADMISSION_TIMEOUT');
 assert.equal(a.status().active,1);
 assert.equal(a.status().queued,0);
 assert.equal(a.status().cancelledQueued,1);
 assert.equal(a.status().expiredQueued,1);
 held();
 assert.equal(a.status().active,0);
});

test('no-op admission in default mode consumes no worker slot',async()=>{
 const a=new CommandCpuAdmission(()=>false);
 const r1=await a.acquire(),r2=await a.acquire();
 assert.equal(a.status().active,0);
 r1();r2();
 assert.equal(a.status().completed,0);
});

test('opt-in CPU admission serializes real native toolchains from same agent process',async()=>{
 process.env.BRC_SHARED_CPU_BUDGET='1';
 const argv=['-e',"setTimeout(() => process.stdout.write('done'), 300)"];
 try{
  const first=runProgram(process.execPath,argv,project,4000);
  const second=runProgram(process.execPath,argv,project,4000);
  await delay(70);
  const status=commandCpuAdmission.status();
  assert.equal(status.maxActive,1);
  assert.equal(status.active,1);
  assert.equal(status.queued,1);
  const [a,b]=await Promise.all([first,second]);
  assert.notEqual(a.isError,true,JSON.stringify(a.structuredContent));
  assert.notEqual(b.isError,true,JSON.stringify(b.structuredContent));
  assert.equal(commandCpuAdmission.status().active,0);
  assert.equal(commandCpuAdmission.status().queued,0);
 }finally{delete process.env.BRC_SHARED_CPU_BUDGET;}
});
