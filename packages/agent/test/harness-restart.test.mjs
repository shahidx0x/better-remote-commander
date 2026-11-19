import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-harness-restart-'));
const root=path.join(scratch,'project');
process.env.BRC_HOME=path.join(scratch,'home');
await fs.mkdir(path.join(root,'src'),{recursive:true});
await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'checkpoint-fixture',scripts:{test:'node -e "process.exit(0)"'}}));
await fs.writeFile(path.join(root,'src','math.ts'),'export const value=1;\n');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {codingSession}=await import('../dist/runtime/harness.js');
after(async()=>{await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:80});});

test('a fresh agent process restores checkpoint but never trusts old verification',async()=>{
 const started=await codingSession({action:'start',path:root,goal:'Improve math safely',scope:['src'],requiredChecks:['test']});
 assert.equal(started.persistent,true,JSON.stringify({started,home:process.env.BRC_HOME,disabled:process.env.BRC_TASK_PERSIST}));
 const checked=path.join(process.env.BRC_HOME,'task-checkpoints',started.sessionId+'.json');
 const saved=JSON.parse(await fs.readFile(checked,'utf8'));
 assert.equal(saved.version,1);
 assert.equal(saved.state,'active');
 const here=path.dirname(fileURLToPath(import.meta.url));
 const modulePath=pathToFileURL(path.join(here,'../dist/runtime/harness.js')).href;
 const script=`
   import {codingSession} from ${JSON.stringify(modulePath)};
   import {configManager} from ${JSON.stringify(pathToFileURL(path.join(here,'../dist/core/config-manager.js')).href)};
   const restored=await codingSession({action:'status',sessionId:${JSON.stringify(started.sessionId)}});
   let rejected=false;
   try{await codingSession({action:'finish',sessionId:${JSON.stringify(started.sessionId)}});}
   catch(e){rejected=e.code==='VERIFICATION_REQUIRED';}
   process.stdout.write('RECOVERY_RESULT='+JSON.stringify({restoredUnverified:restored.restoredUnverified,goal:restored.goal,verified:restored.verifiedCurrentSource,rejected})+'\\n');
   await configManager.close();
 `;
 const child=spawnSync(process.execPath,['--input-type=module','-e',script],{
   cwd:here,env:{...process.env,BRC_HOME:process.env.BRC_HOME,BRC_PLUGINS:'none'},
   encoding:'utf8',timeout:12000
 });
 assert.equal(child.status,0,child.stderr);
 const line=child.stdout.split(/\r?\n/).find(x=>x.startsWith('RECOVERY_RESULT='));
 assert.ok(line,child.stdout);
 const result=JSON.parse(line.slice('RECOVERY_RESULT='.length));
 assert.equal(result.restoredUnverified,true);
 assert.equal(result.verified,false);
 assert.equal(result.rejected,true);
 assert.equal(result.goal,'Improve math safely');
});
