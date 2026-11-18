// Local agent-only edit_block recovery regression: no user project files changed.
import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const scratch=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-edit-errors-'));
const root=path.join(scratch,'project');
process.env.BRC_HOME=path.join(scratch,'agent');
process.env.BRC_LOG_LEVEL='silent';
process.env.BRC_ERROR_LOG='0';
await fs.mkdir(root,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const file=name=>path.join(root,name);
const text=r=>r.content.map(c=>c.text??'').join('\n');
const assertFailed=(r,code)=>{
 assert.equal(r.isError,true,text(r));
 assert.equal(r.structuredContent?.error?.code,code,text(r));
 assert.equal(r.structuredContent.recovery.automaticRetry,false);
 assert.ok(r.structuredContent.recovery.suggestion);
 return r;
};
after(async()=>{await configManager.close();
 await fs.rm(scratch,{recursive:true,force:true,maxRetries:6,retryDelay:75});
});

test('normal exact edit_block replacement succeeds and is observable',async()=>{
 const p=file('single.ts');
 await fs.writeFile(p,'  const value = 1;\n');
 const r=await callTool('edit_block',{file_path:p,old_string:'const value = 1;',new_string:'const value = 2;'});
 assert.notEqual(r.isError,true,text(r));
 assert.equal(await fs.readFile(p,'utf8'),'  const value = 2;\n');
});

test('edit_block aligns a unique multiline indentation-only difference',async()=>{
 const p=file('whitespace.ts');
 await fs.writeFile(p,'function f() {\n    return true;\n}\n');
 const r=await callTool('edit_block',{
   file_path:p,old_string:'function f() {\n  return true;\n}',new_string:'changed'
 });
 assert.notEqual(r.isError,true,text(r));
 assert.equal(r.structuredContent.autoAlignedIndentation,true);
 assert.equal(await fs.readFile(p,'utf8'),'changed\n');
});

test('multiple occurrences report actual count and require an explicit decision',async()=>{
 const p=file('count.ts');
 await fs.writeFile(p,'alpha+alpha');
 const bad=assertFailed(await callTool('edit_block',{file_path:p,
   old_string:'alpha',new_string:'beta',expected_replacements:1
 }), 'EDIT_COUNT_MISMATCH');
 assert.equal(bad.structuredContent.expectedReplacements,1);
 assert.equal(bad.structuredContent.actualReplacements,2);
 assert.equal(bad.structuredContent.changed,false);
 assert.equal(await fs.readFile(p,'utf8'),'alpha+alpha');
 const good=await callTool('edit_block',{file_path:p,
   old_string:'alpha',new_string:'beta',expected_replacements:2
 });
 assert.notEqual(good.isError,true,text(good));
 assert.equal(await fs.readFile(p,'utf8'),'beta+beta');
});

test('replacement counts use actual non-overlapping matches',async()=>{
 const p=file('overlap.ts');
 await fs.writeFile(p,'aaaa');
 const r=await callTool('edit_block',{file_path:p,old_string:'aa',new_string:'b',expected_replacements:2});
 assert.notEqual(r.isError,true,text(r));
 assert.equal(await fs.readFile(p,'utf8'),'bb');
});

test('stale hash rebases only when an exact, unique, sufficiently specific anchor remains',async()=>{
 const p=file('safe-rebase.ts');
 const original='export const importantLabel = "before";\nexport const unrelated = 1;\n';
 const revised='export const importantLabel = "before";\nexport const unrelated = 2;\n';
 await fs.writeFile(p,original);
 const previousHash=sha256(original);
 await fs.writeFile(p,revised);
 const r=await callTool('edit_block',{file_path:p,
   old_string:'export const importantLabel = "before";',
   new_string:'export const importantLabel = "after";',
   expected_sha256:previousHash});
 assert.notEqual(r.isError,true,text(r));
 assert.equal(r.structuredContent?.autoRebasedFromStaleHash,true);
 assert.equal(await fs.readFile(p,'utf8'),
   'export const importantLabel = "after";\nexport const unrelated = 2;\n');
});

test('ambiguous stale anchors keep FILE_CONFLICT and leave new content unchanged',async()=>{
 const p=file('unsafe-rebase.ts');
 const original='export const repeatedValue = 1;\n';
 const revised=original+original+'// independently modified\n';
 await fs.writeFile(p,revised);
 const r=assertFailed(await callTool('edit_block',{file_path:p,
   old_string:'export const repeatedValue = 1;',
   new_string:'export const repeatedValue = 2;',
   expected_sha256:sha256(original)}),'FILE_CONFLICT');
 assert.equal(await fs.readFile(p,'utf8'),revised);
});

test('final atomic write refuses an external change after a validated hash',async()=>{
 const p=file('precondition.ts');
 const original='export const setting = 1;\n';
 const externallyChanged='export const setting = 2;\n';
 await fs.writeFile(p,externallyChanged);
 const {atomicWrite}=await import('../dist/runtime/file-safety.js');
 const {withCallContext}=await import('../dist/context.js');
 await assert.rejects(
   ()=>withCallContext({id:'test-condition',client:null,remote:false,
     writePrecondition:{path:p,sha256:sha256(original)}},
     ()=>atomicWrite(p,'export const setting = 3;\n',sha256(externallyChanged))),
   (e)=>e?.code==='FILE_CONFLICT');
 assert.equal(await fs.readFile(p,'utf8'),externallyChanged);
});

test('stale expected_sha256 is FILE_CONFLICT with actionable instructions',async()=>{
 const p=file('hash.ts');
 const before='export const enabled=true;\n';
 await fs.writeFile(p,before);
 const wrong=assertFailed(await callTool('edit_block',{
   file_path:p,old_string:'true',new_string:'false',expected_sha256:sha256('older version')
 }), 'FILE_CONFLICT');
 assert.match(text(wrong),/read_code_file/);
 assert.equal(await fs.readFile(p,'utf8'),before);
 const snapshot=await callTool('read_code_file',{path:p});
 const good=await callTool('edit_block',{
   file_path:p,old_string:'true',new_string:'false',
   expected_sha256:snapshot.structuredContent.sha256
 });
 assert.notEqual(good.isError,true,text(good));
 assert.equal(await fs.readFile(p,'utf8'),'export const enabled=false;\n');
});

test('missing file_path, new_string and invalid expected_replacements are INVALID_ARGUMENT',async()=>{
 const p=file('argument.ts');
 await fs.writeFile(p,'one\n');
 for(const args of [
  {old_string:'one',new_string:'two'},
  {file_path:p,old_string:'one'},
  {file_path:p,old_string:'one',new_string:'two',expected_replacements:0},
  {file_path:p,old_string:'one',new_string:'two',expected_replacements:1.5},
  {file_path:'',old_string:'one',new_string:'two'},
 ]){
  const r=assertFailed(await callTool('edit_block',args),'INVALID_ARGUMENT');
  assert.match(text(r),/file_path|new_string|old_string|expected_replacements/);
 }
 assert.equal(await fs.readFile(p,'utf8'),'one\n');
});

test('multi-edit mismatch is atomic for ordinary text files',async()=>{
 const p=file('multi.ts');
 await fs.writeFile(p,'first\nsecond\n');
 const r=assertFailed(await callTool('edit_block',{file_path:p,edits:[
   {old_string:'first',new_string:'changed'},
   {old_string:'missing-string',new_string:'changed'}
 ]}),'EDIT_TEXT_NOT_FOUND');
 assert.equal(r.structuredContent.editIndex,2);
 assert.equal(r.structuredContent.editsApplied,0);
 assert.equal(r.structuredContent.changed,false);
 assert.equal(await fs.readFile(p,'utf8'),'first\nsecond\n');
});

test('unsupported range and incorrect file paths have explicit edit errors',async()=>{
 const p=file('range.txt');
 await fs.writeFile(p,'hello');
 const r=assertFailed(await callTool('edit_block',{
   file_path:p,range:'Sheet1!A1:A1',content:[['x']]
 }),'EDIT_UNSUPPORTED_RANGE');
 assert.equal(r.structuredContent.changed,false);
 const missing=await callTool('edit_block',{file_path:file('never-created.txt'),old_string:'a',new_string:'b'});
 assert.equal(missing.isError,true);
 assert.notEqual(missing.structuredContent?.error?.code,'TOOL_FAILED');
 assert.equal(await fs.readFile(p,'utf8'),'hello');
});

test('agent_status exposes recent edit error category without storing source text',async()=>{
 const s=await callTool('agent_status',{});
 assert.ok(s.structuredContent.recentFailures.some(e=>e.tool==='edit_block'));
 assert.equal(s.structuredContent.logging.failedToolLog.maxEntries,100);
 assert.equal(s.structuredContent.logging.failedToolLog.rotation,false);
 assert.equal(s.structuredContent.logging.failedToolLog.enabled,false);
});

test('indent-only recovery refuses ambiguous duplicate blocks and leaves file unchanged',async()=>{
 const p=file('ambiguous-indentation.ts');
 const body='function f() {\n    return true;\n}\n';
 await fs.writeFile(p,body+body);
 const r=assertFailed(await callTool('edit_block',{
   file_path:p,old_string:'function f() {\n  return true;\n}',new_string:'changed'
 }), 'EDIT_TEXT_NOT_FOUND');
 assert.equal(r.structuredContent.changed,false);
 assert.equal(await fs.readFile(p,'utf8'),body+body);
});

test('indent-only recovery never accepts semantic changes',async()=>{
 const p=file('semantic-difference.ts');
 const before='function f() {\n    return false;\n}\n';
 await fs.writeFile(p,before);
 const r=assertFailed(await callTool('edit_block',{
   file_path:p,old_string:'function f() {\n  return true;\n}',new_string:'changed'
 }), 'EDIT_TEXT_NOT_FOUND');
 assert.equal(await fs.readFile(p,'utf8'),before);
});

test('write_file creates missing parent folders under the allowed project',async()=>{
 const p=file(path.join('new-folder','nested','created.ts'));
 const r=await callTool('write_file',{path:p,content:'export const ok = true;\n',mode:'rewrite'});
 assert.notEqual(r.isError,true,text(r));
 assert.equal(await fs.readFile(p,'utf8'),'export const ok = true;\n');
});
