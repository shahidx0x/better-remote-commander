import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-argv-reliability-'));
process.env.BRC_HOME=path.join(root,'agent-home');
const project=path.join(root,'project with spaces');
await fs.mkdir(project,{recursive:true});
const script=path.join(project,'argv check.js');
await fs.writeFile(script,'console.log(process.argv.slice(2).join("|"));\n');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {withCallContext}=await import('../dist/context.js');
const txt=r=>(r.content??[]).filter(x=>x.type==='text').map(x=>x.text).join('\n');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:80});});
test('run_command native argv passes spaces, shell metacharacters and quotes literally',async()=>{
 const sent=['hello world','one && two','space & pipe | still data','quoted "string"'];
 const out=await callTool('run_command',{program:process.execPath,args:[script,...sent],cwd:project,raw:true,timeout_ms:12000});
 assert.notEqual(out.isError,true,txt(out));
 assert.equal(out.structuredContent.invocation,'argv');
 assert.equal(out.structuredContent.resolvedProgram,path.resolve(process.execPath));
 assert.ok(txt(out).includes(sent.join('|')),txt(out));
});
test('remote managed run_command carries direct program/args intact',async()=>{
 const out=await withCallContext({id:'test-remote-argv-0001',client:null,remote:true},()=>
  callTool('run_command',{program:process.execPath,args:['-e','console.log("direct-remote")'],cwd:project,raw:true,timeout_ms:12000}));
 assert.notEqual(out.isError,true,txt(out));
 assert.equal(out.structuredContent.exitCode,0);
 assert.equal(out.structuredContent.invocation,'argv');
 assert.match(txt(out),/direct-remote/);
});
test('program and command are mutually exclusive; direct program forbids a shell',async()=>{
 for(const args of [
  {command:'node -v',program:process.execPath},
  {program:process.execPath,shell:'cmd.exe'},
  {args:['-v']}
 ]){
  const out=await callTool('run_command',args);
  assert.equal(out.isError,true,txt(out));
  assert.equal(out.structuredContent.error.code,'INVALID_ARGUMENT');
 }
});
test('missing native executable never falls back to a shell or executes its arguments',async()=>{
 const blocked=path.join(project,'must-not-exist.txt');
 const out=await callTool('run_command',{program:'brc_not_installed_tool_v1000',args:['-e',`require('fs').writeFileSync('${blocked.replaceAll('\\','\\\\')}','bad')`],cwd:project});
 assert.equal(out.isError,true,txt(out));
 assert.equal(out.structuredContent.error.code,'PROGRAM_NOT_FOUND');
 await assert.rejects(fs.stat(blocked),/ENOENT/);
});
test('blockedCommands checks the real native executable basename, not just the displayed path',async()=>{
 const before=(await configManager.getConfig()).blockedCommands;
 const blocked=path.join(project,'blocked-native.txt');
 try{
  await configManager.setValue('blockedCommands',['node']);
  const out=await callTool('run_command',{program:process.execPath,args:['-e',
   `require('fs').writeFileSync(${JSON.stringify(blocked)},'should never execute')`],cwd:project});
  assert.equal(out.isError,true,txt(out));
  assert.equal(out.structuredContent.error.code,'COMMAND_BLOCKED');
  await assert.rejects(fs.stat(blocked),/ENOENT/);
 }finally{await configManager.setValue('blockedCommands',before??[]);}
});
test('classified nonzero commands preserve stdout/stderr and precise compiler diagnostics',async()=>{
 const out=await callTool('run_command',{program:process.execPath,args:['-e',
  'console.error("src/example.ts(12): error TS2307: Cannot find module");process.exit(1)'],cwd:project,raw:true});
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.error.code,'COMMAND_FAILED');
 assert.equal(out.structuredContent.exitCode,1);
 assert.equal(out.structuredContent.commandFailureKind,'TYPECHECK_ERROR');
 assert.match(txt(out),/TS2307/);
 assert.match(out.structuredContent.recovery.suggestion,/typecheck/);
});
test('failed direct program preserves real process exit code and failure classification',async()=>{
 const out=await callTool('run_command',{program:process.execPath,args:['-e','process.exit(9)'],cwd:project,raw:true});
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.exitCode,9);
 assert.equal(out.structuredContent.error.code,'COMMAND_FAILED');
 assert.equal(out.structuredContent.invocation,'argv');
});
