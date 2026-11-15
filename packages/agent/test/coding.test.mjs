import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {EventEmitter} from 'node:events';
const scratch=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-coding-test-'));
const root=path.join(scratch,'project');await fs.mkdir(root);
process.env.BRC_HOME=path.join(scratch,'agent');process.env.BRC_LOG_FILE='0';process.env.BRC_LOG_LEVEL='silent';
const {configManager}=await import('../dist/core/config-manager.js');await configManager.setValue('allowedDirectories',[root]);
const {callTool,listTools}=await import('../dist/dispatcher.js');
const {withCallContext,getCurrentRemoteClient,getCallContext}=await import('../dist/context.js');
const {sha256,atomicWrite,withFileLocks}=await import('../dist/runtime/file-safety.js');
const {ActivityLog,compactLine}=await import('../dist/runtime/activity.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {OperationScheduler,cancelOperation,operationStatus}=await import('../dist/runtime/operations.js');
const {searchManager}=await import('../dist/core/search-manager.js');
const {SqliteStore}=await import('../../relay/dist/store/sqlite.js');
const {DeviceHub}=await import('../../relay/dist/device-hub.js');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const file=n=>path.join(root,n),read=p=>fs.readFile(p,'utf8');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
async function until(fn,ms=4000){const t=Date.now();while(Date.now()-t<ms){if(await fn())return;await sleep(20);}throw new Error('Fixture timeout');}
const edit=(p,before,after)=>({path:p,expected_sha256:sha256(before),edits:[{old_string:before,new_string:after}]});
after(async()=>{projectIndex.close();for(const s of searchManager.listSearchSessions())searchManager.terminateSearch(s.id);await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:100});});

test('all eight coding tools are discoverable',()=>{
 const names=new Set(listTools().map(t=>t.name));
 for(const n of ['read_code_file','read_code_context','edit_files','batch_tools','verify_project','project_index','agent_status','cancel_operation'])assert.ok(names.has(n),n);
});
test('parallel request context is isolated',async()=>{
 const values=await Promise.all(['alpha','beta','gamma'].map((name,i)=>withCallContext({id:name,client:{name},remote:true},async()=>{await sleep((3-i)*8);return [getCallContext().id,getCurrentRemoteClient().name];})));
 assert.deepEqual(values,[['alpha','alpha'],['beta','beta'],['gamma','gamma']]);assert.equal(getCurrentRemoteClient(),null);
});
test('snapshot hashes raw UTF-8 bytes and reads exact CRLF lines',async()=>{
 const text='\ufeffconst first=1;\r\nconst second=2;\r\n';await fs.writeFile(file('snapshot.ts'),text);
 const d=ok(await callTool('read_code_file',{path:file('snapshot.ts'),offset:1,length:1}));assert.equal(d.text,'const second=2;\r');assert.equal(d.sha256,sha256(text));
});
test('directory policy rejects snapshots and indexes outside allowed roots',async()=>{
 const p=path.join(scratch,'private.txt');await fs.writeFile(p,'private');
 assert.equal((await callTool('read_code_file',{path:p})).isError,true);
 assert.equal((await callTool('project_index',{path:scratch,action:'enable'})).isError,true);
});
test('multi-file exact edits preserve BOM/CRLF and reject stale hashes',async()=>{
 const a=file('a.ts'),b=file('b.ts'),aa='\ufeffconst count=1;\r\n',bb='const count=2;\n';await fs.writeFile(a,aa);await fs.writeFile(b,bb);
 ok(await callTool('edit_files',{files:[edit(a,aa,aa.replace('=1','=3')),edit(b,bb,bb.replace('=2','=4'))]}));
 assert.equal(await read(a),'\ufeffconst count=3;\r\n');assert.equal(await read(b),'const count=4;\n');
 const r=await callTool('edit_files',{files:[edit(a,aa,'bad')]});assert.equal(r.structuredContent.error.code,'FILE_CONFLICT');assert.equal(await read(a),'\ufeffconst count=3;\r\n');
});
test('mismatch, duplicate targets and dry run never partially apply',async()=>{
 const a=file('dry-a.txt'),b=file('dry-b.txt');await fs.writeFile(a,'a');await fs.writeFile(b,'b');
 const wrong={...edit(b,'b','new-b'),edits:[{old_string:'missing',new_string:'x'}]};
 assert.equal((await callTool('edit_files',{files:[edit(a,'a','new-a'),wrong]})).structuredContent.error.code,'EDIT_MISMATCH');assert.equal(await read(a),'a');
 ok(await callTool('edit_files',{files:[edit(a,'a','new-a')],dryRun:true}));assert.equal(await read(a),'a');
 assert.equal((await callTool('edit_files',{files:[edit(a,'a','x'),edit(a,'a','y')]})).structuredContent.error.code,'DUPLICATE_TARGET');
});
test('injected second commit failure rolls back first file and cleans temp files',async()=>{
 const a=file('rollback-a.txt'),b=file('rollback-b.txt');await fs.writeFile(a,'old-a');await fs.writeFile(b,'old-b');
 const rename=fs.rename;
 fs.rename=async(from,to)=>{if(to===b&&String(from).includes('.brc-'))throw Object.assign(new Error('injected failure'),{code:'EIO'});return rename(from,to);};
 try{const r=await callTool('edit_files',{files:[edit(a,'old-a','new-a'),edit(b,'old-b','new-b')]});assert.equal(r.isError,true);assert.equal(r.structuredContent.rolledBack,1);assert.deepEqual(r.structuredContent.rollbackConflicts,[]);assert.equal(await read(a),'old-a');assert.equal(await read(b),'old-b');}finally{fs.rename=rename;}
 assert.equal((await fs.readdir(root)).filter(n=>n.endsWith('.tmp')).length,0);
});
test('legacy write_file supports expected_sha256 and lock serialization',async()=>{
 const p=file('legacy.txt');await fs.writeFile(p,'before');
 assert.equal((await callTool('write_file',{path:p,content:'bad',expected_sha256:sha256('stale')})).isError,true);assert.equal(await read(p),'before');
 ok(await callTool('write_file',{path:p,content:'after',mode:'rewrite',expected_sha256:sha256('before')}));assert.equal(await read(p),'after');
 await fs.writeFile(p,'0');await Promise.all(Array.from({length:8},()=>withFileLocks([p],async()=>{const n=Number(await read(p));await sleep(2);await atomicWrite(p,String(n+1));})));assert.equal(await read(p),'8');
});
test('batch stops on failure and rejects nested batches',async()=>{
 const p=file('batch.txt');await fs.writeFile(p,'one');
 const r=await callTool('batch_tools',{calls:[{tool:'read_code_file',arguments:{path:p}},{tool:'read_code_file',arguments:{path:file('missing')}},{tool:'write_file',arguments:{path:p,content:'two'}}]});assert.equal(r.isError,true);assert.equal(r.structuredContent.skipped,1);assert.equal(await read(p),'one');
 assert.equal((await callTool('batch_tools',{calls:[{tool:'batch_tools',arguments:{}}]})).structuredContent.error.code,'BATCH_TOOL_DENIED');
});
test('ripgrep has a true global cross-file cap',async()=>{
 const dir=file('search');await fs.mkdir(dir);for(let i=0;i<12;i++)await fs.writeFile(path.join(dir,`${i}.ts`),'needle\n'.repeat(40));
 const s=await searchManager.startSearch({rootPath:dir,pattern:'needle',searchType:'content',maxResults:7});await until(()=>searchManager.readSearchResults(s.sessionId).isComplete);
 const r=searchManager.readSearchResults(s.sessionId,0,1000);assert.equal(r.totalMatches,7);assert.equal(r.stopReason,'limit');assert.ok(r.wasIncomplete);
});
test('invalid regex is an error and oversized output is explicitly limited',async()=>{
 assert.equal((await callTool('start_search',{path:root,pattern:'[',searchType:'content',wait:true,literalSearch:false})).isError,true);
 const dir=file('huge');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'line.txt'),'needle'+'x'.repeat(600000));
 const s=await searchManager.startSearch({rootPath:dir,pattern:'needle',searchType:'content',maxResults:20});await until(()=>searchManager.readSearchResults(s.sessionId).isComplete);
 assert.equal(searchManager.readSearchResults(s.sessionId).stopReason,'output_limit');
});
test('combined context search returns fresh snippets and hashes',async()=>{
 const p=file('context.ts'),text='// header\nfunction uniqueFunctionXYZ() {\n  return 42;\n}\n';await fs.writeFile(p,text);
 const d=ok(await callTool('read_code_context',{path:root,pattern:'uniqueFunctionXYZ',contextLines:2,maxResults:4}));assert.equal(d.files.length,1);assert.equal(d.files[0].sha256,sha256(text));assert.ok(d.files[0].snippets[0].text.includes('return 42'));
});
test('optional index invalidates after file changes and skips node_modules',async()=>{
 const dir=file('index');await fs.mkdir(dir);await fs.writeFile(path.join(dir,'first.ts'),'a');await fs.mkdir(path.join(dir,'node_modules'));await fs.writeFile(path.join(dir,'node_modules','ignored.ts'),'b');
 let d=ok(await callTool('project_index',{path:dir,action:'enable',watch:true}));assert.ok(d.files.some(n=>n.includes('first.ts')));assert.ok(!d.files.some(n=>n.includes('ignored.ts')));
 await fs.writeFile(path.join(dir,'second.ts'),'b');if(d.watching)await until(()=>projectIndex.status().some(e=>e.root===dir&&e.dirty));else projectIndex.invalidate(dir);
 d=ok(await callTool('project_index',{path:dir,action:'query',query:'second'}));assert.equal(d.files.length,1);assert.equal(d.persistent,false);
 ok(await callTool('project_index',{path:dir,action:'disable'}));assert.equal(projectIndex.status().length,0);
});
test('command exit status and verify_project failure are structured',async()=>{
 const r=await callTool('run_command',{cwd:root,command:'node -e "process.exit(7)"',timeout_ms:10000});assert.equal(r.isError,true);assert.equal(r.structuredContent.exitCode,7);
 const v=await callTool('verify_project',{cwd:root,commands:[{name:'pass',command:'node -e "process.exit(0)"'},{name:'fail',command:'node -e "process.exit(3)"'},{name:'skip',command:'node -e "process.exit(0)"'}],timeout_ms:20000});assert.equal(v.isError,true);assert.equal(v.structuredContent.steps.length,2);assert.equal(v.structuredContent.skipped,1);
});
test('long commands stop on timeout and cancellation',async()=>{
 let r=await callTool('run_command',{cwd:root,command:'node -e "setInterval(()=>{},1000)"',timeout_ms:300});assert.equal(r.isError,true);assert.equal(r.structuredContent.timedOut,true);
 const c=new AbortController();setTimeout(()=>c.abort(new DOMException('Cancelled','AbortError')),350);
 r=await withCallContext({id:'cancel-test',client:null,remote:false,signal:c.signal},()=>callTool('run_command',{cwd:root,command:'node -e "setInterval(()=>{},1000)"',timeout_ms:10000}));assert.equal(r.isError,true);assert.ok(r.structuredContent.cancelled||r.structuredContent.error.code==='CANCELLED');
});
test('bounded queue rejects overflow and removes cancelled queued jobs',async()=>{
 const q=new OperationScheduler(1,1);let release;const a=q.run('queue-a','test',5000,()=>new Promise(r=>{release=r;}));await sleep(10);
 const b=q.run('queue-b','test',5000,async()=>{throw new Error('must not run');});const rejected=assert.rejects(b,e=>e.code==='CANCELLED');
 await assert.rejects(q.run('queue-c','test',1000,async()=>0),e=>e.code==='BUSY');assert.ok(cancelOperation('queue-b'));await rejected;release('done');assert.equal(await a,'done');await sleep(0);assert.equal(operationStatus().length,0);
});
test('deadline and disconnect cancellation reach running tasks',async()=>{
 const q=new OperationScheduler(1,1),task=s=>new Promise((_,reject)=>s.addEventListener('abort',()=>reject(s.reason),{once:true}));
 await assert.rejects(q.run('deadline','test',30,task),e=>e.code==='TIMEOUT');
 const p=q.run('disconnect','test',5000,task),rejected=assert.rejects(p,e=>e.code==='CANCELLED');await sleep(10);q.cancelAll();await rejected;
});
test('audit expiry preserves users, paired devices and API keys',()=>{
 const s=new SqliteStore(':memory:'),u=s.upsertUser('admin','test-only'),token=s.issueDeviceToken('pc',u.id,'PC','win32'),key=s.createApiKey(u.id,'test');
 const insert=s.db.prepare('INSERT INTO audit(ts,user_id,tool,ok) VALUES(?,?,?,?)');insert.run(Date.now()-49*3600000,u.id,'old',1);insert.run(Date.now()-47*3600000,u.id,'recent',1);
 assert.equal(s.pruneAudit(),2);assert.deepEqual(s.recentAudit(u.id),[]);s.audit({ts:Date.now(),user_id:u.id,device_id:'pc',client:'test',tool:'read_file',ok:1,ms:1,args_hash:null,error:null});assert.equal(s.recentAudit(u.id).length,1);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,0);assert.equal(s.getDeviceByToken(token).device_id,'pc');assert.equal(s.getApiKey(key.raw).user_id,u.id);assert.equal(s.getUserByName('admin').id,u.id);s.close();
});
test('audit startup cleanup deletes old rows and preserves account state',()=>{
 const db=path.join(scratch,'audit.sqlite');let s=new SqliteStore(db);s.upsertUser('admin','test-only');s.db.prepare('INSERT INTO audit(ts,tool,ok) VALUES(?,?,?)').run(Date.now()-49*3600000,'old',1);s.close();
 s=new SqliteStore(db);assert.equal(s.db.prepare('SELECT COUNT(*) AS n FROM audit').get().n,0);assert.ok(s.getUserByName('admin'));s.close();
});
test('log expiry/migration does not delete credentials or config',async()=>{
 const home=path.join(scratch,'logs-home');await fs.mkdir(path.join(home,'logs'),{recursive:true});await fs.writeFile(path.join(home,'device.json'),'credentials');await fs.writeFile(path.join(home,'config.json'),'settings');await fs.writeFile(path.join(home,'agent.log'),'legacy raw');
 const name=t=>`activity-${new Date(t).toISOString().slice(0,13).replace('T','-')}-1-0.jsonl`;
 const old=path.join(home,'logs',name(Date.now()-49*3600000));await fs.writeFile(old,'old');
 const log=new ActivityLog(home,true,true);await log.start();assert.equal(await fs.stat(old).catch(()=>null),null);assert.equal(await fs.stat(path.join(home,'agent.log')).catch(()=>null),null);assert.equal(await read(path.join(home,'device.json')),'credentials');assert.equal(await read(path.join(home,'config.json')),'settings');
 log.tool('START','read_file','abc');log.tool('OK','read_file','abc',12);await log.flush();assert.ok(log.metrics().some(m=>m.tool==='read_file'&&m.maxMs===12));await log.close();
});
test('console and volatile history stay bounded and disk logging cannot be enabled',async()=>{
 assert.ok(!/[\r\n\x1b]/.test(compactLine('token=secret\r\n\x1b[31m red')));assert.ok(!compactLine('token=secret').includes('secret'));
 const home=path.join(scratch,'bounded-log'),log=new ActivityLog(home,true,true);await log.start();for(let i=0;i<1500;i++)log.tool('OK','read_file',String(i),i);assert.equal(log.recent().length,1000);await log.flush();
 assert.equal(await fs.stat(home).catch(()=>null),null);await log.close();
});

class Sock extends EventEmitter{OPEN=1;readyState=1;sent=[];send(s){this.sent.push(JSON.parse(s));}close(){this.readyState=3;this.emit('close');}terminate(){this.close();}}
const hello=id=>Buffer.from(JSON.stringify({type:'hello',protocol:1,device:{deviceId:id,name:id,platform:'test'},tools:[{name:'read_file',inputSchema:{}}]}));
test('relay binds responses to the correct socket and fails disconnections promptly',async()=>{
 const h=new DeviceHub('test',()=>{}),a=new Sock(),b=new Sock();h.attach(a,'owner','a');h.attach(b,'owner','b');a.emit('message',hello('a'));b.emit('message',hello('b'));
 const p=h.call('a','read_file',{}),rejected=assert.rejects(p,/DEVICE_DISCONNECTED/),id=a.sent.find(m=>m.type==='call').id;
 b.emit('message',Buffer.from(JSON.stringify({type:'result',id,result:{content:[{type:'text',text:'forged'}]}})));a.close();await rejected;h.close();
});
test('relay forwards cancellation to its paired agent',async()=>{
 const h=new DeviceHub('test',()=>{}),s=new Sock();h.attach(s,'owner','a');s.emit('message',hello('a'));
 const c=new AbortController(),p=h.call('a','read_file',{}, {signal:c.signal}),rejected=assert.rejects(p,/CALL_CANCELLED/);c.abort();await rejected;assert.ok(s.sent.some(m=>m.type==='cancel'));h.close();
});

test('deep reads from large variable-length files return exact lines',async()=>{
 const {TextFileHandler}=await import('../dist/core/utils/files/text.js');
 const lines=Array.from({length:18000},(_,i)=>`${i}:`+'x'.repeat(i<1200?10:700));
 const p=file('deep.txt');await fs.writeFile(p,lines.join('\n'));
 assert.ok((await fs.stat(p)).size>10*1024*1024);
 const r=await new TextFileHandler().read(p,{offset:1500,length:3,includeStatusMessage:false});
 assert.equal(r.content,lines.slice(1500,1503).join('\n'));
});
test('rollback refuses to overwrite an external edit made during a failing batch',async()=>{
 const a=file('external-a.txt'),b=file('external-b.txt');await fs.writeFile(a,'old-a');await fs.writeFile(b,'old-b');
 const rename=fs.rename;
 fs.rename=async(from,to)=>{if(to===b&&String(from).includes('.brc-')){await fs.writeFile(a,'external-change');throw Object.assign(new Error('injected failure'),{code:'EIO'});}return rename(from,to);};
 try{const r=await callTool('edit_files',{files:[edit(a,'old-a','new-a'),edit(b,'old-b','new-b')]});assert.equal(r.isError,true);assert.equal(r.structuredContent.requiresReview,true);assert.deepEqual(r.structuredContent.rollbackConflicts,[a]);assert.equal(await read(a),'external-change');}finally{fs.rename=rename;}
});
test('disabling disk logging still expires logs left by earlier runs',async()=>{
 const home=path.join(scratch,'disabled-logging'),dir=path.join(home,'logs');await fs.mkdir(dir,{recursive:true});
 const bucket=new Date(Date.now()-49*3600000).toISOString().slice(0,13).replace('T','-'),p=path.join(dir,`activity-${bucket}-1-0.jsonl`);await fs.writeFile(p,'old');
 const log=new ActivityLog(home,true,false);await log.start();assert.equal(await fs.stat(p).catch(()=>null),null);log.tool('OK','read_file','x',1);await log.close();assert.equal((await fs.readdir(dir)).length,0);
});
test('upgrading removes even recent owned log segments without replacing them',async()=>{
 const home=path.join(scratch,'restart-logging'),dir=path.join(home,'logs');await fs.mkdir(dir,{recursive:true});
 const bucket=new Date().toISOString().slice(0,13).replace('T','-');await fs.writeFile(path.join(dir,`activity-${bucket}-${process.pid}-0.jsonl`),'old');
 const log=new ActivityLog(home,true,true);await log.start();log.tool('OK','read_file','live',1);await log.flush();assert.deepEqual(await fs.readdir(dir),[]);await log.close();
});
test('old retention environment cannot re-enable SQLite log persistence',()=>{
 const old=process.env.BRC_LOG_RETENTION_HOURS;process.env.BRC_LOG_RETENTION_HOURS='500';let s;
 try{s=new SqliteStore(':memory:');assert.equal(s.auditRetentionMs,0);}finally{s?.close();if(old===undefined)delete process.env.BRC_LOG_RETENTION_HOURS;else process.env.BRC_LOG_RETENTION_HOURS=old;}
});
test('audit failure preserves a successfully executed tool result',async()=>{
 const {invokeTool}=await import('../../relay/dist/mcp/invoke.js');
 const hub={resolveDefault:()=> 'pc',list:()=>[{deviceId:'pc'}],get:()=>({ownerId:'u',info:{name:'PC'}}),call:async()=>({content:[{type:'text',text:'already edited'}]})};
 const store={getDevice:()=>({paused:0}),audit:()=>{throw new Error('disk full');},touchDevice:()=>{}};
 const r=await invokeTool(hub,store,{userId:'u',clientId:'c'},'write_file',{});assert.equal(r.ok,true);assert.equal(r.result._meta.auditPersisted,false);assert.equal(r.result.content[0].text,'already edited');
});
