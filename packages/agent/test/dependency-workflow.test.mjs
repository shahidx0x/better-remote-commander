import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-dependent-jobs-'));
const root=path.join(temp,'project');
process.env.BRC_HOME=path.join(temp,'home');
await fs.mkdir(root,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
after(async()=>{await configManager.close();await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
const p=n=>path.join(root,n);

test('dependency-aware run_parallel applies multiple ordered file operations without racing',async()=>{
 const a=p('step-a.txt'),b=p('step-b.txt');
 const result=await callTool('run_parallel',{timeout_ms:20000,max_concurrency:3,calls:[
  {tool:'write_file',args:{path:a,content:'produced A'},label:'produce A'},
  {tool:'read_file',args:{path:a},depends_on:[0],label:'read A after produce'},
  {tool:'write_file',args:{path:b,content:'produced B'},depends_on:[0],label:'produce B after A'},
  {tool:'read_file',args:{path:b},depends_on:[2],label:'read B after produce B'}
 ]});
 assert.notEqual(result.isError,true,JSON.stringify(result));
 const state=result.structuredContent;
 assert.equal(state.finished,4,JSON.stringify(state));
 assert.deepEqual(state.dependencies,[[],[0],[0],[2]]);
 assert.equal(await fs.readFile(a,'utf8'),'produced A');
 assert.equal(await fs.readFile(b,'utf8'),'produced B');
 for(const id of state.jobIds){
  const job=await callTool('get_job',{id});
  assert.match(job.content[0].text,/SUCCEEDED/);
 }
});
test('failed predecessor skips all dependent mutations without starting them',async()=>{
 const missing=p('no-such-file.txt'),blocked=p('should-not-exist.txt');
 const result=await callTool('run_parallel',{timeout_ms:20000,calls:[
  {tool:'read_file',args:{path:missing}},
  {tool:'write_file',args:{path:blocked,content:'danger'},depends_on:[0]},
  {tool:'write_file',args:{path:p('second-blocked.txt'),content:'danger2'},depends_on:[1]}
 ]});
 const state=result.structuredContent;
 assert.equal(state.finished,3,JSON.stringify(state));
 const job2=await callTool('get_job',{id:state.jobIds[1]});
 assert.match(job2.content[0].text,/DEPENDENCY_FAILED/);
 const job3=await callTool('get_job',{id:state.jobIds[2]});
 assert.match(job3.content[0].text,/DEPENDENCY_FAILED/);
 await assert.rejects(fs.stat(blocked),/ENOENT/);
 await assert.rejects(fs.stat(p('second-blocked.txt')),/ENOENT/);
});
test('invalid dependencies are rejected before any task is created or any file is written',async()=>{
 const dest=p('invalid-should-not-exist.txt');
 for(const depends of [[0],[1],[1,1]]){
  const out=await callTool('run_parallel',{calls:[
   {tool:'write_file',args:{path:dest,content:'unexpected'},depends_on:depends},
   {tool:'read_file',args:{path:dest}}
  ]});
  assert.equal(out.isError,true);
  assert.equal(out.structuredContent.error.code,'INVALID_DEPENDENCY');
 }
 await assert.rejects(fs.stat(dest),/ENOENT/);
});
