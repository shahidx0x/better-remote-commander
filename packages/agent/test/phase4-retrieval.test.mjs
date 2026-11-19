import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync} from 'node:fs';

const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-phase4-retrieval-'));
const root=path.join(scratch,'project');
process.env.BRC_HOME=path.join(scratch,'agent');
process.env.BRC_ERROR_LOG='0';
process.env.BRC_LOG_LEVEL='silent';
await fs.mkdir(path.join(root,'src'),{recursive:true});
await fs.mkdir(path.join(scratch,'project-sibling'),{recursive:true});
await fs.writeFile(path.join(root,'package.json'),JSON.stringify({name:'phase4-fixture',packageManager:'pnpm@10.0.0',dependencies:{next:'16.0.0'}}));
await fs.writeFile(path.join(root,'AGENTS.md'),'ROOT_PHASE4_INSTRUCTIONS: preserve verified source hashes.\n');
await fs.writeFile(path.join(root,'src','CLAUDE.md'),'SRC_PHASE4_INSTRUCTIONS: changes must be scoped to src.\n');
await fs.writeFile(path.join(root,'.env'),'PRIVATE_PHASE4_MUST_NOT_LEAK=secret');
const paths=[];
for(let i=0;i<80;i++){
 const n='feature'+i.toString().padStart(2,'0')+'.ts';
 const p=path.join(root,'src',n);
 const predecessor=i>0?'import {value'+(i-1)+'} from \'./feature'+(i-1).toString().padStart(2,'0')+'.js\';\n':'';
 const symbols=Array.from({length:5},(_,j)=>'export function phase4Symbol'+i+'_'+j+'(n: number) { return n + '+(i+j)+'; }\n').join('');
 await fs.writeFile(p,predecessor+symbols+'export const value'+i+' = '+i+';\n');
 paths.push(p);
}
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {readMultipleFiles}=await import('../dist/core/tools/filesystem.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {compactGraph}=await import('../dist/runtime/graph-outline.js');
const {callTool}=await import('../dist/dispatcher.js');
const data=r=>{assert.notEqual(r.isError,true,JSON.stringify(r.structuredContent?.error));return r.structuredContent;};
const hash=v=>createHash('sha256').update(v).digest('hex');
after(async()=>{
 codeGraph.clear();
 projectIndex.close();
 await configManager.close();
 await fs.rm(scratch,{recursive:true,force:true,maxRetries:8,retryDelay:80});
});

test('batch reads coalesce duplicates within a call without caching across calls',async()=>{
 const p=paths[0],content=await fs.readFile(p,'utf8');
 const repeated=await readMultipleFiles(Array(16).fill(p));
 assert.equal(repeated.length,16);
 assert.ok(repeated.every(r=>r.path===p && r.content===repeated[0].content && !r.error));
 assert.match(repeated[0].content,/phase4Symbol0_0/);
 await fs.appendFile(p,'// BATCH_CHANGED_AFTER_FIRST_CALL\n');
 const current=await readMultipleFiles([p,p]);
 assert.ok(current.every(r=>r.content?.includes('BATCH_CHANGED_AFTER_FIRST_CALL')));
 assert.ok(!repeated[0].content.includes('BATCH_CHANGED_AFTER_FIRST_CALL'));
 await fs.writeFile(p,content);
 const ranged=await readMultipleFiles([
  {path:p,offset:0,length:1},{path:p,offset:1,length:2},
  {path:p,offset:0,length:1}
 ]);
 assert.equal(ranged[0].content,ranged[2].content);
 assert.notEqual(ranged[0].content,ranged[1].content);
});

test('project filename index preserves total matches and invalidates only actual descendants',async()=>{
 const started=await projectIndex.manage(root,'enable','feature',false,5);
 assert.equal(started.total,80);
 assert.equal(started.files.length,5);
 assert.equal(started.truncated,true);
 const status=()=>projectIndex.status().find(x=>x.root===root);
 assert.equal(status().dirty,false);
 projectIndex.invalidate(path.join(scratch,'project-sibling','unrelated.ts'));
 assert.equal(status().dirty,false,'a sibling prefix must not invalidate this project');
 const next=path.join(root,'src','feature80.ts');
 await fs.writeFile(next,'export const newPhase4File=80;\n');
 projectIndex.invalidate(next);
 const queried=await projectIndex.manage(root,'query','feature80',false,5);
 assert.equal(queried.total,1);
 assert.ok(queried.files.some(f=>f.endsWith('feature80.ts')));
});

test('compact graph output is bounded with valid references at small and large budgets',async()=>{
 const graph=await codeGraph.query(root,undefined,'both',1,100,130,true);
 assert.ok(graph.nodes.length>=80);
 for(const budget of [2000,4000,12000,48000]){
  const result=compactGraph(graph,{maxChars:budget,focus:'src/feature31.ts',query:'phase4Symbol31'});
  const encoded=JSON.stringify(result);
  assert.ok(encoded.length<=budget,budget+' received '+encoded.length);
  assert.ok(result.files.some(f=>f[0]==='src/feature31.ts'),'focused file must survive');
  assert.ok(!encoded.includes('PRIVATE_PHASE4_MUST_NOT_LEAK'));
  for(const d of result.declarations)assert.ok(d[0]<result.files.length && d[3]>=1&&d[4]>=d[3]);
  for(const e of result.relations)assert.ok(e[0]<result.files.length&&e[1]<result.files.length);
  for(const u of result.unresolved)assert.ok(u[0]<result.files.length);
  assert.equal(result.coverage.returnedFiles,result.files.length);
 }
});

test('outline and balanced context preserve scoped instructions, freshness and strict budgets',async()=>{
 const args={path:root,focus:'src/feature31.ts',query:'phase4Symbol31',maxFiles:130};
 for(const mode of ['outline','balanced']){
  const budget=mode==='outline'?6500:8000;
  const r=await callTool('context_pack',{...args,mode,maxChars:budget});
  const info=data(r);
  const encoded=JSON.stringify(info);
  assert.ok(encoded.length<=budget,mode+' exceeded '+budget+': '+encoded.length);
  assert.equal(info.mode,mode);
  assert.equal(info.project.packageManager,'pnpm');
  assert.ok(info.project.frameworks.some(f=>f.name==='next'));
  const guidance=info.instructions.map(x=>x.text).join('\n');
  assert.match(guidance,/ROOT_PHASE4_INSTRUCTIONS/);
  assert.match(guidance,/SRC_PHASE4_INSTRUCTIONS/);
  assert.ok(!encoded.includes('PRIVATE_PHASE4_MUST_NOT_LEAK'));
  if(mode==='outline'){
   assert.equal(info.graph.format,'graph-outline-v1');
   assert.ok(info.graph.files.some(f=>f[0]==='src/feature31.ts'));
   assert.ok(!encoded.includes('return n +'));
  }else{
   const target=info.files.find(f=>f.file==='src/feature31.ts');
   assert.ok(target,'focused file should be returned with fresh hash');
   assert.equal(target.sha256,hash(await fs.readFile(paths[31])));
  }
 }
 const full=data(await callTool('project_context',{path:root,focus:'src/feature31.ts'}));
 assert.ok(full.instructionPolicy);
 assert.ok(full.availableChecks);
 assert.ok(full.editor!==undefined);
});


test('opt-in compact context_pack avoids duplicate text while keeping exact structured references and hashes',async()=>{
 const before=process.env.BRC_RESULT_TEXT_MODE;
 try{
  for(const mode of ['outline','balanced']){
   const args={path:root,focus:'src/feature31.ts',query:'phase4Symbol31',
    maxFiles:130,mode,maxChars:20000};
   process.env.BRC_RESULT_TEXT_MODE='legacy';
   const legacy=await callTool('context_pack',args);
   data(legacy);
   process.env.BRC_RESULT_TEXT_MODE='compact';
   const compact=await callTool('context_pack',args);
   data(compact);
   assert.deepEqual(compact.structuredContent,legacy.structuredContent,
    'compact presentation must preserve the complete machine-readable payload');
   assert.ok(compact.content[0].text.length<800,
    'only the text view should shrink when structured data is available');
   assert.match(compact.content[0].text,/structuredContent/);
   const oldBytes=Buffer.byteLength(JSON.stringify(legacy));
   const newBytes=Buffer.byteLength(JSON.stringify(compact));
   assert.ok(newBytes<oldBytes*.75,
    mode+' result frames should be at least 25% smaller on this fixture');
   console.log('CONTEXT_PACK_BYTES_'+mode.toUpperCase()+'='+JSON.stringify({
    legacy:oldBytes,compact:newBytes,ratio:+(newBytes/oldBytes).toFixed(3)}));
  }
 }finally{
  if(before===undefined)delete process.env.BRC_RESULT_TEXT_MODE;
  else process.env.BRC_RESULT_TEXT_MODE=before;
 }
});
