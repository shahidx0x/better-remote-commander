import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import {mkdtempSync,realpathSync} from 'node:fs';

const dir=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-command-env-'));
const project=path.join(dir,'project');
await fs.mkdir(project,{recursive:true});
process.env.BRC_HOME=path.join(dir,'home');
const previous={policy:process.env.BRC_COMMAND_ENV_POLICY,allow:process.env.BRC_COMMAND_ENV_ALLOW,private:process.env.BRC_TEST_PRIVATE};
process.env.BRC_COMMAND_ENV_POLICY='isolated';
process.env.BRC_TEST_PRIVATE='DO_NOT_INHERIT_TEST_SECRET';
delete process.env.BRC_COMMAND_ENV_ALLOW;
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[project]);
const {runProgram}=await import('../dist/runtime/program-runner.js');
const {runCommandCore}=await import('../dist/tools/brc-tools.js');
function restore(k,v){if(v===undefined)delete process.env[k];else process.env[k]=v;}
after(async()=>{
 restore('BRC_COMMAND_ENV_POLICY',previous.policy);
 restore('BRC_COMMAND_ENV_ALLOW',previous.allow);
 restore('BRC_TEST_PRIVATE',previous.private);
 await configManager.close();
 await fs.rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});

test('real native toolchain subprocess cannot inherit ambient BRC credential in isolated mode',async()=>{
 const out=await runProgram(process.execPath,
  ['-e',"console.log(process.env.BRC_TEST_PRIVATE?'LEAK':'NO_LEAK')"],
  project,4000);
 assert.equal(out.isError,false,JSON.stringify(out.structuredContent));
 assert.match(out.structuredContent.stdout,/NO_LEAK/);
 assert.doesNotMatch(out.structuredContent.stdout,/LEAK[^\\n]*DO_NOT_INHERIT_TEST_SECRET/);
 assert.equal(out.structuredContent.environmentPolicy,'isolated');
});

test('explicitly allowlisted project variable is inherited but irrelevant secret is not',async()=>{
 process.env.NEXT_PUBLIC_FIXTURE_NAME='visible_project_value';
 process.env.BRC_COMMAND_ENV_ALLOW='NEXT_PUBLIC_FIXTURE_NAME';
 try{
  const out=await runProgram(process.execPath,
   ['-e',"console.log([process.env.NEXT_PUBLIC_FIXTURE_NAME,Boolean(process.env.BRC_TEST_PRIVATE)].join('|'))"],
   project,4000);
  assert.equal(out.isError,false,JSON.stringify(out.structuredContent));
  assert.match(out.structuredContent.stdout,/visible_project_value\\|false/);
 }finally{
  delete process.env.NEXT_PUBLIC_FIXTURE_NAME;
  delete process.env.BRC_COMMAND_ENV_ALLOW;
 }
});

test('run_command uses the shared isolated environment, including Windows shell',async()=>{
 const r=await runCommandCore(
  {command:'node -e "console.log(process.env.BRC_TEST_PRIVATE ? 1 : 0)"',
    cwd:project,timeout_ms:6000},
  {maxTimeoutMs:8000});
 assert.equal(r.isError,undefined,JSON.stringify(r.structuredContent));
 assert.equal(r.structuredContent.environmentPolicy,'isolated');
 assert.match(r.content[0].text,/0/);
 assert.doesNotMatch(r.content[0].text,/DO_NOT_INHERIT_TEST_SECRET/);
});

test('timed-out managed subprocess never claims a termination without observing child exit',async()=>{
 const out=await runProgram(process.execPath,
   ['-e',"setInterval(() => {}, 1000)"],project,700);
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.timedOut,true);
 assert.ok(['root_exit_observed','unconfirmed'].includes(out.structuredContent.terminationState));
 if(out.structuredContent.terminationState==='unconfirmed')
   assert.equal(out.structuredContent.error?.code,'TOOL_OUTCOME_UNCERTAIN');
});

test('timed-out shell command communicates unconfirmed stop as an uncertain outcome',async()=>{
 const out=await runCommandCore({
   command:'node -e "setInterval(() => {}, 1000)"',cwd:project,timeout_ms:750
 },{maxTimeoutMs:2500});
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.timedOut,true);
 assert.ok(['root_exit_observed','unconfirmed'].includes(out.structuredContent.terminationState));
 if(out.structuredContent.terminationState==='unconfirmed')
   assert.equal(out.structuredContent.error?.code,'TOOL_OUTCOME_UNCERTAIN');
});

test('interactive start_process shell also follows isolated environment policy',async()=>{
 const {terminalManager}=await import('../dist/core/terminal-manager.js');
 const started=await terminalManager.executeCommand(
   'node -e "console.log(process.env.BRC_TEST_PRIVATE ? 1 : 0)"',4000);
 assert.ok(started.pid>0,JSON.stringify(started));
 let output=String(started.output??'');
 for(let i=0;i<50&&output.trim()!=='0';i++){
   await new Promise(resolve=>setTimeout(resolve,40));
   output=String(terminalManager.getRecentOutput(started.pid,1000)??'');
 }
 assert.equal(output.trim(),'0','interactive child must not inherit BRC_TEST_PRIVATE');
 assert.doesNotMatch(output,/DO_NOT_INHERIT_TEST_SECRET/);
});
