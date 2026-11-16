import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {selectRunCommandShell,nativeChainParts,cmdCompatibleNativeChain} from '../dist/tools/command-shell.js';

const scratch=mkdtempSync(path.join(os.tmpdir(),'brc-shell-recovery-'));
process.env.BRC_HOME=path.join(scratch,'home');
const project=path.join(scratch,'project');
await fs.mkdir(project,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[scratch]);
if(process.platform==='win32')await configManager.setValue('defaultShell','powershell.exe');
const {callTool}=await import('../dist/dispatcher.js');
const read=r=>r.content.map(c=>c.text??'').join('\n');
after(async()=>{
  await configManager.close();
  await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:75});
});

test('detects unquoted && and || but not text inside quotes',()=>{
  assert.deepEqual(nativeChainParts('git status -s && git log -n 10 --oneline').operators,['&&']);
  assert.deepEqual(nativeChainParts('git status || git diff && git log').operators,['||','&&']);
  assert.deepEqual(nativeChainParts('node -e "console.log(\'a && b\')"').operators,[]);
  assert.equal(cmdCompatibleNativeChain('git status -s && git log -n 10 --oneline'),true);
  assert.equal(cmdCompatibleNativeChain('pnpm lint && pnpm build'),true);
  assert.equal(cmdCompatibleNativeChain('Write-Output "ok" && git status'),false);
  assert.equal(cmdCompatibleNativeChain('git status && del source.ts'),false);
  assert.equal(cmdCompatibleNativeChain('git status && node -e "console.log($env:PATH)"'),false);
});

test('only auto-selects cmd for safe native chains under the PS5 default',()=>{
  const native='git status -s && git log -n 10 --oneline';
  const automatic=selectRunCommandShell(native,'powershell.exe',false,'win32');
  assert.equal(automatic.changed,true);
  assert.match(automatic.shell,/cmd.exe$/i);
  assert.equal(automatic.error,undefined);
  const explicit=selectRunCommandShell(native,'powershell.exe',true,'win32');
  assert.equal(explicit.changed,false);
  assert.match(explicit.error,/NO COMMAND WAS EXECUTED/);
  assert.equal(explicit.suggestedShell,'cmd.exe');
  const mixed=selectRunCommandShell('Write-Output 2 && git status','powershell.exe',false,'win32');
  assert.equal(mixed.changed,false);
  assert.ok(mixed.error);
  assert.equal(mixed.suggestedShell,undefined);
  assert.equal(selectRunCommandShell(native,'cmd.exe',false,'win32').changed,false);
  assert.equal(selectRunCommandShell(native,'pwsh.exe',false,'win32').changed,false);
  assert.equal(selectRunCommandShell(native,'powershell.exe',false,'linux').changed,false);
  assert.equal(selectRunCommandShell('node -e "console.log(\'a && b\')"','powershell.exe',false,'win32').changed,false);
});

test('real agent runs git status && git log with the default PowerShell 5.1 config',{skip:process.platform!=='win32'},async()=>{
  const init=spawnSync('git',['init','-q'],{cwd:project,encoding:'utf8'});
  assert.equal(init.status,0,init.stderr);
  const commit=spawnSync('git',['-c','user.name=BRC test','-c','user.email=brc@test.invalid','commit','--allow-empty','-m','shell check','-q'],{cwd:project,encoding:'utf8'});
  assert.equal(commit.status,0,commit.stderr);
  const cmd='git status -s && git log -n 10 --oneline';
  const out=await callTool('run_command',{command:cmd,cwd:project,raw:true,timeout_ms:20000});
  assert.equal(out.isError,undefined,read(out));
  assert.equal(out.structuredContent.exitCode,0);
  assert.equal(out.structuredContent.autoSelectedShell,true);
  assert.match(out.structuredContent.shell,/cmd.exe$/i);
  assert.equal(out.structuredContent.cwd,project);
  assert.match(read(out),/shell check/);
  assert.match(read(out),/shell selection/);
});

test('explicit cmd works; explicit PowerShell 5.1 rejects syntax BEFORE side effects',{skip:process.platform!=='win32'},async()=>{
  const command='node -p "2 + 2" && node -p "3 + 3"';
  const cmd=await callTool('run_command',{cwd:project,command,shell:'cmd.exe',raw:true});
  assert.equal(cmd.isError,undefined,read(cmd));
  assert.equal(cmd.structuredContent.exitCode,0);
  assert.match(read(cmd),/4[\r\n]+6/);
  const denied=await callTool('run_command',{cwd:project,command,shell:'powershell.exe',raw:true});
  assert.equal(denied.isError,true);
  assert.equal(denied.structuredContent.error.code,'SHELL_SYNTAX');
  assert.equal(denied.structuredContent.commandExecuted,false);
  assert.equal(denied.structuredContent.recovery.automaticRetry,false);
  assert.equal(denied.structuredContent.recovery.next.args.shell,'cmd.exe');
  const mixed=await callTool('run_command',{cwd:project,command:'Write-Output hello && git status'});
  assert.equal(mixed.isError,true);
  assert.equal(mixed.structuredContent.error.code,'SHELL_SYNTAX');
  assert.equal(mixed.structuredContent.commandExecuted,false);
  assert.equal(mixed.structuredContent.recovery.next,undefined);
});

test('start_process uses the same safe Windows shell selection and rejects unsafe explicit PS5 chains',
  {skip:process.platform!=='win32'},async()=>{
    const safe=await callTool('start_process',{command:'node -p "7" && node -p "9"',timeout_ms:12000});
    assert.ok(!safe.isError,read(safe));
    assert.match(read(safe),/shell: .*cmd.exe/i);
    assert.match(read(safe),/Shell selection: Windows PowerShell 5.1/);
    const forbidden=await callTool('start_process',{
      command:'node -p "7" && node -p "9"',shell:'powershell.exe',timeout_ms:12000
    });
    assert.equal(forbidden.isError,true);
    assert.equal(forbidden.structuredContent.error.code,'SHELL_SYNTAX');
    assert.equal(forbidden.structuredContent.commandExecuted,false);
    assert.equal(forbidden.structuredContent.recovery.next.args.shell,'cmd.exe');
  });

test('missing shell is a clear start error rather than a command exit or transport failure',
  {skip:process.platform!=='win32'},async()=>{
    const shell=path.join(scratch,'no-such-shell.exe');
    const run=await callTool('run_command',{cwd:project,command:'node -v',shell,raw:true});
    assert.equal(run.isError,true);
    assert.equal(run.structuredContent.error.code,'SHELL_START_FAILED');
    assert.equal(run.structuredContent.recovery.automaticRetry,false);
    const started=await callTool('start_process',{command:'node -v',timeout_ms:1000,shell});
    assert.equal(started.isError,true);
    assert.equal(started.structuredContent.error.code,'SHELL_START_FAILED');
    assert.equal(started.structuredContent.commandExecuted,false);
  });

test('nonzero exit and timeout preserve the real failure reason and next steps',async()=>{
  const failure=await callTool('run_command',{cwd:project,command:'node -e "process.exit(7)"',raw:true,timeout_ms:10000});
  assert.equal(failure.isError,true);
  assert.equal(failure.structuredContent.exitCode,7);
  assert.equal(failure.structuredContent.error.code,'COMMAND_FAILED');
  assert.match(failure.structuredContent.recovery.suggestion,/never replay|never retry|Never replay/i);
  assert.ok(failure.structuredContent.shell);
  const timeout=await callTool('run_command',{cwd:project,command:'node -e "setInterval(()=>{},1000)"',timeout_ms:350,raw:true});
  assert.equal(timeout.isError,true);
  assert.equal(timeout.structuredContent.error.code,'TIMEOUT');
  assert.equal(timeout.structuredContent.timedOut,true);
  assert.match(timeout.structuredContent.recovery.suggestion,/start_process/);
  const relative=await callTool('run_command',{cwd:'src',command:'node -v'});
  assert.equal(relative.isError,true);
  assert.equal(relative.structuredContent.error.code,'INVALID_CWD');
});
