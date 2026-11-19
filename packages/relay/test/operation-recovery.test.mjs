import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtempSync} from 'node:fs';
import {rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {SqliteStore} from '../dist/store/sqlite.js';
import {OperationJournal} from '../dist/mcp/operation-journal.js';
import {invokeTool} from '../dist/mcp/invoke.js';

const SECRET='the-stable-session-secret-for-recovery-tests-64chars!!';
async function withStore(fn){
 const dir=mkdtempSync(path.join(os.tmpdir(),'brc-relay-recovery-'));
 const filename=path.join(dir,'relay.sqlite');
 const store=new SqliteStore(filename);
 try{await fn(store,filename);}finally{store.close();await rm(dir,{recursive:true,force:true});}
}
const output=content=>({content:[{type:'text',text:content}],structuredContent:{passed:true,output:content}});
const ctx={userId:'ownerA',clientId:'oauth-client-1'};

test('encrypted results and claims survive a fresh SQLite relay without exposing plaintext',async()=>{
 await withStore(async(store,file)=>{
  const first=new OperationJournal(store,SECRET);
  const id=randomUUID();
  const claim=await first.claim({...ctx,deviceId:'device-A',tool:'run_command',args:{command:'printf secret'}},id);
  assert.equal(claim.claimed,true);
  const privateOutput='PRIVATE_VALUE_SHOULD_NOT_BE_PLAINTEXT_IN_RELAY';
  const settled=await first.settle(claim.row,output(privateOutput));
  assert.deepEqual(settled,{durable:true,resultStored:true});
  const raw=await readFile(file);
  assert.equal(raw.includes(Buffer.from(privateOutput)),false);
  assert.equal(raw.includes(Buffer.from('printf secret')),false);
  const second=new OperationJournal(store,SECRET);
  const again=await second.claim({...ctx,deviceId:'device-A',tool:'run_command',args:{command:'printf secret'}},id);
  assert.equal(again.claimed,false);
  const restored=await second.recoveredResult(again.row);
  assert.equal(restored.content[0].text,privateOutput);
  const recovered=await second.recovery(ctx,{operationId:id});
  assert.equal(recovered.found,true);
  assert.equal(recovered.resultAvailable,true);
  assert.match(recovered.resultText,/PRIVATE_VALUE_SHOULD_NOT/);
  assert.equal(recovered.automaticReplay,false);
 });
});

test('ownership and argument digest prevent another client or changed command reusing an operation ID',async()=>{
 await withStore(async store=>{
  const journal=new OperationJournal(store,SECRET),id=randomUUID();
  const info={...ctx,deviceId:'dev-A',tool:'write_file',args:{path:'a',content:'hello'}};
  await journal.claim(info,id);
  await assert.rejects(journal.claim({...info,args:{path:'b',content:'hello'}},id),/different arguments/);
  await assert.rejects(journal.claim({...info,clientId:'another-client'},id),/not available/);
  const other=await journal.recovery({...ctx,clientId:'another-client'},{operationId:id});
  assert.equal(other.found,false);
  assert.deepEqual((await journal.recovery({...ctx,clientId:'another-client'},{})).operations,[]);
  assert.equal((await journal.recovery(ctx,{})).operations.length,1);
 });
});

test('relay forwards the durable UUID to the agent exactly once and duplicate returns prior result',async()=>{
 await withStore(async store=>{
  const user=store.upsertUser('admin','test');
  store.issueDeviceToken('device-A',user.id,'Test PC','win32');
  const current={userId:user.id,clientId:'oauth-client'};
  const journal=new OperationJournal(store,SECRET);
  let called=0,lastWireId;
  const hub={
   resolveDefault:()=> 'device-A',list:()=>[{deviceId:'device-A'}],
   get:id=>id==='device-A'?{ownerId:user.id,info:{name:'Test PC'},tools:[{name:'run_command'}]}:undefined,
   call:async(_id,_tool,_args,options)=>{called++;lastWireId=options.callId;return output('done once');}
  };
  const operationId=randomUUID(),args={operationId,command:'node -e "console.log(1)"'};
  const first=await invokeTool(hub,store,current,'run_command',args,{journal});
  assert.equal(first.ok,true);
  assert.equal(first.result._meta.operationId,operationId);
  assert.equal(first.result._meta.relayJournalSettled,true);
  assert.equal(first.result._meta.recoverableResult,true);
  assert.equal(lastWireId,operationId);
  const duplicate=await invokeTool(hub,store,current,'run_command',args,{journal});
  assert.equal(duplicate.ok,true);
  assert.equal(duplicate.result._meta.recoveredFromRelay,true);
  assert.equal(called,1);
  const different=await invokeTool(hub,store,current,'run_command',
   {...args,command:'dangerous different command'},{journal});
  assert.equal(different.ok,false);
  assert.equal(different.status,409);
  assert.equal(called,1);
 });
});

test('disconnect after dispatch stays uncertain; same ID cannot start another mutation',async()=>{
 await withStore(async store=>{
  const user=store.upsertUser('admin','test');
  store.issueDeviceToken('dev-A',user.id,'PC','win32');
  const current={userId:user.id,clientId:'oauth-client'};
  const journal=new OperationJournal(store,SECRET);
  let called=0;
  const hub={
   resolveDefault:()=> 'dev-A',list:()=>[{deviceId:'dev-A'}],
   get:()=>({ownerId:user.id,info:{name:'PC'},tools:[{name:'edit_block'}]}),
   call:async()=>{called++;throw new Error('DEVICE_DISCONNECTED: outcome unknown');}
  };
  const operationId=randomUUID(),args={operationId,old_string:'one',new_string:'two'};
  const first=await invokeTool(hub,store,current,'edit_block',args,{journal});
  assert.equal(first.ok,false);
  assert.equal(first.operationId,operationId);
  assert.equal((await journal.recovery(current,{operationId,includeResult:false})).state,'uncertain');
  const duplicate=await invokeTool(hub,store,current,'edit_block',args,{journal});
  assert.equal(duplicate.ok,true);
  assert.equal(duplicate.result.isError,true);
  assert.equal(called,1);
 });
});

test('JSON result paging preserves UTF-8 and disables payload retention with short/rotated keys',async()=>{
 await withStore(async store=>{
  const journal=new OperationJournal(store,SECRET),id=randomUUID();
  const claim=await journal.claim({...ctx,deviceId:'dev-A',tool:'run_command',args:{}},id);
  await journal.settle(claim.row,output('🎯'.repeat(3000)));
  let offset=0,combined='';
  for(let i=0;i<20;i++){
   const page=await journal.recovery(ctx,{operationId:id,offset,limit:4096});
   combined+=page.resultText;
   offset=page.nextByteOffset;
   if(!page.hasMore)break;
  }
  assert.equal(JSON.parse(combined).content[0].text,'🎯'.repeat(3000));
  const short=new OperationJournal(store,'weak');
  assert.equal(short.status().encryptedPayloads,false);
  const unreadable=await short.recovery(ctx,{operationId:id});
  assert.equal(unreadable.resultText,null);
  assert.equal(unreadable.found,true);
 });
});

test('concurrent identical requests cannot dispatch twice and a read-only call without an ID stays fast',async()=>{
 await withStore(async store=>{
  const user=store.upsertUser('admin','test');
  store.issueDeviceToken('dev-A',user.id,'PC','win32');
  const owner={userId:user.id,clientId:'oauth-client'};
  const journal=new OperationJournal(store,SECRET);
  let calls=0;
  const hub={
   resolveDefault:()=> 'dev-A',list:()=>[{deviceId:'dev-A'}],
   get:()=>({ownerId:user.id,info:{name:'PC'},tools:[{name:'run_command'},{name:'read_file'}]}),
   call:async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,10));return output('hello');}
  };
  const operationId=randomUUID();
  const requests=await Promise.all(Array.from({length:7},()=>invokeTool(
   hub,store,owner,'run_command',{operationId,command:'same command'},{journal})));
  assert.equal(calls,1);
  assert.equal(requests.filter(r=>r.ok&&!r.result.isError).length,1);
  assert.equal(requests.filter(r=>r.ok&&r.result.isError).length,6);
  const ordinary=await invokeTool(hub,store,owner,'read_file',{path:'sample'},
   {journal,readOnly:true});
  assert.equal(ordinary.ok,true);
  assert.equal(ordinary.result._meta?.operationId,undefined);
  const opted=await invokeTool(hub,store,owner,'read_file',{path:'sample',operationId:randomUUID()},
   {journal,readOnly:true});
  assert.equal(opted.ok,true);
  assert.equal(typeof opted.result._meta.operationId,'string');
 });
});

test('oversized result keeps durable metadata but not the plaintext body',async()=>{
 await withStore(async store=>{
  const journal=new OperationJournal(store,SECRET),id=randomUUID();
  const claimed=await journal.claim({...ctx,deviceId:'dev-A',tool:'run_command',args:{}},id);
  const oversize='unretained-payload-'+('x'.repeat(530000));
  const saved=await journal.settle(claimed.row,output(oversize));
  assert.equal(saved.durable,true);
  assert.equal(saved.resultStored,false);
  const recovered=await journal.recovery(ctx,{operationId:id});
  assert.equal(recovered.resultAvailable,false);
  assert.ok(recovered.resultBytes>512*1024);
  assert.equal(recovered.resultText,null);
  assert.equal((await journal.claim({...ctx,deviceId:'dev-A',tool:'run_command',args:{}},id)).claimed,false);
 });
});

test('rotating a strong encryption key does not change durable claims, but old ciphertext cannot be decrypted',async()=>{
 await withStore(async store=>{
  const oldKey=new OperationJournal(store,SECRET),id=randomUUID();
  const claim=await oldKey.claim({...ctx,deviceId:'dev-A',tool:'run_command',args:{}},id);
  assert.equal((await oldKey.settle(claim.row,output('sensitive'))).resultStored,true);
  const newKey=new OperationJournal(store,'a-different-strong-rotation-secret-1234567890123456');
  const recovered=await newKey.recovery(ctx,{operationId:id});
  assert.equal(recovered.found,true);
  assert.equal(recovered.resultText,null);
  assert.equal((await newKey.claim({...ctx,deviceId:'dev-A',tool:'run_command',args:{}},id)).claimed,false);
 });
});
