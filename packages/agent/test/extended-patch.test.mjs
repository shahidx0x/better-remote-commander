import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-extended-patch-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const patch=(...lines)=>['*** Begin Patch',...lines,'*** End Patch'].join('\n');
const f=n=>path.join(root,n);
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:100});});
test('extended patch atomically validates Add, Delete, Move and Update before making any change',async()=>{
 const update=f('update.ts'),remove=f('old.ts'),move=f('source.py'),created=f('folder/new.txt'),dest=f('renamed.py');
 await fs.writeFile(update,'const value = 1;\n');
 await fs.writeFile(remove,'remove this file\n');
 await fs.writeFile(move,'print("move me")\n');
 const input=patch('*** Add File: folder/new.txt','+hello','+world',
  '*** Update File: update.ts','@@','-const value = 1;','+const value = 2;',
  '*** Move File: source.py -> renamed.py',
  '*** Delete File: old.ts');
 const preview=await callTool('apply_patch',{cwd:root,input,dryRun:true});
 assert.notEqual(preview.isError,true,JSON.stringify(preview));
 assert.equal(preview.structuredContent.files.length,4);
 assert.equal(await fs.readFile(update,'utf8'),'const value = 1;\n');
 await assert.rejects(fs.stat(created),/ENOENT/);
 const executed=await callTool('apply_patch',{cwd:root,input});
 assert.notEqual(executed.isError,true,JSON.stringify(executed));
 assert.equal(executed.structuredContent.files.length,4);
 assert.equal(await fs.readFile(update,'utf8'),'const value = 2;\n');
 assert.equal(await fs.readFile(created,'utf8'),'hello\nworld\n');
 assert.equal(await fs.readFile(dest,'utf8'),'print("move me")\n');
 await assert.rejects(fs.stat(move),/ENOENT/);
 await assert.rejects(fs.stat(remove),/ENOENT/);
});
test('later malformed context or duplicate destination aborts whole patch before any files are modified',async()=>{
 const a=f('preflight-a.txt'),b=f('preflight-b.txt');
 await fs.writeFile(a,'FIRST\n');await fs.writeFile(b,'SECOND\n');
 const mismatch=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Add File: newly-created.txt','+new',
  '*** Update File: preflight-a.txt','@@','-FIRST','+OK',
  '*** Update File: preflight-b.txt','@@','-MISSING','+WRONG'
 )});
 assert.equal(mismatch.isError,true);
 assert.equal(mismatch.structuredContent.error.code,'PATCH_CONTEXT_MISMATCH');
 assert.equal(await fs.readFile(a,'utf8'),'FIRST\n');
 await assert.rejects(fs.stat(f('newly-created.txt')),/ENOENT/);
 const exists=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Add File: preflight-b.txt','+overwrite'
 )});
 assert.equal(exists.isError,true);
 assert.equal(exists.structuredContent.error.code,'PATCH_TARGET_EXISTS');
 assert.equal(await fs.readFile(b,'utf8'),'SECOND\n');
});
test('update-and-move directive preserves source changes at the moved destination',async()=>{
 const a=f('rename-original.cs'),b=f('renamed-with-change.cs');
 await fs.writeFile(a,'class Old {}\r\n');
 const result=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Update File: rename-original.cs','*** Move to: renamed-with-change.cs',
  '@@','-class Old {}','+class New {}'
 )});
 assert.notEqual(result.isError,true,JSON.stringify(result));
 await assert.rejects(fs.stat(a),/ENOENT/);
 assert.equal(await fs.readFile(b,'utf8'),'class New {}\r\n');
});
test('patch parser rejects delete or move of symlinks and duplicate paths without mutations',async()=>{
 const original=f('duplicate.txt');await fs.writeFile(original,'A\n');
 const wrong=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Delete File: duplicate.txt',
  '*** Add File: duplicate.txt','+B'
 )});
 assert.equal(wrong.isError,true);
 assert.equal(wrong.structuredContent.error.code,'PATCH_SYNTAX');
 assert.equal(await fs.readFile(original,'utf8'),'A\n');
});
