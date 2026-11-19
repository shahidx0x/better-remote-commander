// Tested features must work after a normal agent restart WITHOUT .env flags.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-features-default-'));
const project=path.join(temp,'project');
await fs.mkdir(project);
process.env.BRC_HOME=path.join(temp,'agent');
const keys=[
 'BRC_SHARED_PROJECT_MANIFEST','BRC_SHARED_CPU_BUDGET','BRC_SHARED_IO_BUDGET',
 'BRC_SHARED_PROCESS_START_BUDGET','BRC_RESULT_TEXT_MODE','BRC_TS_SEMANTIC',
 'BRC_WORKER_PLAN_PERSIST','BRC_OPERATION_RECEIPTS','BRC_COMMAND_ENV_POLICY',
 'BRC_COMMAND_ENV_ALLOW','BRC_REQUIRE_SOURCE_HASH','BRC_JOB_OUTPUT_SPILL',
 'BRC_CALL_OUTCOME_RECEIPTS','BRC_SPILL_VERIFICATION_CACHE'
];
const original=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
for(const k of keys)delete process.env[k];
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[project]);
const {callTool}=await import('../dist/dispatcher.js');
const {sharedManifestEnabled}=await import('../dist/runtime/project-manifest.js');
const {commandCpuAdmission,searchIoAdmission,pluginStartupAdmission}=
 await import('../dist/runtime/resource-admission.js');
const {resultPresentationMode}=await import('../dist/runtime/result-presentation.js');
const {semanticEnabled}=await import('../dist/runtime/semantic-ts-host.js');
const {workerPlanCheckpointsEnabled}=await import('../dist/runtime/worker-plan-checkpoints.js');
const {mutationReceiptsEnabled}=await import('../dist/runtime/operation-receipts.js');
const {sourceObservationMode}=await import('../dist/runtime/source-observations.js');
const {commandEnvironmentPolicy,commandEnvironment}=await import('../dist/runtime/command-environment.js');
const {spillEnabled,spillVerificationStatus}=await import('../dist/runtime/job-output-spill.js');
const {callOutcomesEnabled}=await import('../dist/runtime/call-outcomes.js');
after(async()=>{
 for(const [k,v]of Object.entries(original)){if(v===undefined)delete process.env[k];else process.env[k]=v;}
 await configManager.close();
 await fs.rm(temp,{recursive:true,force:true,maxRetries:7,retryDelay:70});
});
const ok=r=>assert.notEqual(r.isError,true,JSON.stringify(r.structuredContent?.error));
test('all bounded features are enabled with no environment file or flags',()=>{
 assert.equal(sharedManifestEnabled(),true);
 assert.equal(commandCpuAdmission.status().enabled,true);
 assert.equal(searchIoAdmission.status().enabled,true);
 assert.equal(pluginStartupAdmission.status().enabled,true);
 assert.equal(resultPresentationMode(),'compact');
 assert.equal(semanticEnabled(),true);
 assert.equal(workerPlanCheckpointsEnabled(),true);
 assert.equal(mutationReceiptsEnabled(),true);
 assert.equal(callOutcomesEnabled(),true);
 assert.equal(spillVerificationStatus().enabled,true);
 assert.equal(sourceObservationMode(),'auto');
 assert.equal(commandEnvironmentPolicy(),'isolated');
 // Job log retention is the exception: even redacted stdout can contain
 // arbitrary private data, so it still requires explicit authorization.
 assert.equal(spillEnabled(),false);
});
test('isolation keeps MONGODB_URI when present but not ambient relay/API keys',()=>{
 const env=commandEnvironment({
  PATH:'fixture-bin',
  SystemRoot:'C:\\Windows',
  MONGODB_URI:'mongodb://local-only/fixture',
  BRC_RELAY_TOKEN:'should-not-inherit',
  OPENAI_API_KEY:'should-not-inherit'
 });
 assert.equal(env.MONGODB_URI,'mongodb://local-only/fixture');
 assert.equal(env.BRC_RELAY_TOKEN,undefined);
 assert.equal(env.OPENAI_API_KEY,undefined);
 assert.equal(env.PATH,'fixture-bin');
});
test('automatic source preconditions keep ordinary writes and exact edits working',async()=>{
 const file=path.join(project,'existing.ts');
 await fs.writeFile(file,'export const phaseZero = 1;\n');
 ok(await callTool('write_file',{path:file,content:'export const phaseZero = 2;\n',mode:'rewrite'}));
 assert.equal(await fs.readFile(file,'utf8'),'export const phaseZero = 2;\n');
 ok(await callTool('edit_block',{file_path:file,old_string:'phaseZero = 2',new_string:'phaseZero = 3'}));
 assert.match(await fs.readFile(file,'utf8'),/phaseZero = 3/);
 const newFile=path.join(project,'new.ts');
 ok(await callTool('write_file',{path:newFile,content:'export const newOne = 1;\n',mode:'rewrite'}));
});
test('explicit 0 overrides defaults and 1 restores each tested feature',()=>{
 const flags=[
 ['BRC_SHARED_PROJECT_MANIFEST',sharedManifestEnabled],
 ['BRC_SHARED_CPU_BUDGET',()=>commandCpuAdmission.status().enabled],
 ['BRC_SHARED_IO_BUDGET',()=>searchIoAdmission.status().enabled],
 ['BRC_SHARED_PROCESS_START_BUDGET',()=>pluginStartupAdmission.status().enabled],
 ['BRC_TS_SEMANTIC',semanticEnabled],
 ['BRC_WORKER_PLAN_PERSIST',workerPlanCheckpointsEnabled],
 ['BRC_OPERATION_RECEIPTS',mutationReceiptsEnabled],
 ['BRC_CALL_OUTCOME_RECEIPTS',callOutcomesEnabled],
 ['BRC_SPILL_VERIFICATION_CACHE',()=>spillVerificationStatus().enabled]
 ];
 for(const [name,get]of flags){
  process.env[name]='0';assert.equal(get(),false,name);
  process.env[name]='1';assert.equal(get(),true,name);
  delete process.env[name];
 }
 process.env.BRC_RESULT_TEXT_MODE='legacy';
 assert.equal(resultPresentationMode(),'legacy');
 delete process.env.BRC_RESULT_TEXT_MODE;
 process.env.BRC_COMMAND_ENV_POLICY='compat';
 assert.equal(commandEnvironmentPolicy(),'compat');
 delete process.env.BRC_COMMAND_ENV_POLICY;
 process.env.BRC_REQUIRE_SOURCE_HASH='1';
 assert.equal(sourceObservationMode(),'strict');
 process.env.BRC_REQUIRE_SOURCE_HASH='0';
 assert.equal(sourceObservationMode(),'off');
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
});
