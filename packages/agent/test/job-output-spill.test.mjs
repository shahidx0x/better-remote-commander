import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-output-spill-test-'));
process.env.BRC_HOME=path.join(scratch,'home');
process.env.BRC_JOB_OUTPUT_SPILL='0';
process.env.BRC_JOB_OUTPUT_QUOTA_BYTES='2097152';
const spill=await import('../dist/runtime/job-output-spill.js');
const {handleSpawnJob,handleGetJob,handleWaitJobs,setJobToolExecutor}=await import('../dist/tools/jobs.js');
const out=r=>(r.content??[]).map(c=>c.text??'').join('\n');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const jobId=r=>{const id=/Started job (j[a-z0-9]+)/.exec(out(r))?.[1];assert.ok(id,out(r));return id;};
const sampleId=(i)=>'jabcdefgh'+String(i).padStart(3,'0');
after(async()=>{
  delete process.env.BRC_JOB_OUTPUT_SPILL;delete process.env.BRC_JOB_OUTPUT_QUOTA_BYTES;
  await fs.rm(scratch,{recursive:true,force:true,maxRetries:7,retryDelay:90});
});

test('opt-in retains redacted long output with Unicode-safe byte paging and no leaked credentials',async()=>{
  assert.equal(spill.spillEnabled(),false);
  const id=sampleId(1);
  const raw=('Build output: 🌐🎉\n').repeat(5000)+'\ntoken=super-sensitive-value\nBearer verySensitiveBearerValue123\n';
  assert.equal(await spill.saveJobOutput(id,0,raw),null,'default must not persist');
  const saved=await spill.saveJobOutput(id,0,raw,true);
  assert.ok(saved&&saved.bytes>16_000);
  const disk=await fs.readFile(path.join(process.env.BRC_HOME,'job-output',id+'.0.spill'),'utf8');
  assert.doesNotMatch(disk,/super-sensitive-value|verySensitiveBearerValue123/);
  assert.match(disk,/REDACTED/);
  const metricsBefore=spill.spillVerificationStatus();
  const pieces=[];
  let offset=0;
  for(let i=0;i<80;i++){
    const page=await spill.readJobOutput(id,0,offset,1900,saved.sha256);
    assert.ok(page,'page at offset '+offset);
    pieces.push(page.text);
    assert.ok(page.nextByteOffset>offset || !page.hasMore);
    offset=page.nextByteOffset;
    if(!page.hasMore)break;
  }
  assert.equal(pieces.join(''),disk);
  assert.equal(offset,saved.bytes);
  const metricsAfter=spill.spillVerificationStatus();
  assert.equal(metricsAfter.fullHashes-metricsBefore.fullHashes,1,
    'one SHA-256 verification should cover all unchanged output pages');
  assert.ok(metricsAfter.verifiedCacheHits-metricsBefore.verifiedCacheHits>=pieces.length-1,
    'subsequent unchanged pages should reuse the bounded verified file identity');
  assert.equal(await spill.readJobOutput(id,0,0,1000,'0'.repeat(64)),null,'reject corrupt digest');
  const corrupted=Buffer.from(disk);
  corrupted[120]=corrupted[120]===65?66:65;
  await fs.writeFile(path.join(process.env.BRC_HOME,'job-output',id+'.0.spill'),corrupted);
  assert.equal(await spill.readJobOutput(id,0,0,1000,saved.sha256),null,'reject altered stored bytes');
  assert.ok(spill.spillVerificationStatus().identityChanges>=1,
    'a modified output file must invalidate cached verification');
});

test('per-job output opt out and bounded global quota evict old files',async()=>{
  const ids=[sampleId(2),sampleId(3),sampleId(4)];
  const payload=('K'.repeat(150)+'\n').repeat(12_000);
  for(const id of ids){
    assert.ok(await spill.saveJobOutput(id,0,payload,true),id);
    await sleep(25);
  }
  const old=await spill.readJobOutput(ids[0],0,0,1000);
  const recent=await spill.readJobOutput(ids[2],0,0,1000);
  assert.equal(old,null,'old output must be evicted under 2MiB quota');
  assert.ok(recent);
  assert.equal(await spill.saveJobOutput(sampleId(5),0,payload,false),null);
});

test('disk failure does not fail the running job or expose its output',async()=>{
  const previous=process.env.BRC_HOME;
  const blocker=path.join(scratch,'home-is-a-file');
  await fs.writeFile(blocker,'not a folder');
  process.env.BRC_HOME=blocker;
  try{assert.equal(await spill.saveJobOutput(sampleId(6),0,'long'.repeat(10000),true),null);}
  finally{process.env.BRC_HOME=previous;}
});

test('get_job reads redacted pages after process restart without rerunning the tool',async()=>{
  let calls=0;
  setJobToolExecutor(async()=>{calls++;return{content:[{type:'text',text:'FIRST\n'+('✅ build output\n').repeat(6000)+'\napi_key=secret-key-value'}]};});
  const started=await handleSpawnJob({steps:[{tool:'fixture_big_output',args:{someSecret:'never-persist'}}],
    label:'output-spill-fixture',retain_output:true,timeout_ms:10_000});
  const id=jobId(started);
  await handleWaitJobs({ids:[id],timeout_ms:10_000});
  const d=await handleGetJob({id});
  assert.match(out(d),/Retained output/);
  let step=await handleGetJob({id,output_step:0,output_byte_offset:0,output_chars:1200});
  assert.equal(step.isError,undefined,out(step));
  assert.equal(step.structuredContent.jobId,id);
  assert.equal(step.structuredContent.hasMore,true);
  assert.match(out(step),/FIRST/);
  step=await handleGetJob({id,output_step:0,output_byte_offset:step.structuredContent.nextByteOffset,output_chars:1200});
  assert.equal(step.isError,undefined,out(step));
  assert.equal(calls,1);
  const persisted=JSON.stringify(JSON.parse(await fs.readFile(path.join(process.env.BRC_HOME,'jobs',id+'.json'),'utf8')));
  assert.doesNotMatch(persisted,/never-persist|secret-key-value/);
  const here=path.dirname(fileURLToPath(import.meta.url));
  const jobsPath=pathToFileURL(path.join(here,'../dist/tools/jobs.js')).href;
  const child=spawnSync(process.execPath,['--input-type=module','-e',
    'import {handleGetJob} from '+JSON.stringify(jobsPath)+';const r=await handleGetJob({id:'+JSON.stringify(id)+',output_step:0,output_chars:1000});process.stdout.write("RESTORED="+JSON.stringify(r.structuredContent)+"\\n");'],
    {cwd:here,env:{...process.env,BRC_HOME:process.env.BRC_HOME},encoding:'utf8',timeout:12_000});
  assert.equal(child.status,0,child.stderr);
  const line=child.stdout.split(/\r?\n/).find(t=>t.startsWith('RESTORED='));
  assert.ok(line,child.stdout);
  const recovery=JSON.parse(line.slice('RESTORED='.length));
  assert.equal(recovery.jobId,id);
  assert.equal(recovery.hasMore,true);
  assert.equal(calls,1,'retrieval must not execute the tool');
});
