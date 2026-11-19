import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {SqliteStore} from '../dist/store/sqlite.js';
import {OperationJournal} from '../dist/mcp/operation-journal.js';
import {CrossRelayCoordinator} from '../dist/mcp/cross-relay.js';
import {invokeTool,listUserDevices} from '../dist/mcp/invoke.js';

const SECRET='cross-relay-coordination-test-stable-key-123456789012345';
async function until(f,ms=6000){
 const start=Date.now();
 while(Date.now()-start<ms){if(await f())return;await new Promise(r=>setTimeout(r,30));}
 throw new Error('cross-relay fixture timed out');
}
class SharedStore {
 constructor(){
  this.sql=new SqliteStore(':memory:');
  const user=this.sql.upsertUser('admin','pw');this.owner=user.id;
  this.sql.issueDeviceToken('dev1',this.owner,'Shared PC','win32');
  this.presence=new Map();this.routes=new Map();this.lastCipher=null;
 }
 claimOperation(row){return this.sql.claimOperation(row);}
 getOperation(id){return this.sql.getOperation(id);}
 settleOperation(id,update){return this.sql.settleOperation(id,update);}
 recentOperations(user,client,limit){return this.sql.recentOperations(user,client,limit);}
 getDevice(id){return this.sql.getDevice(id);}
 listDevices(user){return this.sql.listDevices(user);}
 audit(){return;}
 touchDevice(){return;}
 async acquirePresence(user,id,instance,lease){
  this.presence.set(id,{device_id:id,user_id:user,instance_id:instance,lease_id:lease,expires_at:Date.now()+20000});
  for(const [key,row] of this.routes)
   if(row.device_id===id&&row.route_state==='queued')row.route_target_instance=instance;
 }
 async renewPresence(id,instance,lease){
  const p=this.presence.get(id);
  if(!p||p.instance_id!==instance||p.lease_id!==lease)return false;
  p.expires_at=Date.now()+20000;return true;
 }
 async releasePresence(id,instance,lease){
  const p=this.presence.get(id);if(p?.instance_id===instance&&p.lease_id===lease)this.presence.delete(id);
 }
 async presenceForUser(user){return [...this.presence.values()].filter(p=>p.user_id===user&&p.expires_at>Date.now());}
 async getPresence(id){const p=this.presence.get(id);return p&&p.expires_at>Date.now()?p:undefined;}
 async enqueueRouted(id,owner,deviceId,instance,ciphertext){
  if(this.routes.has(id)||!this.getOperation(id))return false;
  this.lastCipher=ciphertext;
  this.routes.set(id,{id,user_id:owner,device_id:deviceId,route_state:'queued',
   route_target_instance:instance,route_ciphertext:ciphertext});return true;
 }
 async claimRouted(instance,ids){
  for(const route of this.routes.values()){
   if(route.route_state==='queued'&&route.route_target_instance===instance&&ids.includes(route.device_id)){
    route.route_state='running';route.route_instance=instance;route.route_started_at=Date.now();
    return {...this.sql.getOperation(route.id),...route};
   }
  }
 }
 async clearRoutedPayload(id){const r=this.routes.get(id);if(r)delete r.route_ciphertext;}
 async markStaleRouted(){return 0;}
 close(){this.sql.close();}
}
class FakeHub {
 constructor(instanceId,owner,connected=false){
  this.instanceId=instanceId;this.owner=owner;this.connected=connected;
  this.calls=0;this.acks=[];this.disconnected=0;this.onHello=null;
  this.device={ownerId:owner,info:{deviceId:'dev1',name:'Shared PC'},tools:[{name:'run_command'}]};
 }
 list(user){return this.connected&&(!user||user===this.owner)?[{deviceId:'dev1',name:'Shared PC'}]:[];}
 get(id){return this.connected&&id==='dev1'?this.device:undefined;}
 resolveDefault(user){return this.connected&&user===this.owner?'dev1':null;}
 async call(id,tool,args,opts){
  assert.equal(id,'dev1');assert.equal(tool,'run_command');
  assert.equal(opts.durable,true);
  assert.match(opts.callId,/^[0-9a-f-]{36}$/i);
  this.calls++;return {content:[{type:'text',text:'EXECUTED_ON_'+this.instanceId}]};
 }
 acknowledgeResult(id,operationId,saved){this.acks.push({id,operationId,saved});return true;}
 disconnectDevice(){this.connected=false;this.disconnected++;}
}
test('Mongo-style shared queue routes encrypted request to the correct relay and reuses durable result after device offline',
 {timeout:12000},async()=>{
 const store=new SharedStore(),owner=store.owner,ctx={userId:owner,clientId:'client1'};
 const hubA=new FakeHub('relay-A',owner,false),hubB=new FakeHub('relay-B',owner,true);
 const ja=new OperationJournal(store,SECRET),jb=new OperationJournal(store,SECRET);
 const a=new CrossRelayCoordinator(hubA,store,ja,SECRET);
 const b=new CrossRelayCoordinator(hubB,store,jb,SECRET);
 a.start();b.start();
 try{
  await until(async()=>!!(await store.getPresence('dev1')));
  assert.equal((await listUserDevices(hubA,store,owner,a))[0].online,true);
  const id=randomUUID(),secret='EXTREMELY_SENSITIVE_COMMAND_ARGUMENT_NOT_PLAINTEXT';
  const outcome=await invokeTool(hubA,store,ctx,'run_command',{operationId:id,command:secret},
   {journal:ja,crossRelay:a});
  assert.equal(outcome.ok,true,JSON.stringify(outcome));
  assert.notEqual(outcome.result.isError,true,JSON.stringify(outcome.result));
  assert.match(outcome.result.content[0].text,/relay-B/);
  assert.equal(hubA.calls,0);
  assert.equal(hubB.calls,1);
  assert.ok(store.lastCipher.startsWith('v1.'));
  assert.ok(!store.lastCipher.includes(secret));
  assert.equal((await store.getOperation(id)).state,'settled');
  await b.stop();hubB.connected=false;
  const duplicate=await invokeTool(hubA,store,ctx,'run_command',{operationId:id,command:secret},
   {journal:ja,crossRelay:a});
  assert.equal(duplicate.ok,true);
  assert.equal(duplicate.result._meta.recoveredFromRelay,true);
  assert.equal(hubB.calls,1);
  const changed=await invokeTool(hubA,store,ctx,'run_command',{operationId:id,command:'different'},
   {journal:ja,crossRelay:a});
  assert.equal(changed.ok,false);
  assert.equal(changed.status,409);
 }finally{await a.stop();await b.stop();store.close();}
});
test('queued work retargets safely after lease takeover; former relay cannot execute it', {timeout:12000},async()=>{
 const store=new SharedStore(),owner=store.owner,ctx={userId:owner,clientId:'client1'};
 const hubA=new FakeHub('relay-A',owner),hubB=new FakeHub('relay-B',owner),hubC=new FakeHub('relay-C',owner,true);
 const ja=new OperationJournal(store,SECRET),jc=new OperationJournal(store,SECRET);
 const a=new CrossRelayCoordinator(hubA,store,ja,SECRET);
 const c=new CrossRelayCoordinator(hubC,store,jc,SECRET);
 try{
  // Offline relay B owned the socket, but had not claimed the queued request.
  await store.acquirePresence(owner,'dev1','relay-B','old-lease');
  const id=randomUUID();
  const claimed=await ja.claim({...ctx,tool:'run_command',deviceId:'dev1',args:{command:'safe'}},id);
  await a.enqueue(claimed.row,{command:'safe'});
  assert.equal(store.routes.get(id).route_target_instance,'relay-B');
  c.start();
  await until(()=>store.routes.get(id).route_target_instance==='relay-C');
  await until(async()=>(await store.getOperation(id)).state==='settled');
  assert.equal(hubB.calls,0);
  assert.equal(hubC.calls,1);
  assert.equal(await c.ownsLocal(owner,'dev1'),true);
 }finally{await a.stop();await c.stop();store.close();}
});

test('fenced Mongo presence blocks stale relay after another instance acquires device', {timeout:12000},async()=>{
 const store=new SharedStore(),owner=store.owner;
 const hubB=new FakeHub('relay-B',owner,true);
 const b=new CrossRelayCoordinator(hubB,store,new OperationJournal(store,SECRET),SECRET);
 b.start();
 try{
  await until(async()=>!!(await store.getPresence('dev1')));
  assert.equal(await b.ownsLocal(owner,'dev1'),true);
  await store.acquirePresence(owner,'dev1','relay-C','new-lease');
  assert.equal(await b.ownsLocal(owner,'dev1'),false);
  await until(()=>hubB.disconnected===1,9500);
  assert.equal((await store.getPresence('dev1')).instance_id,'relay-C');
 }finally{
  await b.stop();
  assert.equal((await store.getPresence('dev1')).instance_id,'relay-C',
   'losing instance must not remove the winning lease');
  store.close();
 }
});

test('idle cross-relay queue uses adaptive polling and wakes immediately for a newly connected agent',async()=>{
 const store=new SharedStore(),owner=store.owner,hub=new FakeHub('adaptive-relay',owner,true);
 const journal=new OperationJournal(store,SECRET);
 const coordinator=new CrossRelayCoordinator(hub,store,journal,SECRET);
 // Exercise the real tick scheduler without depending on wall-clock timing.
 coordinator.leases.set('dev1',{userId:owner,leaseId:'local-test'});
 assert.equal(coordinator.nextPollDelay(),400);
 for(let n=0;n<11;n++)await coordinator.tick();
 assert.equal(coordinator.status().queuePollQueries,11);
 assert.equal(coordinator.status().emptyQueuePolls,11);
 assert.equal(coordinator.nextPollDelay(),2500);
 coordinator.wakePoll();
 assert.equal(coordinator.nextPollDelay(),400);
 await coordinator.stop();
});
