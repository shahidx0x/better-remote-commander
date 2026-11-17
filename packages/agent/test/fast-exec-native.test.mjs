import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
process.env.BRC_HOME = (await import('node:fs')).mkdtempSync((await import('node:path')).join((await import('node:os')).tmpdir(), 'brc-home-'));
const {planFastExec}=await import('../dist/tools/fast-exec.js');
const win=process.platform==='win32';
const mk=async()=>fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'brc-fx-')));
const nodeDir=path.dirname(process.execPath);
// make `node` resolvable by bare name regardless of the test runner's PATH
process.env.PATH=nodeDir+path.delimiter+(process.env.PATH??'');
const SHELL='C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'; // only the base name is inspected

test('native plan only for safe literal argv on a bare .exe name (Windows)',{skip:!win},async()=>{
  const ok=await planFastExec(SHELL,'node argv.js a b-c /x C:\\y\\ ..\\z 1.5 -v --flag',process.env);
  assert.equal(ok?.kind,'native');assert.ok(path.isAbsolute(ok.executable));assert.equal(path.extname(ok.executable).toLowerCase(),'.exe');
  assert.deepEqual(ok.args,['argv.js','a','b-c','/x','C:\\y\\','..\\z','1.5','-v','--flag']);
  assert.ok(!ok.windowsVerbatim);
});
test('anything with quotes, & % ^ = , ! paths or non-exe stays on cmd.exe or the shell (Windows)',{skip:!win},async()=>{
  for(const c of ['node argv.js "a b"','node argv.js a&b','node argv.js %PATH%','node argv.js a^b','node argv.js a=b','node argv.js a,b','node argv.js a!b','node argv.js *.js','node argv.js a;b',
    '.\\node argv.js','node.exe argv.js "x"','"node" argv.js','node argv.js a\tb|c']){
    const p=await planFastExec(SHELL,c,process.env);
    assert.notEqual(p?.kind,'native',c);
  }
  // path-qualified program names keep cmd.exe's resolution rules
  assert.notEqual((await planFastExec(SHELL,process.execPath.replace(/\s/g,'')+' -v',process.env))?.kind,'native');
  // .cmd shims and PowerShell aliases are never native
  assert.notEqual((await planFastExec(SHELL,'npm -v',process.env))?.kind,'native');
  assert.equal(await planFastExec(SHELL,'echo hi',process.env),null);
  // cmd.exe path is still used for non-native simple commands (unchanged behaviour)
  assert.equal((await planFastExec(SHELL,'node "a b"',process.env))?.kind,'cmd');
});
test('native launch yields byte-identical argv to the cmd.exe launch (Windows)',{skip:!win},async()=>{
  const d=await mk();
  await fs.writeFile(path.join(d,'argv.js'),'process.stdout.write(JSON.stringify(process.argv.slice(2)))');
  const cmds=['node argv.js','node argv.js a','node argv.js a b-c /x C:\\y\\ ..\\z 1.5 -v --flag','node  argv.js   spaced     out','node argv.js C:\\Program\\ --opt:val /? -x'.replace('/? ',''),'node argv.js \\\\server\\share\\ d:rel'];
  for(const c of cmds){
    const plan=await planFastExec(SHELL,c,process.env);
    assert.equal(plan?.kind,'native',c);
    const native=spawnSync(plan.executable,plan.args,{cwd:d,encoding:'utf8',windowsHide:true});
    const viaCmd=spawnSync(process.env.COMSPEC||'cmd.exe',['/d','/s','/c',`"${c}"`],{cwd:d,encoding:'utf8',windowsHide:true,windowsVerbatimArguments:true});
    assert.equal(native.status,0,native.stderr);
    assert.equal(native.stdout,viaCmd.stdout,c);
    assert.equal(native.status,viaCmd.status);
  }
  // exit codes propagate identically
  await fs.writeFile(path.join(d,'exit.js'),'process.exit(7)');
  const p=await planFastExec(SHELL,'node exit.js',process.env);
  assert.equal(spawnSync(p.executable,p.args,{cwd:d}).status,7);
});
test('non-Windows platforms never produce a native plan',{skip:win},async()=>{
  const p=await planFastExec('/bin/sh','node -v',process.env);
  assert.notEqual(p?.kind,'native');
});
