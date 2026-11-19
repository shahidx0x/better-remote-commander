/**
 * Requires an explicitly configured isolated MongoDB test server.
 * Always uses a NEW random database and drops only that test database.
 * Never uses or modifies the relay's production MONGODB_URI.
 */
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {MongoClient} from 'mongodb';
import {MongoStore} from '../dist/store/mongo.js';
import {MongoResultBudget} from '../dist/store/mongo-result-budget.js';
import {OperationJournal} from '../dist/mcp/operation-journal.js';
import {CrossRelayCoordinator} from '../dist/mcp/cross-relay.js';
import {invokeTool} from '../dist/mcp/invoke.js';

const uri=process.env.BRC_TEST_MONGODB_URI;
const strongSecret='DISPOSABLE_TEST_SECRET_FOR_MONGO_2_INSTANCE_RECOVERY_2026';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn,ms=20000){
 const started=Date.now();
 while(Date.now()-started<ms){if(await fn())return;await delay(45);}
 throw new Error('Isolated MongoDB dual-relay fixture timed out');
}
class TestHub {
 constructor(instanceId,owner,online){
  this.instanceId=instanceId;this.ownerId=owner;this.online=online;
  this.onHello=null;this.calls=0;this.acks=[];
  this.device={ownerId:owner,info:{deviceId:'durable-test-device',name:'Test Device'},
   tools:[{name:'run_command'}]};
 }
 list(user){
  return this.online&&(!user||user===this.ownerId)?
   [{deviceId:'durable-test-device',name:'Test Device'}]:[];
 }
 get(id){return this.online&&id==='durable-test-device'?this.device:undefined;}
 resolveDefault(user){return user===this.ownerId&&this.online?'durable-test-device':null;}
 async call(id,tool,args,opts){
  assert.equal(id,'durable-test-device');
  assert.equal(tool,'run_command');
  assert.equal(opts.durable,true);
  this.calls++;
  return {content:[{type:'text',text:'MONGODB_DUAL_RELAY_OK'}]};
 }
 acknowledgeResult(...args){this.acks.push(args);return true;}
 disconnectDevice(){this.online=false;}
}

test('real isolated MongoDB: two relay instances coordinate, journal, quota and ownership fencing',
 {skip:!uri,timeout:100000},async()=>{
 const dbName='brc_recovery_it_'+randomUUID().replaceAll('-','').slice(0,12);
 assert.match(dbName,/^brc_recovery_it_[a-f0-9]{12}$/);
 let a=null,b=null,coordinatorA=null,coordinatorB=null;
 try{
  [a,b]=await Promise.all([MongoStore.connect(uri,dbName),MongoStore.connect(uri,dbName)]);
  const user=await a.upsertUser('test-user','disposable-test-password');
  await a.issueDeviceToken('durable-test-device',user.id,'Test Device','win32');
  const context={userId:user.id,clientId:'test-oauth-client'};
  const hubA=new TestHub('instance-a',user.id,false);
  const hubB=new TestHub('instance-b',user.id,true);
  const journalA=new OperationJournal(a,strongSecret),journalB=new OperationJournal(b,strongSecret);
  coordinatorA=new CrossRelayCoordinator(hubA,a,journalA,strongSecret);
  coordinatorB=new CrossRelayCoordinator(hubB,b,journalB,strongSecret);
  coordinatorA.start();coordinatorB.start();
  await until(async()=>!!(await a.getPresence('durable-test-device')));
  const id=randomUUID(),args={operationId:id,command:'fixture-no-shell'};
  const original=await invokeTool(hubA,a,context,'run_command',args,{journal:journalA,crossRelay:coordinatorA});
  assert.equal(original.ok,true,JSON.stringify(original));
  assert.notEqual(original.result.isError,true); // no error and no local test-side shell execution
  assert.equal(hubA.calls,0);
  assert.equal(hubB.calls,1);
  assert.equal((await b.getOperation(id)).state,'settled');
  assert.equal((await journalB.recovery(context,{operationId:id})).found,true);
  await coordinatorB.stop();hubB.online=false;
  const repeat=await invokeTool(hubA,a,context,'run_command',args,{journal:journalA,crossRelay:coordinatorA});
  assert.equal(repeat.ok,true);
  assert.equal(repeat.result._meta.recoveredFromRelay,true);
  assert.equal(hubB.calls,1,'no duplicate mutation after lease release');

  const budgetA=new MongoResultBudget(a.db),budgetB=new MongoResultBudget(b.db);
  const reservations=await Promise.all(Array.from({length:12},(_,i)=>
   (i%2?budgetA:budgetB).reserve(10*1024*1024)));
  const admitted=reservations.filter(Boolean).length;
  assert.ok(admitted>=5&&admitted<=6,'atomic cross-instance global budget');
  await Promise.all(reservations.map((ok,i)=>ok?(i%2?budgetA:budgetB).finish(10*1024*1024,false):undefined));
  const quota=await budgetA.status();
  assert.ok(quota.usedBytes<=64*1024*1024);
  assert.equal(quota.pendingReservations,0);
 }finally{
  await coordinatorA?.stop().catch(()=>{});
  await coordinatorB?.stop().catch(()=>{});
  await a?.close().catch(()=>{});
  await b?.close().catch(()=>{});
  // Cleanup is restricted to this test's generated DB, never the URI's DB.
  if(uri&&/^brc_recovery_it_[a-f0-9]{12}$/.test(dbName)){
   const client=new MongoClient(uri,{serverSelectionTimeoutMS:6000});
   try{await client.connect();await client.db(dbName).dropDatabase();}
   finally{await client.close().catch(()=>{});}
  }
 }
});
