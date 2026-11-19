import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const home=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-managed-plugin-'));
process.env.BRC_HOME=path.join(home,'config');
await fs.mkdir(process.env.BRC_HOME,{recursive:true});
const {definePlugin}=await import('../dist/plugins/manager.js');
const {patchPlugin}=await import('../dist/plugins/store.js');
const {getPluginTools,callPluginTool,stopPlugin,stopAllPlugins}=await import('../dist/plugins/host.js');
const {managedChildStatus}=await import('../dist/runtime/process-termination.js');
const {attachManagedStdio}=await import('../dist/plugins/managed-stdio.js');
const {configManager}=await import('../dist/core/config-manager.js');
after(async()=>{
 await stopAllPlugins();
 await configManager.close();
 await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

test('SDK adapter fails closed if a future version stops exposing its child handle',async()=>{
 let closed=false;
 const fake={start:async()=>{},close:async()=>{closed=true;}};
 const owned=attachManagedStdio(fake);
 await assert.rejects(fake.start(),/PLUGIN_PROCESS_UNOBSERVABLE/);
 assert.equal(closed,true);
 assert.equal(owned.pid(),null);
 assert.equal(owned.stop(),false);
});

test('real MCP plugin server and descendant terminate on explicit stop',async t=>{
 if(process.platform!=='win32'){t.skip('Windows /T process-tree verification');return;}
 const id='owned-plugin-fixture';
 const script=path.resolve('packages/agent/test/fixtures/managed-mcp.mjs');
 await definePlugin({
  id,name:'Owned MCP fixture',
  source:{type:'command',command:process.execPath,args:[script]},
  env:{},enabled:true,origin:'user'
 });
 await patchPlugin(id,{status:'installed'});
 const start=managedChildStatus();
 let descendantPid,stopped=false;
 try{
  const tools=await getPluginTools(id,true);
  assert.ok(tools.some(x=>x.name==='descendant_pid'));
  const res=await callPluginTool(id,'descendant_pid',{});
  descendantPid=Number(res.content.find(x=>x.type==='text')?.text);
  assert.ok(Number.isSafeInteger(descendantPid)&&descendantPid>0);
  assert.equal(managedChildStatus().active,start.active+1);
  await stopPlugin(id);
  stopped=true;
  let live=true;
  for(let i=0;i<40;i++){
   try{process.kill(descendantPid,0);}
   catch{live=false;break;}
   await delay(100);
  }
  assert.equal(live,false,'MCP SDK plugin left its descendant running');
  assert.equal(managedChildStatus().active,start.active);
 }finally{
  if(!stopped)await stopPlugin(id);
  if(descendantPid){
   try{process.kill(descendantPid,0);
    // Fixture only: kill the child if a test failure left it behind.
    process.kill(descendantPid,'SIGKILL');
   }catch{}
  }
 }
});

test('stopping a plugin during MCP handshake cancels startup and cleans descendants',async t=>{
 if(process.platform!=='win32'){t.skip('Windows /T process-tree verification');return;}
 const id='owned-plugin-slow-handshake';
 const script=path.resolve('packages/agent/test/fixtures/managed-mcp.mjs');
 const pidFile=path.join(home,'handshake-descendant.pid');
 await definePlugin({
   id,name:'Slow MCP handshake fixture',
   source:{type:'command',command:process.execPath,args:[script]},
   env:{PLUGIN_FIXTURE_START_DELAY_MS:'8000',
        PLUGIN_FIXTURE_CHILD_PID_PATH:pidFile},
   enabled:true,origin:'user'
 });
 await patchPlugin(id,{status:'installed'});
 const pending=getPluginTools(id,true);
 const observed=pending.then(()=>null,e=>e);
 let descendantPid;
 try{
  for(let i=0;i<100;i++){
   try{descendantPid=Number(await fs.readFile(pidFile,'utf8'));break;}
   catch{await delay(40);}
  }
  assert.ok(Number.isSafeInteger(descendantPid)&&descendantPid>0,
    'fixture failed to spawn before delayed handshake');
  await stopPlugin(id);
  const error=await observed;
  assert.ok(error instanceof Error,'starting plugin unexpectedly completed after stop');
  assert.match(error.message,/PLUGIN_START_CANCELLED|cancel|closed|aborted/i);
  let alive=true;
  for(let i=0;i<35;i++){
    try{process.kill(descendantPid,0);}
    catch{alive=false;break;}
    await delay(100);
  }
  assert.equal(alive,false,'cancelled plugin left a descendant running');
 }finally{
  await stopPlugin(id);
  if(descendantPid){try{process.kill(descendantPid,'SIGKILL');}catch{}}
  await observed;
 }
});
