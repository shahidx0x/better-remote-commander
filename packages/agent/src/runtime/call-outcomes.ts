/** Bounded, metadata-only durable record of an actual remote tool call.
 *
 * Only for remotely dispatched, potentially side-effecting tools. Records do
 * not contain call IDs, client IDs, input arguments, paths, commands, outputs,
 * stack traces, credentials or full result payloads.
 *
 * A started record following a crash is UNCERTAIN, not a replay instruction.
 * A settled record proves the local handler returned, NOT that a relay/host
 * received or displayed its response. No auto-retry or exactly-once claims.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {homeDir} from '../transport/pairing.js';
import {enabledByDefault} from './feature-defaults.js';

export type CallOutcome='started'|'returned_success'|'reported_failure'|'pending';
export interface CallOutcomeRecord{
 version:1;idHash:string;tool:string;startedAt:number;settledAt?:number;
 outcome:CallOutcome;durationMs?:number;errorCode?:string;
}
const FILES=128,RETAIN_MS=7*24*60*60_000,FILE_BYTES=1024,MAX_DISK_BYTES=256*1024;
const HASH=/^[0-9a-f]{64}$/;
const VALID_TOOL=/^[a-zA-Z0-9_-]{1,80}$/;
const folder=()=>path.join(homeDir(),'call-outcomes');
const hash=(id:string)=>createHash('sha256').update(id).digest('hex');
const recordPath=(hashed:string)=>{
 if(!HASH.test(hashed))throw new Error('Invalid call-outcome hash');
 return path.join(folder(),hashed+'.json');
};
export const callOutcomesEnabled=()=>enabledByDefault('BRC_CALL_OUTCOME_RECEIPTS');
const isValid=(r:unknown):r is CallOutcomeRecord=>{
 if(!r||typeof r!=='object')return false;
 const a=r as Partial<CallOutcomeRecord>;
 return a.version===1&&typeof a.idHash==='string'&&HASH.test(a.idHash)
  &&typeof a.tool==='string'&&VALID_TOOL.test(a.tool)
  &&typeof a.startedAt==='number'&&Number.isFinite(a.startedAt)&&a.startedAt>0
  &&['started','returned_success','reported_failure','pending'].includes(String(a.outcome))
  &&(a.settledAt===undefined||(Number.isFinite(a.settledAt)&&a.settledAt>=a.startedAt))
  &&(a.durationMs===undefined||(Number.isFinite(a.durationMs)&&a.durationMs>=0&&a.durationMs<=86_400_000))
  &&(a.errorCode===undefined||(typeof a.errorCode==='string'&&/^[A-Z0-9_]{1,64}$/.test(a.errorCode)));
};
let lane:Promise<unknown>=Promise.resolve();
let writes=0,failedWrites=0,prunes=0;
const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{
 const work=lane.catch(()=>{}).then(fn);
 lane=work.then(()=>{},()=>{});
 return work;
};
async function prune():Promise<void>{
 prunes++;
 const dir=folder();
 const names=(await fs.readdir(dir)).filter(n=>HASH.test(n.slice(0,-5))&&n.endsWith('.json'));
 const entries=(await Promise.all(names.map(async name=>{
  try{const stat=await fs.lstat(path.join(dir,name));return stat.isFile()?{name,at:stat.mtimeMs,size:stat.size}:null;}
  catch{return null;}
 }))).filter((e):e is {name:string;at:number;size:number}=>!!e)
  .sort((a,b)=>b.at-a.at);
 let count=0,size=0;
 for(const item of entries){
  count++;size+=item.size;
  if(count>FILES-12||size>MAX_DISK_BYTES||Date.now()-item.at>RETAIN_MS)
   await fs.unlink(path.join(dir,item.name)).catch(()=>{});
 }
}
async function write(record:CallOutcomeRecord):Promise<boolean>{
 if(!callOutcomesEnabled()||!isValid(record))return false;
 const body=Buffer.from(JSON.stringify(record),'utf8');
 if(body.length>FILE_BYTES)return false;
 try{
  return await serial(async()=>{
   await fs.mkdir(folder(),{recursive:true,mode:0o700});
   const dest=recordPath(record.idHash);
   const temp=dest+'.'+process.pid+'.'+randomBytes(4).toString('hex')+'.tmp';
   try{
    await fs.writeFile(temp,body,{flag:'wx',mode:0o600});
    await fs.rename(temp,dest);
    writes++;
    if(writes%12===0)await prune();
    return true;
   }finally{await fs.unlink(temp).catch(()=>{});}
  });
 }catch{failedWrites++;return false;}
}
export async function beginCallOutcome(callId:string,tool:string):Promise<CallOutcomeRecord|null>{
 if(!callOutcomesEnabled()||typeof callId!=='string'||callId.length<8||callId.length>100||!VALID_TOOL.test(tool))return null;
 const receipt:CallOutcomeRecord={version:1,idHash:hash(callId),tool,startedAt:Date.now(),outcome:'started'};
 return await write(receipt)?receipt:null;
}
export async function settleCallOutcome(record:CallOutcomeRecord|null,
  value:{isError?:boolean;structuredContent?:Record<string,unknown>}|undefined,
  durationMs:number):Promise<void>{
 if(!record)return;
 const code=(value?.structuredContent?.error as {code?:unknown}|undefined)?.code;
 const errorCode=typeof code==='string'?code.replace(/[^A-Z0-9_]/gi,'_').toUpperCase().slice(0,64):undefined;
 const outcome:CallOutcome=value?.isError?'reported_failure':
  value?.structuredContent?.pending===true?'pending':'returned_success';
 await write({...record,outcome,settledAt:Date.now(),
  durationMs:Math.max(0,Math.min(86_400_000,Math.round(durationMs))),
  ...(errorCode?{errorCode}:{} )});
}
export interface CallOutcomeLookup{
 found:boolean;outcome?:'uncertain'|'returned_success'|'reported_failure'|'pending';
 tool?:string;startedAt?:number;settledAt?:number;durationMs?:number;
 errorCode?:string;recoveredUncertain?:boolean;
 fullResultStored:false;deliveryToRelayConfirmed:false;automaticReplay:false;
 guidance:string;
}
export async function lookupCallOutcome(callId:string):Promise<CallOutcomeLookup>{
 const none:CallOutcomeLookup={found:false,fullResultStored:false,deliveryToRelayConfirmed:false,automaticReplay:false,
  guidance:'No stored call receipt. This does not prove the operation was never executed; check the actual project/job state before retrying.'};
 if(!callOutcomesEnabled()||typeof callId!=='string'||callId.length<8||callId.length>100)return none;
 try{
  const filename=recordPath(hash(callId));
  const st=await fs.lstat(filename);
  if(!st.isFile()||st.size<40||st.size>FILE_BYTES||Date.now()-st.mtimeMs>RETAIN_MS)return none;
  const data:unknown=JSON.parse(await fs.readFile(filename,'utf8'));
  if(!isValid(data)||data.idHash!==hash(callId))return none;
  const uncertain=data.outcome==='started';
  return {
   found:true,
   outcome:data.outcome==='started'?'uncertain':data.outcome,
   tool:data.tool,startedAt:data.startedAt,settledAt:data.settledAt,
   durationMs:data.durationMs,errorCode:data.errorCode,
   recoveredUncertain:uncertain,
   fullResultStored:false,deliveryToRelayConfirmed:false,automaticReplay:false,
   guidance:uncertain?
    'The call was received but its completion was not durably recorded. It may have completed before a crash. Inspect the actual state; never replay a mutation automatically.':
    data.outcome==='returned_success'?
     'The local agent returned success, but delivery to the relay/ChatGPT is not confirmed. Inspect actual state before any mutation retry.':
     data.outcome==='pending'?
      'The local agent returned a pending job. Query the existing job/session; do not start a duplicate.':
      'The local agent reported failure. Check actual state before retrying because external side effects may still have occurred.'
  };
 }catch{return none;}
}
export const callOutcomeStatus=()=>({
 enabled:callOutcomesEnabled(),retainsPotentialMutationsOnly:true,
 maxFiles:FILES,maxDiskBytes:MAX_DISK_BYTES,retentionDays:7,
 writes,failedWrites,prunes,storesFullResults:false,storesArguments:false,
 storesPaths:false,storesRawCallIds:false,automaticReplay:false,
 deliveryAcknowledgementSupported:false
});
