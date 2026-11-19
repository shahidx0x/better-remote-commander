/** Bounded idle-time housekeeping of ONLY BRC-owned operational records.
 *
 * Explicit one-level allowlist; no recursive walk, project/source directories,
 * installed plugins, device credentials, arbitrary file names, or relay DB.
 * Expired metadata and orphaned temporary files can accumulate if no new
 * records are written. This is a safety-checked periodic supplement to each
 * store's existing write-time quota, not a replacement or a data migration.
 *
 * Raw job output remains opt-in, NEVER enabled by maintenance. Records are
 * never inspected or replayed; only lstat metadata determines retention.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {homeDir} from '../transport/pairing.js';
import {enabledByDefault} from './feature-defaults.js';

const DAY=24*60*60_000;
const MAX_SCAN=4096;
const TMP_AGE_MS=2*60*60_000;
const RECENT_WRITE_GRACE_MS=60_000;
const HEX='[a-f0-9]';
const UUID='[a-f0-9]{8}-[a-f0-9-]{27,50}';
const JOB_ID='j[a-z0-9]{7,64}';
export const operationalRetentionEnabled=()=>enabledByDefault('BRC_OPERATIONAL_RETENTION');
interface Policy{
 name:string;records:RegExp;temp:RegExp;
 maxFiles:number;maxBytes:number;ttlMs:number;
 protectedWriteMs:number;minRetained:number;
}
const maxSpillQuota=()=>{
 const setting=Number(process.env.BRC_JOB_OUTPUT_QUOTA_BYTES);
 return Number.isFinite(setting)&&setting>0
  ?Math.min(64*1024*1024,Math.max(2*1024*1024,Math.floor(setting)))
  :64*1024*1024;
};
function policies():Policy[]{
 return [
  {name:'call-outcomes',records:/^[a-f0-9]{64}\.json$/,
   temp:/^[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{8}\.tmp$/,
   maxFiles:128,maxBytes:512*1024,ttlMs:7*DAY,
   protectedWriteMs:RECENT_WRITE_GRACE_MS,minRetained:0},
  {name:'mutation-receipts',records:/^[a-f0-9]{64}\.json$/,
   temp:/^[a-f0-9]{64}\.json\.\d+\.[a-f0-9]{8}\.tmp$/,
   maxFiles:128,maxBytes:1024*1024,ttlMs:7*DAY,
   protectedWriteMs:RECENT_WRITE_GRACE_MS,minRetained:0},
  {name:'task-checkpoints',records:new RegExp('^'+UUID+'\\.json$','i'),
   temp:new RegExp('^'+UUID+'\\.\\d+\\.[a-f0-9]{10}\\.tmp$','i'),
   maxFiles:8,maxBytes:4*1024*1024,ttlMs:7*DAY,
   protectedWriteMs:RECENT_WRITE_GRACE_MS,minRetained:0},
  {name:'worker-plan-checkpoints',records:/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json$/i,
   temp:/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.json\.\d+\.[a-f0-9]{8}\.tmp$/i,
   maxFiles:4,maxBytes:2*1024*1024,ttlMs:7*DAY,
   protectedWriteMs:RECENT_WRITE_GRACE_MS,minRetained:0},
  {name:'job-output',records:new RegExp('^'+JOB_ID+'\\.(?:[0-9]|[1-4][0-9])\\.spill$'),
   temp:new RegExp('^'+JOB_ID+'\\.(?:[0-9]|[1-4][0-9])\\.spill\\.\\d+\\.[a-f0-9]{8}\\.tmp$'),
   maxFiles:128,maxBytes:maxSpillQuota(),ttlMs:7*DAY,
   protectedWriteMs:RECENT_WRITE_GRACE_MS,minRetained:0},
  // Existing job history has no age-based TTL, only 100 files/32 MiB.
  // Preserve that contract, and never quota-prune a newly running job record.
  {name:'jobs',records:new RegExp('^'+JOB_ID+'\\.json$'),
   temp:new RegExp('^'+JOB_ID+'\\.\\d+\\.[a-f0-9]+\\.tmp$'),
   maxFiles:100,maxBytes:32*1024*1024,ttlMs:Number.POSITIVE_INFINITY,
   protectedWriteMs:6*60*60_000,minRetained:1},
 ];
}
interface FileInfo{name:string;bytes:number;mtime:number;ino:number;dev:number}
export interface RetentionFamilyResult{
 family:string;scanned:number;kept:number;keptBytes:number;
 removed:number;removedBytes:number;removedOrphanTemps:number;
 skippedUnowned:number;skippedRecentlyWritten:number;
 skippedChanged:number;scanLimitHit:boolean;directorySkipped:boolean;failures:number;
}
export interface RetentionRunResult{
 ranAt:number;families:RetentionFamilyResult[];removed:number;
 removedBytes:number;scanLimitHits:number;failures:number;
}
let last:RetentionRunResult|null=null,serialLane:Promise<void>=Promise.resolve();
let runs=0,running=false,skippedDisabled=0,prunedRecords=0,prunedBytes=0,failures=0;
function same(a:FileInfo,b:import('node:fs').Stats):boolean{
 return b.isFile()&&!b.isSymbolicLink()&&b.dev===a.dev&&
  b.ino===a.ino&&b.size===a.bytes&&b.mtimeMs===a.mtime;
}
export function operationalRetentionStatus(){
 return {enabled:operationalRetentionEnabled(),runs,running,skippedDisabled,
  recordsRemoved:prunedRecords,bytesRemoved:prunedBytes,failures,
  lastRunAt:last?.ranAt??null,
  lastRun:last?{removed:last.removed,removedBytes:last.removedBytes,
   scanLimitHits:last.scanLimitHits,failures:last.failures,
   families:last.families.map(f=>({family:f.family,scanned:f.scanned,
    removed:f.removed,removedOrphanTemps:f.removedOrphanTemps,
    kept:f.kept,keptBytes:f.keptBytes,scanLimitHit:f.scanLimitHit,
    directorySkipped:f.directorySkipped,failures:f.failures}))}:null,
  scanLimitPerFamily:MAX_SCAN,temporaryFileGraceMs:TMP_AGE_MS,
  notes:'Only allowlisted agent operational records are pruned. No project files, credentials or source content. Current job output retention remains opt-in. This does not confirm relay delivery or replay outcomes.'};
}
async function cleanFamily(root:string,policy:Policy,now:number):Promise<RetentionFamilyResult>{
 const result:RetentionFamilyResult={family:policy.name,scanned:0,kept:0,keptBytes:0,
  removed:0,removedBytes:0,removedOrphanTemps:0,
  skippedUnowned:0,skippedRecentlyWritten:0,skippedChanged:0,
  scanLimitHit:false,directorySkipped:false,failures:0};
 const folder=path.join(root,policy.name);
 let st:import('node:fs').Stats;
 try{st=await fs.lstat(folder);}
 catch(e){
  if((e as NodeJS.ErrnoException)?.code==='ENOENT'){result.directorySkipped=true;return result;}
  result.failures++;return result;
 }
 if(!st.isDirectory()||st.isSymbolicLink()){
  result.directorySkipped=true;return result;
 }
 const records:FileInfo[]=[],temps:FileInfo[]=[];
 let handle:Awaited<ReturnType<typeof fs.opendir>>|undefined;
 try{
  handle=await fs.opendir(folder);
  for await(const entry of handle){
   result.scanned++;
   if(result.scanned>MAX_SCAN){result.scanLimitHit=true;break;}
   const isRecord=policy.records.test(entry.name),isTemp=policy.temp.test(entry.name);
   if(!isRecord&&!isTemp){result.skippedUnowned++;continue;}
   if(!entry.isFile()||entry.isSymbolicLink()){result.skippedUnowned++;continue;}
   try{
    const info=await fs.lstat(path.join(folder,entry.name));
    if(!info.isFile()||info.isSymbolicLink()){result.skippedUnowned++;continue;}
    const metadata={name:entry.name,bytes:info.size,mtime:info.mtimeMs,ino:info.ino,dev:info.dev};
    (isRecord?records:temps).push(metadata);
   }catch{result.failures++;}
  }
 }catch{result.failures++;}
 finally{await handle?.close().catch(()=>{});}
 // A partial directory listing cannot establish newest-first or quota
 // correctness. Preserve all records and request review rather than delete.
 if(result.scanLimitHit){result.kept=records.length;result.keptBytes=records.reduce((n,e)=>n+e.bytes,0);return result;}
 async function remove(item:FileInfo,isTemp:boolean){
  const file=path.join(folder,item.name);
  try{
   const current=await fs.lstat(file);
   if(!same(item,current)){result.skippedChanged++;return false;}
   // Avoid deleting a file created during this maintenance run.
   if(now-current.mtimeMs<(isTemp?TMP_AGE_MS:policy.protectedWriteMs)){
    result.skippedRecentlyWritten++;return false;
   }
   await fs.unlink(file);
   result.removed++;result.removedBytes+=item.bytes;
   if(isTemp)result.removedOrphanTemps++;
   return true;
  }catch(e){
   if((e as NodeJS.ErrnoException)?.code!=='ENOENT')result.failures++;
   return false;
  }
 }
 for(const item of temps)if(now-item.mtime>TMP_AGE_MS)await remove(item,true);
 records.sort((a,b)=>b.mtime-a.mtime);
 let keptCount=0,keptBytes=0;
 for(const item of records){
  const age=now-item.mtime;
  const expired=age>policy.ttlMs;
  const exceeds=keptCount>=policy.maxFiles||keptBytes+item.bytes>policy.maxBytes;
  const oldEnough=age>=policy.protectedWriteMs;
  const shouldRemove=(expired||exceeds)&&oldEnough&&keptCount>=policy.minRetained;
  if(shouldRemove&&await remove(item,false))continue;
  if((expired||exceeds)&&!oldEnough)result.skippedRecentlyWritten++;
  keptCount++;keptBytes+=item.bytes;
 }
 result.kept=keptCount;result.keptBytes=keptBytes;
 return result;
}
/** Caller should run this only while the agent is idle.
 * Schedules are serial, so overlapping maintenance cannot double-delete.
 */
export async function sweepOperationalRetention(now=Date.now()):Promise<RetentionRunResult|null>{
 if(!operationalRetentionEnabled()){skippedDisabled++;return null;}
 const work=serialLane.catch(()=>{}).then(async()=>{
  running=true;
  try{
   const root=homeDir();
   const result:RetentionRunResult={ranAt:now,families:[],removed:0,
    removedBytes:0,scanLimitHits:0,failures:0};
   for(const p of policies()){
    const family=await cleanFamily(root,p,now);
    result.families.push(family);
    result.removed+=family.removed;result.removedBytes+=family.removedBytes;
    result.scanLimitHits+=Number(family.scanLimitHit);
    result.failures+=family.failures;
   }
   runs++;last=result;prunedRecords+=result.removed;
   prunedBytes+=result.removedBytes;failures+=result.failures;
   return result;
  }finally{running=false;}
 });
 serialLane=work.then(()=>{},()=>{});
 return work;
}
