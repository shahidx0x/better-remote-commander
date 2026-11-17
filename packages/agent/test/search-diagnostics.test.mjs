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
await fs.mkdir(root,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {searchManager}=await import('../dist/core/search-manager.js');
const {searchErrorCode}=await import('../dist/runtime/search-diagnostics.js');
const txt=r=>r.content.map(c=>c.text??'').join('\n');
after(async()=>{for(const s of searchManager.listSearchSessions())searchManager.terminateSearch(s.id);
  await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100});});

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

test('invalid regex is SEARCH_INVALID_PATTERN, not opaque TOOL_FAILED',async()=>{
 const secret='search_privacy_secret_3481';
 const r=await callTool('start_search',{path:root,pattern:'['+secret,searchType:'content',wait:true,maxResults:10});
 assert.equal(r.isError,true);
 assert.equal(r.structuredContent.error.code,'SEARCH_INVALID_PATTERN',txt(r));
 assert.match(r.structuredContent.recovery.suggestion,/literalSearch:true/);
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

