/**
 * Bounded, restart-safe append reconciliation.
 * No source content is stored in receipts: only hashes, path digest and byte counts.
 * A pending receipt is resolved against the full resulting file hash.
 * Any third-party change returns APPEND_OUTCOME_UNCERTAIN, never blind replay.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,randomBytes} from 'node:crypto';
import {homeDir} from '../transport/pairing.js';
import {atomicWrite,readBounded,sha256} from './file-safety.js';
import {validatePath} from '../core/tools/filesystem.js';
import {AgentError} from './errors.js';
const MAX_FILE=8*1024*1024,MAX_CHUNK=1024*1024,MAX_RECEIPTS=128,TTL=7*86400000;
const ID=/^[A-Za-z0-9][A-Za-z0-9_-]{15,127}$/;
type Receipt={version:1;id:string;pathHash:string;chunkHash:string;expectedBefore:string;
 afterHash:string;createdAt:number;state:'planned'|'settled'};
const hash=(x:string)=>createHash('sha256').update(x).digest('hex');
const folder=()=>path.join(homeDir(),'append-receipts');
const fileFor=(id:string)=>path.join(folder(),hash(id)+'.json');
let lane:Promise<unknown>=Promise.resolve();
async function durableReceipt(id:string,row:Receipt){
 const dir=folder(),dest=fileFor(id),temp=dest+'.'+process.pid+'.'+randomBytes(4).toString('hex')+'.tmp';
 await fs.mkdir(dir,{recursive:true,mode:0o700});
 const stat=await fs.lstat(dir);
 if(!stat.isDirectory()||stat.isSymbolicLink())throw new AgentError('APPEND_JOURNAL_UNAVAILABLE','Append receipt directory is unsafe.');
 try{
  const fd=await fs.open(temp,'wx',0o600);
  try{await fd.writeFile(JSON.stringify(row));await fd.sync();}finally{await fd.close();}
  await fs.rename(temp,dest);
  try{const fd=await fs.open(dir,'r');try{await fd.sync();}finally{await fd.close();}}catch{}
 }finally{await fs.unlink(temp).catch(()=>{});}
}
async function prune():Promise<void>{
 const dir=folder();
 const files=(await fs.readdir(dir)).filter(x=>/^[0-9a-f]{64}\.json$/.test(x));
 const stats=(await Promise.all(files.map(async name=>{
  try{const s=await fs.lstat(path.join(dir,name));
   return s.isFile()&&!s.isSymbolicLink()?{name,time:s.mtimeMs}:null;
  }catch{return null;}
 }))).filter((x):x is {name:string;time:number}=>x!==null).sort((a,b)=>b.time-a.time);
 await Promise.all(stats.filter((x,i)=>i>=MAX_RECEIPTS||Date.now()-x.time>TTL)
  .map(x=>fs.unlink(path.join(dir,x.name)).catch(()=>{})));
}
async function previous(id:string):Promise<Receipt|null>{
 try{const data=await fs.readFile(fileFor(id),'utf8');
  if(data.length>4096)throw Error('oversized receipt');
  const row=JSON.parse(data) as Receipt;
  if(row.version!==1||row.id!==id||!row.pathHash||!row.afterHash)
   throw Error('corrupt receipt');
  return row;
 }catch(err){
  if((err as NodeJS.ErrnoException).code==='ENOENT')return null;
  throw new AgentError('APPEND_OUTCOME_UNCERTAIN','Append receipt is unreadable. Inspect the file manually; no append was attempted.');
 }
}
export interface AppendOutcome{alreadyApplied:boolean;bytesWritten:number;beforeSha256:string;afterSha256:string;appendId:string;retentionDays:number}
async function doAppend(dest:string,content:string,id:string,expected?:string):Promise<AppendOutcome>{
 if(!ID.test(id))throw new AgentError('INVALID_ARGUMENT','append_id must contain 16-128 alphanumeric, underscore or hyphen characters.');
 const valid=await validatePath(dest);
 await fs.mkdir(path.dirname(valid),{recursive:true});
 if(await validatePath(dest)!==valid)throw new AgentError('PATH_CHANGED',
   'Append target resolved to a different path after preparing its parent. No bytes were written.');
 const chunkBytes=Buffer.byteLength(content,'utf8');
 if(chunkBytes>MAX_CHUNK)throw new AgentError('WRITE_SIZE_LIMIT','Append exceeds the 1 MiB per-call limit.');
 const existing=await previous(id);
 const pathHash=hash(valid),chunkHash=hash(content);
 if(existing&&(existing.pathHash!==pathHash||existing.chunkHash!==chunkHash||
    (expected && existing.expectedBefore!==expected)))
  throw new AgentError('APPEND_ID_REUSED','append_id was already used with different path/content/precondition; no file changed.');
 let before:Buffer,wasAbsent=false;
 try{before=await readBounded(valid,MAX_FILE);}catch(e){
  if((e as NodeJS.ErrnoException).code==='ENOENT'){before=Buffer.alloc(0);wasAbsent=true;}
  else throw e;
 }
 const actual=sha256(before);
 const ok=(row:Receipt,alreadyApplied:boolean):AppendOutcome=>({
  alreadyApplied,bytesWritten:alreadyApplied?0:chunkBytes,beforeSha256:row.expectedBefore,
  afterSha256:row.afterHash,appendId:id,retentionDays:7
 });
 if(existing){
  if(actual===existing.afterHash){
   if(existing.state!=='settled')await durableReceipt(id,{...existing,state:'settled'});
   return ok(existing,true);
  }
  if(actual!==existing.expectedBefore)
   throw new AgentError('APPEND_OUTCOME_UNCERTAIN','The file no longer matches either pre-append or post-append digest. An earlier append may have succeeded and the file changed afterward. No replay was attempted.');
 }else if(expected&&expected.toLowerCase()!==actual)
  throw new AgentError('FILE_CONFLICT','The expected_sha256 does not match the current file. No append occurred.');
 if(before.length+chunkBytes>MAX_FILE)
  throw new AgentError('APPEND_FILE_TOO_LARGE','Idempotent append is limited to an 8 MiB complete file to keep RAM bounded. Use ordinary append with external reconciliation for larger files.');
 const next=Buffer.concat([before,Buffer.from(content,'utf8')]);
 const row=existing??{version:1 as const,id,pathHash,chunkHash,expectedBefore:actual,
  afterHash:sha256(next),createdAt:Date.now(),state:'planned' as const};
 if(!existing)await durableReceipt(id,row);
 // atomicWrite stages the whole bounded target and publishes it via rename.
 // If publication completed but the acknowledgement was lost, replay verifies
 // afterHash and returns alreadyApplied without writing again.
 if(wasAbsent&&await fs.lstat(valid).then(()=>true,()=>false))
   throw new AgentError('FILE_CONFLICT','A different writer created the destination since its empty precondition. No append was attempted.');
 await atomicWrite(valid,next,wasAbsent?undefined:actual);
 await durableReceipt(id,{...row,state:'settled'});
 await prune().catch(()=>{});
 return ok(row,false);
}
export async function idempotentAppend(dest:string,content:string,id:string,expected?:string):Promise<AppendOutcome>{
 const prev=lane.catch(()=>{});
 let release!:()=>void;
 const current=new Promise<void>(r=>{release=r;});
 lane=current;
 await prev;
 try{return await doAppend(dest,content,id,expected);}
 finally{release();}
}
