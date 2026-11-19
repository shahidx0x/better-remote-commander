import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-edit-repair-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const full=n=>path.join(root,n);
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:75});});
test('edit_block replace_all is explicit, not an accidental duplicate-text mutation',async()=>{
 const file=full('repeated.ts');const before='const one = true;\nconst two = true;\n';
 await fs.writeFile(file,before);
 const denied=await callTool('edit_block',{file_path:file,old_string:'true',new_string:'false'});
 assert.equal(denied.isError,true);
 assert.equal(denied.structuredContent.error.code,'EDIT_COUNT_MISMATCH');
 assert.equal(denied.structuredContent.sourceSha256,sha256(before));
 assert.deepEqual(denied.structuredContent.candidateLines,[]);
 assert.equal(await fs.readFile(file,'utf8'),before);
 const ok=await callTool('edit_block',{file_path:file,old_string:'true',new_string:'false',replace_all:true});
 assert.notEqual(ok.isError,true,JSON.stringify(ok));
 assert.equal(await fs.readFile(file,'utf8'),'const one = false;\nconst two = false;\n');
});
test('edit_block missing anchor returns a hash and line-number repair locations without modifying content',async()=>{
 const file=full('candidates.ts');
 const data=['// retained','const importantLabel = "old";','const other = 42;','const importantLabelX = "value";'].join('\n')+'\n';
 await fs.writeFile(file,data);
 const failed=await callTool('edit_block',{file_path:file,
  old_string:'const importantLabel = "new";',new_string:'const importantLabel = "changed";'});
 assert.equal(failed.structuredContent.error.code,'EDIT_TEXT_NOT_FOUND');
 assert.equal(failed.structuredContent.sourceSha256,sha256(data));
 assert.ok(Array.isArray(failed.structuredContent.candidateLines));
 assert.ok(failed.structuredContent.candidateLines.includes(2));
 assert.equal(failed.structuredContent.next.tool,'read_code_file');
 assert.equal(failed.structuredContent.next.args.path,file);
 assert.equal(await fs.readFile(file,'utf8'),data);
});
test('edit_block multi-edit replace_all validates every hunk before one write',async()=>{
 const file=full('multi.ts'),before='one\nTWO\nTWO\nend\n';
 await fs.writeFile(file,before);
 const r=await callTool('edit_block',{file_path:file,edits:[
  {old_string:'one',new_string:'changed'},
  {old_string:'TWO',new_string:'2',replace_all:true},
  {old_string:'missing',new_string:'problem'}
 ]});
 assert.equal(r.isError,true);
 assert.equal(r.structuredContent.error.code,'EDIT_TEXT_NOT_FOUND');
 assert.equal(await fs.readFile(file,'utf8'),before);
 const good=await callTool('edit_block',{file_path:file,edits:[
  {old_string:'one',new_string:'changed'},
  {old_string:'TWO',new_string:'2',replace_all:true}
 ]});
 assert.notEqual(good.isError,true,JSON.stringify(good));
 assert.equal(await fs.readFile(file,'utf8'),'changed\n2\n2\nend\n');
});
