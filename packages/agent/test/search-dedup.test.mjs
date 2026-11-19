import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-search-dedup-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {searchManager}=await import('../dist/core/search-manager.js');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});});
test('concurrent identical searches reuse the same ripgrep session and avoid extra worker admission',async()=>{
 const dir=path.join(root,'files');await fs.mkdir(dir);
 await Promise.all(Array.from({length:200},(_,i)=>fs.writeFile(path.join(dir,'entry'+i+'.txt'),'sample word\n'.repeat(20))));
 const opts={rootPath:dir,pattern:'sample word',searchType:'content',maxResults:400,skipInitialWait:true};
 const [a,b,c]=await Promise.all([searchManager.startSearch(opts),searchManager.startSearch(opts),searchManager.startSearch({...opts})]);
 assert.equal(a.sessionId,b.sessionId);
 assert.equal(a.sessionId,c.sessionId);
 assert.ok(searchManager.dedupStatus().coalescedRequests>=2);
 searchManager.terminateSearch(a.sessionId);
});
test('different search patterns never share the same running session',async()=>{
 const dir=path.join(root,'files');
 const opts={rootPath:dir,searchType:'content',maxResults:400,skipInitialWait:true};
 const [a,b]=await Promise.all([
  searchManager.startSearch({...opts,pattern:'sample word'}),
  searchManager.startSearch({...opts,pattern:'unrelated pattern'})
 ]);
 assert.notEqual(a.sessionId,b.sessionId);
 searchManager.terminateSearch(a.sessionId);searchManager.terminateSearch(b.sessionId);
});
