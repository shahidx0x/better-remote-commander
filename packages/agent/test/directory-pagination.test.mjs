import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {mkdtempSync,realpathSync} from 'node:fs';
const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-directory-page-'));
process.env.BRC_HOME=path.join(root,'home');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
after(async()=>{await configManager.close();await fs.rm(root,{recursive:true,force:true,maxRetries:8,retryDelay:90});});
test('directory pages have global limits and a continuation, without retaining a 900-item response',async()=>{
 const dir=path.join(root,'wide');await fs.mkdir(dir);
 await Promise.all(Array.from({length:750},(_,i)=>fs.writeFile(path.join(dir,'file-'+String(i).padStart(4,'0')+'.txt'),'x')));
 const found=new Set();
 let next=0,pages=0;
 do{
  const r=await callTool('list_directory',{path:dir,depth:1,offset:next,limit:67});
  assert.notEqual(r.isError,true,JSON.stringify(r));
  const page=r.structuredContent.directory;
  assert.ok(page.entries.length<=67);
  assert.ok(page.bytes<=64*1024);
  assert.equal(page.notSnapshot,true);
  for(const line of page.entries){assert.ok(!found.has(line),line);found.add(line);}
  next=page.nextOffset;
  pages++;
  assert.ok(pages<20,'pagination must make progress');
 }while(next!==null);
 assert.equal(found.size,750);
 assert.ok(pages>10);
});
test('directory listing rejects invalid offsets and never allows infinite output',async()=>{
 const dir=path.join(root,'wide');
 const r=await callTool('list_directory',{path:dir,depth:1,offset:-1,limit:10});
 assert.equal(r.isError,true);
 const big=await callTool('list_directory',{path:dir,depth:1,offset:0,limit:5000});
 assert.equal(big.isError,true);
});
test('nested directories honor per-directory cap and show omission warning',async()=>{
 const dir=path.join(root,'nested'),nested=path.join(dir,'child');
 await fs.mkdir(nested,{recursive:true});
 await Promise.all(Array.from({length:122},(_,i)=>fs.writeFile(path.join(nested,'child-'+i+'.txt'),'x')));
 const r=await callTool('list_directory',{path:dir,depth:2,limit:200});
 assert.notEqual(r.isError,true);
 assert.match(r.content[0].text,/additional nested entries omitted/);
 const p=r.structuredContent.directory;
 assert.ok(p.entries.length<=200);
});
