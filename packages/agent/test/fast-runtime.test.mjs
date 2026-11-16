import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
const scratch=mkdtempSync(path.join(realpathSync.native(tmpdir()),'brc-fast-test-'));
const root=path.join(scratch,'project');await fs.mkdir(root);
process.env.BRC_HOME=path.join(scratch,'agent');process.env.BRC_LOG_LEVEL='silent';
const {configManager}=await import('../dist/core/config-manager.js');await configManager.setValue('allowedDirectories',[root]);
const {callTool,listTools}=await import('../dist/dispatcher.js');
const {result}=await import('../dist/runtime/errors.js');
const {runBatch}=await import('../dist/runtime/fast-batch.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const {withCallContext}=await import('../dist/context.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {clearCodeCache,pruneCodeCache,codeCacheStatus}=await import('../dist/runtime/code-structure.js');
const {cacheStatus,stopResourceMaintenance}=await import('../dist/runtime/resource-limits.js');
const {dockerInventory,inspectDocker,dockerQuery}=await import('../dist/runtime/docker-client.js');
const {sandboxRun,sandboxArgs}=await import('../dist/tools/sandbox-tools.js');
const {ownedScratch,pruneScratch,createScratch,releaseScratch}=await import('../dist/runtime/scratch-budget.js');
const ok=r=>{assert.notEqual(r.isError,true,JSON.stringify(r));return r.structuredContent;};
const p=f=>path.join(root,f),sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function write(f,text){const target=p(f);await fs.mkdir(path.dirname(target),{recursive:true});await fs.writeFile(target,text);return target;}
after(async()=>{stopResourceMaintenance();clearCodeCache();codeGraph.clear();projectIndex.close();await configManager.close();await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:100});});

test('developer tools are discoverable, no duplicate tool names',()=>{
 const defs=listTools();assert.equal(new Set(defs.map(d=>d.name)).size,defs.length);
 for(const name of ['workspace_batch','docker_inventory','docker_inspect','read_images','sandbox_run'])assert.ok(defs.some(d=>d.name===name));
});
test('auto batch overlaps independent reads but writes are ordered barriers',async()=>{
 let active=0,peak=0;const events=[];
 const invoke=async(tool,args)=>{events.push('start:'+args.id);if(tool==='read_code_file'){active++;peak=Math.max(peak,active);await sleep(25);active--;}else assert.equal(active,0);events.push('end:'+args.id);return result({id:args.id});};
 const r=ok(await runBatch({calls:[{tool:'read_code_file',arguments:{id:'a'}},{tool:'read_code_file',arguments:{id:'b'}},{tool:'write_file',arguments:{id:'w'}},{tool:'read_code_file',arguments:{id:'c'}}]},invoke));
 assert.equal(peak,2);assert.ok(events.indexOf('start:w')>events.indexOf('end:a'));assert.ok(events.indexOf('start:w')>events.indexOf('end:b'));assert.ok(events.indexOf('start:c')>events.indexOf('end:w'));assert.deepEqual(r.results.map(r=>r.index),[0,1,2,3]);assert.equal(r.executed,4);
});
test('parallel writes and nested batches fail before executing anything',async()=>{
 let calls=0;const invoke=async()=>{calls++;return result({});};
 await assert.rejects(runBatch({mode:'parallel',calls:[{tool:'write_file'}]},invoke),e=>e.code==='PARALLEL_WRITE_DENIED');
 await assert.rejects(withCallContext({id:'x',client:null,remote:false,depth:1},()=>runBatch({calls:[{tool:'read_file'}]},invoke)),e=>e.code==='NESTED_BATCH');assert.equal(calls,0);
});
test('stopOnError waits for started reads and never launches a later mutation',async()=>{
 let writes=0;const r=await runBatch({calls:[{tool:'read_file',arguments:{bad:true}},{tool:'read_file'},{tool:'write_file'}]},async(t,a)=>{if(t==='write_file')writes++;await sleep(5);return result({},!!a.bad);});
 assert.equal(r.isError,true);assert.equal(writes,0);assert.equal(r.structuredContent.executed,2);assert.equal(r.structuredContent.skipped,1);
});
test('64-call batches have a shared output cap and compact structured results',async()=>{
 const calls=Array.from({length:64},()=>({tool:'read_code_file'}));
 const r=ok(await runBatch({calls,maxChars:4000},async()=>result({text:'x'.repeat(10000)})));
 assert.ok(JSON.stringify(r).length<15000);assert.ok(r.results.some(x=>x.truncated));assert.ok(r.skipped>0);
 const small=ok(await runBatch({calls},async()=>result({answer:42})));
 assert.equal(small.executed,64);assert.ok(!('content'in small.results[0].result));assert.equal(small.results[0].result.structuredContent.answer,42);
});
test('workspace batch previews changes then creates, edits and reads back any UTF-8 language',async()=>{
 const old='\ufeffpublic class A {}\r\n';await write('A.cs',old);
 const args={path:root,changes:[{path:'A.cs',expected_sha256:sha256(old),edits:[{old_string:'class A',new_string:'class B'}]},{path:'new.unknownlanguage',expected_sha256:null,content:'custom source\n'}],reads:[{path:'A.cs'},{path:'new.unknownlanguage'}]};
 const preview=await callTool('workspace_batch',args);assert.equal(preview.structuredContent.dryRun,true);assert.equal(await fs.readFile(p('A.cs'),'utf8'),old);assert.equal(await fs.stat(p('new.unknownlanguage')).catch(()=>null),null);
 const applied=ok(await callTool('workspace_batch',{...args,dryRun:false}));assert.equal(applied.changes.length,2);assert.equal(applied.reads.length,2);assert.match(applied.reads[0].text,/class B/);assert.equal(await fs.readFile(p('A.cs'),'utf8'),old.replace('class A','class B'));
 const unchanged=ok(await callTool('workspace_batch',{path:root,reads:[{path:'A.cs',known_sha256:applied.reads[0].sha256}]}));assert.equal(unchanged.reads[0].unchanged,true);assert.equal(unchanged.reads[0].text,'');
});
test('workspace rejects stale hashes, wrong check IDs and duplicate targets before writes',async()=>{
 await write('atomic.txt','old');const change={path:'atomic.txt',expected_sha256:sha256('old'),content:'new'};
 const stale=await callTool('workspace_batch',{path:root,dryRun:false,changes:[{...change,expected_sha256:sha256('wrong')}]});assert.equal(stale.structuredContent.error.code,'FILE_CONFLICT');
 const duplicate=await callTool('workspace_batch',{path:root,dryRun:false,changes:[change,change]});assert.equal(duplicate.structuredContent.error.code,'DUPLICATE_TARGET');
 const check=await callTool('workspace_batch',{path:root,dryRun:false,changes:[change],checks:['not_a_real_check']});assert.equal(check.isError,true);assert.equal(await fs.readFile(p('atomic.txt'),'utf8'),'old');
});
test('exclusive create never overwrites a racing file and rolls back prior commits',async()=>{
 await write('rollback.txt','old');const link=fs.link;
 fs.link=async(from,to)=>{if(to===p('racing.txt'))await fs.writeFile(to,'external');return link(from,to);};
 try{const r=await callTool('workspace_batch',{path:root,dryRun:false,changes:[{path:'rollback.txt',expected_sha256:sha256('old'),content:'new'},{path:'racing.txt',expected_sha256:null,content:'mine'}]});assert.equal(r.isError,true);assert.equal(r.structuredContent.rolledBack,1);assert.equal(await fs.readFile(p('rollback.txt'),'utf8'),'old');assert.equal(await fs.readFile(p('racing.txt'),'utf8'),'external');}finally{fs.link=link;}
});
test('workspace can verify a changed project in the same request',async()=>{
 await write('package.json',JSON.stringify({name:'batch-fixture',packageManager:'pnpm@11.24.0',scripts:{verify:'node --check verify.cjs'}}));await write('verify.cjs','const answer=1;');
 const r=ok(await callTool('workspace_batch',{path:root,dryRun:false,changes:[{path:'verify.cjs',expected_sha256:sha256('const answer=1;'),content:'const answer=2;'}],reads:[{path:'verify.cjs'}],checks:['verify']}));
 assert.equal(r.checks.passed,true);assert.match(r.reads[0].text,/answer=2/);
});
test('Docker unavailable is unknown, never an empty invented inventory',async()=>{
 const r=await dockerInventory({path:root},async()=>({ok:false,rows:[],truncated:false,error:'daemon unavailable'}));assert.equal(r.isError,true);assert.equal(r.structuredContent.available,false);assert.equal(r.structuredContent.containers,null);assert.equal(r.structuredContent.images,null);
});
test('Docker inventory returns exact existing IDs while dropping commands and environment',async()=>{
 const r=ok(await dockerInventory({path:root},async args=>({ok:true,truncated:false,rows:args[0]==='container'?[{ID:'c1',Names:'db',Image:'mongo:8',State:'running',Command:'SECRET_COMMAND',Env:['TOKEN=SECRET']}]:[{ID:'sha256:abc',Repository:'mongo',Tag:'8',Size:'300MB'}]})));
 assert.equal(r.containers[0].id,'c1');assert.equal(r.images[0].repository,'mongo');assert.ok(!JSON.stringify(r).includes('SECRET'));assert.equal(r.complete,true);
 const inspect=await inspectDocker('image',['mongo:8'],root,async()=>({ok:true,truncated:false,rows:[{id:'sha256:abc',os:'linux',volumes:{'/data':{}},Env:['SECRET']}]}));assert.deepEqual(inspect[0].volumes,['/data']);assert.ok(!JSON.stringify(inspect).includes('SECRET'));
});
test('Docker argument validation and invalid/truncated JSON fail closed',async()=>{
 await assert.rejects(inspectDocker('image',['--privileged'],root));
 let r=await dockerQuery([],root,1000,async()=>result({stdout:'not json',exitCode:0}));assert.equal(r.ok,false);
 r=await dockerQuery([],root,1000,async()=>result({stdout:'{"ID":"x"}',exitCode:0,truncated:true}));assert.equal(r.ok,false);assert.equal(r.rows.length,0);
});
test('image folder list is metadata only and previews are actual resized image blocks',async()=>{
 const {default:sharp}=await import('sharp');const folder=p('pictures');await fs.mkdir(folder);
 await sharp({create:{width:1200,height:600,channels:3,background:{r:10,g:40,b:80}}}).png().toFile(path.join(folder,'one.png'));
 await sharp({create:{width:300,height:500,channels:3,background:{r:80,g:40,b:10}}}).jpeg().toFile(path.join(folder,'two.jpg'));
 const listing=ok(await callTool('read_images',{path:folder}));assert.equal(listing.files.length,2);assert.equal(listing.previewGenerated,false);
 const preview=await callTool('read_images',{path:folder,mode:'previews',files:['one.png','two.jpg'],maxDimension:320});ok(preview);const blocks=preview.content.filter(b=>b.type==='image');assert.equal(blocks.length,2);
 const meta=await sharp(Buffer.from(blocks[0].data,'base64')).metadata();assert.ok(meta.width<=320&&meta.height<=320);assert.equal(meta.exif,undefined);assert.ok(blocks[0].mimeType==='image/webp');assert.deepEqual((await fs.readdir(folder)).sort(),['one.png','two.jpg']);
 const sheet=await callTool('read_images',{path:folder,mode:'sheet',files:['one.png','two.jpg']});ok(sheet);assert.equal(sheet.content.filter(b=>b.type==='image').length,1);const m=await sharp(Buffer.from(sheet.content[1].data,'base64')).metadata();assert.equal(m.width,512);assert.equal(m.height,256);
});
test('native image batch keeps ordering, budget, first frame, and sheet cell dimensions', async () => {
 const {default:sharp}=await import('sharp');
 const folder=p('fast-native-pictures'); await fs.mkdir(folder);
 const files=[];
 for(let i=0;i<6;i++){
  const name='img-'+i+'.png'; files.push(name);
  await sharp({create:{width:130+i*4,height:95+i*3,channels:4,
   background:{r:20+i*25,g:40+i*12,b:80+i*9,alpha:0.6}}}).png().toFile(path.join(folder,name));
 }
 const preview=await callTool('read_images',{path:folder,mode:'previews',files,maxDimension:256});
 const data=ok(preview);
 assert.deepEqual(data.files.map(f=>f.file),files);
 assert.equal(data.returnedImages,6);
 assert.ok(data.encodedOutputBytes<=2*1024*1024);
 assert.deepEqual(data.files.map(f=>f.previewIndex),[0,1,2,3,4,5]);
 assert.equal(preview.content.filter(b=>b.type==='image').length,6);
 const sheet=await callTool('read_images',{path:folder,mode:'sheet',files});
 const summary=ok(sheet);
 assert.equal(summary.returnedImages,1);
 assert.ok(summary.encodedOutputBytes<=2*1024*1024);
 assert.deepEqual(summary.files.map(f=>f.previewIndex),[0,1,2,3,4,5]);
 const sheetBytes=Buffer.from(sheet.content.find(b=>b.type==='image').data,'base64');
 const md=await sharp(sheetBytes).metadata();
 assert.equal(md.width,768);assert.equal(md.height,512);assert.equal(md.exif,undefined);
 const metadata=ok(await callTool('read_images',{path:folder,mode:'metadata',files}));
 assert.equal(metadata.returnedImages,0);
 assert.deepEqual(metadata.files.map(f=>f.file),files);
 assert.equal(metadata.files.length,6);
});
test('image reading rejects disguised SVG and paths outside the requested folder',async()=>{
 await write('pictures/disguised.png','<svg><image href="file:///private"/></svg>');
 const r=await callTool('read_images',{path:p('pictures'),mode:'previews',files:['disguised.png','../A.cs']});assert.equal(r.isError,true);assert.equal(r.content.filter(b=>b.type==='image').length,0);assert.ok(!JSON.stringify(r).includes('public class'));
});
test('sandbox preview never stages or runs, even with explicit program arguments',async()=>{
 const calls=[],image={id:'sha256:'+'a'.repeat(64),os:'linux',volumes:[]};
 const run=async(program,args)=>{calls.push(args);return result({stdout:JSON.stringify('npipe:////./pipe/docker_engine'),exitCode:0});};
 const r=ok(await sandboxRun({path:root,image:'local-node',program:'node',args:['--version']},{run,inspect:async()=>[image]}));assert.equal(r.execute,false);assert.equal(r.staged,false);assert.ok(!calls.some(a=>a[0]==='run'));assert.equal(await ownedScratch(),null);
});
test('sandbox stages sanitized readonly inputs, uses no network/pull/logs and removes only its own container',async()=>{
 const source=p('sandbox-source');await fs.mkdir(source);await fs.writeFile(path.join(source,'main.py'),'print(1)');await fs.writeFile(path.join(source,'.env'),'SECRET');await fs.writeFile(path.join(source,'.npmrc'),'TOKEN');
 const calls=[],image={id:'sha256:'+'a'.repeat(64),os:'linux',volumes:[]};let mount;
 const run=async(program,args)=>{calls.push(args);assert.equal(program,'docker');if(args[0]==='context')return result({stdout:JSON.stringify('npipe:////./pipe/docker_engine'),exitCode:0});if(args[0]==='run'){assert.ok(args.includes('--pull=never'));assert.ok(args.includes('--network=none'));assert.ok(args.includes('--cap-drop=ALL'));assert.ok(args.includes('--log-driver=none'));assert.ok(args.includes('--read-only'));const spec=args[args.indexOf('--mount')+1];mount=/source=(.*),target=/.exec(spec)[1];assert.match(spec,/readonly/);assert.equal(await fs.readFile(path.join(mount,'main.py'),'utf8'),'print(1)');assert.equal(await fs.stat(path.join(mount,'.env')).catch(()=>null),null);assert.equal(await fs.stat(path.join(mount,'.npmrc')).catch(()=>null),null);return result({exitCode:0,stdout:'1',stderr:''});}assert.deepEqual(args.slice(0,3),['container','rm','--force']);assert.match(args[3],/^brc-sandbox-[a-f0-9-]{36}$/);return result({exitCode:0,stdout:''});};
 const r=ok(await sandboxRun({path:source,image:'local-python',program:'python',args:['main.py'],execute:true},{run,inspect:async()=>[image]}));assert.equal(r.cleanupConfirmed,true);assert.equal(r.stagedFiles,1);assert.equal(await fs.stat(mount).catch(()=>null),null);assert.equal(await fs.readFile(path.join(source,'main.py'),'utf8'),'print(1)');assert.ok(!calls.some(a=>['pull','build'].includes(a[0])));
});
test('sandbox refuses volume-creating images and unsafe mount interpolation',async()=>{
 await assert.rejects(sandboxRun({path:root,image:'db',program:'node'},{inspect:async()=>[{id:'sha256:'+'a'.repeat(64),os:'linux',volumes:['/data']}]}),e=>e.code==='SANDBOX_IMAGE_VOLUMES');
 assert.throws(()=>sandboxArgs('test','C:\\bad,path','sha256:abc','node',[]),e=>e.code==='UNSUPPORTED_PATH');
 const args=sandboxArgs('brc-test','C:\\scratch','sha256:abc','node',[]);assert.ok(!args.includes('--privileged'));assert.ok(!args.some(s=>s.includes('docker.sock')));
});
test('owned scratch expires oldest entries on age/size without touching unrelated data',async()=>{
 const dir=await ownedScratch(true);await fs.writeFile(path.join(dir,'unrelated.txt'),'keep');
 async function stale(age,size){const folder=path.join(dir,`sandbox-${Date.now()-age}-${randomUUID()}`);await fs.mkdir(folder);await fs.writeFile(path.join(folder,'.owner.json'),JSON.stringify({kind:'brc-sandbox-input',created:Date.now()-age,pid:9999999}));const fd=await fs.open(path.join(folder,'input.bin'),'w');await fd.truncate(size);await fd.close();return folder;}
 const old=await stale(3*3600000,1024);await pruneScratch();assert.equal(await fs.stat(old).catch(()=>null),null);
 const large=await stale(10000,257*1024*1024);await pruneScratch();assert.equal(await fs.stat(large).catch(()=>null),null);assert.equal(await fs.readFile(path.join(dir,'unrelated.txt'),'utf8'),'keep');
 const active=await createScratch();await pruneScratch();assert.ok(await fs.stat(active));await releaseScratch(active);
});
test('context caches and watchers expire without deleting code',async()=>{
 const target=await write('cache/sample.rs','pub fn run() {}');ok(await callTool('code_outline',{path:target}));assert.ok(codeCacheStatus().entries);
 ok(await callTool('code_graph',{path:p('cache')}));ok(await callTool('project_index',{path:p('cache'),action:'enable'}));const future=Date.now()+301000;
 assert.ok(pruneCodeCache(future)>0);assert.ok(codeGraph.pruneIdle(future)>0);assert.ok(projectIndex.pruneIdle(future)>0);assert.equal(await fs.readFile(target,'utf8'),'pub fn run() {}');const status=cacheStatus();assert.equal(status.diskContextCacheBytes,0);assert.ok(status.estimatedRetainedContextBytes<256*1024*1024);
});
test('popular generic languages keep honest, useful declaration candidates',async()=>{
 for(const [name,text,symbol]of [['extra.lua','local function hello() end','hello'],['extra.sql','CREATE TABLE users (id int);','users'],['extra.R','model <- function(x) x','model'],['extra.sh','run() { echo ok; }','run']]){
 const file=await write(name,text),r=ok(await callTool('code_outline',{path:file}));assert.equal(r.provider,'generic');assert.ok(r.symbols.some(s=>s.name===symbol));assert.equal((await callTool('code_diagnostics',{paths:[file]})).structuredContent.files[0].checked,false);
 }
});

test('relay SQL reuse never caches revoked keys or pause state and coalesces last-used writes',async()=>{
 const {SqliteStore}=await import('../../relay/dist/store/sqlite.js');const s=new SqliteStore(':memory:');
 try{
  const u=s.upsertUser('test','test-only'),key=s.createApiKey(u.id,'fixture');s.issueDeviceToken('pc',u.id,'PC','test');
  const before=s.db.prepare('SELECT total_changes() AS n').get().n;
  assert.equal(s.getApiKey(key.raw).user_id,u.id);const first=s.db.prepare('SELECT total_changes() AS n').get().n;
  for(let i=0;i<10;i++)assert.equal(s.getApiKey(key.raw).user_id,u.id);
  assert.equal(first,before+1);assert.equal(s.db.prepare('SELECT total_changes() AS n').get().n,first);
  assert.equal(s.getDevice('pc').paused,0);s.setDevicePaused('pc',true);assert.equal(s.getDevice('pc').paused,1);
  s.revokeApiKey(u.id,key.prefix);assert.equal(s.getApiKey(key.raw),undefined);
 }finally{s.close();}
});
