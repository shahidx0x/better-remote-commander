import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync} from 'node:fs';
import {WebSocketServer} from 'ws';
// Isolated home BEFORE any dist import: never touch the real ~/.brc.
const home=mkdtempSync(path.join(os.tmpdir(),'brc-ops-home-'));
process.env.BRC_HOME=home;
delete process.env.BRC_ERROR_LOG;
const {callTool,listTools}=await import('../dist/dispatcher.js');
const {runBatch,BatchSchema}=await import('../dist/runtime/fast-batch.js');
const {WsClient}=await import('../dist/transport/ws-client.js');
const {OperationScheduler}=await import('../dist/runtime/operations.js');
const failureLog=await import('../dist/runtime/failure-log.js');
const limits=await import('../dist/runtime/resource-limits.js');
const {withCallContext}=await import('../dist/context.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mk=async()=>fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(),'brc-ops-')));
const ok=r=>({content:[{type:'text',text:'ok'}],structuredContent:{ok:true}});
after(()=>{limits.stopResourceMaintenance();});

/* ---------------- batch_tools ---------------- */
test('batch_tools / agent_status / cancel_operation are advertised',()=>{
  const names=listTools().map(t=>t.name);
  for(const n of ['batch_tools','agent_status','cancel_operation'])assert.ok(names.includes(n),n);
  const batch=listTools().find(t=>t.name==='batch_tools');
  for(const mentioned of batch.description.match(/\b[a-z]+(?:_[a-z]+)+\b/g)??[])
    if(/^(read|list|get|write|edit|create|move|find|project|code|context|related|language|discover|workspace)_/.test(mentioned))
      assert.ok(names.includes(mentioned),'description mentions missing tool '+mentioned);
});

test('ordered write barrier: write then read sees the new content; stopOnError skips the rest',async()=>{
  const d=await mk(),f=path.join(d,'a.txt');
  const r=await callTool('batch_tools',{calls:[
    {tool:'write_file',arguments:{path:f,content:'one\n',mode:'rewrite'}},
    {tool:'read_file',arguments:{path:f}},
    {tool:'read_file',arguments:{path:path.join(d,'missing.txt')}},
    {tool:'write_file',arguments:{path:f,content:'two\n',mode:'rewrite'}},
  ]});
  const b=r.structuredContent;
  assert.equal(b.results[0].isError,false,JSON.stringify(b.results[0]));
  assert.match(JSON.stringify(b.results[1]),/one/,'compact mode must keep the text a read tool returns');
  assert.equal(b.results[2].isError,true);
  assert.equal(b.skipped,1);assert.equal(b.executed,3);assert.equal(r.isError,true);
  assert.equal(await fs.readFile(f,'utf8'),'one\n');
});

test('reads overlap up to the concurrency cap; barriers run alone and in order',async()=>{
  let live=0,peak=0;const log=[];
  const invoke=async(tool,args)=>{
    log.push('start:'+args.n);live++;peak=Math.max(peak,live);
    await sleep(tool==='write_file'?5:30);
    live--;log.push('end:'+args.n);return ok();
  };
  const calls=[0,1,2,3,4].map(n=>({tool:'read_file',arguments:{n}}));
  calls.push({tool:'write_file',arguments:{n:5}},{tool:'read_file',arguments:{n:6}});
  const r=await runBatch({calls,concurrency:3},invoke);
  assert.equal(peak,3);assert.equal(r.structuredContent.executed,7);
  const w=log.indexOf('start:5');
  for(const n of [0,1,2,3,4])assert.ok(log.indexOf('end:'+n)<w,'read '+n+' finished before the write');
  assert.ok(log.indexOf('start:6')>log.indexOf('end:5'),'read after the write starts after it ends');
  // sequential never overlaps
  live=0;peak=0;await runBatch({calls:calls.slice(0,4),mode:'sequential'},invoke);assert.equal(peak,1);
});

test('parallel mode refuses writes; denied tools; nesting; caps',async()=>{
  const inv=async()=>ok();
  await assert.rejects(runBatch({mode:'parallel',calls:[{tool:'write_file',arguments:{}}]},inv),/PARALLEL|Parallel/);
  for(const bad of ['start_process','set_config_value','kill_process','spawn_job','run_parallel','call_plugin_tool'])
    await assert.rejects(runBatch({calls:[{tool:bad,arguments:{}}]},inv),e=>e.code==='BATCH_TOOL_DENIED',bad);
  await assert.rejects(runBatch({calls:[{tool:'batch_tools',arguments:{calls:[]}}]},inv),e=>e.code==='NESTED_BATCH');
  // a call already inside a batch (depth>0) cannot start another one
  await assert.rejects(withCallContext({id:'x',client:null,remote:false,depth:1},()=>runBatch({calls:[{tool:'read_file',arguments:{}}]},inv)),e=>e.code==='NESTED_BATCH');
  // size caps
  assert.throws(()=>BatchSchema.parse({calls:[]}));
  assert.throws(()=>BatchSchema.parse({calls:Array.from({length:65},()=>({tool:'read_file',arguments:{}}))}));
  assert.throws(()=>BatchSchema.parse({calls:[{tool:'read_file',arguments:{}}],concurrency:5}));
  assert.throws(()=>BatchSchema.parse({calls:[{tool:'read_file',arguments:{}}],maxChars:10}));
  await assert.rejects(runBatch({calls:[{tool:'write_file',arguments:{content:'x'.repeat(4.2*1024*1024)}}]},inv),e=>e.code==='BATCH_TOO_LARGE');
});

test('batch output is bounded: long entries truncated, later calls skipped',async()=>{
  const big=async()=>({content:[{type:'text',text:'y'.repeat(200000)}],structuredContent:{blob:'y'.repeat(200000)}});
  const r=await runBatch({calls:Array.from({length:6},()=>({tool:'read_file',arguments:{}})),maxChars:4000,stopOnError:false},big);
  const text=JSON.stringify(r.structuredContent);
  assert.ok(text.length<12000,'bounded, got '+text.length);
  assert.equal(r.structuredContent.results[0].truncated,true);
  assert.equal(r.structuredContent.outputLimited,true);assert.ok(r.structuredContent.skipped>0);
  // images are never inlined
  const img=await runBatch({calls:[{tool:'read_file',arguments:{}}],compact:false},async()=>({content:[{type:'image',data:'AAAA',mimeType:'image/png'}]}));
  assert.ok(!JSON.stringify(img).includes('AAAA'));
});

test('nested calls are re-validated by the dispatcher; jobs cannot run batch_tools',async()=>{
  const r=await callTool('batch_tools',{calls:[{tool:'write_file',arguments:{path:'x.txt',content:'1',expected_sha256:'nothex'}}]});
  assert.equal(r.structuredContent.results[0].isError,true);
  assert.match(JSON.stringify(r.structuredContent.results[0]),/INVALID_ARGUMENT/);
  const j=await callTool('run_parallel',{calls:[{tool:'batch_tools',args:{calls:[{tool:'list_directory',arguments:{path:home}}]}}]});
  assert.match(JSON.stringify(j),/NESTED_BATCH/);
});

/* ---------------- scheduler / ws-client ---------------- */
test('OperationScheduler: BUSY, duplicate ids, deadline includes queue time',async()=>{
  const s=new OperationScheduler(1,1);let release;const gate=new Promise(r=>release=r);
  const a=s.run('s-a','slow',5000,()=>gate);
  const b=s.run('s-b','slow',60,async()=>ok());
  await assert.rejects(s.run('s-c','slow',1000,async()=>ok()),e=>e.code==='BUSY'&&e.retryable);
  await assert.rejects(s.run('s-a','slow',1000,async()=>ok()),e=>e.code==='DUPLICATE_CALL');
  await assert.rejects(b,e=>e.code==='TIMEOUT'); // expired while still queued
  release();await a;
});

async function fakeRelay(){
  const wss=new WebSocketServer({port:0,host:'127.0.0.1'});
  await new Promise(r=>wss.on('listening',r));
  const results=new Map(),waiters=new Map();let sock;
  const connected=new Promise(res=>wss.on('connection',ws=>{
    sock=ws;
    ws.on('message',d=>{
      const m=JSON.parse(d);
      if(m.type==='hello')ws.send(JSON.stringify({type:'welcome',protocol:m.protocol,relayVersion:'t',serverTime:Date.now()}));
      if(m.type==='welcome'||m.type==='hello')res();
      if(m.type==='result'){results.set(m.id,m.result);waiters.get(m.id)?.(m.result);}
    });
  }));
  return {wss,port:wss.address().port,connected,results,
    call:(id,tool,args={},timeoutMs)=>sock.send(JSON.stringify({type:'call',id,tool,args,timeoutMs})),
    cancel:id=>sock.send(JSON.stringify({type:'cancel',id})),
    result:id=>results.has(id)?Promise.resolve(results.get(id)):new Promise(r=>waiters.set(id,r)),
    close:()=>{sock?.terminate();wss.close();}};
}

test('remote calls: bounded queue, BUSY, agent_status shows queued+running, cancel_operation cancels both',async()=>{
  const relay=await fakeRelay();
  const started=[],releases=new Map();
  const callToolImpl=async(name,args)=>{
    if(name!=='slow')return callTool(name,args);
    started.push(args.n);
    await new Promise(r=>releases.set(args.n,r)); // deliberately ignores the abort signal
    return {content:[{type:'text',text:'done '+args.n}]};
  };
  const client=new WsClient({relayUrl:'http://127.0.0.1:'+relay.port,token:'t',deviceId:'d',name:'n',agentVersion:'1',coreVersion:'1',tools:[],callTool:callToolImpl,concurrency:1,queueLimit:2});
  client.start();
  try{
    await relay.connected;await sleep(100);
    relay.call('A','slow',{n:'A'});await sleep(50);
    relay.call('B','slow',{n:'B'});relay.call('C','slow',{n:'C'});await sleep(50);
    relay.call('D','slow',{n:'D'}); // 1 running + 2 queued = full
    const d=await relay.result('D');
    assert.equal(d.isError,true);assert.equal(d.structuredContent.error.code,'BUSY');assert.equal(d.structuredContent.error.retryable,true);
    assert.deepEqual(started,['A']);
    // agent_status bypasses the full queue
    relay.call('S1','agent_status');
    const s=(await relay.result('S1')).structuredContent;
    const byId=Object.fromEntries(s.operations.map(o=>[o.id,o]));
    assert.equal(byId.A.state,'running');assert.equal(byId.B.state,'queued');assert.equal(byId.C.state,'queued');
    assert.equal(s.queue.active,1);assert.equal(s.queue.queued,2);assert.equal(s.queue.concurrency,1);
    assert.ok(!JSON.stringify(s).includes('"n":'),'no tool arguments in status');
    // cancel a QUEUED call through the tool: it never starts
    relay.call('X1','cancel_operation',{callId:'B'});
    assert.equal((await relay.result('X1')).structuredContent.cancelRequested,true);
    const b=await relay.result('B');
    assert.equal(b.structuredContent.error.code,'CANCELLED');
    // cancel the RUNNING call: answered immediately even though the task ignores the signal
    relay.call('X2','cancel_operation',{callId:'A'});
    assert.equal((await relay.result('X2')).structuredContent.cancelRequested,true);
    const a=await relay.result('A');
    assert.equal(a.structuredContent.error.code,'CANCELLED');
    assert.deepEqual(started,['A'],'B never started; C still waits because the slot is held until A settles');
    releases.get('A')();
    await sleep(100);
    assert.deepEqual(started,['A','C']);
    // unknown id and self-cancel
    relay.call('X3','cancel_operation',{callId:'nope'});
    assert.equal((await relay.result('X3')).structuredContent.cancelRequested,false);
    relay.call('X4','cancel_operation',{callId:'X4'});
    assert.equal((await relay.result('X4')).isError,true);
    // relay 'cancel' message still works (existing protocol)
    relay.cancel('C');
    assert.equal((await relay.result('C')).structuredContent.error.code,'CANCELLED');
    releases.get('C')();
    await sleep(50);
    assert.equal(client.status().inFlight,0);
  }finally{client.stop();relay.close();}
});

test('remote deadline includes queue time and settings pause is preserved',async()=>{
  const relay=await fakeRelay();const started=[];let release;
  const callToolImpl=async(name,args)=>{started.push(args.n);if(args.n==='A')await new Promise(r=>release=r);return {content:[{type:'text',text:'ok'}]};};
  const client=new WsClient({relayUrl:'http://127.0.0.1:'+relay.port,token:'t',deviceId:'d',name:'n',agentVersion:'1',coreVersion:'1',tools:[],callTool:callToolImpl,concurrency:1});
  client.start();
  try{
    await relay.connected;await sleep(100);
    relay.call('A','t',{n:'A'});await sleep(30);
    relay.call('Q','t',{n:'Q'},1500); // relay timeout 1.5s -> agent deadline 1s (min), all spent queued
    const q=await relay.result('Q');
    assert.equal(q.structuredContent.error.code,'TIMEOUT');
    assert.deepEqual(started,['A']);
    assert.equal(client.pauseForSettings(),false,'busy agent refuses to pause');
    release();await sleep(50);
    assert.equal(client.pauseForSettings(),true);
    relay.call('P','t',{n:'P'});
    assert.equal((await relay.result('P')).structuredContent.error.code,'SETTINGS_OPEN');
    client.resumeAfterSettings();
  }finally{client.stop();relay.close();}
});

test('BRC_MAX_CONCURRENCY is honoured and capped at 16',()=>{
  process.env.BRC_MAX_CONCURRENCY='99';
  const c=new WsClient({relayUrl:'http://127.0.0.1:1',token:'t',deviceId:'d',name:'n',agentVersion:'1',coreVersion:'1',tools:[],callTool:async()=>ok()});
  assert.equal(c.scheduler.concurrency,16);
  process.env.BRC_MAX_CONCURRENCY='3';
  assert.equal(new WsClient({relayUrl:'http://127.0.0.1:1',token:'t',deviceId:'d',name:'n',agentVersion:'1',coreVersion:'1',tools:[],callTool:async()=>ok()}).scheduler.concurrency,3);
  delete process.env.BRC_MAX_CONCURRENCY;
  assert.equal(new WsClient({relayUrl:'http://127.0.0.1:1',token:'t',deviceId:'d',name:'n',agentVersion:'1',coreVersion:'1',tools:[],callTool:async()=>ok()}).scheduler.concurrency,4);
});

/* ---------------- failure log ---------------- */
test('failure log is off by default: nothing is written',async()=>{
  delete process.env.BRC_ERROR_LOG;
  await callTool('read_file',{path:path.join(home,'nope-default.txt')});
  failureLog.recordToolFailure({tool:'read_file',code:'TOOL_FAILED',durationMs:1,callId:'abc'});
  await failureLog.flushToolFailureLogs();
  await assert.rejects(fs.stat(failureLog.failureLogPath()));
  const s=(await callTool('agent_status',{})).structuredContent;
  assert.deepEqual(s.recentFailures,[]);assert.equal(s.logging.mode,'live-only');
});

test('failure log (opt-in) is bounded and free of arguments, paths and content',async()=>{
  process.env.BRC_ERROR_LOG='1';
  try{
    const secret='TOPSECRET-'+Date.now();
    await callTool('read_file',{path:path.join(home,secret,'x.txt')});
    const nameSecret='NAMESECRET'+Date.now();
    await callTool('definitely_not_a_tool_'+nameSecret,{content:secret});
    for(let i=0;i<250;i++)failureLog.recordToolFailure({tool:'read_file',code:'TOOL_FAILED',durationMs:i,callId:'id-'+i+'/'+secret+'\\..\\x'});
    await failureLog.flushToolFailureLogs();
    const file=failureLog.failureLogPath();
    const text=await fs.readFile(file,'utf8');
    const lines=text.trim().split('\n');
    assert.ok(lines.length<=failureLog.MAX_FAILURE_LOG_ENTRIES,'bounded: '+lines.length);
    assert.ok(!text.includes(secret),'no arguments/paths/content');
    assert.ok(!text.includes(nameSecret),'caller-chosen unknown tool names are not recorded');
    assert.ok(!text.includes(home));
    for(const l of lines){const e=JSON.parse(l);assert.deepEqual(Object.keys(e).sort(),['callId','code','durationMs','reason','timestamp','tool']);assert.ok(e.callId.length<=16);}
    const s=(await callTool('agent_status',{})).structuredContent;
    assert.ok(s.recentFailures.length>0&&s.recentFailures.length<=20);
    assert.ok(!JSON.stringify(s).includes(secret));assert.equal(s.logging.mode,'live-plus-opt-in-failure-metadata');
  }finally{delete process.env.BRC_ERROR_LOG;}
});

test('a tampered or oversized failure file cannot grow output or smuggle fields',async()=>{
  process.env.BRC_ERROR_LOG='1';
  try{
    const file=failureLog.failureLogPath();
    await fs.writeFile(file,JSON.stringify({tool:'read_file',code:'TOOL_FAILED',durationMs:1,callId:'z',extra:'LEAK-ME',reason:'LEAK-ME'})+'\nnot json\n');
    failureLog.recordToolFailure({tool:'read_file',code:'BUSY',durationMs:1,callId:'q'});
    await failureLog.flushToolFailureLogs();
    const text=await fs.readFile(file,'utf8');
    assert.ok(!text.includes('LEAK-ME'));assert.match(text,/BUSY/);
    await fs.writeFile(file,'x'.repeat(2*1024*1024)); // oversized: ignored, then replaced by a small bounded file
    failureLog.recordToolFailure({tool:'read_file',code:'BUSY',durationMs:1,callId:'q'});
    await failureLog.flushToolFailureLogs();
    assert.ok((await fs.stat(file)).size<20000);
  }finally{delete process.env.BRC_ERROR_LOG;}
});

/* ---------------- resource maintenance ---------------- */
test('resource maintenance timer is unref\'d, idempotent and stoppable',async()=>{
  await limits.startResourceMaintenance(20);await limits.startResourceMaintenance(20);
  assert.equal(limits.resourceMaintenanceRunning(),true);
  await sleep(70);
  const st=limits.cacheStatus();
  assert.equal(st.cleanupErrors,0);assert.ok(st.estimatedRetainedContextBytes>=0);
  limits.stopResourceMaintenance();
  assert.equal(limits.resourceMaintenanceRunning(),false);
  limits.reclaimCaches(Date.now(),true);
});
