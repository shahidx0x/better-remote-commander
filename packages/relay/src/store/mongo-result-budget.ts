/** Atomic cross-replica quota for encrypted recovery results.
 *
 * Normal settlements reserve in one constant-time MongoDB document; expensive
 * byte reconciliation is exclusively a maintenance task, never the hot path.
 *
 * An ambiguous write can conservatively retain quota until maintenance, rather
 * than silently undercount and violate the 64 MiB ceiling.
 */
import type {Db,Document} from 'mongodb';
import {MAX_OPERATION_STORED_BYTES} from './operation-record.js';

const ID='global';
const RECONCILE_INTERVAL_MS=30*60_000;
type QuotaDoc=Document&{_id:string;used_bytes:number;pending:number;version:number;reconciled_at:number;last_reserved_at?:number};

export class MongoResultBudget {
 constructor(private readonly db:Db){}
 private col(){return this.db.collection<QuotaDoc>('durable_result_quota');}
 private async actualUsage():Promise<number>{
  const sums=await this.db.collection('durable_operations').aggregate<{total:number}>([
   {$match:{encrypted_result:{$type:'string'},expires_at:{$gt:Date.now()}}},
   {$group:{_id:null,total:{$sum:{$strLenBytes:'$encrypted_result'}}}}
  ]).toArray();
  return Math.max(0,sums[0]?.total??0);
 }
 async initialize():Promise<void>{
  if(await this.col().findOne({_id:ID}))return;
  const total=await this.actualUsage();
  try{
   await this.col().updateOne({_id:ID},{$setOnInsert:{
    used_bytes:total,pending:0,version:0,reconciled_at:Date.now(),last_reserved_at:0
   }},{upsert:true,writeConcern:{j:true}});
  }catch(error){
   // Two relay replicas may initialize the same counter simultaneously.
   // The winner's durable counter is authoritative; no boot failure is needed.
   if((error as {code?:unknown})?.code!==11000||!(await this.col().findOne({_id:ID})))
    throw error;
  }
 }
 /** Reserve BEFORE writing the result; an atomic filter prevents overbooking. */
 async reserve(bytes:number):Promise<boolean>{
  if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>MAX_OPERATION_STORED_BYTES)return false;
  const row=await this.col().findOneAndUpdate(
   {_id:ID,used_bytes:{$lte:MAX_OPERATION_STORED_BYTES-bytes}},
   {$inc:{used_bytes:bytes,pending:1,version:1},$set:{last_reserved_at:Date.now()}},
   {returnDocument:'after',writeConcern:{j:true}});
  return !!row;
 }
 /** Settle a known reservation after a confirmed row write or no-op. */
 async finish(bytes:number,stored:boolean):Promise<void>{
  await this.col().updateOne({_id:ID},{$inc:{
   used_bytes:stored?0:-bytes,pending:-1,version:1
  }},{writeConcern:{j:true}});
 }
 /** Safe compare-and-swap, only when no writes are reserved or in flight. */
 async reconcile(now=Date.now(),force=false):Promise<boolean>{
  const snap=await this.col().findOne({_id:ID});
  if(!snap||snap.pending!==0||(!force&&now-snap.reconciled_at<RECONCILE_INTERVAL_MS))return false;
  const total=await this.actualUsage();
  const update=await this.col().updateOne(
   {_id:ID,pending:0,version:snap.version},
   {$set:{used_bytes:total,reconciled_at:now},$inc:{version:1}},
   {writeConcern:{j:true}});
  return update.modifiedCount===1;
 }
 async status():Promise<{usedBytes:number;capBytes:number;pendingReservations:number;reconciledAt:number;lastReservationAt:number}>{
  const row=await this.col().findOne({_id:ID});
  return {usedBytes:Math.max(0,Number(row?.used_bytes??0)),
   capBytes:MAX_OPERATION_STORED_BYTES,
   pendingReservations:Math.max(0,Number(row?.pending??0)),
   reconciledAt:Number(row?.reconciled_at??0),lastReservationAt:Number(row?.last_reserved_at??0)};
 }
}
