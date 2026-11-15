// Real HTTP MCP -> relay -> WebSocket -> compiled agent CLI, using disposable state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {buildRelay} from '../../relay/dist/app.js';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=15000){const start=Date.now();while(Date.now()-start<ms){if(await fn())return;await sleep(30);}throw new Error('Timed out waiting for integration fixture');}

test('real MCP coding workflow, cancellation and bounded live diagnostics',{timeout:45000},async t=>{
 const dir=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-transport-test-'));
 const project=path.join(dir,'project'),home=path.join(dir,'agent');await fs.mkdir(project);
 const p=path.join(project,'sample.ts'),source='const sourceSecret = "DO_NOT_LOG_SOURCE_7e164";\nconst value = 1;\n';await fs.writeFile(p,source);
 await fs.writeFile(path.join(project,'package.json'),JSON.stringify({name:'mcp-fixture',packageManager:'pnpm@11.24.0',scripts:{test:'node --check sample.ts'}}));
 await fs.writeFile(path.join(project,'AGENTS.md'),'Keep edits small. Verify before completion.');
 const relay=await buildRelay({port:0,host:'127.0.0.1',publicUrl:'http://127.0.0.1:3210',trustProxy:false,dbFile:path.join(dir,'relay.sqlite'),sessionSecret:'test-only',adminUser:'admin',adminPassword:'test-only',relayVersion:'integration'},()=>{});
 await new Promise(r=>relay.http.listen(0,'127.0.0.1',r));
 const url=`http://127.0.0.1:${relay.http.address().port}`,user=relay.store.getUserByName('admin');
 const token=relay.store.issueDeviceToken('integration-pc',user.id,'Test PC','win32'),apiKey=relay.store.createApiKey(user.id,'integration');
 const child=spawn(process.execPath,[path.resolve('packages/agent/dist/cli.js'),'--relay',url,'--device-id','integration-pc','--name','Test PC','--no-browser','--allow-dir',project],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BRC_HOME:home,BRC_TOKEN:token,BRC_LOG_FILE:'1',BRC_LOG_LEVEL:'info',BRC_DEBUG:'0'}});
 let output='',seq=0;for(const stream of [child.stdout,child.stderr])stream.on('data',b=>{output=(output+b.toString()).slice(-1000000);});
 async function rpc(method,params){
  const r=await fetch(`${url}/mcp`,{method:'POST',headers:{authorization:`Bearer ${apiKey.raw}`,'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++seq,method,params}),signal:AbortSignal.timeout(20000)});
  const text=await r.text();assert.equal(r.status,200,text);
  const messages=text.trim().startsWith('{')?[JSON.parse(text)]:text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
  const answer=messages.find(m=>m.result!==undefined||m.error!==undefined);assert.ok(answer,text);assert.equal(answer.error,undefined,JSON.stringify(answer));return answer.result;
 }
 const tool=(name,args={})=>rpc('tools/call',{name,arguments:args});
 try{
  await until(()=>relay.hub.list().length===1);
  await rpc('initialize',{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'integration-test',version:'1'}});
  await t.test('new tool definitions and exact snapshots traverse MCP',async()=>{
   const d=await rpc('tools/list',{});assert.ok(d.tools.some(x=>x.name==='edit_files'));assert.ok(d.tools.some(x=>x.name==='agent_status'));
   const r=await tool('read_code_file',{path:p});assert.equal(r.isError,false);assert.ok(r.structuredContent.sha256);assert.ok(r._meta.callId);assert.equal(r._meta.deviceId,'integration-pc');
  });
  await t.test('hash-checked editing and batch reads work through the relay',async()=>{
   const snap=await tool('read_code_file',{path:p});
   const r=await tool('edit_files',{files:[{path:p,expected_sha256:snap.structuredContent.sha256,edits:[{old_string:'value = 1',new_string:'value = 2'}]}]});assert.equal(r.isError,false);assert.ok((await fs.readFile(p,'utf8')).includes('value = 2'));
   const b=await tool('batch_tools',{calls:[{tool:'read_code_file',arguments:{path:p}},{tool:'read_code_context',arguments:{path:project,pattern:'value = 2'}}]});assert.equal(b.isError,false);assert.equal(b.structuredContent.results.length,2);
  });
  await t.test('build/test verification returns structured success',async()=>{
   const r=await tool('verify_project',{cwd:project,commands:[{name:'syntax check',command:'node --check sample.ts'}]});assert.equal(r.isError,false);assert.equal(r.structuredContent.passed,true);
  });
  await t.test('project context, symbol tools and safe previews traverse real MCP',async()=>{
   const defs=await rpc('tools/list',{});assert.equal(defs.tools.length,71);assert.ok(defs.tools.some(t=>t.name==='coding_session'));
   const context=await tool('project_context',{path:project,focus:'sample.ts'});assert.equal(context.isError,false);assert.equal(context.structuredContent.package.packageManager,'pnpm');assert.ok(context.structuredContent.instructions.some(x=>x.path==='AGENTS.md'));
   const outline=await tool('code_outline',{path:p});assert.equal(outline.isError,false);assert.ok(outline.structuredContent.symbols.some(s=>s.name==='value'));
   const symbol=await tool('read_symbol',{path:p,name:'value'});assert.equal(symbol.isError,false);assert.match(symbol.structuredContent.text,/value = 2/);
   const preview=await tool('replace_symbol',{path:p,name:'value',expected_sha256:symbol.structuredContent.sha256,replacement:'const value = 3;'});assert.equal(preview.isError,false);assert.equal(preview.structuredContent.dryRun,true);assert.match(await fs.readFile(p,'utf8'),/value = 2/);
   const syntax=await tool('code_diagnostics',{paths:[p]});assert.equal(syntax.isError,false);assert.equal(syntax.structuredContent.level,'syntax-only');
  });
  await t.test('completion gate through MCP requires actual fresh project checks',async()=>{
   const started=await tool('coding_session',{action:'start',path:project,goal:'Validate saved source',scope:['sample.ts'],requiredChecks:['test']});assert.equal(started.isError,false);const sessionId=started.structuredContent.sessionId;
   const early=await tool('coding_session',{action:'finish',sessionId});assert.equal(early.isError,true);assert.equal(early.structuredContent.error.code,'VERIFICATION_REQUIRED');
   const verify=await tool('coding_session',{action:'verify',sessionId});assert.equal(verify.isError,false,JSON.stringify(verify));assert.equal(verify.structuredContent.passed,true);
   const finished=await tool('coding_session',{action:'finish',sessionId});assert.equal(finished.isError,false);assert.equal(finished.structuredContent.state,'finished');assert.equal(finished.structuredContent.persistent,false);
  });
  await t.test('multilingual symbols, relationships and context travel over MCP',async()=>{
   const cs=path.join(project,'App.cs'),helper=path.join(project,'Helper.cs'),rs=path.join(project,'lib.rs');
   await fs.writeFile(cs,'using Demo.Tools; namespace Demo.App { public class App { public int Run() { return 1; } } }');
   await fs.writeFile(helper,'namespace Demo.Tools { public class Helper {} }');
   await fs.writeFile(rs,'pub fn hello() -> i32 { 1 }');
   const capabilities=await tool('language_capabilities');assert.equal(capabilities.isError,false);assert.ok(capabilities.structuredContent.languages.some(l=>l.id==='rust'));
   const outline=await tool('code_outline',{path:cs});assert.equal(outline.isError,false);assert.equal(outline.structuredContent.language,'csharp');
   const symbol=await tool('read_symbol',{path:rs,name:'hello'});assert.equal(symbol.isError,false);assert.match(symbol.structuredContent.text,/pub fn hello/);
   const preview=await tool('replace_symbol',{path:rs,name:'hello',expected_sha256:symbol.structuredContent.sha256,replacement:'pub fn hello() -> i32 { 2 }'});assert.equal(preview.isError,false);assert.match(await fs.readFile(rs,'utf8'),/1/);
   const related=await tool('related_files',{path:project,file:'App.cs'});assert.equal(related.isError,false);assert.ok(related.structuredContent.edges.some(e=>e.to==='Helper.cs'));
   const context=await tool('context_pack',{path:project,focus:'App.cs',maxChars:8000});assert.equal(context.isError,false);assert.equal(context.structuredContent.persistent,false);
   const schemas1=await rpc('tools/list',{}),schemas2=await rpc('tools/list',{});assert.deepEqual(schemas1,schemas2);
  });
  await t.test('larger batches and combined mutation/readback pass through MCP',async()=>{
   const files=Array.from({length:24},(_,i)=>`batch-${i}.txt`);
   const r=await tool('workspace_batch',{path:project,dryRun:false,changes:files.map((file,i)=>({path:file,expected_sha256:null,content:`sample ${i}\n`})),reads:files.map(file=>({path:file}))});
   assert.equal(r.isError,false,JSON.stringify(r));assert.equal(r.structuredContent.changes.length,24);assert.equal(r.structuredContent.reads.length,24);
   assert.equal(typeof r._meta.agentQueueMs,'number');assert.equal(typeof r._meta.agentTotalMs,'number');
   const b=await tool('batch_tools',{calls:files.map(file=>({tool:'read_code_file',arguments:{path:path.join(project,file)}}))});assert.equal(b.isError,false);assert.equal(b.structuredContent.executed,24);assert.equal(b.structuredContent.mode,'auto');
   const unchanged=await tool('workspace_batch',{path:project,reads:r.structuredContent.reads.map(x=>({path:x.path,known_sha256:x.sha256}))});assert.equal(unchanged.isError,false);assert.ok(unchanged.structuredContent.reads.every(x=>x.unchanged));
  });
  await t.test('real image previews cross MCP without persisted thumbnails or base64 text dumps',async()=>{
   const {default:sharp}=await import('sharp');const image=path.join(project,'fixture.png');
   await sharp({create:{width:240,height:160,channels:3,background:{r:20,g:60,b:90}}}).png().toFile(image);
   const listing=await tool('read_images',{path:project});assert.equal(listing.isError,false);assert.ok(listing.structuredContent.files.some(x=>x.file==='fixture.png'));
   const preview=await tool('read_images',{path:project,mode:'previews',files:['fixture.png'],maxDimension:128});assert.equal(preview.isError,false,JSON.stringify(preview));
   const block=preview.content.find(x=>x.type==='image');assert.ok(block);assert.equal(block.mimeType,'image/webp');assert.equal((await sharp(Buffer.from(block.data,'base64')).metadata()).width,128);
   assert.ok(!preview.content.filter(x=>x.type==='text').some(x=>x.text.includes(block.data)));
   const status=await tool('agent_status');assert.equal(status.structuredContent.resources.diskContextCacheBytes,0);
  });
  await t.test('independent worker clients coordinate patches and final checks over real MCP',async()=>{
   const made=await tool('worker_tasks',{action:'create',path:project,goal:'Parallel changes with one verified integration',hostMode:'native_workers',tasks:[{id:'front',goal:'Change the saved constant',scope:['sample.ts']},{id:'back',goal:'Improve the Rust function',scope:['lib.rs']}],requiredChecks:['test']});
   assert.equal(made.isError,false,JSON.stringify(made));const plan=made.structuredContent;assert.equal(plan.spawnedModels,0);
   const leases=await Promise.all(['front','back'].map(taskId=>tool('worker_tasks',{action:'claim',planId:plan.planId,taskId,workerId:taskId,reads:[{path:taskId==='front'?'sample.ts':'lib.rs'}]})));
   leases.forEach(r=>assert.equal(r.isError,false,JSON.stringify(r)));
   const beforeTs=await fs.readFile(p,'utf8'),rs=path.join(project,'lib.rs'),beforeRs=await fs.readFile(rs,'utf8');
   const pending=leases.map((r,i)=>tool('worker_patch',{planId:plan.planId,taskId:i===0?'front':'back',claimKey:r.structuredContent.claimKey,submissionId:'proposal-'+i,summary:'Unverified proposal',changes:[{path:i===0?'sample.ts':'lib.rs',expected_sha256:r.structuredContent.snapshot.reads[0].sha256,content:i===0?beforeTs.replace('value = 2','value = 4'):'pub fn hello() -> i32 { 4 }'}]}));
   const proposed=await Promise.all(pending);proposed.forEach(r=>assert.equal(r.isError,false,JSON.stringify(r)));assert.equal(await fs.readFile(p,'utf8'),beforeTs);assert.equal(await fs.readFile(rs,'utf8'),beforeRs);
   const direct=await tool('write_file',{path:p,content:'incorrect bypass',mode:'rewrite'});assert.equal(direct.structuredContent.error.code,'COORDINATED_WRITE_REQUIRED');
   const preview=await tool('worker_integrate',{planId:plan.planId,coordinatorKey:plan.coordinatorKey});assert.equal(preview.isError,false,JSON.stringify(preview));
   const applyArgs={action:'apply',planId:plan.planId,coordinatorKey:plan.coordinatorKey,review_sha256:preview.structuredContent.review_sha256,runChecks:true};
   const applied=await tool('worker_integrate',applyArgs);assert.equal(applied.isError,false,JSON.stringify(applied));assert.equal(applied.structuredContent.checks.passed,true);assert.match(await fs.readFile(p,'utf8'),/value = 4/);
   const replay=await tool('worker_integrate',applyArgs);assert.equal(replay.structuredContent.replay,true);assert.equal(replay.structuredContent.checks,undefined);
   const finish=await tool('worker_integrate',{action:'finish',planId:plan.planId,coordinatorKey:plan.coordinatorKey});assert.equal(finish.isError,false,JSON.stringify(finish));assert.equal(finish.structuredContent.verifiedCurrentSource,true);
   const status=await tool('agent_status');assert.equal(status.structuredContent.resources.workerCoordination.patchBytes,0);assert.equal(status.structuredContent.resources.workerCoordination.spawnedModels,0);
   assert.ok(!output.includes(plan.coordinatorKey));for(const r of leases)assert.ok(!output.includes(r.structuredContent.claimKey));
  });
  await t.test('a long-running remote command can be inspected and cancelled' ,async()=>{
   const pending=tool('run_command',{cwd:project,command:'node -e "setInterval(()=>{},1000)"',timeout_ms:15000});
   let operation;
   await until(async()=>{const s=await tool('agent_status');operation=s.structuredContent.operations.find(o=>o.tool==='run_command');return !!operation;});
   const c=await tool('cancel_operation',{callId:operation.id});assert.equal(c.structuredContent.cancelRequested,true);
   const r=await pending;assert.equal(r.isError,true);assert.ok(r.structuredContent.cancelled||r.structuredContent.error.code==='CANCELLED');
  });
  await t.test('visible tool logs include status/duration but not code or credentials',async()=>{
   await until(()=>output.includes('read_code_file')&&output.includes('START')&&output.includes('OK'));
   assert.ok(/read_code_file.*\d+ms/.test(output),output);assert.ok(!output.includes('DO_NOT_LOG_SOURCE_7e164'));assert.ok(!output.includes(token));assert.ok(!output.includes(apiKey.raw));
   await sleep(700);
   assert.deepEqual(await fs.readdir(path.join(home,'logs')).catch(()=>[]),[]);
   assert.equal(relay.store.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,0);
   assert.equal(await fs.stat(path.join(home,'agent.log')).catch(()=>null),null);
  });
 }finally{
  const exited=child.exitCode!==null?Promise.resolve():once(child,'exit');child.kill('SIGTERM');await Promise.race([exited,sleep(2500)]);if(child.exitCode===null){child.kill('SIGKILL');await Promise.race([exited,sleep(1000)]);}
  relay.http.closeAllConnections();await relay.close();await fs.rm(dir,{recursive:true,force:true,maxRetries:8,retryDelay:100});
 }
});
