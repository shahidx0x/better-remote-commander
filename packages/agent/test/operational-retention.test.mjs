import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const home=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-retention-'));
const previous=process.env.BRC_HOME;
const priorFlag=process.env.BRC_OPERATIONAL_RETENTION;
const priorQuota=process.env.BRC_JOB_OUTPUT_QUOTA_BYTES;
process.env.BRC_HOME=home;
const {operationalRetentionEnabled,sweepOperationalRetention,
 operationalRetentionStatus}=await import('../dist/runtime/operational-retention.js');
const now=Date.now(), DAY=24*60*60_000;
const root=()=>home;
const named=(folder,name)=>path.join(root(),folder,name);
const age=async(p,millis)=>fs.utimes(p,new Date(now-millis),new Date(now-millis));
const make=async(folder,name,contents='tiny',oldMs=3*60_000)=>{
 const f=named(folder,name);await fs.mkdir(path.dirname(f),{recursive:true});
 await fs.writeFile(f,contents);await age(f,oldMs);return f;
};
const exists=async p=>!!(await fs.lstat(p).catch(()=>null));
after(async()=>{
 if(previous===undefined)delete process.env.BRC_HOME;
 else process.env.BRC_HOME=previous;
 if(priorFlag===undefined)delete process.env.BRC_OPERATIONAL_RETENTION;
 else process.env.BRC_OPERATIONAL_RETENTION=priorFlag;
 if(priorQuota===undefined)delete process.env.BRC_JOB_OUTPUT_QUOTA_BYTES;
 else process.env.BRC_JOB_OUTPUT_QUOTA_BYTES=priorQuota;
 await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

test('retention is enabled by default; never visits files other than six approved directories',async()=>{
 delete process.env.BRC_OPERATIONAL_RETENTION;
 assert.equal(operationalRetentionEnabled(),true);
 const secret=await make('','device.json','DONT DELETE',90*DAY);
 const plugin=await make('plugins','installed.json','DONT TOUCH',90*DAY);
 const project=await make('project','source.ts','const a=1',90*DAY);
 const foreign=await make('call-outcomes','user-note.json','keep me',90*DAY);
 const old=await make('call-outcomes','a'.repeat(64)+'.json','{broken-json',8*DAY);
 const recent=await make('call-outcomes','b'.repeat(64)+'.json','{"v":1}',DAY);
 const result=await sweepOperationalRetention(now);
 assert.ok(result?.removed>=1);
 assert.equal(await exists(old),false,'expired owned corrupt receipt should be removed');
 for(const p of [secret,plugin,project,foreign,recent])
  assert.equal(await exists(p),true,'unowned or recent file was deleted: '+path.basename(p));
 const st=operationalRetentionStatus();
 assert.equal(st.enabled,true);
 assert.equal(st.lastRunAt,now);
 assert.equal(st.lastRun.families.length,6);
 assert.equal(st.lastRun.families.some(f=>f.family==='jobs'),true);
 assert.doesNotMatch(JSON.stringify(st),/DONT DELETE|source.ts|device.json|installed.json/);
});

test('orphaned atomic-write temps are pruned only by exact safe names after grace',async()=>{
 const oldTemp=await make('mutation-receipts','a'.repeat(64)+'.json.9135.0123abcd.tmp','orphan',3*60*60_000);
 const young=await make('mutation-receipts','b'.repeat(64)+'.json.9135.0123abcd.tmp','active',2*60_000);
 const foreign=await make('mutation-receipts','security-dump.json.9135.0123abcd.tmp','not ours',90*DAY);
 await sweepOperationalRetention(now);
 assert.equal(await exists(oldTemp),false);
 assert.equal(await exists(young),true);
 assert.equal(await exists(foreign),true);
});

test('per-family count and disk quota evict oldest only; job history never prunes fresh active record',async()=>{
 const dir='worker-plan-checkpoints';
 for(let i=0;i<7;i++){
  const tail=String(i).padStart(12,'0');
  await make(dir,'12345678-1234-4123-8123-'+tail+'.json','a'.repeat(200),10*60_000+i*1000);
 }
 const active=await make('jobs','jactive12345.json','active',40_000);
 for(let i=0;i<104;i++){
  const id='j'+i.toString(36).padStart(9,'a');
  await make('jobs',id+'.json','{"finished":true}',8*60*60_000+i*1000);
 }
 const value=await sweepOperationalRetention(now);
 const afterWorker=await fs.readdir(path.join(home,dir));
 const afterJobs=await fs.readdir(path.join(home,'jobs'));
 assert.equal(afterWorker.filter(n=>n.endsWith('.json')).length,4);
 assert.ok(afterJobs.filter(n=>n.endsWith('.json')).length<=100);
 assert.equal(await exists(active),true);
 assert.ok(value.removed>=7);
});

test('job-output configured quota is respected without opting in to storing output',async()=>{
 const prev=process.env.BRC_JOB_OUTPUT_QUOTA_BYTES;
 process.env.BRC_JOB_OUTPUT_QUOTA_BYTES=2*1024*1024;
 try{
  const content='x'.repeat(1024*1024);
  const oldest=await make('job-output','jtest12345.0.spill',content,30*60_000);
  const middle=await make('job-output','jtest12345.1.spill',content,20*60_000);
  const fresh=await make('job-output','jtest12345.2.spill',content,10*60_000);
  await sweepOperationalRetention(now);
  assert.equal(await exists(oldest),false);
  assert.equal(await exists(middle),true);
  assert.equal(await exists(fresh),true);
  assert.equal(operationalRetentionStatus().enabled,true,
    'Maintenance does not change the independent spill opt-in policy');
 }finally{
  if(prev===undefined)delete process.env.BRC_JOB_OUTPUT_QUOTA_BYTES;
  else process.env.BRC_JOB_OUTPUT_QUOTA_BYTES=prev;
 }
});

test('maliciously substituted symlink record and symlink-owned directory are not followed',async t=>{
 const dest=await make('','do-not-touch.txt','KEEP',30*DAY);
 const link=named('call-outcomes','c'.repeat(64)+'.json');
 let supported=true;
 try{await fs.symlink(dest,link,'file');}
 catch(e){supported=false;t.diagnostic('Windows file symlink permission unavailable: '+e.code);}
 if(supported){
  await sweepOperationalRetention(now);
  assert.equal(await exists(dest),true);
  assert.equal(await fs.readFile(dest,'utf8'),'KEEP');
  assert.equal(await exists(link),true);
 }
 const trap=path.join(root(),'task-checkpoints');
 const outside=path.join(root(),'outside');
 await fs.mkdir(outside,{recursive:true});
 const foreign=await make('outside','12345678-1234-4123-8123-000000000099.json','KEEP',90*DAY);
 let dirLink=false;
 try{await fs.symlink(outside,trap,'junction');dirLink=true;}catch{}
 await sweepOperationalRetention(now);
 assert.equal(await exists(foreign),true,'symlinked folder must not be traversed');
 if(dirLink){
  assert.equal(await exists(trap),true);
  await fs.unlink(trap);
 }
});

test('explicit opt-out avoids cleanup, then concurrent runs serialize and publish only metadata',async()=>{
 const old=await make('call-outcomes','d'.repeat(64)+'.json','old',8*DAY);
 process.env.BRC_OPERATIONAL_RETENTION='0';
 const off=await sweepOperationalRetention(now);
 assert.equal(off,null);
 assert.equal(await exists(old),true);
 delete process.env.BRC_OPERATIONAL_RETENTION;
 const [a,b]=await Promise.all([sweepOperationalRetention(now),sweepOperationalRetention(now)]);
 assert.ok(a&&b&&a.ranAt===now&&b.ranAt===now);
 assert.equal(await exists(old),false);
 assert.equal(operationalRetentionStatus().running,false);
});

test('recently written receipts survive quota pressure until write completes',async()=>{
 const folder='task-checkpoints';
 for(let i=0;i<10;i++){
  await make(folder,'aaaaaaaa-'+i.toString(16).padStart(4,'0')+'-4123-8123-'+
   String(i).padStart(12,'0')+'.json','active record',2000+i);
 }
 await sweepOperationalRetention(now);
 const n=(await fs.readdir(path.join(home,folder))).filter(s=>s.endsWith('.json'));
 assert.equal(n.length,10,'record touched within last 60s should not be deleted');
 assert.ok(operationalRetentionStatus().lastRun.families.some(f=>f.family===folder&&f.kept===10));
});
