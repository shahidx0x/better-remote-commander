/**
 * Durable, metadata-only receipts for mutations. They describe what BRC
 * observed; they are NOT an exactly-once executor and never replay actions.
 * A receipt left "started" after a crash must be treated as uncertain.
 *
 * Enabled by default; BRC_OPERATION_RECEIPTS=0 disables it. Max 128 records and 1 MiB on disk.
 * No arguments, command text, source, file paths or results are persisted.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {homeDir} from '../transport/pairing.js';
import {enabledByDefault} from './feature-defaults.js';

const MAX_FILES=128,MAX_TOTAL=1024*1024,MAX_FILE_BYTES=4096,TTL_MS=7*24*60*60_000;
const folder=()=>path.join(homeDir(),'mutation-receipts');
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const receiptFilename=(digest:string)=>path.join(folder(),digest+'.json');
export const mutationReceiptsEnabled=()=>enabledByDefault('BRC_OPERATION_RECEIPTS');

export type MutationOutcome='started'|'returned_success'|'reported_failure'|'uncertain';
export interface MutationReceipt {
  version:1;
  id:string; // SHA-256 of call id, never an arbitrary path
  tool:string;
  at:number;
  finishedAt?:number;
  outcome:MutationOutcome;
  targets:string[]; // SHA-256 of canonical path, never the raw paths
  before?:string[];
  after?:string[];
  errorCode?:string;
}
const boundedCode=(s:string)=>s.replace(/[^a-z0-9_-]/gi,'_').slice(0,48);
async function fingerprint(paths:string[]):Promise<string[]>{
  const result:string[]=[];
  for(const p of paths.slice(0,6)){
    let handle:Awaited<ReturnType<typeof fs.open>>|undefined;
    try{
      const link=await fs.lstat(p);
      if(!link.isFile()||link.isSymbolicLink()){result.push('not_regular_file');continue;}
      if(link.size>1024*1024){result.push('too_large_to_hash');continue;}
      handle=await fs.open(p,'r');
      const st=await handle.stat();
      if(!st.isFile()||st.size>1024*1024){result.push('too_large_to_hash');continue;}
      // Read from the open descriptor with a hard allocation bound, even if
      // another process grows the file after its first stat.
      const bytes=Buffer.alloc(st.size);
      let n=0;
      while(n<st.size){
        const got=await handle.read(bytes,n,st.size-n,n);
        if(!got.bytesRead)break;
        n+=got.bytesRead;
      }
      const after=await handle.stat();
      if(n!==st.size||after.size!==st.size){result.push('changed_during_fingerprint');continue;}
      result.push(createHash('sha256').update(bytes).digest('hex'));
    }catch(e){
      result.push((e as NodeJS.ErrnoException).code==='ENOENT'?'missing':'unavailable');
    }finally{await handle?.close().catch(()=>{});}
  }
  return result;
}
function valid(input:unknown):input is MutationReceipt{
  if(!input||typeof input!=='object')return false;
  const r=input as Partial<MutationReceipt>;
  return r.version===1&&typeof r.id==='string'&&/^[a-f0-9]{64}$/.test(r.id)
    &&typeof r.tool==='string'&&r.tool.length<=80
    &&typeof r.at==='number'&&Number.isFinite(r.at)
    &&['started','returned_success','reported_failure','uncertain'].includes(String(r.outcome))
    &&Array.isArray(r.targets)&&r.targets.length<=6&&r.targets.every(p=>typeof p==='string'&&/^[0-9a-f]{64}$/.test(p));
}
let lane=Promise.resolve();
async function prune():Promise<void>{
  const dir=folder();
  const names=(await fs.readdir(dir)).filter(n=>/^[0-9a-f]{64}\.json$/.test(n));
  const files=(await Promise.all(names.map(async name=>{
    try{
      const st=await fs.lstat(path.join(dir,name));
      return st.isFile()?{name,mtime:st.mtimeMs,bytes:st.size}:null;
    }catch{return null;}
  }))).filter((e):e is {name:string;mtime:number;bytes:number}=>!!e).sort((a,b)=>b.mtime-a.mtime);
  let bytes=0,now=Date.now();
  for(let i=0;i<files.length;i++){
    const entry=files[i];
    bytes+=entry.bytes;
    if(i>=MAX_FILES||bytes>MAX_TOTAL||now-entry.mtime>TTL_MS)
      await fs.unlink(path.join(dir,entry.name)).catch(()=>{});
  }
}
async function writeReceipt(r:MutationReceipt):Promise<boolean>{
  const data=Buffer.from(JSON.stringify(r));
  if(data.length>MAX_FILE_BYTES)return false;
  const task=lane.catch(()=>{}).then(async()=>{
    const dir=folder(),target=receiptFilename(r.id);
    const temp=target+'.'+process.pid+'.'+randomBytes(4).toString('hex')+'.tmp';
    try{
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      await fs.writeFile(temp,data,{flag:'wx',mode:0o600});
      await fs.rename(temp,target);
      await prune();
      return true;
    }finally{await fs.unlink(temp).catch(()=>{});}
  });
  lane=task.then(()=>{},()=>{});
  try{return await task;}catch{return false;}
}
/** Call AFTER authorization and inside file locks, BEFORE first side effect. */
export async function beginMutationReceipt(
  callId:string,tool:string,paths:string[]
):Promise<MutationReceipt|null>{
  if(!mutationReceiptsEnabled())return null;
  const targets=paths.slice(0,6).map(hash);
  const receipt:MutationReceipt={
    version:1,id:hash(callId+':'+tool),tool:boundedCode(tool),
    at:Date.now(),outcome:'started',targets,before:await fingerprint(paths)
  };
  return await writeReceipt(receipt)?receipt:null;
}
export async function settleMutationReceipt(
  receipt:MutationReceipt|null,paths:string[],outcome:Exclude<MutationOutcome,'started'>,
  errorCode?:string
):Promise<void>{
  if(!receipt)return;
  const updated:MutationReceipt={...receipt,outcome,finishedAt:Date.now(),
    after:await fingerprint(paths),
    ...(errorCode?{errorCode:boundedCode(errorCode)}:{})};
  await writeReceipt(updated);
}
/** On restart, a started receipt can only be classified as uncertain.
 * Displaying an outcome NEVER triggers replay or system mutation. */
export async function recentMutationReceipts(limit=12):Promise<Array<MutationReceipt&{recoveredUncertain:boolean}>>{
  if(!mutationReceiptsEnabled())return [];
  try{
    const dir=folder();
    const names=(await fs.readdir(dir)).filter(n=>/^[0-9a-f]{64}\.json$/.test(n));
    const meta=(await Promise.all(names.map(async name=>{
      try{return{name,at:(await fs.stat(path.join(dir,name))).mtimeMs};}catch{return null;}
    }))).filter((v):v is {name:string;at:number}=>!!v).sort((a,b)=>b.at-a.at).slice(0,Math.min(MAX_FILES,Math.max(1,limit)));
    const items: Array<MutationReceipt&{recoveredUncertain:boolean}>=[];
    for(const entry of meta){
      try{
        const p=path.join(dir,entry.name);
        if((await fs.stat(p)).size>MAX_FILE_BYTES)continue;
        const value:unknown=JSON.parse(await fs.readFile(p,'utf8'));
        if(!valid(value)||entry.name!==value.id+'.json')continue;
        items.push({...value,outcome:value.outcome==='started'?'uncertain':value.outcome,
          recoveredUncertain:value.outcome==='started'});
      }catch{/* ignore partial, inaccessible, or corrupt records */}
    }
    return items;
  }catch{return [];}
}
export const mutationReceiptStatus=()=>({
  enabled:mutationReceiptsEnabled(),maxReceipts:MAX_FILES,maxBytes:MAX_TOTAL,
  storesArguments:false,storesPaths:false,automaticReplay:false
});
