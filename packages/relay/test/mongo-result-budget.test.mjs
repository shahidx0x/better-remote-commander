import {test} from 'node:test';
import assert from 'node:assert/strict';
import {MongoResultBudget} from '../dist/store/mongo-result-budget.js';
import {MongoStore} from '../dist/store/mongo.js';

const LIMIT=64*1024*1024;
class FakeQuota {
 row=null;
 findOne(q){
  return this.row?{...this.row}:null;
 }
 updateOne(q,change,{upsert=false}={}){
  if(!this.row){
   if(!upsert)return {matchedCount:0,modifiedCount:0};
   this.row={_id:'global',...change.$setOnInsert};
   return {matchedCount:1,modifiedCount:1};
  }
  if(q.version!==undefined&&this.row.version!==q.version)return {matchedCount:0,modifiedCount:0};
  if(q.pending!==undefined&&this.row.pending!==q.pending)return {matchedCount:0,modifiedCount:0};
  if(q.used_bytes?.$lte!==undefined&&this.row.used_bytes>q.used_bytes.$lte)return {matchedCount:0,modifiedCount:0};
  for(const [k,v] of Object.entries(change.$inc??{}))this.row[k]+=v;
  for(const [k,v] of Object.entries(change.$set??{}))this.row[k]=v;
  return {matchedCount:1,modifiedCount:1};
 }
 findOneAndUpdate(q,change){
  const res=this.updateOne(q,change);
  return res.matchedCount?{...this.row}:null;
 }
}
class FakeOps {
 constructor(){this.rows=new Map();this.aggregateReads=0;this.throwOnUpdate=false;}
 findOne({ _id }){const r=this.rows.get(_id);return r?{...r}:null;}
 aggregate(){this.aggregateReads++;return {toArray:async()=>[{
  total:[...this.rows.values()].reduce((s,r)=>s+(typeof r.encrypted_result==='string'?Buffer.byteLength(r.encrypted_result):0),0)
 }]};}
 updateOne(q,change){
  if(this.throwOnUpdate)throw Error('SIMULATED_AMBIGUOUS_MONGO_WRITE');
  const row=this.rows.get(q._id);
  if(!row)return {matchedCount:0,modifiedCount:0};
  const match=row.state!=='settled'||(change.$set.encrypted_result&&row.encrypted_result===null&&row.result_sha256===change.$set.result_sha256);
  if(!match)return {matchedCount:0,modifiedCount:0};
  Object.assign(row,change.$set);
  return {matchedCount:1,modifiedCount:1};
 }
}
function fixtures(){
 const quota=new FakeQuota(),ops=new FakeOps();
 const db={collection:name=>name==='durable_result_quota'?quota:ops};
 const budget=new MongoResultBudget(db);
 const store=Object.create(MongoStore.prototype);
 store.db=db;store.resultBudget=budget;
 return {quota,ops,budget,store};
}
const record=(id='op-1')=>({
 _id:id,id,user_id:'user',client_id:'client',device_id:'device',tool:'run_command',
 args_hash:'digest',state:'claimed',created_at:Date.now(),updated_at:Date.now(),
 expires_at:Date.now()+86400000,encrypted_result:null,result_bytes:0,result_sha256:null,
 result_is_error:null,error_code:null
});
const update=(payload,digest='same-digest')=>({
 state:'settled',updated_at:Date.now(),encrypted_result:payload,
 result_bytes:payload.length,result_sha256:digest,result_is_error:0,error_code:null
});

test('atomic Mongo result reservations never oversubscribe the 64MiB budget',async()=>{
 const f=fixtures();await f.budget.initialize();
 const outcomes=await Promise.all(Array.from({length:10},()=>f.budget.reserve(10*1024*1024)));
 assert.equal(outcomes.filter(Boolean).length,6);
 assert.equal((await f.budget.status()).usedBytes,60*1024*1024);
 assert.equal((await f.budget.status()).pendingReservations,6);
 await Promise.all(Array.from({length:6},()=>f.budget.finish(10*1024*1024,true)));
 assert.equal((await f.budget.status()).pendingReservations,0);
 assert.ok((await f.budget.status()).usedBytes<=LIMIT);
 assert.equal(f.ops.aggregateReads,1,'full scan only at first initialization');
});
test('routine Mongo result writes use constant-time quota updates; duplicate settlement never consumes more',async()=>{
 const f=fixtures();await f.budget.initialize();
 f.ops.rows.set('op-1',record());
 await f.store.settleOperation('op-1',update('ciphertext-example'));
 assert.equal(f.ops.rows.get('op-1').encrypted_result,'ciphertext-example');
 const bytes=(await f.budget.status()).usedBytes;
 await f.store.settleOperation('op-1',update('another-ciphertext'));
 assert.equal(f.ops.rows.get('op-1').encrypted_result,'ciphertext-example');
 assert.equal((await f.budget.status()).usedBytes,bytes);
 assert.equal((await f.budget.status()).pendingReservations,0);
 assert.equal(f.ops.aggregateReads,1,'global aggregate must never execute on settlement hot path');
});
test('quota full settles metadata without retaining large payload and never exceeds cap',async()=>{
 const f=fixtures();await f.budget.initialize();
 assert.equal(await f.budget.reserve(LIMIT),true);
 await f.budget.finish(LIMIT,true);
 f.ops.rows.set('op-2',record('op-2'));
 await f.store.settleOperation('op-2',update('private-output'));
 assert.equal(f.ops.rows.get('op-2').state,'settled');
 assert.equal(f.ops.rows.get('op-2').encrypted_result,null);
 assert.equal((await f.budget.status()).usedBytes,LIMIT);
});
test('ambiguous DB writes retain conservative reservation; recovery reconciliation refuses active or uncertain writers',async()=>{
 const f=fixtures();await f.budget.initialize();
 f.ops.rows.set('op-3',record('op-3'));
 f.ops.throwOnUpdate=true;
 await assert.rejects(f.store.settleOperation('op-3',update('encrypted')),/SIMULATED_AMBIGUOUS/);
 assert.equal((await f.budget.status()).usedBytes,9);
 assert.equal((await f.budget.status()).pendingReservations,1);
 assert.equal(await f.budget.reconcile(Date.now()+3600000,true),false);
 assert.equal(f.ops.aggregateReads,1);
});
test('maintenance quota reconciliation uses a revision compare-and-swap and accounts for expired results',async()=>{
 const f=fixtures();await f.budget.initialize();
 f.ops.rows.set('op-4',{...record('op-4'),encrypted_result:'123456789'});
 assert.equal(await f.budget.reconcile(Date.now()+3600000,true),true);
 assert.equal((await f.budget.status()).usedBytes,9);
 assert.equal(f.ops.aggregateReads,2,'periodic full scan happens only outside the settlement hot path');
});
