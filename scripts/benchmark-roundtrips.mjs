// Real loopback HTTP MCP -> relay -> WebSocket -> agent benchmark. Temporary fixtures; stdout only.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {buildRelay} from '../packages/relay/dist/app.js';
const N=32,ROUNDS=3,sleep=ms=>new Promise(r=>setTimeout(r,ms));
const sha=s=>createHash('sha256').update(s).digest('hex');
const dir=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-io-bench-'));
const project=path.join(dir,'project'),home=path.join(dir,'agent');await fs.mkdir(project);
const source=i=>`// fixture ${i}\nexport function sample${i}() { return ${i}; }\n`;
for(let i=0;i<N;i++){await fs.writeFile(path.join(project,`read-${i}.ts`),source(i));await fs.writeFile(path.join(project,`single-${i}.txt`),'baseline');await fs.writeFile(path.join(project,`batch-${i}.txt`),'baseline');await fs.writeFile(path.join(project,`parallel-${i}.txt`),'baseline');}
const relay=await buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3210',trustProxy:false,dbFile:path.join(dir,'relay.sqlite'),sessionSecret:randomBytes(20).toString('hex'),adminUser:'benchmark',adminPassword:randomBytes(20).toString('hex'),relayVersion:'benchmark'},()=>{});
await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
const url=`http://127.0.0.1:${relay.http.address().port}`,u=relay.store.getUserByName('benchmark');
const token=relay.store.issueDeviceToken('bench-device',u.id,'Benchmark','win32'),key=relay.store.createApiKey(u.id,'temporary benchmark');
const child=spawn(process.execPath,[path.resolve('packages/agent/dist/cli.js'),'--relay',url,'--device-id','bench-device','--name','Benchmark','--no-browser','--allow-dir',project],{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,BRC_HOME:home,BRC_TOKEN:token,BRC_LOG_LEVEL:'silent',BRC_DEBUG:'0'}});
let childOutput='',seq=0;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>childOutput=(childOutput+b).slice(-2000));
const median=values=>[...values].sort((a,b)=>a-b)[Math.floor(values.length/2)];
const elapsed=async fn=>{const start=performance.now();await fn();return +(performance.now()-start).toFixed(2);};
async function rpc(method,params){
 const response=await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:`Bearer ${key.raw}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params}),signal:AbortSignal.timeout(30000)});
 const text=await response.text();assert.equal(response.status,200,text);
 const messages=text.trim().startsWith('{')?[JSON.parse(text)]:text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
 const answer=messages.find(m=>m.result!==undefined||m.error!==undefined);assert.ok(answer,text);assert.equal(answer.error,undefined,JSON.stringify(answer));return answer.result;
}
async function tool(name,args={}){const out=await rpc('tools/call',{name,arguments:args});assert.equal(out.isError,false,JSON.stringify(out));return out;}
try{
 const start=Date.now();while(relay.hub.list().length===0){if(child.exitCode!==null||Date.now()-start>20000)throw new Error('Benchmark agent did not connect: '+childOutput);await sleep(30);}
 await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'local-benchmark',version:'1'}});
 const before=await tool('agent_status');await tool('read_code_file',{path:path.join(project,'read-0.ts'),length:20});
 const singleReads=[],batchReads=[],workspaceReads=[],singleWrites=[],workspaceWrites=[],parallelWrites=[];
 let last='baseline';
 for(let round=0;round<ROUNDS;round++){
  singleReads.push(await elapsed(async()=>{for(let i=0;i<N;i++){const out=await tool('read_code_file',{path:path.join(project,`read-${i}.ts`),length:20});assert.equal(out.structuredContent.sha256,sha(source(i)));}}));
  batchReads.push(await elapsed(async()=>{const out=await tool('batch_tools',{calls:Array.from({length:N},(_,i)=>({tool:'read_code_file',arguments:{path:path.join(project,`read-${i}.ts`),length:20}}))});assert.equal(out.structuredContent.executed,N);assert.equal(out.structuredContent.skipped,0);}));
  workspaceReads.push(await elapsed(async()=>{const out=await tool('workspace_batch',{path:project,reads:Array.from({length:N},(_,i)=>({path:`read-${i}.ts`,length:20}))});assert.equal(out.structuredContent.reads.length,N);}));
  const next=`verified write round ${round}\n`;
  singleWrites.push(await elapsed(async()=>{for(let i=0;i<N;i++)await tool('write_file',{path:path.join(project,`single-${i}.txt`),mode:'rewrite',expected_sha256:sha(last),content:next});}));
  workspaceWrites.push(await elapsed(async()=>{const out=await tool('workspace_batch',{path:project,dryRun:false,changes:Array.from({length:N},(_,i)=>({path:`batch-${i}.txt`,expected_sha256:sha(last),content:next})),reads:Array.from({length:N},(_,i)=>({path:`batch-${i}.txt`,length:20}))});assert.equal(out.structuredContent.changes.length,N);assert.equal(out.structuredContent.reads.length,N);assert.ok(out.structuredContent.reads.every(r=>r.sha256===sha(next)));}));
  parallelWrites.push(await elapsed(async()=>{const out=await tool('workspace_batch',{path:project,dryRun:false,writeConcurrency:4,changes:Array.from({length:N},(_,i)=>({path:`parallel-${i}.txt`,expected_sha256:sha(last),content:next})),reads:Array.from({length:N},(_,i)=>({path:`parallel-${i}.txt`,length:20}))});assert.equal(out.structuredContent.writeConcurrency,4);assert.equal(out.structuredContent.changes.length,N);assert.ok(out.structuredContent.reads.every(r=>r.sha256===sha(next)));}));
  for(let i=0;i<N;i++)assert.equal(await fs.readFile(path.join(project,`single-${i}.txt`),'utf8'),next);
  last=next;
 }
 const after=await tool('agent_status');
 console.log(JSON.stringify({fixture:`${N} small files`,transport:'loopback HTTP MCP + relay + WebSocket + separate agent process',rounds:ROUNDS,
  read:{separateCalls:N,separateMedianMs:median(singleReads),autoBatchCalls:1,autoBatchMedianMs:median(batchReads),workspaceCalls:1,workspaceMedianMs:median(workspaceReads)},
  write:{separateCalls:N,separateMedianMs:median(singleWrites),workspaceCalls:1,workspaceWriteAndReadbackMedianMs:median(workspaceWrites),parallelWriteConcurrency:4,parallelWriteAndReadbackMedianMs:median(parallelWrites)},
  agentRssMiB:{before:+(before.structuredContent.memoryBytes/1048576).toFixed(1),after:+(after.structuredContent.memoryBytes/1048576).toFixed(1)},managedContextBytes:after.structuredContent.resources.estimatedRetainedContextBytes,
  caveat:'Local synthetic timings only, not measured Internet/ChatGPT latency. Model generation and deployment network are excluded. No blanket production speedup or hard RSS guarantee.'},null,2));
}finally{
 const exited=child.exitCode!==null?Promise.resolve():once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,sleep(2000)]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([exited,sleep(1000)]);}
 relay.http.closeAllConnections();await relay.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});
}
