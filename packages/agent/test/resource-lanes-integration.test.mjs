import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';

const tmp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-resource-lanes-'));
const root=path.join(tmp,'project');
await fs.mkdir(root,{recursive:true});
await fs.writeFile(path.join(root,'fixture.py'),
  'def phase7_fixture():\n    return "lane_needle"\n');
process.env.BRC_HOME=path.join(tmp,'home');
process.env.BRC_ERROR_LOG='0';
process.env.BRC_LOG_LEVEL='silent';
const saved={
 cpu:process.env.BRC_SHARED_CPU_BUDGET,
 io:process.env.BRC_SHARED_IO_BUDGET,
 startup:process.env.BRC_SHARED_PROCESS_START_BUDGET,
};
process.env.BRC_SHARED_CPU_BUDGET='1';
process.env.BRC_SHARED_IO_BUDGET='1';
process.env.BRC_SHARED_PROCESS_START_BUDGET='1';

const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {commandCpuAdmission,searchIoAdmission,pluginStartupAdmission}=
  await import('../dist/runtime/resource-admission.js');
const {parseInWorker,parserStatus,closeParserWorkers}=
  await import('../dist/runtime/parser-pool.js');
const {searchManager}=await import('../dist/core/search-manager.js');
const {callTool}=await import('../dist/dispatcher.js');
const {withCallContext}=await import('../dist/context.js');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
after(async()=>{
 closeParserWorkers();
 for(const s of searchManager.listSearchSessions())searchManager.terminateSearch(s.id);
 await sleep(80);
 for(const [key,value] of Object.entries(saved)){
  const name={cpu:'BRC_SHARED_CPU_BUDGET',io:'BRC_SHARED_IO_BUDGET',
    startup:'BRC_SHARED_PROCESS_START_BUDGET'}[key];
  if(value===undefined)delete process.env[name];else process.env[name]=value;
 }
 await configManager.close();
 await fs.rm(tmp,{recursive:true,force:true,maxRetries:8,retryDelay:90});
});

test('parser thread waits behind the same CPU permit as one-shot commands',async()=>{
 closeParserWorkers();
 const release=await commandCpuAdmission.acquire();
 const pending=parseInWorker('python','python','def phase7_fixture():\n    return 7\n');
 await sleep(25);
 assert.equal(commandCpuAdmission.status().active,1);
 assert.equal(commandCpuAdmission.status().queued,1);
 assert.equal(parserStatus().workers,0,'must not spawn parser thread before admission');
 release();
 const parsed=await pending;
 assert.ok(Array.isArray(parsed.symbols),JSON.stringify(parsed));
 assert.ok(parsed.symbols.some(s=>s.name==='phase7_fixture'));
 assert.equal(commandCpuAdmission.status().active,0);
 assert.equal(commandCpuAdmission.status().queued,0);
});

test('cancelled parser while waiting for CPU slot never spawns a new worker',async()=>{
 closeParserWorkers();
 const release=await commandCpuAdmission.acquire();
 const abort=new AbortController();
 const pending=withCallContext({
  id:'phase7-parser-cancel',remote:false,client:null,signal:abort.signal
 },()=>parseInWorker('python','python','def never_started():\n    return 10\n'));
 await sleep(15);
 assert.equal(commandCpuAdmission.status().queued,1);
 abort.abort(new Error('parser canceled before admission'));
 await assert.rejects(pending,/parser canceled before admission/);
 assert.equal(commandCpuAdmission.status().queued,0);
 assert.equal(parserStatus().workers,0);
 release();
 assert.equal(commandCpuAdmission.status().active,0);
});

test('I/O search admission queues without launching ripgrep and releases when process exits',async()=>{
 const release1=await searchIoAdmission.acquire();
 const release2=await searchIoAdmission.acquire();
 assert.equal(searchIoAdmission.status().active,2);
 const pending=searchManager.startSearch({
  rootPath:root,pattern:'lane_needle',literalSearch:true,
  searchType:'content',maxResults:15,timeout:4000,skipInitialWait:true
 });
 await sleep(30);
 assert.equal(searchIoAdmission.status().queued,1);
 assert.equal(searchManager.getActiveSessionCount(),0,
   'no ripgrep process should start before acquiring I/O permit');
 release1();release2();
 const started=await pending;
 assert.ok(started.sessionId);
 for(let i=0;i<35;i++){
  const data=searchManager.readSearchResults(started.sessionId,0,20);
  if(data.isComplete){
   assert.ok(data.results.some(r=>String(r.lineText??'').includes('lane_needle')));
   break;
  }
  await searchManager.waitForActivity(started.sessionId,100);
 }
 await sleep(30);
 assert.equal(searchIoAdmission.status().active,0,
   'I/O slot must be released on real ripgrep exit rather than on request return');
 assert.equal(searchIoAdmission.status().queued,0);
});

test('cancelled search in I/O queue releases its existing search reservation',async()=>{
 const release1=await searchIoAdmission.acquire();
 const release2=await searchIoAdmission.acquire();
 const abort=new AbortController();
 const pending=withCallContext({
  id:'phase7-search-cancel',remote:false,client:null,signal:abort.signal
 },()=>searchManager.startSearch({
  rootPath:root,pattern:'never_started',searchType:'content',literalSearch:true,
  timeout:4000,maxResults:10,skipInitialWait:true
 }));
 await sleep(20);
 assert.equal(searchIoAdmission.status().queued,1);
 abort.abort(new Error('I/O search canceled before spawn'));
 await assert.rejects(pending,/I\/O search canceled before spawn/);
 release1();release2();
 assert.equal(searchIoAdmission.status().queued,0);
 assert.equal(searchIoAdmission.status().active,0);
 assert.equal(searchManager.getActiveSessionCount(),0);
});

test('local plugin startup lane has bounded concurrency; never holds permit indefinitely',async()=>{
 const start1=await pluginStartupAdmission.acquire();
 const start2=await pluginStartupAdmission.acquire();
 const waiting=pluginStartupAdmission.acquire(undefined,250);
 await sleep(15);
 assert.equal(pluginStartupAdmission.status().active,2);
 assert.equal(pluginStartupAdmission.status().queued,1);
 start1();
 const third=await waiting;
 assert.equal(pluginStartupAdmission.status().active,2);
 start2();third();
 assert.equal(pluginStartupAdmission.status().active,0);
});

test('agent_status exposes all three resource lanes without leaking arguments or source text',async()=>{
 const r=await callTool('agent_status',{});
 assert.equal(r.isError,false,JSON.stringify(r.structuredContent?.error));
 const lanes=r.structuredContent?.resourceLanes;
 assert.equal(lanes.cpu.enabled,true);
 assert.equal(lanes.searchIo.enabled,true);
 assert.equal(lanes.pluginStartup.enabled,true);
 assert.equal(lanes.cpu.maxActive,1);
 assert.equal(lanes.searchIo.maxActive,2);
 assert.equal(lanes.pluginStartup.maxActive,2);
 for(const lane of Object.values(lanes)){
   assert.ok(lane.waitSamples>=0&&lane.waitSamples<=64);
   assert.ok(lane.waitP50Ms>=0&&lane.waitP95Ms>=lane.waitP50Ms);
 }
 const activity=r.structuredContent?.managedActivity;
 for(const key of ['terminalSessions','ripgrepProcesses','parserWorkers','semanticWorker','pluginConnections'])
   assert.ok(Number.isInteger(activity[key])&&activity[key]>=0,key);
 const serialized=JSON.stringify(lanes);
 assert.ok(!serialized.includes('lane_needle'));
 assert.ok(!serialized.includes(root));
});


test('interactive terminal cannot spawn before startup admission but frees permit once launched',async()=>{
 const {terminalManager}=await import('../dist/core/terminal-manager.js');
 const r1=await pluginStartupAdmission.acquire();
 const r2=await pluginStartupAdmission.acquire();
 const launch=terminalManager.executeCommand(
  'node -e "console.log(2042)"',1200);
 await sleep(30);
 assert.equal(pluginStartupAdmission.status().queued,1);
 assert.equal(terminalManager.listActiveSessions().length,0);
 r1();r2();
 const started=await launch;
 assert.ok(started.pid>0,JSON.stringify(started));
 assert.equal(pluginStartupAdmission.status().queued,0);
 assert.equal(pluginStartupAdmission.status().active,0,
  'long-lived terminal session must not hold the short startup permit');
 // The terminal may already have exited. Observability remains via the
 // completed-session log, not a duplicate restart of the test command.
 let logged='';
 for(let i=0;i<20;i++){
  logged=terminalManager.getRecentOutput(started.pid,200)??logged;
  if(logged.includes('2042'))break;
  await sleep(40);
 }
 assert.match(logged,/2042/);
});

test('optional TS semantic worker uses the same startup gate without retaining it while warm',async()=>{
 const {semanticTsManager}=await import('../dist/runtime/semantic-ts-host.js');
 const prev=process.env.BRC_TS_SEMANTIC;
 process.env.BRC_TS_SEMANTIC='1';
 semanticTsManager.close();
 const source='export function phase7Semantic(n:number){return n+1;}\nphase7Semantic(1);\n';
 await fs.writeFile(path.join(root,'semantic.ts'),source);
 await fs.writeFile(path.join(root,'tsconfig.json'),JSON.stringify({
  compilerOptions:{target:'ES2022',module:'CommonJS',noEmit:true,skipLibCheck:true},
  files:['semantic.ts']
 }));
 const r1=await pluginStartupAdmission.acquire();
 const r2=await pluginStartupAdmission.acquire();
 try{
  const pending=semanticTsManager.query(
   root,'semantic.ts','phase7Semantic',2,source.split('\n')[1].indexOf('phase7Semantic')+1,15);
  await sleep(30);
  assert.equal(pluginStartupAdmission.status().queued,1);
  assert.equal(semanticTsManager.status().activeProcess,false);
  r1();r2();
  const res=await pending;
  assert.ok(res.references.length>=2,JSON.stringify(res));
  assert.equal(pluginStartupAdmission.status().queued,0);
  assert.equal(pluginStartupAdmission.status().active,0);
  assert.equal(semanticTsManager.status().activeProcess,true);
 }finally{
  r1();r2();
  semanticTsManager.close();
  if(prev===undefined)delete process.env.BRC_TS_SEMANTIC;
  else process.env.BRC_TS_SEMANTIC=prev;
 }
});


test('TypeScript main-thread AST parsing also waits behind active CPU-heavy commands',async()=>{
 const {parseSource}=await import('../dist/runtime/code-structure.js');
 const release=await commandCpuAdmission.acquire();
 const pending=parseSource(path.join(root,'phase7-syntax.ts'),
  'export const phase7Cpu = 27;\n','hash-fixture');
 await sleep(25);
 assert.equal(commandCpuAdmission.status().active,1);
 assert.equal(commandCpuAdmission.status().queued,1,
  'TypeScript AST creation should not race the active CPU-heavy command');
 release();
 const parsed=await pending;
 assert.equal(parsed.provider,'typescript');
 assert.ok(parsed.symbols.some(s=>s.name==='phase7Cpu'));
 assert.equal(commandCpuAdmission.status().active,0);
 assert.equal(commandCpuAdmission.status().queued,0);
});
