/**
 * MongoDB-only cross-replica device routing.
 * No plaintext tool arguments in Mongo, no automatic re-execution of jobs,
 * no new publicly exposed port or credential. Supports shared OAuth identities.
 */
import {randomUUID,randomBytes,createCipheriv,createDecipheriv,hkdfSync} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import type {ToolResult} from 'brc-shared';
import type {DeviceHub} from '../device-hub.js';
import type {MongoStore} from '../store/mongo.js';
import type {DevicePresence,RoutedOperation} from '../store/cross-relay-types.js';
import type {OperationRow} from '../store/operation-record.js';
import type {OperationJournal} from './operation-journal.js';

const MAX_ARGS=1024*1024;
const MAX_ENCRYPTED=1450*1024;
const PRESENCE_REFRESH_MS=5000;
const ROW_POLL_MS=400;
const MAX_CONCURRENT=2;
type Lease={userId:string;leaseId:string};
export type RemoteDevice={deviceId:string;deviceName:string;instanceId:string};

export class CrossRelayCoordinator {
 readonly enabled:boolean;
 readonly instanceId:string;
 private readonly key:Buffer|null;
 private readonly leases=new Map<string,Lease>();
 private readonly acquisitions=new Map<string,Promise<void>>();
 private poller?:NodeJS.Timeout;private renewal?:NodeJS.Timeout;private sweeper?:NodeJS.Timeout;
 private stopped=false;private ticking=false;private refreshing=false;
 private workers=0;
 private counters={routed:0,executed:0,persisted:0,uncertain:0,errors:0,leaseLost:0};
 constructor(private readonly hub:DeviceHub,private readonly store:MongoStore,
  private readonly journal:OperationJournal,secret:string,
  private readonly log:(level:string,msg:string)=>void=()=>{}){
  const raw=process.env.BRC_RECOVERY_ENCRYPTION_KEY??secret;
  this.enabled=raw.length>=32&&journal.payloadsEnabled;
  this.instanceId=hub.instanceId;
  this.key=this.enabled?Buffer.from(hkdfSync('sha256',Buffer.from(raw),
   Buffer.from('brc-cross-relay-v1'),Buffer.from('encrypted-routing-arguments'),32)):null;
 }
 status(){return {enabled:this.enabled,mode:this.enabled?'mongodb-coordinated':'local-only',
  encryptedRequests:true,automaticReplay:false,staleCallsNeverReexecuted:true,
  maxRemoteArgumentBytes:MAX_ARGS,presenceLeaseSeconds:20,pollIntervalMs:ROW_POLL_MS,
  inFlightWorkers:this.workers,...this.counters};}
 start():void{
  if(!this.enabled||this.poller)return;
  this.stopped=false;
  const previous=this.hub.onHello;
  this.hub.onHello=(info,tools)=>{
   try{previous?.(info,tools);}finally{void this.acquire(info.deviceId);}
  };
  this.poller=setInterval(()=>{void this.tick();},ROW_POLL_MS);this.poller.unref();
  this.renewal=setInterval(()=>{void this.refresh();},PRESENCE_REFRESH_MS);this.renewal.unref();
  this.sweeper=setInterval(()=>{void this.sweep();},60_000);this.sweeper.unref();
  void this.refresh();
 }
 async stop():Promise<void>{
  this.stopped=true;
  clearInterval(this.poller);clearInterval(this.renewal);clearInterval(this.sweeper);
  this.poller=undefined;this.renewal=undefined;this.sweeper=undefined;
  await Promise.all([...this.acquisitions.values()].map(p=>p.catch(()=>{})));
  await Promise.all([...this.leases.entries()].map(([id,lease])=>
   this.store.releasePresence(id,this.instanceId,lease.leaseId).catch(()=>{})));
  this.leases.clear();
 }
 private acquire(id:string):Promise<void>{
  if(this.stopped)return Promise.resolve();
  const prior=this.acquisitions.get(id)??Promise.resolve();
  const next=prior.catch(()=>{}).then(async()=>{
   const dev=this.hub.get(id);
   if(!dev||this.stopped)return;
   const leaseId=randomUUID();
   await this.store.acquirePresence(dev.ownerId,id,this.instanceId,leaseId);
   const current=this.hub.get(id);
   if(current?.ownerId!==dev.ownerId||this.stopped){
    await this.store.releasePresence(id,this.instanceId,leaseId).catch(()=>{});
    return;
   }
   this.leases.set(id,{userId:dev.ownerId,leaseId});
  }).catch(()=>{this.counters.errors++;this.log('warn','Cross-relay presence update failed');});
  this.acquisitions.set(id,next);
  void next.finally(()=>{if(this.acquisitions.get(id)===next)this.acquisitions.delete(id);});
  return next;
 }
 private async refresh():Promise<void>{
  if(this.stopped||this.refreshing)return;
  this.refreshing=true;
  try{
   const online=this.hub.list();
   const known=new Set(online.map(x=>x.deviceId));
   for(const [id,lease] of this.leases){
    if(!known.has(id)){
     this.leases.delete(id);
     await this.store.releasePresence(id,this.instanceId,lease.leaseId).catch(()=>{});
    }
   }
   for(const dev of online){
    const lease=this.leases.get(dev.deviceId);
    if(!lease){await this.acquire(dev.deviceId);continue;}
    const renewed=await this.store.renewPresence(dev.deviceId,this.instanceId,lease.leaseId);
    if(!renewed){
     this.counters.leaseLost++;
     this.leases.delete(dev.deviceId);
     this.hub.disconnectDevice(dev.deviceId,'Device session superseded by another relay instance');
    }
   }
  }catch{this.counters.errors++;this.log('warn','Cross-relay lease renewal failed');}
  finally{this.refreshing=false;}
 }
 async ownsLocal(userId:string,deviceId:string):Promise<boolean>{
  if(!this.enabled)return true;
  // The first local call may arrive before Mongo acknowledges onHello.
  await this.acquisitions.get(deviceId)?.catch(()=>{});
  const lease=this.leases.get(deviceId);
  if(!lease||lease.userId!==userId)return false;
  const current=await this.store.getPresence(deviceId);
  return !!current&&current.user_id===userId&&current.instance_id===this.instanceId&&current.lease_id===lease.leaseId;
 }
 async available(userId:string):Promise<DevicePresence[]>{
  if(!this.enabled)return [];
  return this.store.presenceForUser(userId);
 }
 async resolveDefault(userId:string):Promise<string|null>{
  const pres=await this.available(userId);
  return pres.length===1?pres[0].device_id:null;
 }
 async remoteDevice(userId:string,id:string):Promise<RemoteDevice|null>{
  if(!this.enabled)return null;
  const presence=await this.store.getPresence(id);
  if(!presence||presence.user_id!==userId)return null;
  const saved=await this.store.getDevice(id);
  if(!saved||saved.user_id!==userId||saved.paused)return null;
  return {deviceId:id,deviceName:saved.name,instanceId:presence.instance_id};
 }
 private aad(row:OperationRow):Buffer{
  return Buffer.from([row.id,row.user_id,row.client_id,row.device_id,row.tool].join('\0'),'utf8');
 }
 private encrypt(row:OperationRow,args:Record<string,unknown>):string{
  if(!this.key)throw new Error('CROSS_RELAY_KEY_UNAVAILABLE');
  const bytes=Buffer.from(JSON.stringify(args),'utf8');
  if(bytes.length>MAX_ARGS)throw new Error('REMOTE_ARGS_TOO_LARGE');
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
  cipher.setAAD(this.aad(row));
  const body=Buffer.concat([cipher.update(bytes),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
 }
 private decrypt(row:RoutedOperation):Record<string,unknown>{
  if(!this.key||typeof row.route_ciphertext!=='string'||row.route_ciphertext.length>MAX_ENCRYPTED)
   throw new Error('REMOTE_PAYLOAD_UNAVAILABLE');
  const parts=row.route_ciphertext.split('.');
  if(parts.length!==4||parts[0]!=='v1')throw new Error('REMOTE_PAYLOAD_INVALID');
  const iv=Buffer.from(parts[1],'base64url'),tag=Buffer.from(parts[2],'base64url');
  if(iv.length!==12||tag.length!==16)throw new Error('REMOTE_PAYLOAD_INVALID');
  const decipher=createDecipheriv('aes-256-gcm',this.key,iv);
  decipher.setAAD(this.aad(row));decipher.setAuthTag(tag);
  const plain=Buffer.concat([decipher.update(Buffer.from(parts[3],'base64url')),decipher.final()]);
  if(plain.length>MAX_ARGS)throw new Error('REMOTE_PAYLOAD_TOO_LARGE');
  const args:unknown=JSON.parse(plain.toString('utf8'));
  if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('REMOTE_PAYLOAD_INVALID');
  return args as Record<string,unknown>;
 }
 /** This records encrypted arguments for the CURRENT owner without dispatching twice. */
 async enqueue(row:OperationRow,args:Record<string,unknown>):Promise<void>{
  if(!this.enabled)throw new Error('CROSS_RELAY_UNAVAILABLE');
  const presence=await this.store.getPresence(row.device_id);
  if(!presence||presence.user_id!==row.user_id)throw new Error('REMOTE_DEVICE_OFFLINE');
  const ciphertext=this.encrypt(row,args);
  const saved=await this.store.enqueueRouted(row.id,row.user_id,row.device_id,presence.instance_id,ciphertext);
  if(!saved)throw new Error('REMOTE_QUEUE_CONFLICT');
  this.counters.routed++;
 }
 async wait(ctx:{userId:string;clientId:string},id:string,
  signal?:AbortSignal,timeoutMs=110_000):Promise<ToolResult>{
  const deadline=Date.now()+Math.min(Math.max(500,timeoutMs),110_000);
  while(Date.now()<deadline){
   const row=await this.journal.get(ctx,id);
   if(!row)return this.response(id,'OPERATION_NOT_FOUND',false);
   if(row.state==='settled'){
    const recovered=await this.journal.recoveredResult(row);
    if(recovered)return {...recovered,_meta:{...recovered._meta,operationId:id,
     remoteRelay:true,relayJournalSettled:true,recoverableResult:true}};
    return this.response(id,'RESULT_NOT_RETAINED',false);
   }
   if(row.state==='uncertain')return this.response(id,'REMOTE_OUTCOME_UNCERTAIN',false);
   if(signal?.aborted)return this.response(id,'HOST_DISCONNECTED',true);
   await delay(250);
  }
  return this.response(id,'REMOTE_OPERATION_PENDING',true);
 }
 private response(id:string,code:string,pending:boolean):ToolResult{
  return {isError:true,content:[{type:'text',
   text:code+': Operation '+id+' may already have executed on the remote agent. Use recover_operation. Do not rerun mutations blindly.'}],
   structuredContent:{operationId:id,pending,automaticReplay:false,
    recovery:{tool:'recover_operation',args:{operationId:id}},
    error:{code,retryable:false}}};
 }
 private async tick():Promise<void>{
  if(this.stopped||this.ticking||this.workers>=MAX_CONCURRENT)return;
  this.ticking=true;
  try{
   const online=this.hub.list().map(d=>d.deviceId);
   const eligible=online.filter(id=>this.leases.has(id));
   if(!eligible.length)return;
   const route=await this.store.claimRouted(this.instanceId,eligible);
   if(!route)return;
   this.workers++;
   void this.execute(route).finally(()=>{this.workers--;});
  }catch{this.counters.errors++;}
  finally{this.ticking=false;}
 }
 private async execute(route:RoutedOperation):Promise<void>{
  try{
   const dev=this.hub.get(route.device_id);
   if(!dev||dev.ownerId!==route.user_id||!(await this.ownsLocal(route.user_id,route.device_id)))
    throw new Error('REMOTE_DEVICE_MOVED');
   const stored=await this.store.getDevice(route.device_id);
   if(!stored||stored.paused||stored.user_id!==route.user_id)
    throw new Error('REMOTE_DEVICE_PAUSED');
   const args=this.decrypt(route);
   this.counters.executed++;
   const result=await this.hub.call(route.device_id,route.tool,args,{
    callId:route.id,durable:true,timeoutMs:110_000,client:{name:route.client_id}
   });
   const settled=await this.journal.settle(route,result);
   if(settled.resultStored){this.counters.persisted++;
    this.hub.acknowledgeResult(route.device_id,route.id,true);}
   await this.store.clearRoutedPayload(route.id);
  }catch(err){
   this.counters.uncertain++;
   const code=err instanceof Error&&/^[A-Z_]{4,64}/.test(err.message)?
    err.message.match(/^[A-Z_]{4,64}/)?.[0]??'REMOTE_OUTCOME_UNCERTAIN':'REMOTE_OUTCOME_UNCERTAIN';
   await this.journal.uncertain(route,code).catch(()=>{});
   await this.store.clearRoutedPayload(route.id).catch(()=>{});
  }
 }
 private async sweep():Promise<void>{
  if(this.stopped)return;
  try{this.counters.uncertain+=await this.store.markStaleRouted();}
  catch{this.counters.errors++;}
 }
}
