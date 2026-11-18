// Agent-only start_search regression: temporary root, no real user files or credentials.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-search-failure-'));
const root=path.join(scratch,'project');
process.env.BRC_HOME=path.join(scratch,'agent');
process.env.BRC_LOG_LEVEL='silent';
process.env.BRC_ERROR_LOG='1';
await fs.mkdir(root,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {searchManager}=await import('../dist/core/search-manager.js');
const {flushToolFailureLogs,failureLogPath}=await import('../dist/runtime/failure-log.js');
const {searchErrorCode}=await import('../dist/runtime/search-diagnostics.js');
const txt=r=>r.content.map(c=>c.text??'').join('\n');
after(async()=>{for(const s of searchManager.listSearchSessions())searchManager.terminateSearch(s.id);
  await flushToolFailureLogs();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

test('valid filename and content searches, including no-match, are successful',async()=>{
 await fs.writeFile(path.join(root,'example.ts'),'needle test\n');
 let r=await callTool('start_search',{path:root,pattern:'example.ts',searchType:'files',wait:true,maxResults:20});
 assert.equal(r.isError,undefined,txt(r));
 assert.match(txt(r),/example.ts/);
 assert.ok(r.structuredContent.sessionId);
 r=await callTool('start_search',{path:root,pattern:'needle',searchType:'content',wait:true,maxResults:20,contextLines:0});
 assert.equal(r.isError,undefined,txt(r));
 assert.match(txt(r),/needle/);
 r=await callTool('start_search',{path:root,pattern:'definitely_missing_zyx',searchType:'content',wait:true,maxResults:20,contextLines:0});
 assert.equal(r.isError,undefined,txt(r));
 assert.match(txt(r),/No matches found/);
});

test('invalid regex is SEARCH_INVALID_PATTERN, not opaque TOOL_FAILED, and logs safe cause',async()=>{
 const secret='search_privacy_secret_3481';
 const r=await callTool('start_search',{path:root,pattern:'['+secret,searchType:'content',wait:true,maxResults:10});
 assert.equal(r.isError,true);
 assert.equal(r.structuredContent.error.code,'SEARCH_INVALID_PATTERN',txt(r));
 assert.match(r.structuredContent.recovery.suggestion,/literalSearch:true/);
 const status=await callTool('agent_status',{});
 assert.ok(status.structuredContent.recentFailures.some(e=>e.tool==='start_search'&&e.code==='SEARCH_INVALID_PATTERN'));
 assert.equal(status.structuredContent.logging.failedToolLog.enabled,true);
 await flushToolFailureLogs();
 const log=await fs.readFile(failureLogPath(),'utf8');
 assert.ok(log.includes('SEARCH_INVALID_PATTERN'),log);
 assert.ok(log.includes('ripgrep rejected the regex'),log);
 assert.ok(!log.includes(secret),'must never write raw regex into diagnostic log');
 assert.ok(!log.includes(root),'must never write project path into diagnostic log');
 assert.ok(!log.includes('needle'),'must never log searched file contents');
});

test('invalid path and search result session have actionable codes',async()=>{
 const invalid=await callTool('start_search',{path:path.join(scratch,'outside-folder'),pattern:'abc',searchType:'files',wait:true});
 assert.equal(invalid.isError,true);
 assert.notEqual(invalid.structuredContent.error.code,'TOOL_FAILED');
 assert.ok(invalid.structuredContent.recovery?.suggestion);
 const missing=await callTool('get_more_search_results',{sessionId:'search_nonexistent_for_test',offset:0,length:20});
 assert.equal(missing.isError,true);
 assert.equal(missing.structuredContent.error.code,'SEARCH_SESSION_NOT_FOUND');
 assert.match(missing.structuredContent.recovery.suggestion,/Start a new search/);
 assert.equal(searchErrorCode('Failed to locate ripgrep binary'),'SEARCH_RIPGREP_UNAVAILABLE');
 assert.equal(searchErrorCode('SEARCH_BUSY: no slots'),'SEARCH_BUSY');
 assert.equal(searchErrorCode('SEARCH_CANCELLED: cancelled while waiting for a free search worker.'),'SEARCH_CANCELLED');
 assert.equal(searchErrorCode('rg: error parsing glob "["'),'SEARCH_INVALID_GLOB');
});

test('large searches have a 48K budget, session ID and correct continuation',async()=>{
 const file=path.join(root,'big.ts');
 await fs.writeFile(file,Array.from({length:900},(_,i)=>'needle'+String(i)+'-'+('Q'.repeat(220))).join('\n')+'\n');
 const r=await callTool('start_search',{path:root,pattern:'needle',searchType:'content',wait:true,maxResults:700,contextLines:0,timeout_ms:25000});
 assert.equal(r.isError,undefined,txt(r));
 assert.ok(txt(r).length<54000,'oversized start_search response '+txt(r).length);
 assert.equal(r.structuredContent.outputTruncated,true);
 assert.equal(r.structuredContent.hasMoreResults,true);
 const next=r.structuredContent.next;
 assert.equal(next.tool,'get_more_search_results');
 assert.ok(next.args.offset>0);
 const further=await callTool('get_more_search_results',{...next.args,length:1000000});
 assert.equal(further.isError,undefined,txt(further));
 assert.ok(txt(further).length<54000,'oversized paged reply '+txt(further).length);
 assert.equal(further.structuredContent.sessionId,next.args.sessionId);
});

test('failed run_command records safe diagnosis and exit code, never the shell command',async()=>{
 const command='node -e "process.exit(7)"';
 const r=await callTool('run_command',{cwd:root,command,raw:true,timeout_ms:10000});
 assert.equal(r.isError,true,txt(r));
 assert.equal(r.structuredContent?.error?.code,'COMMAND_FAILED',txt(r));
 assert.equal(r.structuredContent?.exitCode,7,txt(r));
 await flushToolFailureLogs();
 const lines=(await fs.readFile(failureLogPath(),'utf8')).trim().split('\n').map(s=>JSON.parse(s));
 const last=lines.at(-1);
 assert.equal(last.tool,'run_command');
 assert.equal(last.code,'COMMAND_FAILED');
 assert.equal(last.exitCode,7);
 assert.equal(last.diagnostic,'NONZERO_EXIT');
 assert.ok(!(await fs.readFile(failureLogPath(),'utf8')).includes(command));
});

test('failure logger retains metadata only, is bounded, and can be disabled',async()=>{
 const {recordToolFailure,flushToolFailureLogs}=await import('../dist/runtime/failure-log.js');
 const enabled=process.env.BRC_ERROR_LOG;
 try{
  process.env.BRC_ERROR_LOG='0';
  const previous=await fs.readFile(failureLogPath(),'utf8');
  recordToolFailure({tool:'start_search',code:'SEARCH_FAILED',callId:'ignored',durationMs:1});
  await flushToolFailureLogs();
  assert.equal(await fs.readFile(failureLogPath(),'utf8'),previous);
  process.env.BRC_ERROR_LOG='1';
  // Old versions rotated this backup. Remove it: only the last 100 failures
  // are retained in one file, even across multiple flushes/restarts.
  await fs.writeFile(failureLogPath()+'.previous','legacy-backup');
  for(let i=0;i<3500;i++)recordToolFailure({tool:'start_search',code:'SEARCH_FAILED',callId:String(i),durationMs:i});
  await flushToolFailureLogs();
  let log=await fs.readFile(failureLogPath(),'utf8');
  let rows=log.trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(rows.length,100,'must retain exactly the most recent 100 failures total');
  assert.equal(rows[0].callId,'3400');
  assert.equal(rows.at(-1).callId,'3499');
  assert.equal(await fs.stat(failureLogPath()+'.previous').catch(()=>null),null,'no rotated backup allowed');
  for(let i=3500;i<3575;i++)
   recordToolFailure({tool:'start_search',code:'SEARCH_FAILED',callId:String(i),durationMs:i});
  await flushToolFailureLogs();
  log=await fs.readFile(failureLogPath(),'utf8');
  rows=log.trim().split('\n').map(s=>JSON.parse(s));
  assert.equal(rows.length,100,'retention also applies after a second log flush');
  assert.equal(rows[0].callId,'3475');
  assert.equal(rows.at(-1).callId,'3574');
  assert.ok((await fs.stat(failureLogPath())).size<30000,'metadata log should remain small');
  assert.ok(rows.every(x=>x.reason && !x.args && !x.file_path),'invalid or sensitive JSONL entry');
 }finally{
  if(enabled===undefined)delete process.env.BRC_ERROR_LOG;
  else process.env.BRC_ERROR_LOG=enabled;
 }
});

test('invalid filename glob errors are classified rather than returned as opaque failures',async()=>{
 const r=await callTool('start_search',{path:root,pattern:'[',searchType:'files',wait:true,maxResults:10});
 assert.equal(r.isError,true,txt(r));
 assert.equal(r.structuredContent?.error?.code,'SEARCH_INVALID_GLOB',txt(r));
 assert.match(r.structuredContent.recovery.suggestion,/glob/);
});

test('failure metadata gives safe actionable diagnosis without recording shell content',async()=>{
 const {failureReason}=await import('../dist/runtime/failure-log.js');
 assert.match(failureReason('run_command','COMMAND_FAILED','MODULE_RESOLUTION'),/cwd/);
 assert.match(failureReason('run_command','COMMAND_FAILED','GIT_NOT_REPOSITORY'),/repository/);
 assert.match(failureReason('read_code_file','ENOENT'),/does not exist/);
 assert.match(failureReason('run_command','TIMEOUT'),/start_process/);
});
