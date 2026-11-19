import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync} from 'node:fs';
const base=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-ast-guard-'));
process.env.BRC_HOME=path.join(base,'agent');
await fs.mkdir(process.env.BRC_HOME,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
const {guardedAstRewrite}=await import('../dist/runtime/ast-rewrite-guard.js');
const {applyEdits}=await import('../dist/tools/ast-grep.js');
const {projectIndex}=await import('../dist/runtime/project-index.js');
const {codeGraph}=await import('../dist/runtime/code-graph.js');
const SHA=s=>createHash('sha256').update(s).digest('hex');
await configManager.setValue('allowedDirectories',[base]);
after(async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 projectIndex.close();codeGraph.clear();
 await configManager.close();
 await fs.rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
const match=(text,token,replacement)=>{
 const pos=Buffer.from(text).indexOf(Buffer.from(token));
 if(pos<0)throw new Error('Token not found');
 return {text:token,range:{byteOffset:{start:pos,end:pos+Buffer.byteLength(token)}},replacement};
};
const one=(file,source,token,next)=>[{file,display:path.basename(file),matches:[match(source,token,next)]}];
const opt=(dryRun=true,hashes)=>({dryRun,contextLines:1,expectedSha256ByFile:hashes});
async function file(name,content){
 const p=path.join(base,name);await fs.mkdir(path.dirname(p),{recursive:true});
 await fs.writeFile(p,content);return p;
}
test('dry run emits full-source hashes; application updates bytes atomically by default',async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 const old='const greeting = "hello";\n',target=await file('first.ts',old);
 const staged=one(target,old,'hello','world');
 const preview=await guardedAstRewrite(staged,opt(),applyEdits);
 assert.equal(preview.totalEdits,1);
 assert.equal(preview.prepared[0].beforeHash,SHA(old));
 assert.equal(await fs.readFile(target,'utf8'),old,'dry-run must never write');
 const applied=await guardedAstRewrite(staged,opt(false,{'first.ts':SHA(old)}),applyEdits);
 assert.deepEqual(applied.written,['first.ts']);
 assert.equal(await fs.readFile(target,'utf8'),'const greeting = "world";\n');
 assert.equal(applied.prepared[0].afterHash,SHA('const greeting = "world";\n'));
});
test('changed source text makes stale byte offsets fail closed without any write',async()=>{
 const old='let value = 10;\n',target=await file('stale.ts',old);
 const scanned=one(target,old,'10','20');
 await fs.writeFile(target,'let value = 11;\n');
 await assert.rejects(guardedAstRewrite(scanned,opt(false),applyEdits),
   error=>error.code==='AST_MATCH_STALE');
 assert.equal(await fs.readFile(target,'utf8'),'let value = 11;\n');
});
test('strict mode requires dry-run hash and rejects a stale hash even if matching text remains',async()=>{
 const old='export const a = 1;\n',target=await file('strict.ts',old);
 const scanned=one(target,old,'a = 1','a = 2');
 process.env.BRC_REQUIRE_SOURCE_HASH='1';
 try{
  await assert.rejects(guardedAstRewrite(scanned,opt(false),applyEdits),
    error=>error.code==='SOURCE_HASH_REQUIRED');
  await fs.appendFile(target,'// other edit\n');
  await assert.rejects(guardedAstRewrite(scanned,opt(false,{'strict.ts':SHA(old)}),applyEdits),
    error=>error.code==='FILE_CONFLICT');
  assert.equal(await fs.readFile(target,'utf8'),old+'// other edit\n');
  const current=await fs.readFile(target,'utf8');
  const applied=await guardedAstRewrite(one(target,current,'a = 1','a = 2'),
    opt(false,{'strict.ts':SHA(current)}),applyEdits);
  assert.equal(applied.written.length,1);
 }finally{delete process.env.BRC_REQUIRE_SOURCE_HASH;}
});
test('multi-file rewrite validates ALL matched spans before publishing any file',async()=>{
 const a='const first = 111;\n',b='const second = 222;\n';
 const first=await file('multi/a.ts',a),second=await file('multi/b.ts',b);
 const targets=[...one(first,a,'111','333'),...one(second,b,'222','444')];
 await fs.writeFile(second,'const second = 999;\n');
 await assert.rejects(guardedAstRewrite(targets,opt(false),applyEdits),
  error=>error.code==='AST_MATCH_STALE');
 assert.equal(await fs.readFile(first,'utf8'),a);
 assert.equal(await fs.readFile(second,'utf8'),'const second = 999;\n');
});
test('out-of-bounds and overlapping offsets cannot silently apply partial source changes',async()=>{
 const src='x y z\n',target=await file('bounds.ts',src);
 const broken=one(target,src,'x','A');
 broken[0].matches[0].range.byteOffset.end=999;
 await assert.rejects(guardedAstRewrite(broken,opt(false),applyEdits),
  error=>error.code==='AST_MATCH_STALE');
 const overlaps=[...one(target,src,'x y','one')];
 overlaps[0].matches.push({...match(src,'y','two')});
 await assert.rejects(guardedAstRewrite(overlaps,opt(false),applyEdits),
  error=>error.code==='AST_OVERLAPPING_MATCHES');
 assert.equal(await fs.readFile(target,'utf8'),src);
});
test('UTF-8 byte offsets preserve multibyte characters in a guarded rewrite',async()=>{
 const src='const café = "☕";\n',target=await file('unicode.ts',src);
 const applied=await guardedAstRewrite(one(target,src,'☕','tea'),opt(false),applyEdits);
 assert.equal(applied.totalEdits,1);
 assert.equal(await fs.readFile(target,'utf8'),'const café = "tea";\n');
});
