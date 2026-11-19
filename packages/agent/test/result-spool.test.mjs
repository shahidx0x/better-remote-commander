import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {readFile,readdir,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {ResultSpool} from '../dist/transport/result-spool.js';

const token='brc_dev_very-secret-long-value-not-for-storage';
async function fixture(fn){
 const dir=mkdtempSync(path.join(os.tmpdir(),'brc-agent-result-spool-'));
 const old=process.env.BRC_HOME,oldFlag=process.env.BRC_DURABLE_AGENT_SPOOL;
 process.env.BRC_HOME=dir;
 delete process.env.BRC_DURABLE_AGENT_SPOOL;
 try{await fn(dir);}finally{
  if(old===undefined)delete process.env.BRC_HOME;else process.env.BRC_HOME=old;
  if(oldFlag===undefined)delete process.env.BRC_DURABLE_AGENT_SPOOL;else process.env.BRC_DURABLE_AGENT_SPOOL=oldFlag;
  await rm(dir,{recursive:true,force:true});
 }
}
test('completed result is encrypted before send, recovered after process restart and deleted only after ack',async()=>{
 await fixture(async dir=>{
  const id=randomUUID(),secret='ULTRA_SECRET_NOT_PLAINTEXT_SPOOL_87382';
  const s=new ResultSpool('dev-one',token,'wss://example.test/ws');
  assert.equal(await s.save(id,'run_command',{content:[{type:'text',text:secret}]}),true);
  const files=await readdir(path.join(dir,'result-spool'));
  assert.equal(files.length,1);
  assert.ok(!files[0].includes(id));
  const bytes=await readFile(path.join(dir,'result-spool',files[0]),'utf8');
  assert.equal(bytes.includes(secret),false);
  assert.equal(bytes.includes(token),false);
  const restored=new ResultSpool('dev-one',token,'wss://example.test/ws');
  assert.deepEqual(await restored.ids(),[id]);
  assert.equal((await restored.get(id)).result.content[0].text,secret);
  const child=spawnSync(process.execPath,['--input-type=module','-e',
   'import {ResultSpool} from '+JSON.stringify(new URL('../dist/transport/result-spool.js',import.meta.url).href)+';'+
   'const s=new ResultSpool("dev-one",'+JSON.stringify(token)+',"wss://example.test/ws");'+
   'process.stdout.write((await s.get('+JSON.stringify(id)+')).result.content[0].text);'],
   {encoding:'utf8',env:{...process.env},timeout:15000});
  assert.equal(child.status,0,child.stderr);
  assert.equal(child.stdout,secret);
  assert.equal(await restored.ack(id),true);
  assert.deepEqual(await restored.ids(),[]);
  assert.equal(await restored.get(id),null);
 });
});
test('wrong pairing token or different relay origin cannot decrypt old spool',async()=>{
 await fixture(async()=>{
  const id=randomUUID(),s=new ResultSpool('device',token,'wss://original/ws');
  assert.equal(await s.save(id,'edit_block',{content:[{type:'text',text:'secret'}]}),true);
  assert.equal(await new ResultSpool('device','rotated-token','wss://original/ws').get(id),null);
  assert.equal(await new ResultSpool('device',token,'wss://other/ws').get(id),null);
 });
});
test('no automatic spool when opt-out, invalid IDs or oversized results',async()=>{
 await fixture(async()=>{
  const s=new ResultSpool('device',token,'wss://original/ws');
  assert.equal(await s.save('not-uuid','write_file',{content:[{type:'text',text:'hi'}]}),false);
  assert.equal(await s.save(randomUUID(),'run_command',{content:[{type:'text',text:'x'.repeat(520000)}]}),false);
  const old=process.env.BRC_DURABLE_AGENT_SPOOL;
  process.env.BRC_DURABLE_AGENT_SPOOL='0';
  assert.equal(await s.save(randomUUID(),'edit_block',{content:[{type:'text',text:'disabled'}]}),false);
  if(old===undefined)delete process.env.BRC_DURABLE_AGENT_SPOOL;else process.env.BRC_DURABLE_AGENT_SPOOL=old;
  assert.equal(s.status().automaticExecutionRetry,false);
  assert.equal(s.status().maxResultBytes,500*1024);
 });
});
