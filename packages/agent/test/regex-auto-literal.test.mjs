import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-regex-repair-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});});
test('malformed implicit regex reruns one bounded search as exact literal text',async()=>{
 const file=path.join(root,'needle.ts');await fs.writeFile(file,'const expression = "foo[bar";\n');
 const r=await callTool('start_search',{path:root,pattern:'foo[bar',searchType:'content',wait:true,maxResults:5,contextLines:0});
 assert.notEqual(r.isError,true,JSON.stringify(r));
 assert.equal(r.structuredContent.autoLiteralFallback,true);
 assert.equal(r.structuredContent.actualSearchMode,'literal');
 assert.match(r.content[0].text,/foo\[bar/);
 assert.match(r.content[0].text,/searched exact literal text/);
});
test('explicit regex mode still reports malformed patterns without changing search semantics',async()=>{
 const r=await callTool('start_search',{path:root,pattern:'foo[bar',searchType:'content',wait:true,literalSearch:false,maxResults:5,contextLines:0});
 assert.equal(r.isError,true,JSON.stringify(r));
 assert.equal(r.structuredContent.error.code,'SEARCH_INVALID_PATTERN');
 assert.equal(r.structuredContent.autoLiteralFallback,undefined);
});
test('valid expressions remain regexes; no literal fallback',async()=>{
 await fs.writeFile(path.join(root,'valid.py'),'fooAbar\n');
 const r=await callTool('start_search',{path:root,pattern:'foo.bar',searchType:'content',wait:true,maxResults:5,contextLines:0});
 assert.notEqual(r.isError,true,JSON.stringify(r));
 assert.equal(r.structuredContent.autoLiteralFallback,undefined);
 assert.match(r.content[0].text,/fooAbar/);
});
