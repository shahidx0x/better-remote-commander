import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-search-source-'));
process.env.BRC_HOME=path.join(root,'agent-home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const {hydrateSearchSources}=await import('../dist/runtime/search-source-context.js');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:80});});
test('blocking content search automatically returns a fresh, bounded source snippet and exact file SHA-256',async()=>{
 const content='// intro\nexport function importantSymbol() {\n  return 42;\n}\n';
 const file=path.join(root,'module.ts');
 await fs.writeFile(file,content);
 const r=await callTool('start_search',{path:root,pattern:'importantSymbol',
  searchType:'content',wait:true,maxResults:10,literalSearch:true,contextLines:0});
 assert.notEqual(r.isError,true,JSON.stringify(r));
 const source=r.structuredContent.sourceContext;
 assert.equal(source.files.length,1,JSON.stringify(source));
 assert.equal(source.files[0].sourceSha256,sha256(content));
 assert.ok(source.files[0].text.includes('return 42'));
 assert.match(r.content[0].text,/FRESH SOURCE SNIPPETS/);
 assert.equal(source.files[0].status,'fresh');
});
test('explicit search source opt-out preserves lightweight bounded result',async()=>{
 const r=await callTool('start_search',{path:root,pattern:'importantSymbol',
  searchType:'content',wait:true,maxResults:10,literalSearch:true,includeSource:false});
 assert.notEqual(r.isError,true,JSON.stringify(r));
 assert.equal(r.structuredContent.sourceContext,undefined);
 assert.doesNotMatch(r.content[0].text,/FRESH SOURCE SNIPPETS/);
});
test('source hydration refuses oversized files without leaking whole source text',async()=>{
 const p=path.join(root,'large-file.py');
 await fs.writeFile(p,'needle\n'+'a'.repeat(540000));
 const sources=await hydrateSearchSources(root,[{type:'content',file:'large-file.py',line:1}]);
 assert.equal(sources.files[0].status,'too_large');
 assert.equal(sources.files[0].sourceSha256,undefined);
 assert.equal(sources.files[0].text,undefined);
});
