import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';

test('portable BAT registers built source, runs after moving elsewhere, and preserves CLI arguments',
 {skip:process.platform!=='win32'},()=>{
 const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'brc-launcher-test-'));
 const root=path.resolve('.');
 try{
  const home=path.join(scratch,'saved configuration');
  const moved=path.join(scratch,'moved folder');
  fs.mkdirSync(moved,{recursive:true});
  const original=path.join(root,'START_AGENT.bat');
  const copied=path.join(moved,'Portable Agent Launcher.bat');
  const env={...process.env,BRC_LAUNCHER_HOME:home};
  delete env.BRC_AGENT_ROOT;
  const run=(filepath,commandArgs)=>spawnSync('powershell.exe',
   ['-NoProfile','-NonInteractive','-Command',"& '"+filepath.replaceAll("'","''")+"' "+commandArgs+'; exit $LASTEXITCODE'],
   {cwd:moved,env,encoding:'utf8',timeout:12000,windowsHide:true});
  const registered=run(original,'--register-only');
  assert.equal(registered.status,0,registered.stderr+'\n'+registered.stdout);
  assert.match(registered.stdout,/Portable launcher registered/);
  const pointer=fs.readFileSync(path.join(home,'agent-root.txt'),'utf8').trim();
  assert.equal(path.resolve(pointer).toLowerCase(),path.resolve(root).toLowerCase());
  fs.copyFileSync(original,copied);
  const launched=run(copied,'--help');
  assert.equal(launched.status,0,'Moved launcher failed: '+launched.stdout+'\n'+launched.stderr);
  assert.match(launched.stdout,/Local agent: START_AGENT/);
  assert.match(launched.stdout,/--compact, --verbose/);
  const originalCmd=run(path.join(root,'START_AGENT.cmd'),'--help');
  assert.equal(originalCmd.status,0,originalCmd.stderr+'\n'+originalCmd.stdout);
  assert.match(originalCmd.stdout,/Local agent:/);
 }finally{fs.rmSync(scratch,{recursive:true,force:true,maxRetries:5,retryDelay:100})}
});
