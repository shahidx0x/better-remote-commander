import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-context-patch-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});});
const file=n=>path.join(root,n);
const patch=(...lines)=>['*** Begin Patch',...lines,'*** End Patch'].join('\n');
test('apply_patch validates and commits multiple existing source files and hunks',async()=>{
 const a=file('main.ts'),b=file('helper.ts');
 await fs.writeFile(a,'const title = "old";\nconst enabled = false;\n');
 await fs.writeFile(b,'function helper() {\n  return 10;\n}\n');
 const input=patch(
  '*** Update File: main.ts','@@','-const title = "old";','+const title = "new";',
  '@@','-const enabled = false;','+const enabled = true;',
  '*** Update File: helper.ts','@@',' function helper() {','-  return 10;','+  return 20;',' }'
 );
 const check=await callTool('apply_patch',{cwd:root,input,dryRun:true});
 assert.notEqual(check.isError,true,JSON.stringify(check));
 assert.equal(check.structuredContent.hunks,3);
 assert.equal(await fs.readFile(a,'utf8'),'const title = "old";\nconst enabled = false;\n');
 const result=await callTool('apply_patch',{cwd:root,input});
 assert.notEqual(result.isError,true,JSON.stringify(result));
 assert.equal(result.structuredContent.validatedFullPatchBeforeWriting,true);
 assert.equal(await fs.readFile(a,'utf8'),'const title = "new";\nconst enabled = true;\n');
 assert.equal(await fs.readFile(b,'utf8'),'function helper() {\n  return 20;\n}\n');
});
test('second-file context mismatch fails whole patch before writing any file',async()=>{
 const a=file('preflight-a.txt'),b=file('preflight-b.txt');
 await fs.writeFile(a,'alpha\n');
 await fs.writeFile(b,'beta\n');
 const result=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Update File: preflight-a.txt','@@','-alpha','+ALPHA',
  '*** Update File: preflight-b.txt','@@','-missing','+MISSING'
 )});
 assert.equal(result.isError,true);
 assert.equal(result.structuredContent.error.code,'PATCH_CONTEXT_MISMATCH');
 assert.equal(await fs.readFile(a,'utf8'),'alpha\n');
 assert.equal(await fs.readFile(b,'utf8'),'beta\n');
});
test('ambiguous same-line context fails closed, and traversal/deletion are rejected',async()=>{
 const a=file('ambiguous.txt');
 await fs.writeFile(a,'same\nsame\n');
 const ambiguous=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Update File: ambiguous.txt','@@','-same','+changed'
 )});
 assert.equal(ambiguous.isError,true);
 assert.equal(ambiguous.structuredContent.error.code,'PATCH_CONTEXT_MISMATCH');
 assert.equal(await fs.readFile(a,'utf8'),'same\nsame\n');
 const traversal=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Update File: ../escape.txt','@@','-old','+new'
 )});
 assert.equal(traversal.isError,true);
 assert.equal(traversal.structuredContent.error.code,'PATCH_SYNTAX');
 const unsupported=await callTool('apply_patch',{cwd:root,input:patch('*** Delete File: ambiguous.txt')});
 assert.equal(unsupported.isError,true);
 assert.equal(unsupported.structuredContent.error.code,'PATCH_SYNTAX');
 assert.equal(await fs.readFile(a,'utf8'),'same\nsame\n');
});
test('CRLF edits retain line endings and exact whole-line matching',async()=>{
 const p=file('windows.cs');await fs.writeFile(p,'class A {\r\n  int Value = 5;\r\n}\r\n');
 const result=await callTool('apply_patch',{cwd:root,input:patch(
  '*** Update File: windows.cs','@@',' class A {','-  int Value = 5;','+  int Value = 6;',' }'
 )});
 assert.notEqual(result.isError,true,JSON.stringify(result));
 assert.equal(await fs.readFile(p,'utf8'),'class A {\r\n  int Value = 6;\r\n}\r\n');
});
