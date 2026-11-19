/** Tool invocation: ownership, pause checks, durable pre-dispatch receipt and safe replay prevention. */
import type {DeviceHub} from '../device-hub.js';
import type {RelayStore} from '../store/types.js';
import type {ToolResult} from 'brc-shared';
import {OperationJournal,RecoveryError} from './operation-journal.js';

export interface InvokeContext {userId:string;clientId:string}
export type InvokeOutcome =
  | {ok:true;deviceId:string;deviceName:string;result:ToolResult;ms:number}
  | {ok:false;status:number;message:string;operationId?:string};

export async function listUserDevices(hub:DeviceHub,store:RelayStore,userId:string){
 const online=new Set(hub.list(userId).map(d=>d.deviceId));
 return (await store.listDevices(userId)).map(d=>({
  deviceId:d.device_id,name:d.name,platform:d.platform,online:online.has(d.device_id),
  paused:!!d.paused,lastSeen:d.last_seen
 }));
}
export async function connectionStatus(hub:DeviceHub,store:RelayStore,userId:string){
 const devices=await listUserDevices(hub,store,userId);
 const eligible=devices.some(d=>d.online&&!d.paused);
 if(eligible)return {devices,status:'ready' as const};
 if(devices.length)return {
  devices,status:devices.some(d=>d.online)?'paused' as const:'paired_device_offline' as const,
  message:devices.some(d=>d.online)?
   'The paired device is paused by this account. Resume it in BRC Admin.':
   'The devices paired to this OAuth account are offline. Restart brc-agent using the saved device pairing.'
 };
 return {devices,status:'no_devices_for_oauth_account' as const,
  message:'This OAuth account has no paired devices. If your PC appears online on the relay homepage, reconnect OAuth while signed in as the same BRC account that paired that PC. No pairing or OAuth credentials need to be cleared.'};
}

export async function invokeTool(
 hub:DeviceHub,store:RelayStore,ctx:InvokeContext,tool:string,
 rawArgs:Record<string,unknown>|undefined,
 opts:{timeoutMs?:number;signal?:AbortSignal;journal?:OperationJournal;readOnly?:boolean}={}
):Promise<InvokeOutcome>{
 const args={...(rawArgs??{})};
 const requested=typeof args.deviceId==='string'&&args.deviceId?args.deviceId:undefined;
 const requestedOperationId=args.operationId;
 delete args.deviceId;
 delete args.operationId;
 const deviceId=requested??hub.resolveDefault(ctx.userId);
 if(!deviceId){
  const n=hub.list(ctx.userId).length;
  if(n===0){
   const status=await connectionStatus(hub,store,ctx.userId);
   return {ok:false,status:503,message:'No device is online for this OAuth account. '+
    (status.status==='ready'?'Retry list_devices.':status.message)};
  }
  return {ok:false,status:409,message:`${n} devices are online for this account; pass deviceId (see list_devices).`};
 }
 const dev=hub.get(deviceId);
 if(!dev||dev.ownerId!==ctx.userId)return {ok:false,status:404,message:`Device ${deviceId} is not online or not yours.`};
 if((await store.getDevice(deviceId))?.paused)return {ok:false,status:423,message:`Device ${dev.info.name} is paused by its owner.`};
 // Claim only executable tools. Otherwise a malformed request could reserve a
 // durable operation ID without ever reaching the agent.
 if(Array.isArray(dev.tools)&&!dev.tools.some(t=>t.name===tool))
  return {ok:false,status:404,message:`UNKNOWN_TOOL: ${tool} is not registered on the selected device.`};
 const started=Date.now();
 // Existing safe reads can be reissued as fresh reads. Avoid journaling them
 // by default to reduce database writes and metadata quota consumption.
 // A caller-provided operationId explicitly opts that read into recovery.
 const journal=opts.readOnly&&requestedOperationId===undefined?undefined:opts.journal;
 let receipt:Awaited<ReturnType<OperationJournal['claim']>>|undefined;
 if(journal){
  try{
   receipt=await journal.claim({...ctx,deviceId,tool,args},requestedOperationId);
  }catch(error){
   const e=error instanceof RecoveryError?error:
    new RecoveryError('RECOVERY_STORAGE_UNAVAILABLE','Operation receipt could not be verified. No command was dispatched.');
   return {ok:false,status:e.code==='INVALID_OPERATION_ID'?400:e.code==='OPERATION_ID_CONFLICT'?409:503,
    message:e.code+': '+e.message};
  }
  if(!receipt.claimed){
   const prior=receipt.row;
   const recovered=prior.state==='settled'?await journal.recoveredResult(prior):null;
   if(recovered)return {ok:true,deviceId,deviceName:dev.info.name,ms:Date.now()-started,
    result:{...recovered,_meta:{...recovered._meta,operationId:receipt.id,
      recoveredFromRelay:true,reexecuted:false}}};
   return {ok:true,deviceId,deviceName:dev.info.name,ms:Date.now()-started,
    result:{isError:true,content:[{type:'text',text:
      'OPERATION_ALREADY_CLAIMED: Existing operation '+receipt.id+' is '+prior.state+
      '. No command was re-executed. Use recover_operation or agent_status.lookupCallId; inspect actual state before starting new work.'}],
      structuredContent:{operationId:receipt.id,state:prior.state,automaticReplay:false,
       resultAvailable:false,error:{code:'OPERATION_ALREADY_CLAIMED',retryable:false}}}};
  }
 }
 try{
  const result=await hub.call(deviceId,tool,args,{client:{name:ctx.clientId},
   timeoutMs:opts.timeoutMs,signal:opts.signal,
   ...(receipt?{callId:receipt.id}:{})});
  const ms=Date.now()-started;
  const durable=receipt&&journal?
   await journal.settle(receipt.row,result):undefined;
  // This ACK proves relay persistence only, never host/UI delivery.
  if(receipt&&durable?.durable)hub.acknowledgeResult?.(deviceId,receipt.id,true);
  result._meta={...result._meta,auditPersisted:false,activityStorage:'memory-only',
   ...(receipt?{operationId:receipt.id,relayJournalSettled:durable?.durable??false,
    recoverableResult:durable?.resultStored??false}:{})};
  try{
   void store.audit({ts:started,user_id:ctx.userId,device_id:deviceId,
    client:ctx.clientId,tool,args_hash:null,ok:result.isError?0:1,ms,error:null});
   void Promise.resolve().then(()=>store.touchDevice(deviceId)).catch(()=>{});
  }catch{
   result._meta={...result._meta,auditPersisted:false,
    auditWarning:'Live activity update failed; tool result is still valid.'};
  }
  return {ok:true,deviceId,deviceName:dev.info.name,result,ms};
 }catch(err){
  const message=err instanceof Error?err.message:String(err);
  if(receipt&&journal){
   const errorCode=/^[A-Z_]+/.exec(message)?.[0]??'OUTCOME_UNCERTAIN';
   await journal.uncertain(receipt.row,errorCode);
  }
  try{
   await store.audit({ts:started,user_id:ctx.userId,device_id:deviceId,client:ctx.clientId,
    tool,args_hash:null,ok:0,ms:Date.now()-started,
    error:/^[A-Z_]+/.exec(message)?.[0]??'RELAY_ERROR'});
  }catch{}
  const status=message.startsWith('UNKNOWN_TOOL')?404:message.startsWith('CALL_TIMEOUT')?504:
   /^(?:RELAY_BUSY|DEVICE_BUSY|RELAY_BACKPRESSURE)/.test(message)?503:
   message.startsWith('CALL_TOO_LARGE')?413:502;
  return {ok:false,status,
   message:'Relay error: '+message+(receipt?
    '. Operation '+receipt.id+' was recorded as uncertain. Do not automatically retry.':''),
   ...(receipt?{operationId:receipt.id}:{})};
 }
}
