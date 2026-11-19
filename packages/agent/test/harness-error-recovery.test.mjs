import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync} from 'node:fs';

// Never use the live user's ~/.brc configuration in a test worker.
const temp=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-harness-error-recovery-'));
process.env.BRC_HOME=path.join(temp,'agent');
process.env.BRC_LOG_LEVEL='silent';
process.env.BRC_ERROR_LOG='0';
const dir=path.join(temp,'project');
await fs.mkdir(dir,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[dir]);
const {callTool}=await import('../dist/dispatcher.js');
const {sha256}=await import('../dist/runtime/file-safety.js');
const {sourceObservationMode}=await import('../dist/runtime/source-observations.js');
const file=n=>path.join(dir,n);
const rendered=r=>(r.content??[]).map(x=>x.type==='text'?x.text:'').join('\n');
const isError=(r,code)=>{assert.equal(r.isError,true,rendered(r));
 assert.equal(r.structuredContent?.error?.code,code,rendered(r));};
after(async()=>{delete process.env.BRC_REQUIRE_SOURCE_HASH;
 await configManager.close();
 await fs.rm(temp,{recursive:true,force:true,maxRetries:6,retryDelay:80});
});

test('default source mode safely rebases a uniquely anchored stale edit without losing unrelated changes',async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 assert.equal(sourceObservationMode(),'auto');
 const f=file('safe.ts');
 const old='export const importantLabel = "before";\nexport const untouched = 1;\n';
 const changed='export const importantLabel = "before";\nexport const untouched = 2;\n';
 await fs.writeFile(f,changed);
 const out=await callTool('edit_block',{file_path:f,
  old_string:'export const importantLabel = "before";',
  new_string:'export const importantLabel = "after";',
  expected_sha256:sha256(old)});
 assert.notEqual(out.isError,true,rendered(out));
 assert.equal(out.structuredContent?.autoRebasedFromStaleHash,true);
 assert.equal(await fs.readFile(f,'utf8'),
   'export const importantLabel = "after";\nexport const untouched = 2;\n');
 assert.match(rendered(out),/Stale hash safely refreshed/);
});

test('stale hash with ambiguous anchors fails and returns the current hash and next read window',async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 const f=file('ambiguous.ts');
 const old='export const repeatedValue = 1;\n';
 const now=old+old+'// independent change\n';
 await fs.writeFile(f,now);
 const out=await callTool('edit_block',{file_path:f,
  old_string:'export const repeatedValue = 1;',
  new_string:'export const repeatedValue = 2;',
  expected_sha256:sha256(old)});
 isError(out,'FILE_CONFLICT');
 assert.equal(out.structuredContent.currentSha256,sha256(now));
 assert.equal(out.structuredContent.exactAnchorMatches,2);
 assert.equal(out.structuredContent.next.tool,'read_code_file');
 assert.equal(out.structuredContent.next.args.path,f);
 assert.match(rendered(out),/CURRENT_SHA256:/);
 assert.match(rendered(out),/NEXT: read_code_file/);
 assert.equal(await fs.readFile(f,'utf8'),now);
});

test('strict hash mode never rebases even a uniquely matched stale anchor',async()=>{
 process.env.BRC_REQUIRE_SOURCE_HASH='1';
 const f=file('strict.ts');
 const old='export const uniqueSetting = "off";\n';
 const now=old+'// external change\n';
 await fs.writeFile(f,now);
 try{
  const out=await callTool('edit_block',{file_path:f,
   old_string:'export const uniqueSetting = "off";',
   new_string:'export const uniqueSetting = "on";',
   expected_sha256:sha256(old)});
  isError(out,'FILE_CONFLICT');
  assert.equal(out.structuredContent.currentSha256,sha256(now));
  assert.equal(await fs.readFile(f,'utf8'),now);
 }finally{delete process.env.BRC_REQUIRE_SOURCE_HASH;}
});

test('short or missing stale anchors cannot trigger an automatic unsafe edit',async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 const f=file('short.ts'),current='export const ready=true;\n// new content\n';
 await fs.writeFile(f,current);
 const out=await callTool('edit_block',{file_path:f,
  old_string:'true',new_string:'false',
  expected_sha256:sha256('previous version')});
 isError(out,'FILE_CONFLICT');
 assert.equal(out.structuredContent.currentSha256,sha256(current));
 assert.equal(out.structuredContent.exactAnchorMatches,1);
 assert.equal(await fs.readFile(f,'utf8'),current);
 const absent=await callTool('edit_block',{file_path:f,
  old_string:'const completelyOldValue = 123456;',
  new_string:'const completelyOldValue = 456;',
  expected_sha256:sha256('older')});
 isError(absent,'FILE_CONFLICT');
 assert.equal(absent.structuredContent.exactAnchorMatches,0);
 assert.equal(await fs.readFile(f,'utf8'),current);
});

test('a missing exact edit returns readable hash and candidate line numbers',async()=>{
 const f=file('missing.ts');
 const current='// retained\nconst importantLabel = "old";\nconst other = 2;\n';
 await fs.writeFile(f,current);
 const out=await callTool('edit_block',{file_path:f,
  old_string:'const importantLabel = "new";',
  new_string:'const importantLabel = "updated";'});
 isError(out,'EDIT_TEXT_NOT_FOUND');
 assert.equal(out.structuredContent.sourceSha256,sha256(current));
 assert.match(rendered(out),/CURRENT_SHA256:/);
 assert.match(rendered(out),/CANDIDATE_LINES: 2/);
 assert.match(rendered(out),/NEXT_READ:/);
 assert.equal(await fs.readFile(f,'utf8'),current);
});

test('missing source read includes the nearest permitted directory and helpful next tool in visible output',async()=>{
 const exists=file('component-example.ts');
 await fs.writeFile(exists,'export const example = 1;\n');
 const missing=file('componet-example.ts');
 const out=await callTool('read_code_file',{path:missing});
 isError(out,'ENOENT');
 assert.equal(out.structuredContent.pathRecovery.nearestExistingDirectory,dir);
 assert.ok(out.structuredContent.pathRecovery.suggestions.includes(exists));
 assert.match(rendered(out),/POSSIBLE_FILENAMES:/);
 assert.match(rendered(out),/NEXT: list_directory/);
 await assert.rejects(fs.stat(missing),/ENOENT/);
});

test('whole-file writes do not silently ignore a stale explicit hash',async()=>{
 delete process.env.BRC_REQUIRE_SOURCE_HASH;
 const f=file('whole.ts'),initial='const initial=1;\n',now='const updated=2;\n';
 await fs.writeFile(f,now);
 const out=await callTool('write_file',{path:f,mode:'rewrite',
  content:'const replaced=3;\n',expected_sha256:sha256(initial)});
 isError(out,'FILE_CONFLICT');
 assert.equal(await fs.readFile(f,'utf8'),now);
});
