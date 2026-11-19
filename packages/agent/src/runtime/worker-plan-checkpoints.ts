/** Bounded restart checkpoints for cooperative worker plans (enabled by default).
 *
 * No raw coordinator/claim keys, claim hashes, worker identities, submitted
 * patches, source content, tool arguments or model transcripts are stored.
 * A SHA-256 VERIFIER for the high-entropy coordinator key is kept so the
 * original coordinator can explicitly authorize resumption/cancellation.
 * Restored plans must be reviewed and validated before any new work.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {homeDir} from '../transport/pairing.js';
import {enabledByDefault} from './feature-defaults.js';

const MAX_FILE_BYTES=512*1024,MAX_PLANS=4,TTL_MS=7*24*60*60*1000;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH=/^[a-f0-9]{64}$/i;
const dir=()=>path.join(homeDir(),'worker-plan-checkpoints');
const file=(id:string)=>{
  if(!UUID.test(id))throw new Error('Invalid worker plan ID');
  return path.join(dir(),id+'.json');
};
export const workerPlanCheckpointsEnabled=()=>enabledByDefault('BRC_WORKER_PLAN_PERSIST');
export interface WorkerPlanCheckpoint {
  version:1;id:string;root:string;goal:string;
  mode:'native_workers'|'parallel_tools'|'single';
  maxWorkers:number;coordinatorHash:string;
  state:'active'|'needs_review'|'finished'|'cancelled';
  createdAt:number;touchedAt:number;revision:number;
  requiredChecks:string[];
  tasks:Array<{
    id:string;goal:string;scope:Array<{relative:string;canonical:string;key:string;directory:boolean}>;
    dependsOn:string[];readOnly:boolean;state:'queued'|'applied';generation:number;
  }>;
  baseline:[string,string][];
  appliedHashes:[string,string][];
}
const str=(s:unknown,n:number):s is string=>typeof s==='string'&&s.length>0&&s.length<=n;
function valid(v:unknown):v is WorkerPlanCheckpoint{
 if(!v||typeof v!=='object')return false;
 const a=v as Partial<WorkerPlanCheckpoint>;
 return a.version===1&&str(a.id,40)&&UUID.test(a.id)&&str(a.root,2048)&&path.isAbsolute(a.root)
  &&str(a.goal,2000)&&['native_workers','parallel_tools','single'].includes(String(a.mode))
  &&Number.isInteger(a.maxWorkers)&&a.maxWorkers!>=1&&a.maxWorkers!<=10
  &&str(a.coordinatorHash,64)&&HASH.test(a.coordinatorHash)
  &&['active','needs_review','finished','cancelled'].includes(String(a.state))
  &&typeof a.createdAt==='number'&&Number.isFinite(a.createdAt)
  &&typeof a.touchedAt==='number'&&Number.isFinite(a.touchedAt)
  &&Number.isInteger(a.revision)&&a.revision!>=1
  &&Array.isArray(a.requiredChecks)&&a.requiredChecks.length<=5
  &&a.requiredChecks.every(x=>str(x,100))
  &&Array.isArray(a.tasks)&&a.tasks.length>=1&&a.tasks.length<=32
  &&a.tasks.every(t=>str(t.id,64)&&str(t.goal,2000)&&Array.isArray(t.scope)
   &&t.scope.length>=1&&t.scope.length<=16
   &&t.scope.every(s=>str(s.relative,500)&&str(s.canonical,2048)&&path.isAbsolute(s.canonical)
    &&str(s.key,2048)&&typeof s.directory==='boolean')
   &&Array.isArray(t.dependsOn)&&t.dependsOn.length<=31&&t.dependsOn.every(x=>str(x,64))
   &&typeof t.readOnly==='boolean'&&['queued','applied'].includes(t.state)
   &&Number.isInteger(t.generation)&&t.generation>=0)
  &&Array.isArray(a.baseline)&&a.baseline.length<=20000
  &&a.baseline.every(pair=>Array.isArray(pair)&&pair.length===2&&str(pair[0],500)&&str(pair[1],64)&&HASH.test(pair[1]))
  &&Array.isArray(a.appliedHashes)&&a.appliedHashes.length<=512
  &&a.appliedHashes.every(pair=>Array.isArray(pair)&&pair.length===2&&str(pair[0],500)&&str(pair[1],64)&&HASH.test(pair[1]));
}
let lane:Promise<unknown>=Promise.resolve();
const serial=<T>(fn:()=>Promise<T>):Promise<T>=>{
 const work=lane.catch(()=>{}).then(fn);lane=work.then(()=>{},()=>{});return work;
};
async function prune():Promise<void>{
 const names=(await fs.readdir(dir())).filter(n=>UUID.test(n.slice(0,-5))&&n.endsWith('.json'));
 const entries=(await Promise.all(names.map(async n=>{
  try{const stat=await fs.lstat(path.join(dir(),n));return stat.isFile()?{name:n,mtime:stat.mtimeMs}:null;}
  catch{return null;}
 }))).filter((e):e is {name:string;mtime:number}=>!!e).sort((a,b)=>b.mtime-a.mtime);
 for(const entry of entries.slice(MAX_PLANS)){
  await fs.unlink(path.join(dir(),entry.name)).catch(()=>{});
 }
}
export async function saveWorkerPlanCheckpoint(value:WorkerPlanCheckpoint):Promise<boolean>{
 if(!workerPlanCheckpointsEnabled()||!valid(value))return false;
 const data=Buffer.from(JSON.stringify(value),'utf8');
 if(data.length>MAX_FILE_BYTES)return false;
 try{
  return await serial(async()=>{
   await fs.mkdir(dir(),{recursive:true,mode:0o700});
   const dest=file(value.id),temp=dest+'.'+process.pid+'.'+randomBytes(4).toString('hex')+'.tmp';
   try{
    await fs.writeFile(temp,data,{flag:'wx',mode:0o600});
    await fs.rename(temp,dest);
    await prune();
    return true;
   }finally{await fs.unlink(temp).catch(()=>{});}
  });
 }catch{return false;}
}
export async function loadWorkerPlanCheckpoints():Promise<WorkerPlanCheckpoint[]>{
 if(!workerPlanCheckpointsEnabled())return [];
 try{
  const names=(await fs.readdir(dir())).filter(n=>n.endsWith('.json')&&UUID.test(n.slice(0,-5)));
  const found:(WorkerPlanCheckpoint|null)[]=await Promise.all(names.slice(0,48).map(async n=>{
   try{
    const pathname=path.join(dir(),n);
    const stat=await fs.lstat(pathname);
    if(!stat.isFile()||stat.size>MAX_FILE_BYTES||stat.size<40)return null;
    const candidate:unknown=JSON.parse(await fs.readFile(pathname,'utf8'));
    if(!valid(candidate)||n!==candidate.id+'.json'||Date.now()-candidate.touchedAt>TTL_MS)return null;
    return candidate;
   }catch{return null;}
  }));
  return found.filter((x):x is WorkerPlanCheckpoint=>x!==null)
   .sort((a,b)=>b.touchedAt-a.touchedAt).slice(0,MAX_PLANS);
 }catch{return [];}
}
export async function deleteWorkerPlanCheckpoint(id:string):Promise<void>{
 if(!workerPlanCheckpointsEnabled())return;
 try{await serial(()=>fs.unlink(file(id)).catch(()=>{}));}catch{}
}
export const workerPlanCheckpointStatus=()=>({
 enabled:workerPlanCheckpointsEnabled(),maxPlans:MAX_PLANS,maxFileBytes:MAX_FILE_BYTES,
 retentionDays:7,rawKeysStored:false,claimHashesStored:false,patchPayloadsStored:false,
 coordinatorKeyVerifierStored:true,automaticallyResumesWork:false
});
