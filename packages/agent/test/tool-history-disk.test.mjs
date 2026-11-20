import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ToolHistory,MAX_HISTORY_ENTRIES,MAX_STORED_OUTPUT_BYTES,
  MAX_HISTORY_FILE_SIZE_BYTES} from '../dist/core/utils/toolHistory.js';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-jsonl-history-'));
const home=(id)=>path.join(scratch,id);
after(async()=>fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:60}));

function output(value,failed=false){
  return {isError:failed,content:[{type:'text',text:value}],
    structuredContent:{exitCode:failed?1:0}};
}
test('history is off until explicitly started and missing files are not created by imports',async()=>{
 const store=new ToolHistory(home('no-start'));
 store.addCall('run_command',{},output('ignored'),3);
 await store.flush();
 assert.equal(store.getStats().persisted,false);
 assert.equal(await fs.stat(store.path).catch(()=>null),null);
});
test('4 KiB preview cap, credential redaction and source omission survive a restart',async()=>{
 const store=new ToolHistory(home('safe-output'));
 await store.start();
 const project='D:/private/project';
 store.addCall('read_file',{path:project+'/customer-records.txt'},
   output('sensitive patient info that should not appear in a persisted log'),11,
   {phase:'OK',callId:'readcall-1234'});
 store.addCall('get_job',{id:'job-safe'},output('Source code with unlabelled private credentials'),13);
 store.addCall('call_plugin_tool',{plugin:'external',tool:'echo'},
   output('Private external response must not persist',true),17);
 store.addCall('run_command',{command:'node -e "SECRET_LITERAL"',cwd:project},
   output('--- stdout ---\npassword=ShouldNeverAppear\nBearer UnsentTokenValue\n'+
    Array.from({length:650},(_,i)=>'build task '+String(i).padStart(4,'0')+' completed\n').join('')),42,
   {phase:'OK',callId:'run-id-1234'});
 await store.flush();
 const raw=await fs.readFile(store.path,'utf8');
 assert.doesNotMatch(raw,/ShouldNeverAppear|UnsentTokenValue|SECRET_LITERAL|sensitive patient info|Source code with unlabelled private credentials|Private external response/);
 const rows=raw.trim().split('\n').map(x=>JSON.parse(x));
 assert.equal(rows.length,4);
 for(const row of rows){
   const preview=row.output.content[0].text;
   assert.ok(Buffer.byteLength(preview,'utf8')<=MAX_STORED_OUTPUT_BYTES);
   assert.deepEqual(Object.keys(row.arguments),['summary']);
 }
 assert.equal((await fs.stat(store.path)).size<=MAX_HISTORY_FILE_SIZE_BYTES,true);
 assert.ok(rows.at(-1).output.content[0].text.includes('history preview clipped to 4 KiB'));
 assert.equal(store.getStats().maxEntries,1000);
 await store.cleanup();
 const {ActivityLog}=await import('../dist/runtime/activity.js');
 const live=new ActivityLog(home('safe-output'),true);
 await live.prune(); // the legacy-log cleanup must not delete new durable history
 assert.ok((await fs.stat(store.path)).size>0);
 await live.close();
 const restarted=new ToolHistory(home('safe-output'));
 await restarted.start();
 const recent=await restarted.getRecentCalls({maxResults:10});
 assert.equal(recent.length,4);
 assert.equal(recent[0].toolName,'read_file');
 assert.equal(recent[1].toolName,'get_job');
 assert.equal(recent[2].toolName,'call_plugin_tool');
 assert.equal(recent[3].toolName,'run_command');
 const formatted=await restarted.getRecentCallsFormatted({maxResults:2,offset:1});
 assert.equal(formatted.length,2);
 assert.equal(formatted[1].toolName,'call_plugin_tool');
 assert.ok(formatted[0].localTime.length>10);
 await restarted.cleanup();
});
test('up to 1,000 most-recent records, <=5 MiB JSONL, and disk paging without an idle RAM cache',async()=>{
 const store=new ToolHistory(home('rolling'));
 await store.start();
 const lots=Array.from({length:500},(_,i)=>
   'compiling component '+String(i).padStart(4,'0')+' outcome OK\n').join('');
 for(let i=0;i<1205;i++){
   store.addCall('run_command',{command:'pnpm test',cwd:'D:/test/fixture'},
     output('--- stdout ---\n'+lots+'\nexit code 0'),i,
     {phase:'OK',callId:'serial-'+i});
   // Keep the pending disk queue below its fixed 32-KiB cap during the test.
   if(i%5===4)await store.flush();
 }
 await store.flush();
 const stats=store.getStats();
 assert.equal(stats.persisted,true);
 assert.equal(stats.maxFileBytes,5*1024*1024);
 assert.equal(stats.maxOutputBytes,4*1024);
 assert.ok(stats.totalEntries<=MAX_HISTORY_ENTRIES,stats.totalEntries);
 assert.ok(stats.totalEntries>=800,stats.totalEntries);
 assert.equal(stats.dropped,0,'the writer should not lose queued calls');
 assert.ok((await fs.stat(store.path)).size<=MAX_HISTORY_FILE_SIZE_BYTES);
 const page=await store.getRecentCalls({maxResults:3,offset:0});
 assert.equal(page.length,3);
 assert.ok(page[2].details.callId.includes('1204'));
 const earlier=await store.getRecentCalls({maxResults:3,offset:3});
 assert.equal(earlier.length,3);
 assert.notEqual(page[0].details.callId,earlier[0].details.callId);
 const file=await fs.readFile(store.path,'utf8');
 const lines=file.trim().split('\n');
 assert.ok(lines.length<=1000,lines.length);
 assert.ok(lines.every(row=>Buffer.byteLength(JSON.parse(row).output.content[0].text)<=4096));
 await store.cleanup();
 const resumed=new ToolHistory(home('rolling'));
 await resumed.start();
 assert.equal(resumed.getStats().totalEntries,stats.totalEntries);
 assert.equal((await resumed.getRecentCalls({maxResults:1}))[0].details.callId,
   page[2].details.callId);
 await resumed.cleanup();
});
test('unsafe symlink or directory history path is refused rather than followed',async()=>{
 const store=new ToolHistory(home('unsafe'));
 await fs.mkdir(path.dirname(store.path),{recursive:true});
 await fs.mkdir(store.path);
 await assert.rejects(()=>store.start(),/regular file/);
});
