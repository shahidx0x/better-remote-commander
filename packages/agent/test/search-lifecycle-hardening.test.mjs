// Search lifecycle regressions: isolated temporary files, never the user's project.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-search-lifecycle-'));
const root=path.join(temp,'project');
process.env.BRC_HOME=path.join(temp,'agent');
process.env.BRC_ERROR_LOG='0';
process.env.BRC_LOG_LEVEL='silent';
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'file.ts'),'export const fixture = "needle";\n');

const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {searchManager}=await import('../dist/core/search-manager.js');
const {clearRipgrepCache}=await import('../dist/core/utils/ripgrep-resolver.js');
const {withCallContext}=await import('../dist/context.js');
const text=r=>r.content.map(c=>c.text??'').join('\n');

after(async()=>{
  delete process.env.BRC_RG_PATH;
  clearRipgrepCache();
  for(const s of searchManager.listSearchSessions())searchManager.terminateSearch(s.id);
  await configManager.close();
  await fs.rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:90});
});

test('bad ripgrep executable returns a classified startup failure without crashing Node or leaking slots',async()=>{
  const fake=path.join(root,process.platform==='win32'?'bad-ripgrep.exe':'bad-ripgrep');
  await fs.writeFile(fake,'not an executable');
  const old=process.env.BRC_RG_PATH;
  process.env.BRC_RG_PATH=fake;
  clearRipgrepCache();
  try{
    const failed=await callTool('start_search',{path:root,pattern:'needle',
      searchType:'content',wait:true,maxResults:10,timeout_ms:1000});
    assert.equal(failed.isError,true,text(failed));
    assert.equal(failed.structuredContent?.error?.code,'SEARCH_START_FAILED',text(failed));
    assert.equal(searchManager.getActiveSessionCount(),0);
    await new Promise(resolve=>setTimeout(resolve,55));
    // Unhandled ChildProcess error would crash the test process before this.
    assert.equal(searchManager.getActiveSessionCount(),0);
  }finally{
    if(old===undefined)delete process.env.BRC_RG_PATH;
    else process.env.BRC_RG_PATH=old;
    clearRipgrepCache();
  }
  const good=await callTool('start_search',{path:root,pattern:'needle',
    searchType:'content',wait:true,maxResults:10,timeout_ms:3000});
  assert.notEqual(good.isError,true,text(good));
  assert.match(text(good),/needle/);
});

test('cancelled blocking search always terminates its session before returning CANCELLED',async()=>{
  const actualRead=searchManager.readSearchResults;
  const actualWait=searchManager.waitForActivity;
  const actualStop=searchManager.releaseSearch;
  const controller=new AbortController();
  let forced=false,waitCalls=0,stopped=0;
  try{
    searchManager.readSearchResults=function(id,offset,length){
      const info=actualRead.call(this,id,offset,length);
      if(!forced){
        forced=true;
        // Deterministically force the blocking wait path even if this tiny
        // fixture finished in the same event-loop turn.
        return {...info,isComplete:false,totalMatches:0};
      }
      return info;
    };
    searchManager.waitForActivity=async function(){
      waitCalls++;
      controller.abort(new DOMException('Cancelled by test','AbortError'));
    };
    searchManager.releaseSearch=function(id){
      stopped++;
      return actualStop.call(this,id);
    };
    const result=await withCallContext({
      id:'cancel-search-lifecycle',remote:false,client:null,signal:controller.signal
    },()=>callTool('start_search',{path:root,pattern:'needle',
      searchType:'content',wait:true,timeout_ms:1500,maxResults:10}));
    assert.equal(result.isError,true,text(result));
    assert.equal(result.structuredContent?.error?.code,'CANCELLED',text(result));
    assert.ok(waitCalls>=1,'must reach blocking wait');
    assert.ok(stopped>=1,'must release the cancelled search subscription');
    await new Promise(resolve=>setTimeout(resolve,65));
    assert.equal(searchManager.getActiveSessionCount(),0,'last subscriber cancellation stops the ripgrep worker');
  }finally{
    searchManager.readSearchResults=actualRead;
    searchManager.waitForActivity=actualWait;
    searchManager.releaseSearch=actualStop;
  }
});

test('missing read_code_file gives safe next action without creating files',async()=>{
  const missing=path.join(root,'does-not-exist.ts');
  const failed=await callTool('read_code_file',{path:missing});
  assert.equal(failed.isError,true,text(failed));
  assert.equal(failed.structuredContent?.error?.code,'ENOENT');
  assert.match(failed.structuredContent?.recovery?.suggestion??'',/list_directory|start_search/);
  await assert.rejects(fs.stat(missing),{code:'ENOENT'});
});
