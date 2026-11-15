// Cooperative worker tests use disposable projects only. No model/provider or production process is invoked.
import {test, after, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync, realpathSync} from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
const scratch=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-workers-test-'));
process.env.BRC_HOME=path.join(scratch,'home');process.env.BRC_LOG_LEVEL='silent';
const {configManager}=await import('../dist/core/config-manager.js');await configManager.setValue('allowedDirectories',[scratch]);
const {callTool,listTools}=await import('../dist/dispatcher.js');
const {workerCoordinator,WorkerCoordinator,WORKER_LIMITS}=await import('../dist/runtime/worker-coordination.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const {withCallContext}=await import('../dist/context.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {clearCodeCache}=await import('../dist/runtime/code-structure.js');
const {cacheStatus}=await import('../dist/runtime/resource-limits.js');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const bad=(r,code)=>{assert.equal(r.isError,true,JSON.stringify(r));assert.equal(r.structuredContent.error.code,code);};
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let seq=0;
async function fixture(){
 const root=path.join(scratch,'project-'+(++seq));await fs.mkdir(root);await fs.mkdir(path.join(root,'src'));
 await fs.writeFile(path.join(root,'src','a.cs'),'public class A {}\n');await fs.writeFile(path.join(root,'src','b.rs'),'pub fn b() {}\n');await fs.writeFile(path.join(root,'external.txt'),'untouched');
 await fs.writeFile(path.join(root,'check.cjs'),'const fs=require("node:fs"); if(fs.readFileSync("src/a.cs","utf8").includes("BAD")) process.exit(9); console.log("actual-check-ran");');
 await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'worker-test',packageManager:'pnpm@11.24.0',scripts:{verify:'node check.cjs'}}));
 return root;
}
const task=(id,scope,dependsOn=[],readOnly=false)=>({id,goal:'Implement '+id,scope,dependsOn,readOnly});
const create=(root,tasks,extra={})=>callTool('worker_tasks',{action:'create',path:root,goal:'Independent coding work',tasks,requiredChecks:['verify'],...extra}).then(ok);
const claim=(plan,id,extra={})=>callTool('worker_tasks',{action:'claim',planId:plan.planId,taskId:id,workerId:'worker-'+id,...extra}).then(ok);
const patch=(plan,id,lease,changes,extra={})=>callTool('worker_patch',{planId:plan.planId,taskId:id,claimKey:lease.claimKey,submissionId:'submission-'+id,summary:'Proposed change; not verified.',changes,...extra});
const integrate=(plan,action,extra={})=>callTool('worker_integrate',{planId:plan.planId,coordinatorKey:plan.coordinatorKey,action,...extra});
async function replacement(root,file,content){return{path:file,expected_sha256:sha256(await fs.readFile(path.join(root,file))),content};}
async function submitOne(plan,root,id,file,content){const lease=await claim(plan,id);ok(await patch(plan,id,lease,[await replacement(root,file,content)]));return lease;}
async function applyAll(plan,runChecks=false){const preview=ok(await integrate(plan,'preview'));return integrate(plan,'apply',{review_sha256:preview.review_sha256,runChecks});}
beforeEach(()=>workerCoordinator.clear());
after(async()=>{workerCoordinator.clear();projectIndex.close();codeGraph.clear();clearCodeCache();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});});

test('three coordination tools are unique and native spawning is never fabricated',async()=>{
 const names=listTools().map(t=>t.name);for(const name of ['worker_tasks','worker_patch','worker_integrate'])assert.ok(names.includes(name));assert.equal(new Set(names).size,names.length);
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs']),task('b',['src/b.rs'])],{hostMode:'native_workers'});
 assert.equal(p.hostMode,'native_workers');assert.equal(p.spawnedModels,0);assert.match(p.next,/host/);assert.ok(p.coordinatorKey);assert.equal(p.persistent,false);
 const status=ok(await callTool('worker_tasks',{action:'status',planId:p.planId}));assert.ok(!JSON.stringify(status).includes(p.coordinatorKey));assert.equal(status.tasks.length,2);
 assert.equal(await fs.stat(path.join(root,'.brc')).catch(()=>null),null);
});
test('overlapping writer scopes are rejected unless dependencies serialize them',async()=>{
 const root=await fixture();
 bad(await callTool('worker_tasks',{action:'create',path:root,goal:'conflict',tasks:[task('a',['src']),task('b',['src/a.cs'])]}),'OVERLAPPING_SCOPE');
 const p=await create(root,[task('a',['src']),task('b',['src/a.cs'],['a'])]);assert.deepEqual(p.readyTaskIds,['a']);
 bad(await callTool('worker_tasks',{action:'claim',planId:p.planId,taskId:'b',workerId:'second'}),'TASK_BLOCKED');
});
test('duplicate IDs, dependency cycles, missing dependencies and unsafe scope fail closed',async()=>{
 const root=await fixture();
 for(const [tasks,code]of [[ [task('a',['src']),task('a',['src'])],'DUPLICATE_TASK'],[[task('a',['src/a.cs'],['b']),task('b',['src/b.rs'],['a'])],'TASK_CYCLE'],[[task('a',['src'],['missing'])],'UNKNOWN_DEPENDENCY'],[[task("a", ["../outside"])],'INVALID_SCOPE'],[[task('a',['.git'])],'INVALID_SCOPE']])bad(await callTool('worker_tasks',{action:'create',path:root,goal:'invalid',tasks}),code);
});
test('concurrent plan creation cannot reserve overlapping project roots twice',async()=>{
 const root=await fixture();const outcomes=await Promise.all([1,2].map(()=>callTool('worker_tasks',{action:'create',path:root,goal:'reserve',tasks:[task('a',['src'])]})));
 assert.equal(outcomes.filter(r=>!r.isError).length,1);assert.equal(outcomes.filter(r=>r.structuredContent.error?.code==='WORKER_ROOT_BUSY').length,1);
});
test('concurrent claims have a single winner, honor the cap, and can return snapshots',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs']),task('b',['src/b.rs']),task('c',['src'],[],true)],{maxWorkers:2});
 const outcomes=await Promise.all([1,2,3].map(i=>callTool('worker_tasks',{action:'claim',planId:p.planId,taskId:'a',workerId:'w'+i,reads:[{path:'src/a.cs'}]})));
 const first=ok(outcomes.find(r=>!r.isError));assert.equal(outcomes.filter(r=>!r.isError).length,1);assert.equal(first.snapshot.reads[0].sha256,sha256('public class A {}\n'));
 const second=await claim(p,'b');bad(await callTool('worker_tasks',{action:'claim',planId:p.planId,taskId:'c',workerId:'third'}),'WORKER_CAPACITY');
 ok(await callTool('worker_tasks',{action:'release',planId:p.planId,taskId:'b',claimKey:second.claimKey}));const third=await claim(p,'c');assert.ok(third.claimKey);assert.notEqual(second.claimKey,third.claimKey);
});
test('expired and reset claim keys cannot submit and renew extends a live lease',async()=>{
 let time=1000000;const c=new WorkerCoordinator(()=>time),root=await fixture();
 const p=await c.create({path:root,goal:'lease',tasks:[task('a',['src/a.cs'])],requiredChecks:['verify']});
 const lease=await c.manage({action:'claim',planId:p.planId,taskId:'a',workerId:'w',leaseSeconds:30});time+=20000;
 await c.manage({action:'renew',planId:p.planId,taskId:'a',claimKey:lease.claimKey,leaseSeconds:30});time+=20000;
 assert.equal((await c.manage({action:'status',planId:p.planId})).tasks[0].state,'claimed');time+=11000;
 await assert.rejects(c.submit({planId:p.planId,taskId:'a',claimKey:lease.claimKey,submissionId:'old',summary:'old',changes:[await replacement(root,'src/a.cs','new')]}),e=>e.code==='WORKER_ACCESS_DENIED');
 const fresh=await c.manage({action:'claim',planId:p.planId,taskId:'a',workerId:'new'});assert.notEqual(fresh.claimKey,lease.claimKey);c.clear();
});
test('independent workers can submit together without changing any shared source',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs']),task('b',['src/b.rs'])]);const [a,b]=await Promise.all([claim(p,'a'),claim(p,'b')]);
 const submitted=await Promise.all([patch(p,'a',a,[await replacement(root,'src/a.cs','public class ImprovedA {}\n')]),patch(p,'b',b,[await replacement(root,'src/b.rs','pub fn better_b() {}\n')])]);
 submitted.forEach(ok);assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'public class A {}\n');assert.equal(await fs.readFile(path.join(root,'src/b.rs'),'utf8'),'pub fn b() {}\n');
 assert.equal(workerCoordinator.stats().patches,2);assert.ok(workerCoordinator.stats().patchBytes>0);
});
test('submission scope, read-only tasks, bounds and current hashes are enforced',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs']),task('review',['src'],[],true)]);const a=await claim(p,'a'),review=await claim(p,'review');
 bad(await patch(p,'a',a,[await replacement(root,'src/b.rs','unauthorized')]),'TASK_SCOPE_VIOLATION');
 bad(await patch(p,'review',review,[await replacement(root,'src/a.cs','unauthorized')]),'READ_ONLY_TASK');
 bad(await patch(p,'a',a,[{path:'src/a.cs',expected_sha256:'0'.repeat(64),content:'stale'}]),'FILE_CONFLICT');
 bad(await patch(p,'a',a,[{path:'src/a.cs',expected_sha256:sha256('public class A {}\n'),content:'x'.repeat(2*1024*1024)}]),'PATCH_TOO_LARGE');
 ok(await patch(p,'review',review,[]));assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'public class A {}\n');
});
test('patch submission retries are idempotent and changed retries are rejected',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs'])]),a=await claim(p,'a'),changes=[await replacement(root,'src/a.cs','new')];
 assert.equal(ok(await patch(p,'a',a,changes)).replay,false);const bytes=workerCoordinator.stats().patchBytes;
 assert.equal(ok(await patch(p,'a',a,changes)).replay,true);assert.equal(workerCoordinator.stats().patchBytes,bytes);
 bad(await patch(p,'a',a,changes,{summary:'different'}),'TASK_ALREADY_SUBMITTED');
});
test('preview requires coordinator access and cannot write; apply waits for active workers',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs']),task('b',['src/b.rs'])]);await submitOne(p,root,'a','src/a.cs','new');const b=await claim(p,'b');
 bad(await integrate(p,'preview',{coordinatorKey:'x'.repeat(32)}),'WORKER_ACCESS_DENIED');
 const preview=ok(await integrate(p,'preview'));assert.equal(preview.writesPerformed,0);assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'public class A {}\n');
 bad(await integrate(p,'apply',{review_sha256:preview.review_sha256}),'WORKERS_ACTIVE');
 ok(await callTool('worker_tasks',{action:'release',planId:p.planId,taskId:'b',claimKey:b.claimKey}));
 bad(await integrate(p,'apply',{review_sha256:'f'.repeat(64)}),'STALE_REVIEW');
});
test('ordinary file writers are blocked in coordinated roots but unrelated projects stay usable',async()=>{
 const root=await fixture(),other=await fixture(),p=await create(root,[task('a',['src/a.cs'])]);
 bad(await callTool('write_file',{path:path.join(root,'src/a.cs'),content:'bad'}),'COORDINATED_WRITE_REQUIRED');
 bad(await callTool('workspace_batch',{path:root,dryRun:false,changes:[await replacement(root,'src/a.cs','bad')]}),'COORDINATED_WRITE_REQUIRED');
 bad(await callTool('batch_tools',{calls:[{tool:'write_file',arguments:{path:path.join(root,'src/a.cs'),content:'bad'}}]}),'TOOL_FAILED');
 ok(await callTool('write_file',{path:path.join(other,'external.txt'),content:'permitted',mode:'rewrite'}));ok(await callTool('read_code_file',{path:path.join(root,'src/a.cs')}));
 ok(await callTool('worker_tasks',{action:'cancel',planId:p.planId,coordinatorKey:p.coordinatorKey}));ok(await callTool('write_file',{path:path.join(root,'src/a.cs'),content:'after cancellation',mode:'rewrite'}));
});
test('integration applies exact patches once and frees their RAM payloads',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs']),task('b',['src/b.rs'])]);
 await submitOne(p,root,'a','src/a.cs','public class BetterA {}');await submitOne(p,root,'b','src/b.rs','pub fn better_b() {}');
 const review=ok(await integrate(p,'preview'));const first=ok(await integrate(p,'apply',{review_sha256:review.review_sha256}));assert.equal(first.committed,true);assert.equal(first.changes.length,2);assert.equal(workerCoordinator.stats().patchBytes,0);
 const replay=ok(await integrate(p,'apply',{review_sha256:review.review_sha256}));assert.equal(replay.replay,true);assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'public class BetterA {}');
 bad(await integrate(p,'finish'),'VERIFICATION_REQUIRED');
});
test('dependent shared-file work can start only after predecessor was applied',async()=>{
 const root=await fixture(),p=await create(root,[task('first',['src/a.cs']),task('second',['src/a.cs'],['first'])]);
 await submitOne(p,root,'first','src/a.cs','public class First {}');bad(await callTool('worker_tasks',{action:'claim',planId:p.planId,taskId:'second',workerId:'two'}),'TASK_BLOCKED');
 ok(await applyAll(p));const second=await claim(p,'second',{reads:[{path:'src/a.cs'}]});assert.match(second.snapshot.reads[0].text,/First/);
 bad(await callTool('worker_tasks',{action:'reset',planId:p.planId,taskId:'first',coordinatorKey:p.coordinatorKey}),'DEPENDENTS_ACTIVE');
 ok(await patch(p,'second',second,[await replacement(root,'src/a.cs','public class Second {}')]));ok(await applyAll(p));assert.match(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),/Second/);
});
test('real combined checks and fresh snapshots gate finish; worker claims are not evidence',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs'])]);await submitOne(p,root,'a','src/a.cs','public class Verified {}');
 const applied=ok(await applyAll(p,true));assert.equal(applied.checks.passed,true);assert.ok(JSON.stringify(applied.checks).includes('actual-check-ran'));
 const done=ok(await integrate(p,'finish'));assert.equal(done.state,'finished');assert.equal(done.verifiedCurrentSource,true);
});
test('failed checks retain applied edits but cannot finish or trigger mutation replay',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs'])]);await submitOne(p,root,'a','src/a.cs','BAD');
 const preview=ok(await integrate(p,'preview')),r=await integrate(p,'apply',{review_sha256:preview.review_sha256,runChecks:true});
 assert.equal(r.isError,true);assert.equal(r.structuredContent.committed,true);assert.equal(r.structuredContent.checks.passed,false);assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'BAD');
 const retry=ok(await integrate(p,'apply',{review_sha256:preview.review_sha256,runChecks:true}));assert.equal(retry.replay,true);assert.equal(retry.checks,undefined);
 bad(await integrate(p,'finish'),'VERIFICATION_REQUIRED');
 ok(await callTool('worker_tasks',{action:'reset',planId:p.planId,taskId:'a',coordinatorKey:p.coordinatorKey}));await submitOne(p,root,'a','src/a.cs','public class Fixed {}');ok(await applyAll(p,true));ok(await integrate(p,'finish'));
});
test('outside edits and edits after verification cannot silently pass completion',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs'])]);await submitOne(p,root,'a','src/a.cs','public class Fine {}');ok(await applyAll(p,true));
 await fs.writeFile(path.join(root,'external.txt'),'outside modification');bad(await integrate(p,'finish'),'UNAPPROVED_CHANGES');assert.equal(await fs.readFile(path.join(root,'external.txt'),'utf8'),'outside modification');
});
test('missing check definitions never turn a read-only summary into a passed build',async()=>{
 const root=await fixture(),p=await create(root,[task('review',['src'],[],true)],{requiredChecks:[]}),lease=await claim(p,'review');ok(await patch(p,'review',lease,[],{summary:'All tests passed (untrusted claim).'}));ok(await applyAll(p));
 bad(await integrate(p,'verify'),'NO_VERIFICATION_DEFINED');bad(await integrate(p,'finish'),'VERIFICATION_REQUIRED');
 ok(await callTool('worker_tasks',{action:'set_checks',planId:p.planId,coordinatorKey:p.coordinatorKey,requiredChecks:['verify']}));ok(await integrate(p,'verify'));ok(await integrate(p,'finish'));
});
test('cancellation and expiry discard only coordination state, not project files',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs'])]);const lease=await submitOne(p,root,'a','src/a.cs','never applied');
 ok(await callTool('worker_tasks',{action:'cancel',planId:p.planId,coordinatorKey:p.coordinatorKey}));assert.equal(workerCoordinator.stats().patchBytes,0);assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'public class A {}\n');
 bad(await patch(p,'a',lease,[]),'WORKER_PLAN_CLOSED');assert.ok(workerCoordinator.prune(Date.now()+WORKER_LIMITS.terminalMs+100)>0);assert.equal(workerCoordinator.stats().plans,0);assert.equal(cacheStatus().diskContextCacheBytes,0);
});
test('parallel publication holds readback until all writes finish and rolls back settled successes',async()=>{
 const root=await fixture(),a=path.join(root,'src/a.cs'),b=path.join(root,'src/b.rs');const beforeA=await fs.readFile(a,'utf8'),beforeB=await fs.readFile(b,'utf8');
 const rename=fs.rename;let active=0,peak=0;
 fs.rename=async(from,to)=>{if(String(from).includes('.brc-')){active++;peak=Math.max(peak,active);await sleep(30);try{return await rename(from,to);}finally{active--;}}return rename(from,to);};
 try{const r=ok(await callTool('workspace_batch',{path:root,dryRun:false,writeConcurrency:4,changes:[{path:'src/a.cs',expected_sha256:sha256(beforeA),content:'one'},{path:'src/b.rs',expected_sha256:sha256(beforeB),content:'two'}],reads:[{path:'src/a.cs'},{path:'src/b.rs'}]}));assert.equal(peak,2);assert.equal(active,0);assert.deepEqual(r.reads.map(x=>x.text),['one','two']);}finally{fs.rename=rename;}
 let firstPending=false;
 fs.rename=async(from,to)=>{if(String(from).includes('.brc-')&&to===a){firstPending=true;await sleep(40);const r=await rename(from,to);firstPending=false;return r;}if(String(from).includes('.brc-')&&to===b)throw Object.assign(new Error('injected'),{code:'EIO'});return rename(from,to);};
 try{const r=await callTool('workspace_batch',{path:root,dryRun:false,writeConcurrency:4,changes:[{path:'src/a.cs',expected_sha256:sha256('one'),content:'bad-one'},{path:'src/b.rs',expected_sha256:sha256('two'),content:'bad-two'}]});assert.equal(r.isError,true);assert.equal(firstPending,false);assert.equal(await fs.readFile(a,'utf8'),'one');assert.equal(await fs.readFile(b,'utf8'),'two');assert.equal(r.structuredContent.rolledBack,1);}finally{fs.rename=rename;}
});
test('scope symlinks cannot be retargeted to escape a worker task',async()=>{
 const root=await fixture(),outside=await fixture(),link=path.join(root,'alias');
 await fs.symlink(path.join(root,'src'),link,process.platform==='win32'?'junction':'dir');
 const p=await create(root,[task('a',['alias'])]),lease=await claim(p,'a');await fs.unlink(link);await fs.symlink(path.join(outside,'src'),link,process.platform==='win32'?'junction':'dir');
 const r=await patch(p,'a',lease,[{path:'alias/a.cs',expected_sha256:sha256('public class A {}\n'),content:'escape'}]);assert.equal(r.isError,true);assert.ok(['OUTSIDE_PROJECT','SCOPE_CHANGED'].includes(r.structuredContent.error.code));assert.equal(await fs.readFile(path.join(outside,'src/a.cs'),'utf8'),'public class A {}\n');
});

test('staged patch quota fails before adding more RAM and never writes proposed files',async()=>{
 const root=await fixture(),tasks=Array.from({length:10},(_,i)=>task('t'+i,['new'+i+'.txt']));const p=await create(root,tasks);
 let accepted=0;for(let i=0;i<10;i++){const lease=await claim(p,'t'+i);const r=await patch(p,'t'+i,lease,[{path:'new'+i+'.txt',expected_sha256:null,content:'x'.repeat(900000)}]);if(r.isError){bad(r,'WORKER_MEMORY_LIMIT');break;}accepted++;}
 assert.equal(accepted,9);assert.ok(workerCoordinator.stats().patchBytes<=WORKER_LIMITS.planPatchBytes);assert.equal(await fs.stat(path.join(root,'new0.txt')).catch(()=>null),null);
 ok(await callTool('worker_tasks',{action:'cancel',planId:p.planId,coordinatorKey:p.coordinatorKey}));assert.equal(workerCoordinator.stats().patchBytes,0);
});
test('fresh scope policy is checked on every coordination call',async()=>{
 const root=await fixture(),other=await fixture(),p=await create(root,[task('a',['src/a.cs'])]);
 await configManager.setValue('allowedDirectories',[other]);
 try{const denied=await callTool('worker_tasks',{action:'status',planId:p.planId});assert.equal(denied.isError,true);assert.ok(!JSON.stringify(denied).includes(p.coordinatorKey));}
 finally{await configManager.setValue('allowedDirectories',[scratch]);}
 ok(await callTool('worker_tasks',{action:'cancel',planId:p.planId,coordinatorKey:p.coordinatorKey}));
});
test('reset revokes old submissions and old preview digests cannot authorize new edits',async()=>{
 const root=await fixture(),p=await create(root,[task('a',['src/a.cs'])]),lease=await submitOne(p,root,'a','src/a.cs','old proposal');const preview=ok(await integrate(p,'preview'));
 ok(await callTool('worker_tasks',{action:'reset',planId:p.planId,taskId:'a',coordinatorKey:p.coordinatorKey}));
 bad(await patch(p,'a',lease,[await replacement(root,'src/a.cs','late proposal')]),'WORKER_ACCESS_DENIED');
 await submitOne(p,root,'a','src/a.cs','new proposal');bad(await integrate(p,'apply',{review_sha256:preview.review_sha256}),'STALE_REVIEW');assert.equal(await fs.readFile(path.join(root,'src/a.cs'),'utf8'),'public class A {}\n');
});
test('cancelling parallel publication waits for pending writes before rollback',async()=>{
 const root=await fixture(),a=path.join(root,'src/a.cs'),b=path.join(root,'src/b.rs'),originalA=await fs.readFile(a,'utf8'),originalB=await fs.readFile(b,'utf8');
 const abort=new AbortController(),rename=fs.rename;let starts=0;
 fs.rename=async(from,to)=>{if(String(from).includes('.brc-')&&[a,b].includes(to)){starts++;if(starts===2)abort.abort(new DOMException('cancelled','AbortError'));await sleep(20);}return rename(from,to);};
 try{const r=await withCallContext({id:'cancel-parallel-publish',client:null,remote:false,signal:abort.signal},()=>callTool('workspace_batch',{path:root,dryRun:false,writeConcurrency:4,changes:[{path:'src/a.cs',expected_sha256:sha256(originalA),content:'new a'},{path:'src/b.rs',expected_sha256:sha256(originalB),content:'new b'},{path:'new-final.txt',expected_sha256:null,content:'must not be published'}]}));assert.equal(r.isError,true);assert.equal(await fs.readFile(a,'utf8'),originalA);assert.equal(await fs.readFile(b,'utf8'),originalB);assert.equal(await fs.stat(path.join(root,'new-final.txt')).catch(()=>null),null);}finally{fs.rename=rename;}
});
