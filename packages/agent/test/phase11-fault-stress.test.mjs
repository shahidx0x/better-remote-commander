/** Phase 11 integration faults: only subprocesses and temp BRC_HOME.
 * Never use live devices, networks, real project mutations, relay, or creds.
 */
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-phase11-'));
const root=path.join(temp,'project');
const previousHome=process.env.BRC_HOME;
process.env.BRC_HOME=path.join(temp,'agent');
await fs.mkdir(root,{recursive:true});
const {CommandCpuAdmission,commandCpuAdmission}=await import('../dist/runtime/resource-admission.js');
const {runProgram}=await import('../dist/runtime/program-runner.js');
const {withCallContext}=await import('../dist/context.js');
const {configManager}=await import('../dist/core/config-manager.js');
const {terminalManager,MAX_BUFFERED_OUTPUT_CHARS,keepRecentTerminalOutput}=await import('../dist/core/terminal-manager.js');
const {spawnManaged,managedSpawnStatus}=await import('../dist/runtime/managed-spawn.js');
const {stopManagedChild,managedChildStatus}=await import('../dist/runtime/process-termination.js');
const {lookupCallOutcome}=await import('../dist/runtime/call-outcomes.js');
await configManager.setValue('allowedDirectories',[root]);
after(async()=>{
 await configManager.close();
 if(previousHome===undefined)delete process.env.BRC_HOME;
 else process.env.BRC_HOME=previousHome;
 await fs.rm(temp,{recursive:true,force:true,maxRetries:8,retryDelay:100});
});

test('admission stress: FIFO without starvation, hard bounded queues, cancellation releases slots',async()=>{
 const lane=new CommandCpuAdmission(()=>true,1,'phase11-test',24);
 const one=await lane.acquire();
 const all=[],controllers=[],order=[];
 for(let i=0;i<68;i++){
  const ac=new AbortController();controllers.push(ac);
  all.push(lane.acquire(ac.signal,3000).then(release=>{
   order.push(i);release();return 'granted';
  },error=>error.code??'cancelled'));
 }
 assert.equal(lane.status().queued,24);
 assert.equal(lane.status().rejected,44);
 for(let i=0;i<24;i+=3)controllers[i].abort(new Error('phase11 queued cancellation'));
 assert.equal(lane.status().queued,16);
 one();
 const results=await Promise.all(all);
 assert.equal(lane.status().active,0);
 assert.equal(lane.status().queued,0);
 assert.equal(lane.status().cancelledQueued,8);
 assert.equal(lane.status().rejected,44);
 assert.deepEqual(order,Array.from({length:24},(_,i)=>i).filter(i=>i%3!==0));
 assert.equal(results.filter(x=>x==='granted').length,16);
 assert.equal(lane.status().waitSamples<=64,true);
});

test('abort storms cannot start commands while awaiting CPU admission',{timeout:12000},async()=>{
 const pathOut=path.join(root,'must-not-exist.txt');
 const release=await commandCpuAdmission.acquire();
 const pending=[],controllers=[];
 try{
  for(let i=0;i<12;i++){
   const ac=new AbortController();controllers.push(ac);
   const marker=JSON.stringify(pathOut);
   const code="require('fs').writeFileSync("+marker+",'executed')";
   pending.push(withCallContext({id:'phase11-abort-'+i,client:null,remote:false,signal:ac.signal},
    ()=>runProgram(process.execPath,['-e',code],root,3000)).then(
      x=>({ok:true,data:x}),e=>({ok:false,code:e.code??'CANCELLED'})));
  }
  // Preflight/config validation is asynchronous: wait until each call has
  // either acquired a queue slot or finished its preflight.
  for(let i=0;i<100&&commandCpuAdmission.status().queued<12;i++)await delay(15);
  assert.equal(commandCpuAdmission.status().queued,12);
  for(const ac of controllers)ac.abort(new Error('Cancelled before spawn'));
  const results=await Promise.all(pending);
  assert.ok(results.every(x=>!x.ok),JSON.stringify(results));
  assert.equal(commandCpuAdmission.status().queued,0);
  assert.equal(await fs.stat(pathOut).catch(()=>null),null,'cancelled fixture unexpectedly executed');
 }finally{release();}
 assert.equal(commandCpuAdmission.status().active,0);
});

test('chatty child output never retains more than terminal budget or unlimited completed sessions',{timeout:15000},async()=>{
 // A 9 MiB output fixture: the global cap should retain only its latest
 // 500KiB of text. No model tokens, huge log files or live agent processes.
 const code="process.stdout.write('Z'.repeat(9*1024*1024));";
 const started=await terminalManager.executeCommand(
  'node -e "'+code+'"',1200);
 assert.ok(started.pid>0,JSON.stringify(started));
 let snapshot;
 for(let i=0;i<120;i++){
  snapshot=terminalManager.readOutputPaginated(started.pid,-100000,100000);
  if(snapshot?.isComplete)break;
  await delay(55);
 }
 assert.equal(snapshot?.isComplete,true,'high-output fixture did not finish');
 const chars=snapshot.lines.join('\n').length;

 assert.ok(chars<=MAX_BUFFERED_OUTPUT_CHARS+8192,
  'retained terminal output exceeded bounded cap: '+chars);
 assert.ok(chars>MAX_BUFFERED_OUTPUT_CHARS/4,'fixture did not exercise the cap');
 const recent=terminalManager.getRecentOutput(started.pid,MAX_BUFFERED_OUTPUT_CHARS);
 assert.ok(typeof recent==='string'&&recent.length<=MAX_BUFFERED_OUTPUT_CHARS+1000);
});

test('Windows native job repeated descendant termination does not leak managed handles',{skip:process.platform!=='win32'||!managedSpawnStatus().nativeAvailable,timeout:30000},async()=>{
 const start=managedChildStatus();
 const original='BRC_WIN_JOB_MODE' in process.env?process.env.BRC_WIN_JOB_MODE:undefined;
 process.env.BRC_WIN_JOB_MODE='strict';
 const script="const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},300)'],{stdio:'ignore',windowsHide:true,detached:true}); console.log(child.pid); setInterval(()=>{},300);";
 try{
  for(let i=0;i<8;i++){
   const child=spawnManaged(process.execPath,['-e',script],
    {stdio:['ignore','pipe','pipe'],windowsHide:true});
   let pid=0;
   const pidReady=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('missing descendant pid')),5000);
    let buf='';
    child.stdout.on('data',data=>{
     buf+=data.toString();
     const match=buf.match(/^\s*(\d+)\s/);
     if(match){clearTimeout(timer);resolve(Number(match[1]));}
    });
    child.once('error',reject);
   });
   try{
    pid=await pidReady;
    assert.ok(pid>0);
    const closed=new Promise((resolve,reject)=>{
     const timer=setTimeout(()=>reject(new Error('native wrapper hung')),5000);
     child.once('close',()=>{clearTimeout(timer);resolve();});
    });
    assert.equal(stopManagedChild(child),true);
    assert.equal(stopManagedChild(child),true,'idempotent native stop');
    await closed;
    let live=true;
    for(let j=0;j<30;j++){
     try{process.kill(pid,0);}catch{live=false;break;}
     await delay(60);
    }
    assert.equal(live,false,'descendant survived Job handle close iteration '+i);
   }finally{
    if(child.exitCode===null&&child.signalCode===null)stopManagedChild(child);
    // No PID-only kill after a confirmed descendant exit.
   }
  }
  const done=managedChildStatus();
  assert.equal(done.active,start.active,'owned child handles leaked');
  assert.ok(done.duplicateStopRequests>=start.duplicateStopRequests+8);
 }finally{
  if(original===undefined)delete process.env.BRC_WIN_JOB_MODE;
  else process.env.BRC_WIN_JOB_MODE=original;
 }
});

test('hard agent crash after durable start is recovered uncertain, never automatically replayed',{timeout:10000},async()=>{
 const id='phase11-'+randomUUID();
 const out=path.join(root,'not-executed.txt');
 const modulePath=new URL('../dist/runtime/call-outcomes.js',import.meta.url).href;
 const code=[
  'import {beginCallOutcome} from '+JSON.stringify(modulePath)+';',
  'const result=await beginCallOutcome('+JSON.stringify(id)+',"write_file");',
  'if(!result)process.exit(20);',
  'process.exit(93);'
 ].join('\n');
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],{
  env:{...process.env,BRC_HOME:process.env.BRC_HOME},windowsHide:true,
  encoding:'utf8',timeout:7000});
 assert.equal(child.status,93,child.stderr);
 const recovered=await lookupCallOutcome(id);
 assert.equal(recovered.outcome,'uncertain');
 assert.equal(recovered.recoveredUncertain,true);
 assert.equal(recovered.deliveryToRelayConfirmed,false);
 assert.equal(recovered.automaticReplay,false);
 assert.equal(await fs.stat(out).catch(()=>null),null);
});

test('multibyte terminal output obeys a real 500 KiB UTF-8 budget, not a UTF-16 character count',{timeout:15000},async()=>{
 const code="process.stdout.write('漢'.repeat(290000));";
 const started=await terminalManager.executeCommand('node -e "'+code+'"',1200);
 assert.ok(started.pid>0,JSON.stringify(started));
 let snapshot;
 for(let i=0;i<120;i++){
  snapshot=terminalManager.readOutputPaginated(started.pid,-100000,100000);
  if(snapshot?.isComplete)break;
  await delay(55);
 }
 assert.equal(snapshot?.isComplete,true);
 const buffer=snapshot.lines.join('\n');
 const bytes=Buffer.byteLength(buffer,'utf8');
 assert.ok(bytes<=MAX_BUFFERED_OUTPUT_CHARS+8192,
   'terminal buffer is char-bounded but exceeded 500 KiB in UTF-8 bytes: '+bytes);
});

test('initial output tail preserves valid astral characters within a 500 KiB byte cap',()=>{
 const tail=keepRecentTerminalOutput('🚀'.repeat(300000),'a');
 assert.ok(Buffer.byteLength(tail,'utf8')<=500*1024);
 assert.equal(tail.endsWith('a'),true);
 assert.equal(/[\ud800-\udfff]/.test(tail.replace(/🚀/g,'')),false,
  'output trim left a dangling UTF-16 surrogate');
 assert.ok(!tail.includes('�'));
 let rolling='';
 for(let i=0;i<45;i++)
  rolling=keepRecentTerminalOutput(rolling,'漢'.repeat(18000));
 assert.ok(Buffer.byteLength(rolling,'utf8')<=500*1024);
 assert.equal(rolling.endsWith('漢'.repeat(18000)),true);
});

test('astral UTF-8 stream preserves surrogate boundaries when wrapping long lines',{timeout:15000},async()=>{
 const code="process.stdout.write(String.fromCodePoint(0x1F680).repeat(270000));";
 const session=await terminalManager.executeCommand('node -e "'+code+'"',1200);
 assert.ok(session.pid>0,JSON.stringify(session));
 let page;
 for(let i=0;i<100;i++){
  page=terminalManager.readOutputPaginated(session.pid,-100000,100000);
  if(page?.isComplete)break;
  await delay(50);
 }
 assert.equal(page?.isComplete,true);
 assert.ok(page.lines.length>5);
 const all=page.lines.join('\n');
 assert.ok(Buffer.byteLength(all,'utf8')<=500*1024+4);
 for(const line of page.lines){
  if(!line.length)continue;
  const first=line.charCodeAt(0),last=line.charCodeAt(line.length-1);
  assert.ok(!(first>=0xdc00&&first<=0xdfff),'wrapped line begins on lone low surrogate');
  assert.ok(!(last>=0xd800&&last<=0xdbff),'wrapped line ends on lone high surrogate');
 }
});
