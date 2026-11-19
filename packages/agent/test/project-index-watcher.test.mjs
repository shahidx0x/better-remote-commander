import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {mkdtempSync,realpathSync} from 'node:fs';
import {setTimeout as delay} from 'node:timers/promises';
const base=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-watcher-'));
const root=path.join(base,'repo');
process.env.BRC_HOME=path.join(base,'home');
await fs.mkdir(root,{recursive:true});
const {configManager}=await import('../dist/core/config-manager.js');
const {ProjectIndex}=await import('../dist/runtime/project-index.js');
await configManager.setValue('allowedDirectories',[root]);
const instances=[];
const newIndex=()=>{const i=new ProjectIndex();instances.push(i);return i;};
after(async()=>{
 for(const i of instances)i.close();
 await configManager.close();
 await fs.rm(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});
});
async function makeRepo(sub){
 const dir=path.join(root,sub);await fs.mkdir(path.join(dir,'src'),{recursive:true});
 await fs.writeFile(path.join(dir,'src','entry.ts'),'export const value=1;\n');
 return dir;
}
test('recursive watcher invalidates cached index on external nested rename, not just TTL',{timeout:10000},async t=>{
 const dir=await makeRepo('changes');
 const index=newIndex();
 const initial=await index.manage(dir,'enable','',true,200);
 if(!initial.watching){t.skip('Recursive fs.watch not available on this platform');return;}
 assert.ok(initial.files.some(f=>f.replace(/\\/g,'/')==='src/entry.ts'),JSON.stringify(initial.files));
 const newFile=path.join(dir,'src','new.ts');
 await fs.writeFile(newFile,'export const fresh=1;\n');
 let dirty=false;
 for(let i=0;i<100;i++){
  if(index.status().some(e=>e.root===dir&&e.dirty)){dirty=true;break;}
  await delay(25);
 }
 assert.ok(dirty,'watcher never invalidated index after external file creation');
 const current=await index.manage(dir,'query','new.ts',true,200);
 assert.deepEqual(current.files.map(f=>f.replace(/\\/g,'/')),['src/new.ts']);
 assert.equal(current.stale,false);
 assert.ok(index.status()[0].watcherEvents>0);
 await fs.rename(newFile,path.join(dir,'src','renamed.ts'));
 for(let i=0;i<100;i++){
  if(index.status()[0]?.dirty)break;
  await delay(25);
 }
 const renamed=await index.manage(dir,'query','renamed',true,200);
 assert.deepEqual(renamed.files.map(f=>f.replace(/\\/g,'/')),['src/renamed.ts']);
 assert.equal(renamed.stale,false);
 index.close();
 assert.equal(index.status().length,0);
});
test('if file changes during first scan, exactly one fresh read-only retry avoids stale names',async()=>{
 const dir=await makeRepo('retry');
 const index=newIndex();
 const original=index.build.bind(index);
 let scans=0;
 index.build=async entry=>{
  await original(entry);scans++;
  if(scans===1)index.invalidate(dir);
 };
 const v=await index.manage(dir,'enable','entry',false,50);
 assert.equal(v.stale,false);
 assert.equal(scans,2);
 assert.equal(index.status()[0].staleScanRetries,1);
});
test('continuously changing project tree fails closed after two scans',async()=>{
 const dir=await makeRepo('unsteady');
 const index=newIndex();
 const original=index.build.bind(index);
 let scans=0;
 index.build=async entry=>{await original(entry);scans++;index.invalidate(dir);};
 await assert.rejects(index.manage(dir,'enable','entry',false,50),e=>e.code==='INDEX_CHANGED');
 assert.equal(scans,2);
 assert.equal(index.status()[0].unstableScanRefusals,1);
});
