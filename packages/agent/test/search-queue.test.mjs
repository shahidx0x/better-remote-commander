import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { mkdtempSync, realpathSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-search-queue-'));
const root=path.join(temp,'project');
process.env.BRC_HOME=path.join(temp,'agent');
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'sample.ts'),'needle one\nneedle two\n');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {SearchManager}=await import('../dist/core/search-manager.js');
const {withCallContext}=await import('../dist/context.js');

after(async()=>{
  await configManager.close();
  await fs.rm(temp,{recursive:true,force:true,maxRetries:5,retryDelay:120});
});

const args={rootPath:root,pattern:'needle',searchType:'content',
  maxResults:4,contextLines:0,timeout:6000,skipInitialWait:true};

test('bursts wait in a FIFO queue rather than getting SEARCH_BUSY at two workers',async()=>{
  const manager=new SearchManager();
  // Synthetic occupied slots make the scheduler deterministic without
  // launching CPU-intensive recursive searches in a test.
  manager.sessions.set('occupied-a',{isComplete:false});
  manager.sessions.set('occupied-b',{isComplete:false});
  const one=manager.startSearch(args);
  const two=manager.startSearch({...args,pattern:'two'});
  await new Promise(resolve=>setTimeout(resolve,45));
  assert.equal(manager.slotWaiters.length,2);
  assert.equal(manager.getActiveSessionCount(),2);
  assert.equal(manager.pendingStarts,0);
  manager.sessions.delete('occupied-a');
  manager.grantSearchSlots();
  const startedOne=await one;
  assert.ok(startedOne.sessionId.startsWith('search_'));
  assert.equal(manager.getActiveSessionCount()+manager.pendingStarts<=2,true);
  // The first real search will close and release the slot for the second.
  const startedTwo=await Promise.race([
    two,new Promise((_,reject)=>setTimeout(()=>reject(new Error('queue did not drain')),3500)),
  ]);
  assert.ok(startedTwo.sessionId.startsWith('search_'));
  assert.notEqual(startedOne.sessionId,startedTwo.sessionId);
  manager.sessions.delete('occupied-b');
  const ready=manager.readSearchResults(startedOne.sessionId,0,40);
  assert.ok(ready.results.length>=1);
});

test('cancelling an awaiting request removes the waiter without claiming success',async()=>{
  const manager=new SearchManager();
  manager.sessions.set('busy1',{isComplete:false});
  manager.sessions.set('busy2',{isComplete:false});
  const controller=new AbortController();
  const pending=withCallContext({id:'queued-search-test',client:null,remote:false,
    signal:controller.signal},()=>manager.startSearch(args));
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(manager.slotWaiters.length,1);
  controller.abort();
  await assert.rejects(pending,/SEARCH_CANCELLED/);
  assert.equal(manager.slotWaiters.length,0);
  assert.equal(manager.pendingStarts,0);
});

test('queued searches never spawn more than the configured two workers',async()=>{
  const manager=new SearchManager();
  manager.sessions.set('occupied1',{isComplete:false});
  manager.sessions.set('occupied2',{isComplete:false});
  const pending=Array.from({length:6},(_,i)=>
    manager.startSearch({...args,pattern:i%2?'two':'needle'}));
  await new Promise(resolve=>setTimeout(resolve,25));
  assert.equal(manager.slotWaiters.length,6);
  assert.equal(manager.getActiveSessionCount(),2);
  manager.sessions.delete('occupied1');
  manager.sessions.delete('occupied2');
  manager.grantSearchSlots();
  const sessions=await Promise.all(pending);
  assert.equal(sessions.length,6);
  assert.equal(new Set(sessions.map(s=>s.sessionId)).size,6);
  assert.ok(manager.getActiveSessionCount()<=2);
});
