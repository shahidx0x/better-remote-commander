// Metadata-only cooperative worker-plan persistence.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {randomUUID,createHash} from 'node:crypto';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {mkdtempSync,realpathSync} from 'node:fs';

const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-worker-persist-'));
const project=path.join(scratch,'project');
process.env.BRC_HOME=path.join(scratch,'home');
process.env.BRC_WORKER_PLAN_PERSIST='1';
process.env.BRC_LOG_LEVEL='silent';
await fs.mkdir(path.join(project,'src'),{recursive:true});
await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'worker-persist-fixture',
  scripts:{verify:'node -e "process.exit(0)"'}}));
await fs.writeFile(path.join(project,'src','alpha.ts'),'export const alpha=1;\n');
await fs.writeFile(path.join(project,'src','beta.ts'),'export const beta=2;\n');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[project]);
const {callTool}=await import('../dist/dispatcher.js');
const disk=await import('../dist/runtime/worker-plan-checkpoints.js');
const here=path.dirname(fileURLToPath(import.meta.url));
const dispatcherUrl=pathToFileURL(path.join(here,'../dist/dispatcher.js')).href;
const configUrl=pathToFileURL(path.join(here,'../dist/core/config-manager.js')).href;
const sha=s=>createHash('sha256').update(s).digest('hex');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r.structuredContent?.error??r));return r.structuredContent;};
const failed=(r,code)=>{assert.equal(r.isError,true,JSON.stringify(r));assert.equal(r.structuredContent?.error?.code,code);};
const planData=async()=>{
 const p=ok(await callTool('worker_tasks',{action:'create',path:project,goal:'Implement alpha/beta safely',
  tasks:[
   {id:'alpha',goal:'Change alpha',scope:['src/alpha.ts']},
   {id:'beta',goal:'Change beta',scope:['src/beta.ts']}
  ],requiredChecks:['verify']}));
 assert.equal(p.persistent,true,JSON.stringify(p));
 return p;
};
const fresh=(lines,extras={})=>{
 const boot=[
  'import {callTool} from '+JSON.stringify(dispatcherUrl)+';',
  'import {configManager} from '+JSON.stringify(configUrl)+';',
  'await configManager.setValue("allowedDirectories",['+JSON.stringify(project)+']);',
  'const err=(r)=>r.structuredContent?.error?.code;',
  'const data=(r)=>r.structuredContent;',
 ];
 const script=[...boot,...lines,"await configManager.close();"].join('\n');
 const result=spawnSync(process.execPath,['--input-type=module','-e',script],{
  cwd:here,encoding:'utf8',timeout:18000,env:{...process.env,...extras}
 });
 assert.equal(result.status,0,result.stderr+'\n'+result.stdout);
 const line=result.stdout.split(/\r?\n/).find(x=>x.startsWith('CHECK='));
 assert.ok(line,result.stdout);
 return JSON.parse(line.slice(6));
};
after(async()=>{
 delete process.env.BRC_WORKER_PLAN_PERSIST;
 await configManager.close();
 await fs.rm(scratch,{recursive:true,force:true,maxRetries:7,retryDelay:90});
});

test('checkpoint contains scoped metadata and only a coordinator verifier, never live keys or staged patches',async()=>{
 const p=await planData();
 const lease=ok(await callTool('worker_tasks',{
  action:'claim',planId:p.planId,taskId:'alpha',workerId:'sensitive-worker-label'
 }));
 const text='export const alpha=99231; // UNSAVED_STAGED_CONTENT_NEVER_ON_DISK\n';
 ok(await callTool('worker_patch',{planId:p.planId,taskId:'alpha',claimKey:lease.claimKey,
  submissionId:'stage-alpha',summary:'UNSAVED_STAGED_SUMMARY_DO_NOT_STORE',
  changes:[{path:'src/alpha.ts',expected_sha256:sha('export const alpha=1;\n'),content:text}]}));
 const file=path.join(process.env.BRC_HOME,'worker-plan-checkpoints',p.planId+'.json');
 const raw=await fs.readFile(file,'utf8');
 assert.doesNotMatch(raw,/UNSAVED_STAGED_CONTENT_NEVER_ON_DISK|UNSAVED_STAGED_SUMMARY_DO_NOT_STORE|sensitive-worker-label|stage-alpha/);
 assert.ok(!raw.includes(p.coordinatorKey),'raw coordinator key leaked');
 assert.ok(!raw.includes(lease.claimKey),'raw claim key leaked');
 const checkpoint=JSON.parse(raw);
 assert.equal(checkpoint.coordinatorHash,sha(p.coordinatorKey));
 assert.equal(checkpoint.tasks.find(t=>t.id==='alpha').state,'queued','staged source must not survive');
 assert.deepEqual(checkpoint.baseline.find(e=>e[0].endsWith('alpha.ts'))?.[1],sha('export const alpha=1;\n'));
 ok(await callTool('worker_tasks',{action:'cancel',planId:p.planId,coordinatorKey:p.coordinatorKey}));
 await assert.rejects(fs.stat(file),{code:'ENOENT'});
});

test('fresh agent restores applied task, resets submissions and refuses old claim/verification',async()=>{
 const p=await planData();
 const claimA=ok(await callTool('worker_tasks',{action:'claim',planId:p.planId,taskId:'alpha',workerId:'first-worker'}));
 ok(await callTool('worker_patch',{planId:p.planId,taskId:'alpha',claimKey:claimA.claimKey,
  submissionId:'alpha-patch',summary:'alpha diff',changes:[{path:'src/alpha.ts',
   expected_sha256:sha('export const alpha=1;\n'),content:'export const alpha=7;\n'}]}));
 const preview=ok(await callTool('worker_integrate',{action:'preview',planId:p.planId,coordinatorKey:p.coordinatorKey}));
 const applied=ok(await callTool('worker_integrate',{action:'apply',planId:p.planId,
  coordinatorKey:p.coordinatorKey,review_sha256:preview.review_sha256}));
 assert.equal(applied.committed,true);
 const claimB=ok(await callTool('worker_tasks',{action:'claim',planId:p.planId,taskId:'beta',workerId:'second-worker'}));
 ok(await callTool('worker_patch',{planId:p.planId,taskId:'beta',claimKey:claimB.claimKey,
  submissionId:'beta-patch',summary:'beta unsaved',changes:[{path:'src/beta.ts',
   expected_sha256:sha('export const beta=2;\n'),content:'export const beta=secret; // NOT_SAVED_STAGED\n'}]}));
 const recorded=await fs.readFile(path.join(process.env.BRC_HOME,'worker-plan-checkpoints',p.planId+'.json'),'utf8');
 assert.ok(!recorded.includes('NOT_SAVED_STAGED'));
 const out=fresh([
  'const status=await callTool("worker_tasks",{action:"status",planId:'+JSON.stringify(p.planId)+'});',
  'const premature=await callTool("worker_tasks",{action:"claim",planId:'+JSON.stringify(p.planId)+',taskId:"beta",workerId:"wrong"});',
  'const direct=await callTool("write_file",{path:'+JSON.stringify(path.join(project,'src','beta.ts'))+',content:"should be blocked"});',
  'const bad=await callTool("worker_tasks",{action:"resume",planId:'+JSON.stringify(p.planId)+',coordinatorKey:"x".repeat(32)});',
  'const restored=await callTool("worker_tasks",{action:"resume",planId:'+JSON.stringify(p.planId)+',coordinatorKey:'+JSON.stringify(p.coordinatorKey)+'});',
  'const expired=await callTool("worker_patch",{planId:'+JSON.stringify(p.planId)+',taskId:"beta",claimKey:'+JSON.stringify(claimB.claimKey)+',submissionId:"old-beta",summary:"old",changes:[]});',
  'const next=await callTool("worker_tasks",{action:"claim",planId:'+JSON.stringify(p.planId)+',taskId:"beta",workerId:"fresh-worker"});',
  'process.stdout.write("CHECK="+JSON.stringify({',
  '  state:data(status).state,restored:data(status).restored,review:data(status).resumeRequired,',
  '  taskStates:data(status).tasks.map(x=>[x.id,x.state]),',
  '  premature:err(premature),direct:err(direct),unauthorized:err(bad),',
  '  resumedState:data(restored).state,oldClaimError:err(expired),',
  '  newClaim:data(next).claimKey?.length>20,',
  '  newClaimDifferent:data(next).claimKey!=='+JSON.stringify(claimB.claimKey),
  '})+"\\n");'
 ]);
 assert.equal(out.state,'needs_review');
 assert.equal(out.restored,true);
 assert.equal(out.review,true);
 assert.deepEqual(out.taskStates,[['alpha','applied'],['beta','queued']]);
 assert.equal(out.premature,'WORKER_PLAN_CLOSED');
 assert.equal(out.direct,'COORDINATED_WRITE_REQUIRED');
 assert.equal(out.unauthorized,'WORKER_ACCESS_DENIED');
 assert.equal(out.resumedState,'active');
 assert.equal(out.oldClaimError,'WORKER_ACCESS_DENIED');
 assert.equal(out.newClaim,true);
 assert.equal(out.newClaimDifferent,true);
 assert.equal(await fs.readFile(path.join(project,'src','alpha.ts'),'utf8'),'export const alpha=7;\n');
 assert.equal(await fs.readFile(path.join(project,'src','beta.ts'),'utf8'),'export const beta=2;\n');
 // This test uses the same fixture root as the next case. Cancel explicitly
 // to avoid a legitimate WORKER_ROOT_BUSY caused by the surviving plan.
 const cleaned=fresh([
  'const c=await callTool("worker_tasks",{action:"cancel",planId:'+JSON.stringify(p.planId)+',coordinatorKey:'+JSON.stringify(p.coordinatorKey)+'});',
  'process.stdout.write("CHECK="+JSON.stringify({state:data(c).state})+"\\n");'
 ]);
 assert.equal(cleaned.state,'cancelled');
 const {workerCoordinator}=await import('../dist/runtime/worker-coordination.js');
 workerCoordinator.clear();
 await fs.writeFile(path.join(project,'src','alpha.ts'),'export const alpha=1;\n');
});

test('external modification blocks recovery and cancellation can clean a restored plan',async()=>{
 const p=await planData();
 await fs.writeFile(path.join(project,'src','beta.ts'),'externally modified after checkpoint\n');
 const info=fresh([
  'const status=await callTool("worker_tasks",{action:"status",planId:'+JSON.stringify(p.planId)+'});',
  'const blocked=await callTool("worker_tasks",{action:"resume",planId:'+JSON.stringify(p.planId)+',coordinatorKey:'+JSON.stringify(p.coordinatorKey)+'});',
  'const cancelled=await callTool("worker_tasks",{action:"cancel",planId:'+JSON.stringify(p.planId)+',coordinatorKey:'+JSON.stringify(p.coordinatorKey)+'});',
  'process.stdout.write("CHECK="+JSON.stringify({state:data(status).state,code:err(blocked),',
  '  cancelled:data(cancelled).state})+"\\n");'
 ]);
 assert.equal(info.state,'needs_review');
 assert.equal(info.code,'UNAPPROVED_CHANGES');
 assert.equal(info.cancelled,'cancelled');
 await assert.rejects(fs.stat(path.join(process.env.BRC_HOME,'worker-plan-checkpoints',p.planId+'.json')),{code:'ENOENT'});
 await fs.writeFile(path.join(project,'src','beta.ts'),'export const beta=2;\n');
});

test('idle RAM pruning can recover a persisted plan in needs_review, without fresh worker claims',async()=>{
 const {workerCoordinator,WORKER_LIMITS}=await import('../dist/runtime/worker-coordination.js');
 // The previous case cancelled its plan in a different process. Reset this
 // test process's stale singleton before creating another plan for the root.
 workerCoordinator.clear();
 const p=await planData();
 assert.ok(workerCoordinator.stats().plans>=1);
 const removed=workerCoordinator.prune(Date.now()+WORKER_LIMITS.idleMs+120000);
 assert.ok(removed>=1);
 const restored=ok(await callTool('worker_tasks',{action:'status',planId:p.planId}));
 assert.equal(restored.state,'needs_review');
 assert.equal(restored.restored,true);
 assert.equal(restored.resumeRequired,true);
 assert.ok(restored.tasks.every(t=>t.state==='queued'));
 ok(await callTool('worker_tasks',{action:'cancel',planId:p.planId,coordinatorKey:p.coordinatorKey}));
});

test('corrupted checkpoint is ignored and storage failures do not break workflow',async()=>{
 const existing=await disk.loadWorkerPlanCheckpoints();
 assert.ok(Array.isArray(existing));
 const dir=path.join(process.env.BRC_HOME,'worker-plan-checkpoints');
 await fs.mkdir(dir,{recursive:true});
 await fs.writeFile(path.join(dir,randomUUID()+'.json'),'{invalid');
 assert.ok((await disk.loadWorkerPlanCheckpoints()).every(x=>x.version===1));
 const home=process.env.BRC_HOME;
 const marker=path.join(scratch,'blocker-file');
 await fs.writeFile(marker,'file');
 const good=(await disk.loadWorkerPlanCheckpoints())[0];
 process.env.BRC_HOME=marker;
 try{
  if(good)assert.equal(await disk.saveWorkerPlanCheckpoint(good),false);
  assert.deepEqual(await disk.loadWorkerPlanCheckpoints(),[]);
 }finally{process.env.BRC_HOME=home;}
});
