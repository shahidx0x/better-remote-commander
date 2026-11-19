import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';

const home=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-retention-recovery-'));
const previous=process.env.BRC_HOME;
process.env.BRC_HOME=home;
const {beginCallOutcome,lookupCallOutcome,settleCallOutcome}=await import('../dist/runtime/call-outcomes.js');
const {beginMutationReceipt,recentMutationReceipts,settleMutationReceipt}=await import('../dist/runtime/operation-receipts.js');
const {saveTaskCheckpoint,loadTaskCheckpoints}=await import('../dist/runtime/task-checkpoints.js');
const {saveJobOutput,readJobOutput}=await import('../dist/runtime/job-output-spill.js');
const {sweepOperationalRetention}=await import('../dist/runtime/operational-retention.js');
after(async()=>{
 if(previous===undefined)delete process.env.BRC_HOME;
 else process.env.BRC_HOME=previous;
 await fs.rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:90});
});
const abs=s=>path.resolve('packages/agent/dist/runtime/'+s+'.js');

test('fresh recovery metadata and opted-in large job output survive idle cleanup and a real process restart',async()=>{
 const callId='phase10-'+randomUUID(),id=randomUUID();
 const started=await beginCallOutcome(callId,'write_file');
 assert.ok(started,'call receipt did not persist');
 const mutated=await beginMutationReceipt(callId,'write_file',[]);
 assert.ok(mutated);
 const checkpoint={version:1,id,root:home,goal:'verify retained metadata',
  scope:[],requiredChecks:[],baseline:[],state:'active',touchedAt:Date.now(),
  events:[{at:Date.now(),type:'started'}]};
 assert.equal(await saveTaskCheckpoint(checkpoint),true);
 const original='Unicode café ☕\n'.repeat(2100);
 const ref=await saveJobOutput('jcheckpoint123',0,original,true);
 assert.ok(ref);
 assert.equal((await lookupCallOutcome(callId)).outcome,'uncertain',
   'an unsettled call must remain uncertain rather than be auto-replayed');
 const sweep=await sweepOperationalRetention();
 assert.ok(sweep);
 assert.equal((await lookupCallOutcome(callId)).outcome,'uncertain');
 assert.equal((await loadTaskCheckpoints())[0].id,id);
 assert.ok((await recentMutationReceipts()).some(r=>r.id===mutated.id&&r.recoveredUncertain));
 const page=await readJobOutput('jcheckpoint123',0,0,8000,ref.sha256);
 assert.ok(page?.text.includes('Unicode café'));
 const script=[
  'import {lookupCallOutcome} from '+JSON.stringify(pathToFileURL(abs('call-outcomes')).href)+';',
  'import {loadTaskCheckpoints} from '+JSON.stringify(pathToFileURL(abs('task-checkpoints')).href)+';',
  'import {readJobOutput} from '+JSON.stringify(pathToFileURL(abs('job-output-spill')).href)+';',
  'const call=await lookupCallOutcome('+JSON.stringify(callId)+');',
  'const tasks=await loadTaskCheckpoints();',
  "const page=await readJobOutput('jcheckpoint123',0,0,8000,"+JSON.stringify(ref.sha256)+');',
  'console.log(JSON.stringify({outcome:call.outcome,task:tasks.some(t=>t.id==='+JSON.stringify(id)+"),page:page?.text.includes('Unicode café')}));"
 ].join('\n');
 const restarted=spawnSync(process.execPath,['--input-type=module','-e',script],{
  cwd:process.cwd(),env:{...process.env,BRC_HOME:home},
  encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:2*1024*1024});
 assert.equal(restarted.status,0,restarted.stderr);
 assert.deepEqual(JSON.parse(restarted.stdout.trim()),{outcome:'uncertain',task:true,page:true});
 await settleCallOutcome(started,{isError:false,structuredContent:{done:true}},12);
 await settleMutationReceipt(mutated,[],'returned_success');
 const finished=await lookupCallOutcome(callId);
 assert.equal(finished.outcome,'returned_success');
 assert.equal(finished.deliveryToRelayConfirmed,false);
 const all=await fs.readdir(path.join(home,'call-outcomes'));
 assert.ok(!all.some(n=>n.includes(callId)),'raw callId must not be persisted');
});
