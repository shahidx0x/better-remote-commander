import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-tool-error-recovery-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
const {callTool}=await import('../dist/dispatcher.js');
const {failureReason}=await import('../dist/runtime/failure-log.js');
await configManager.setValue('allowedDirectories',[root]);
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:75});});

test('read_code_file missing files give specific error, allowed parent and bounded suggestions',async()=>{
 const file=path.join(root,'missing.ts');
 const out=await callTool('read_code_file',{path:file});
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.error.code,'ENOENT');
 assert.equal(out.structuredContent.pathRecovery?.automaticCreation,false);
 assert.equal(out.structuredContent.pathRecovery?.nearestExistingDirectory,root);
 assert.equal((await fs.readdir(root)).includes('missing.ts'),false);
});

test('read_code_file on a directory reports a classified failure, never generic TOOL_FAILED',async()=>{
 const out=await callTool('read_code_file',{path:root});
 assert.equal(out.isError,true);
 assert.notEqual(out.structuredContent?.error?.code,'TOOL_FAILED');
 assert.match(out.content[0].text,/file|directory|source/i);
});

test('list_directory on a file fails with a precise type error',async()=>{
 const file=path.join(root,'single.ts');await fs.writeFile(file,'export const x=1;\n');
 const out=await callTool('list_directory',{path:file,depth:1});
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.error.code,'NOT_DIRECTORY');
});

test('invalid interact_with_process arguments produce a structured error without sending input',async()=>{
 const out=await callTool('interact_with_process',{pid:'invalid',input:'print("hi")'});
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.error.code,'INVALID_ARGUMENT');
 assert.equal(out.structuredContent.commandExecuted,false);
 assert.match(out.structuredContent.recovery.suggestion,/PID/);
});

test('failure-only diagnostic mapping provides actionable reasons without tool arguments',()=>{
 for(const [tool,code] of [
   ['read_code_file','CODE_SNAPSHOT_FAILED'],
   ['list_directory','DIRECTORY_LIST_FAILED'],
   ['project_map','PROJECT_MAP_FAILED'],
   ['call_plugin_tool','PLUGIN_TOOL_REPORTED_ERROR'],
   ['interact_with_process','PROCESS_INTERACTION_FAILED'],
   ['run_command','TIMEOUT']
 ]){
   const reason=failureReason(tool,code);
   assert.ok(reason.length>30,tool+':'+code);
   assert.doesNotMatch(reason,/tool failed; inspect its structured error/i);
 }
});
