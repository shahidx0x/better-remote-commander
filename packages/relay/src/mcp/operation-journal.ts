/**
 * Durable, owner-scoped relay operation journal.
 *
 * A claim is written BEFORE forwarding a call to an agent. Duplicate operation
 * IDs can return retained results but never dispatch again. A crash after a
 * claim is deliberately UNCERTAIN, not a command replay.
 *
 * Stored payloads are optional AES-256-GCM ciphertext with authenticated scope.
 * No raw arguments, bearer tokens, commands, file paths or results enter logs
 * or unencrypted database columns.
 */
import {createHash,randomBytes,randomUUID,createCipheriv,createDecipheriv,hkdfSync} from 'node:crypto';
import type {ToolResult} from 'brc-shared';
import type {RelayStore} from '../store/types.js';
import {OPERATION_TTL_MS,MAX_OPERATION_RESULT_BYTES,type OperationRow,type OperationUpdate} from '../store/operation-record.js';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RECOVERY_PAGE_MAX=16*1024;
const digest=(text:string)=>createHash('sha256').update(text).digest('hex');

export class RecoveryError extends Error {
 constructor(public readonly code:string,message:string){super(message);}
}

/** Sort object keys recursively without touching array order. Never saves arguments. */
function canonical(input:unknown):unknown {
 if(Array.isArray(input))return input.map(canonical);
 if(input&&typeof input==='object'){
  const out:Record<string,unknown>=Object.create(null);
  for(const key of Object.keys(input as Record<string,unknown>).sort())
   out[key]=canonical((input as Record<string,unknown>)[key]);
  return out;
 }
 return input;
}
export const argumentsDigest=(tool:string,args:Record<string,unknown>)=>
 digest(JSON.stringify([tool,canonical(args)]));

export function parseOperationId(id:unknown):string {
 if(typeof id!=='string'||!UUID.test(id))throw new RecoveryError('INVALID_OPERATION_ID','operationId must be an existing UUID.');
 return id.toLowerCase();
}
const scoped=(row:OperationRow,ctx:{userId:string;clientId:string})=>
 row.user_id===ctx.userId&&row.client_id===ctx.clientId;
const safeRow=(row:OperationRow)=>({
 timeline:[
  {phase:'claimed',at:row.created_at},
  ...(typeof row.route_started_at==='number'?[{phase:'remote_dispatch_started',at:row.route_started_at}]:[]),
  ...(row.state!=='claimed'?[{phase:row.state==='settled'?'result_settled':'outcome_uncertain',at:row.updated_at}]:[])
 ],
 hostDeliveryConfirmed:false,
 operationId:row.id,tool:row.tool,deviceId:row.device_id,
 state:row.state,startedAt:row.created_at,updatedAt:row.updated_at,
 expiresAt:row.expires_at,resultBytes:row.result_bytes,
 resultSha256:row.result_sha256,resultAvailable:!!row.encrypted_result,
 isError:row.result_is_error===null?null:row.result_is_error===1,
 errorCode:row.error_code,automaticReplay:false
});
const safeCode=(raw:unknown)=>typeof raw==='string'&&/^[A-Z0-9_]{1,64}$/.test(raw)?raw:'OUTCOME_UNCERTAIN';
type Context={userId:string;clientId:string};
type DispatchInfo=Context&{deviceId:string;tool:string;args:Record<string,unknown>};

export class OperationJournal {
 readonly payloadsEnabled:boolean;
 private readonly key:Buffer|null;
 constructor(private readonly store:RelayStore,stableSecret:string){
  // Reuse the already-configured stable session secret. Never generate an
  // ephemeral key that makes stored results unreadable after redeployment.
  const secret=process.env.BRC_RECOVERY_ENCRYPTION_KEY??stableSecret;
  this.payloadsEnabled=process.env.BRC_DURABLE_RESULT_PAYLOADS!=='0'&&secret.length>=32;
  this.key=this.payloadsEnabled?Buffer.from(hkdfSync('sha256',
   Buffer.from(secret,'utf8'),Buffer.from('brc-relay-result-store-v1'),
   Buffer.from('aes-256-gcm:owner-bound-operation-results'),32)):null;
 }
 status(){
  return {enabled:true,claimsBeforeDispatch:true,automaticReplay:false,
   ttlDays:7,maxResultBytes:MAX_OPERATION_RESULT_BYTES,
   encryptedPayloads:this.payloadsEnabled,
   encryption:'AES-256-GCM with authenticated operation ownership',
   note:this.payloadsEnabled?'Encrypted results persist until expiry or quota eviction; no result delivery to the ChatGPT UI is presumed.':
    'A stable secret at least 32 characters long is required (BRC_SESSION_SECRET or BRC_RECOVERY_ENCRYPTION_KEY) for encrypted payload retention; metadata-only recovery remains active.'};
 }
 newId(){return randomUUID();}
 async claim(info:DispatchInfo,requestedId?:unknown):Promise<{id:string;claimed:boolean;row:OperationRow}>{
  const id=requestedId===undefined?this.newId():parseOperationId(requestedId);
  const now=Date.now();
  const proposed:OperationRow={
   id,user_id:info.userId,client_id:info.clientId,device_id:info.deviceId,
   tool:info.tool,args_hash:argumentsDigest(info.tool,info.args),state:'claimed',
   created_at:now,updated_at:now,expires_at:now+OPERATION_TTL_MS,
   encrypted_result:null,result_bytes:0,result_sha256:null,result_is_error:null,error_code:null
  };
  let claimed:boolean;
  try{claimed=await this.store.claimOperation(proposed);}
  catch(error){
   if((error as Error).message==='RECOVERY_CAPACITY')
    throw new RecoveryError('RECOVERY_CAPACITY','Durable operation capacity reached. No command was dispatched.');
   throw new RecoveryError('RECOVERY_STORAGE_UNAVAILABLE','Durable claim could not be saved; no command was dispatched.');
  }
  if(claimed)return {id,claimed:true,row:proposed};
  const row=await Promise.resolve(this.store.getOperation(id)).catch(()=>undefined);
  // Do not expose the existence of another account/client's ID.
  if(!row||!scoped(row,info))throw new RecoveryError('OPERATION_ID_CONFLICT','operationId is not available for this client.');
  if(row.device_id!==info.deviceId||row.tool!==info.tool||row.args_hash!==proposed.args_hash)
   throw new RecoveryError('OPERATION_ID_CONFLICT','operationId was already used with different arguments or device.');
  return {id,claimed:false,row};
 }
 private aad(row:OperationRow){return Buffer.from([row.id,row.user_id,row.client_id,row.device_id].join('\0'),'utf8');}
 private encrypt(row:OperationRow,plaintext:Buffer):string|null{
  if(!this.key)return null;
  const iv=randomBytes(12);
  const cipher=createCipheriv('aes-256-gcm',this.key,iv);
  cipher.setAAD(this.aad(row));
  const body=Buffer.concat([cipher.update(plaintext),cipher.final()]);
  return ['v1',iv.toString('base64url'),cipher.getAuthTag().toString('base64url'),body.toString('base64url')].join('.');
 }
 private decrypt(row:OperationRow):Buffer|null{
  if(!this.key||!row.encrypted_result)return null;
  const bits=row.encrypted_result.split('.');
  if(bits.length!==4||bits[0]!=='v1')return null;
  try{
   const iv=Buffer.from(bits[1],'base64url'),tag=Buffer.from(bits[2],'base64url');
   if(iv.length!==12||tag.length!==16)return null;
   const decipher=createDecipheriv('aes-256-gcm',this.key,iv);
   decipher.setAAD(this.aad(row));decipher.setAuthTag(tag);
   const data=Buffer.concat([decipher.update(Buffer.from(bits[3],'base64url')),decipher.final()]);
   return data.length===row.result_bytes&&digest(data.toString('utf8'))===row.result_sha256?data:null;
  }catch{return null;}
 }
 async settle(row:OperationRow,result:ToolResult):Promise<{durable:boolean;resultStored:boolean}>{
  const json=JSON.stringify(result);
  const bytes=Buffer.from(json,'utf8');
  const error=(result.structuredContent?.error as {code?:unknown}|undefined)?.code;
  const encrypted=bytes.length<=MAX_OPERATION_RESULT_BYTES?this.encrypt(row,bytes):null;
  const update:OperationUpdate={
   state:'settled',updated_at:Date.now(),encrypted_result:encrypted,
   result_bytes:bytes.length,result_sha256:digest(json),
   result_is_error:result.isError?1:0,error_code:result.isError?safeCode(error):null
  };
  try{
   await this.store.settleOperation(row.id,update);
   const recorded=await this.store.getOperation(row.id);
   return {durable:recorded?.state==='settled',resultStored:!!recorded?.encrypted_result};
  }catch{return {durable:false,resultStored:false};}
 }
 async uncertain(row:OperationRow,cause:unknown):Promise<boolean>{
  const code=safeCode(cause);
  try{
   await this.store.settleOperation(row.id,{state:'uncertain',updated_at:Date.now(),
    encrypted_result:null,result_bytes:0,result_sha256:null,result_is_error:1,error_code:code});
   return true;
  }catch{return false;}
 }
 async get(ctx:Context,id:string):Promise<OperationRow|undefined>{
  const row=await this.store.getOperation(parseOperationId(id));
  return row&&scoped(row,ctx)?row:undefined;
 }
 async recoveredResult(row:OperationRow):Promise<ToolResult|null>{
  const plaintext=this.decrypt(row);
  if(!plaintext)return null;
  try{
   const result:unknown=JSON.parse(plaintext.toString('utf8'));
   return result&&typeof result==='object'&&Array.isArray((result as ToolResult).content)?result as ToolResult:null;
  }catch{return null;}
 }
 async recovery(ctx:Context,raw:Record<string,unknown>):Promise<Record<string,unknown>>{
  const id=raw.operationId;
  if(id===undefined){
   const limit=raw.limit===undefined?10:raw.limit;
   if(!Number.isInteger(limit)||(limit as number)<1||(limit as number)>20)
    throw new RecoveryError('INVALID_ARGUMENT','limit must be between 1 and 20.');
   const rows=await this.store.recentOperations(ctx.userId,ctx.clientId,limit as number);
   return {operations:rows.map(safeRow),retentionDays:7,automaticReplay:false,
    note:'Only operations belonging to this authorized MCP client are listed. Unknown or missing receipts do not prove non-execution.'};
  }
  const row=await this.get(ctx,parseOperationId(id));
  if(!row)return {found:false,operationId:id,automaticReplay:false,
   guidance:'Not found, expired or not owned by this MCP client. Do not assume a mutation did not execute.'};
  const response:Record<string,unknown>={found:true,...safeRow(row)};
  if(raw.includeResult===false)return response;
  const data=this.decrypt(row);
  if(!data){
   return {...response,resultText:null,guidance:row.state==='claimed'?
    'The relay saved the claim before dispatch, but no result was durably settled. Outcome unknown; inspect agent_status.lookupCallId and project state. Never automatically rerun.':
    'Full result is unavailable (disabled, oversized, expired, evicted, encrypted with a different key or storage fault). Inspect the job/project state before repeating work.'};
  }
  const offset=raw.offset===undefined?0:raw.offset;
  const limit=raw.limit===undefined?8192:raw.limit;
  if(!Number.isSafeInteger(offset)||(offset as number)<0||(offset as number)>data.length||
   !Number.isSafeInteger(limit)||(limit as number)<1||(limit as number)>RECOVERY_PAGE_MAX)
   throw new RecoveryError('INVALID_ARGUMENT','Result offset and limit must be valid byte ranges (limit up to 16384).');
  // Avoid splitting UTF-8 code points across pages.
  let start=offset as number,end=Math.min(data.length,start+(limit as number));
  while(start<data.length&&(data[start]&0xc0)===0x80)start++;
  while(end>start&&end<data.length&&(data[end]&0xc0)===0x80)end--;
  const text=data.subarray(start,end).toString('utf8');
  return {...response,resultText:text,byteOffset:start,nextByteOffset:end,
   hasMore:end<data.length,totalBytes:data.length,
   ...(end<data.length?{next:{tool:'recover_operation',args:{operationId:row.id,offset:end,limit}}}:{})};
 }
}
