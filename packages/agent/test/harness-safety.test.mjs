// Regression tests for plugin secrets and filesystem-policy failures.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,realpathSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-harness-safety-'));
process.env.BRC_HOME=path.join(root,'brc');
await fs.mkdir(process.env.BRC_HOME,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
const {validatePath}=await import('../dist/core/tools/filesystem.js');
const {pluginEnvironment}=await import('../dist/plugins/plugin-environment.js');
const {resolveLaunch}=await import('../dist/plugins/host.js');

after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:4,retryDelay:80});});

test('plugin subprocess inherits only OS runtime variables and explicitly granted credentials',()=>{
 const env=pluginEnvironment({
   PATH:'C:\\Windows\\System32',SystemRoot:'C:\\Windows',TEMP:'C:\\Temp',
   BRC_RELAY_TOKEN:'private-relay-token',OPENAI_API_KEY:'private-api-key',
   AWS_SECRET_ACCESS_KEY:'private-aws',NODE_OPTIONS:'--require secret',
   HOME:'/tmp/user',CUSTOM_TOKEN:'other-key',
 },{
   PLUGIN_API_KEY:'explicit-secret',CUSTOM_PLUGIN_MODE:'safe'
 });
 assert.equal(env.PATH,'C:\\Windows\\System32');
 assert.equal(env.SystemRoot,'C:\\Windows');
 assert.equal(env.PLUGIN_API_KEY,'explicit-secret');
 assert.equal(env.CUSTOM_PLUGIN_MODE,'safe');
 for(const key of ['BRC_RELAY_TOKEN','OPENAI_API_KEY','AWS_SECRET_ACCESS_KEY','NODE_OPTIONS','CUSTOM_TOKEN'])
   assert.equal(env[key],undefined,key);
});

test('launch spec preserves explicitly configured plugin environment',()=>{
 const rec={id:'fixture',name:'Fixture',enabled:true,status:'installed',source:{type:'command',command:process.execPath,args:['-e','']},env:{PLUGIN_MY_KEY:'only-this-plugin'}};
 const launch=resolveLaunch(rec);
 assert.equal(launch.env.PLUGIN_MY_KEY,'only-this-plugin');
 assert.equal(launch.command,process.execPath);
});

test('failed path-policy load denies rather than grants filesystem access',async()=>{
 const safe=path.join(root,'permitted');
 await fs.mkdir(safe,{recursive:true});
 await configManager.setValue('allowedDirectories',[safe]);
 assert.equal(await validatePath(safe),await fs.realpath(safe));
 const original=configManager.getConfig;
 configManager.getConfig=async()=>{throw new Error('simulated config read failure');};
 try{
   await assert.rejects(validatePath(safe),/PATH_POLICY_UNAVAILABLE/);
   await assert.rejects(validatePath(path.join(root,'other')),/PATH_POLICY_UNAVAILABLE/);
 }finally{configManager.getConfig=original;}
});

test('plugin stderr rotates at 512 KiB and retains recent diagnostics',async()=>{
 const {cappedPluginStderr}=await import('../dist/plugins/capped-stderr.js');
 const logfile=path.join(root,'test-plugin.log');
 const sink=cappedPluginStderr(logfile);
 for(let i=0;i<20;i++){
   await new Promise((resolve,reject)=>{
     sink.write(Buffer.from('x'.repeat(80*1024-8)+'\nmarker '+i+'\n'),err=>err?reject(err):resolve());
   });
 }
 await new Promise(resolve=>sink.end(resolve));
 const stat=await fs.stat(logfile);
 assert.ok(stat.size<=512*1024,'plugin stderr exceeded cap: '+stat.size);
 const tail=await fs.readFile(logfile,'utf8');
 assert.match(tail,/marker 19/);
 assert.doesNotMatch(tail,/marker 0/);
});

test('plugin crash after a mutation is reported as uncertain and never auto-replayed',async()=>{
 const {definePlugin}=await import('../dist/plugins/manager.js');
 const {patchPlugin}=await import('../dist/plugins/store.js');
 const {getPluginTools,callPluginTool,stopAllPlugins}=await import('../dist/plugins/host.js');
 const fixture=path.resolve('packages/agent/test/fixtures/crashing-mcp.mjs');
 const countFile=path.join(root,'plugin-mutation-count.txt');
 const id='mutation-crash-fixture';
 await definePlugin({id,name:'Mutating crash fixture',source:{type:'command',command:process.execPath,args:[fixture]},
  env:{PLUGIN_CRASH_COUNT_FILE:countFile},enabled:true,origin:'user'});
 await patchPlugin(id,{status:'installed'});
 try {
   const tools=await getPluginTools(id,true);
   assert.ok(tools.some(t=>t.name==='mutate_and_crash'));
   await assert.rejects(callPluginTool(id,'mutate_and_crash',{}),/PLUGIN_CALL_OUTCOME_UNCERTAIN/);
   await new Promise(resolve=>setTimeout(resolve,70));
   assert.equal((await fs.readFile(countFile,'utf8')).trim().split('\n').length,1);
 }finally{await stopAllPlugins();}
});
