import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import {mkdtempSync,realpathSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';

const root=mkdtempSync(path.join(realpathSync.native(os.tmpdir()),'brc-mutation-receipts-'));
process.env.BRC_HOME=path.join(root,'home');
process.env.BRC_OPERATION_RECEIPTS='1';
const r=await import('../dist/runtime/operation-receipts.js');
const {configManager}=await import('../dist/core/config-manager.js');
await configManager.setValue('allowedDirectories',[root]);
const {callTool}=await import('../dist/dispatcher.js');
const hash=input=>createHash('sha256').update(input).digest('hex');
after(async()=>{await configManager.close();delete process.env.BRC_OPERATION_RECEIPTS;await fs.rm(root,{recursive:true,force:true,maxRetries:6,retryDelay:100});});

test('mutation receipts never persist raw paths, tool arguments, or content',async()=>{
 const secretPath=path.join(root,'token=secret-file-name.txt');
 await fs.writeFile(secretPath,'ORIGINAL\n');
 const receipt=await r.beginMutationReceipt('call-unique-one','write_file',[secretPath]);
 assert.equal(receipt?.outcome,'started');
 await fs.writeFile(secretPath,'CHANGED\n');
 await r.settleMutationReceipt(receipt,[secretPath],'returned_success');
 const saved=await fs.readFile(path.join(process.env.BRC_HOME,'mutation-receipts',hash('call-unique-one:write_file')+'.json'),'utf8');
 assert.doesNotMatch(saved,/secret-file-name|ORIGINAL|CHANGED|call-unique-one/);
 const data=JSON.parse(saved);
 assert.equal(data.outcome,'returned_success');
 assert.notEqual(data.before[0],data.after[0]);
 assert.equal(data.after[0],hash('CHANGED\n'));
 assert.equal(data.targets[0],hash(secretPath));
});

test('dispatcher file mutation leaves a durable settled receipt',async()=>{
 const dest=path.join(root,'new-output.txt');
 const response=await callTool('write_file',{path:dest,content:'confidential test payload'});
 assert.notEqual(response.isError,true,JSON.stringify(response));
 const saved=await r.recentMutationReceipts(20);
 assert.ok(saved.some(e=>e.tool==='write_file'&&e.outcome==='returned_success'&&e.after?.some(h=>h===hash('confidential test payload'))),
   JSON.stringify(saved));
 assert.ok(!JSON.stringify(saved).includes('new-output.txt'));
});

test('started receipt appears UNCERTAIN after fresh process; never replays mutation',async()=>{
 const target=path.join(root,'untouched.txt');
 const rec=await r.beginMutationReceipt('abandoned-receipt','edit_block',[target]);
 assert.ok(rec);
 const here=path.dirname(fileURLToPath(import.meta.url));
 const moduleUri=pathToFileURL(path.resolve(here,'../dist/runtime/operation-receipts.js')).href;
 const code='import {recentMutationReceipts} from '+JSON.stringify(moduleUri)+';process.stdout.write("RESULT="+JSON.stringify(await recentMutationReceipts(30))+"\\n");';
 const child=spawnSync(process.execPath,['--input-type=module','-e',code],
  {cwd:here,env:{...process.env,BRC_HOME:process.env.BRC_HOME,BRC_OPERATION_RECEIPTS:'1'},encoding:'utf8',timeout:10_000});
 assert.equal(child.status,0,child.stderr);
 const line=child.stdout.split(/\r?\n/).find(s=>s.startsWith('RESULT='));
 assert.ok(line,child.stdout);
 const events=JSON.parse(line.slice(7));
 const interrupted=events.find(e=>e.id===rec.id);
 assert.equal(interrupted.outcome,'uncertain');
 assert.equal(interrupted.recoveredUncertain,true);
 await assert.rejects(fs.stat(target),{code:'ENOENT'});
});

test('corrupt receipts ignored, disabled and disk failure are safe',async()=>{
 const dir=path.join(process.env.BRC_HOME,'mutation-receipts');
 await fs.writeFile(path.join(dir,hash('corrupt')+'.json'),'{unclosed');
 const events=await r.recentMutationReceipts(25);
 assert.ok(events.every(item=>item.id!==hash('corrupt')));
 process.env.BRC_OPERATION_RECEIPTS='0';
 try{assert.equal(await r.beginMutationReceipt('skip','write_file',[]),null);
   assert.deepEqual(await r.recentMutationReceipts(),[]);}
 finally{process.env.BRC_OPERATION_RECEIPTS='1';}
 const previous=process.env.BRC_HOME,blocker=path.join(root,'blocked-home');
 await fs.writeFile(blocker,'not a folder');
 process.env.BRC_HOME=blocker;
 try{assert.equal(await r.beginMutationReceipt('disk-error','write_file',[]),null);}
 finally{process.env.BRC_HOME=previous;}
});

test('bounded retention prunes old receipt files',async()=>{
 for(let i=0;i<132;i++){
  const receipt=await r.beginMutationReceipt('quota-'+i,'edit_block',[]);
  assert.ok(receipt);
 }
 const entries=(await fs.readdir(path.join(process.env.BRC_HOME,'mutation-receipts'))).filter(n=>n.endsWith('.json'));
 assert.ok(entries.length<=128,entries.length);
});


test('two nested mutations with the same parent MCP call ID keep separate receipts',async()=>{
 const {withCallContext}=await import('../dist/context.js');
 const a=path.join(root,'nested-one.txt'),b=path.join(root,'nested-two.txt');
 const results=await withCallContext({id:'shared-parent-mcp',remote:false,client:null},
   ()=>Promise.all([
     callTool('write_file',{path:a,content:'NESTED_ONE_CONTENT'}),
     callTool('write_file',{path:b,content:'NESTED_TWO_CONTENT'})
   ]));
 for(const res of results)assert.notEqual(res.isError,true,JSON.stringify(res));
 assert.equal(await fs.readFile(a,'utf8'),'NESTED_ONE_CONTENT');
 assert.equal(await fs.readFile(b,'utf8'),'NESTED_TWO_CONTENT');
 const items=(await r.recentMutationReceipts(40)).filter(e=>e.tool==='write_file');
 const one=items.find(e=>e.after?.includes(hash('NESTED_ONE_CONTENT')));
 const two=items.find(e=>e.after?.includes(hash('NESTED_TWO_CONTENT')));
 assert.ok(one&&two,'both operations require distinct durable receipts');
 assert.notEqual(one.id,two.id);
 assert.equal(one.outcome,'returned_success');
 assert.equal(two.outcome,'returned_success');
});
