/** Durable metadata-only coding-session checkpoints.
 * Stores goals/scopes and source hashes, never tool transcripts or file content.
 * Activated for explicit coding_session workflows; BRC_TASK_PERSIST=0 opts out.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { homeDir } from '../transport/pairing.js';

const MAX_RECORD_BYTES=512*1024;
const MAX_SESSIONS=8;
const TTL_MS=7*24*60*60*1000;
const ID=/^[0-9a-f]{8}-[0-9a-f-]{27,50}$/i;

export type TaskCheckpointEvent='started'|'verification_passed'|'verification_failed'|'finished'|'resumed';
export interface TaskCheckpoint {
 version:1;
 id:string;
 root:string;
 goal:string;
 scope:string[];
 requiredChecks:string[];
 baseline:[string,string][];
 state:'active'|'verified'|'finished';
 touchedAt:number;
 events:{at:number;type:TaskCheckpointEvent}[];
}
export const checkpointEnabled=()=>process.env.BRC_TASK_PERSIST!=='0';
const dir=()=>path.join(homeDir(),'task-checkpoints');
const filename=(id:string)=>{if(!ID.test(id))throw new Error('Invalid task checkpoint ID');return path.join(dir(),id+'.json');};

function valid(value:unknown):value is TaskCheckpoint {
 if(!value || typeof value!=='object')return false;
 const v=value as Partial<TaskCheckpoint>;
 return v.version===1 && typeof v.id==='string' && ID.test(v.id)
  && typeof v.root==='string' && path.isAbsolute(v.root) && v.root.length<2048
  && typeof v.goal==='string' && v.goal.length<=2048
  && Array.isArray(v.scope) && v.scope.length<=100 && v.scope.every(s=>typeof s==='string' && s.length<=500)
  && Array.isArray(v.requiredChecks) && v.requiredChecks.length<=50 && v.requiredChecks.every(s=>typeof s==='string'&&s.length<150)
  && Array.isArray(v.baseline) && v.baseline.length<=2500
  && v.baseline.every(row=>Array.isArray(row)&&row.length===2&&typeof row[0]==='string'&&row[0].length<1024&&typeof row[1]==='string'&&/^[0-9a-f]{64}$/i.test(row[1]))
  && ['active','verified','finished'].includes(String(v.state))
  && typeof v.touchedAt==='number'&&Number.isFinite(v.touchedAt)
  && Array.isArray(v.events)&&v.events.length<=32;
}

export async function saveTaskCheckpoint(data:TaskCheckpoint):Promise<boolean>{
 if(!checkpointEnabled() || !valid(data))return false;
 const bytes=Buffer.from(JSON.stringify(data),'utf8');
 if(bytes.length>MAX_RECORD_BYTES)return false;
 const dest=filename(data.id);
 const temp=path.join(dir(),data.id+'.'+process.pid+'.'+randomBytes(5).toString('hex')+'.tmp');
 try {
  await fs.mkdir(dir(),{recursive:true,mode:0o700});
  await fs.writeFile(temp,bytes,{flag:'wx',mode:0o600});
  await fs.rename(temp,dest);
  const entries=(await fs.readdir(dir())).filter(n=>ID.test(n.replace(/\.json$/,''))&&n.endsWith('.json'));
  const stats=await Promise.all(entries.map(async name=>({name,mtime:(await fs.stat(path.join(dir(),name))).mtimeMs})));
  stats.sort((a,b)=>b.mtime-a.mtime);
  await Promise.all(stats.slice(MAX_SESSIONS).map(e=>fs.unlink(path.join(dir(),e.name)).catch(()=>{})));
  return true;
 }catch{return false;}finally{await fs.unlink(temp).catch(()=>{});}
}
export async function loadTaskCheckpoints():Promise<TaskCheckpoint[]>{
 if(!checkpointEnabled())return [];
 try{
  const names=(await fs.readdir(dir())).filter(n=>n.endsWith('.json')&&ID.test(n.slice(0,-5)));
  const entries=await Promise.all(names.slice(0,MAX_SESSIONS*2).map(async n=>{
   try{
    const pathname=path.join(dir(),n);
    const st=await fs.stat(pathname);
    if(st.size>MAX_RECORD_BYTES || st.size<10)return null;
    const data=JSON.parse(await fs.readFile(pathname,'utf8')) as unknown;
    if(!valid(data)||n!==data.id+'.json'||Date.now()-data.touchedAt>TTL_MS)return null;
    return data;
   }catch{return null;}
  }));
  return entries.filter((e):e is TaskCheckpoint=>!!e).sort((a,b)=>b.touchedAt-a.touchedAt).slice(0,MAX_SESSIONS);
 }catch{return [];}
}
export async function deleteTaskCheckpoint(id:string):Promise<void>{
 if(!checkpointEnabled())return;
 try{await fs.unlink(filename(id));}catch{}
}
