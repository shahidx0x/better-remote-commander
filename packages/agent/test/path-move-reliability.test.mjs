import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-file-diagnostics-'));
const other=path.join(process.cwd(),'.brc-move-fixture-'+randomUUID().slice(0,8));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await fs.mkdir(other,{recursive:true});
await configManager.setValue('allowedDirectories',[root,other]);
const {callTool}=await import('../dist/dispatcher.js');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:70});await fs.rm(other,{recursive:true,force:true,maxRetries:8,retryDelay:70});});
const file=n=>path.join(root,n);
test('read_code_file returns nearest permitted parent and safe typo suggestions without creating anything',async()=>{
 const correct=file('component-example.ts');await fs.writeFile(correct,'export const example = 1;');
 const wrong=file('componet-example.ts');
 const res=await callTool('read_code_file',{path:wrong});
 assert.equal(res.isError,true);
 assert.equal(res.structuredContent.error.code,'ENOENT');
 assert.equal(res.structuredContent.pathRecovery.nearestExistingDirectory,root);
 assert.ok(res.structuredContent.pathRecovery.suggestions.includes(correct));
 assert.equal(res.structuredContent.pathRecovery.automaticCreation,false);
 await assert.rejects(fs.stat(wrong),/ENOENT/);
});
test('read_file also supplies structured missing-path diagnosis',async()=>{
 const res=await callTool('read_file',{path:file('not-here.json')});
 assert.equal(res.isError,true);
 assert.equal(res.structuredContent.error.code,'ENOENT');
 assert.equal(res.structuredContent.pathRecovery.nearestExistingDirectory,root);
});
test('move_file never overwrites an existing destination and preserves both files',async()=>{
 const source=file('source.txt'),dest=file('destination.txt');
 await fs.writeFile(source,'source data');await fs.writeFile(dest,'dest data');
 const r=await callTool('move_file',{source,destination:dest});
 assert.equal(r.isError,true);
 assert.equal(r.structuredContent.error.code,'MOVE_DEST_EXISTS');
 assert.equal(await fs.readFile(source,'utf8'),'source data');
 assert.equal(await fs.readFile(dest,'utf8'),'dest data');
});
test('same-volume file move is no-clobber and avoids copying file content',async()=>{
 const source=file('fast-src.txt'),dest=file('fast-dest.txt');
 await fs.writeFile(source,'fast move');
 const r=await callTool('move_file',{source,destination:dest});
 assert.notEqual(r.isError,true,JSON.stringify(r));
 assert.equal(r.structuredContent.move.verified,true);
 assert.equal(r.structuredContent.move.method,'hardlink_unlink');
 assert.equal(await fs.readFile(dest,'utf8'),'fast move');
 await assert.rejects(fs.stat(source),/ENOENT/);
});
test('different-volume file move streams a verified copy before deleting source',async(t)=>{
 if(process.platform!=='win32'||path.parse(root).root.toLowerCase()===path.parse(other).root.toLowerCase()){
  t.skip('The test machine does not expose two different Windows filesystem volumes');return;
 }
 const src=file('crossvolume.txt'),dst=path.join(other,'crossvolume.txt');
 await fs.writeFile(src,'cross volume data'.repeat(2000));
 const r=await callTool('move_file',{source:src,destination:dst});
 assert.notEqual(r.isError,true,JSON.stringify(r));
 assert.equal(r.structuredContent.move.method,'verified_copy');
 assert.equal(r.structuredContent.move.sourceRemoved,true);
 assert.equal(await fs.readFile(dst,'utf8'),'cross volume data'.repeat(2000));
 await assert.rejects(fs.stat(src),/ENOENT/);
});
test('cross-volume directory move fails clearly and never copies an unbounded tree',async(t)=>{
 if(process.platform!=='win32'||path.parse(root).root.toLowerCase()===path.parse(other).root.toLowerCase()){
  t.skip('The test machine does not expose two different volumes');return;
 }
 const src=file('folder'),dest=path.join(other,'folder');
 await fs.mkdir(src);await fs.writeFile(path.join(src,'data.txt'),'important');
 const r=await callTool('move_file',{source:src,destination:dest});
 assert.equal(r.isError,true);
 assert.equal(r.structuredContent.error.code,'MOVE_DIRECTORY_EXDEV');
 assert.equal(await fs.readFile(path.join(src,'data.txt'),'utf8'),'important');
 await assert.rejects(fs.stat(dest),/ENOENT/);
});
