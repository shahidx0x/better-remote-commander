import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createHash} from 'node:crypto';
import {mkdtempSync,realpathSync} from 'node:fs';

const dir=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-strict-source-'));
const project=path.join(dir,'project');
process.env.BRC_HOME=path.join(dir,'agent');
process.env.BRC_REQUIRE_SOURCE_HASH='1';
await fs.mkdir(project,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[project]);
const {callTool}=await import('../dist/dispatcher.js');
const hash=s=>createHash('sha256').update(s).digest('hex');
const error=(r,code)=>{
 assert.equal(r.isError,true,JSON.stringify(r.structuredContent));
 assert.equal(r.structuredContent?.error?.code,code,JSON.stringify(r.structuredContent));
};
const ok=r=>assert.notEqual(r.isError,true,JSON.stringify(r.structuredContent?.error));
after(async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 await configManager.close();
 await fs.rm(dir,{recursive:true,force:true,maxRetries:6,retryDelay:80});
});

test('strict mode requires current hash for writing existing source, accepts fresh hash',async()=>{
 const file=path.join(project,'locked.ts'),old='export const count = 1;\n';
 await fs.writeFile(file,old);
 error(await callTool('write_file',{path:file,content:'should not write',mode:'rewrite'}),'SOURCE_HASH_REQUIRED');
 assert.equal(await fs.readFile(file,'utf8'),old);
 error(await callTool('write_file',{path:file,content:'should not write',mode:'rewrite',expected_sha256:hash('wrong')}),'FILE_CONFLICT');
 assert.equal(await fs.readFile(file,'utf8'),old);
 const next='export const count = 2;\n';
 ok(await callTool('write_file',{path:file,content:next,mode:'rewrite',expected_sha256:hash(old)}));
 assert.equal(await fs.readFile(file,'utf8'),next);
});

test('strict edit_block disables silent stale hash rebasing, preserves unrelated external writes',async()=>{
 const file=path.join(project,'external.ts'),base='export const sample = 1;\n';
 await fs.writeFile(file,base);
 error(await callTool('edit_block',{file_path:file,old_string:'sample = 1',new_string:'sample = 3'}),'SOURCE_HASH_REQUIRED');
 await fs.appendFile(file,'// external change\n');
 error(await callTool('edit_block',{file_path:file,old_string:'sample = 1',new_string:'sample = 3',
   expected_sha256:hash(base)}),'FILE_CONFLICT');
 assert.equal(await fs.readFile(file,'utf8'),base+'// external change\n');
 const current=await fs.readFile(file);
 ok(await callTool('edit_block',{file_path:file,old_string:'sample = 1',new_string:'sample = 3',
   expected_sha256:hash(current)}));
 assert.match(await fs.readFile(file,'utf8'),/sample = 3/);
});

test('new source creation remains allowed and default legacy editing behavior is preserved',async()=>{
 const fresh=path.join(project,'created.ts');
 ok(await callTool('write_file',{path:fresh,content:'export const fresh = 1;\n',mode:'rewrite'}));
 process.env.BRC_REQUIRE_SOURCE_HASH='0';
 try{
  ok(await callTool('write_file',{path:fresh,content:'export const fresh = 2;\n',mode:'rewrite'}));
  ok(await callTool('edit_block',{file_path:fresh,old_string:'fresh = 2',new_string:'fresh = 3'}));
  assert.match(await fs.readFile(fresh,'utf8'),/fresh = 3/);
 }finally{process.env.BRC_REQUIRE_SOURCE_HASH='1';}
});
