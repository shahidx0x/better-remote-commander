/**
 * Opt-in bounded diagnostic output storage for managed BRC jobs.
 *
 * Never stores model conversations, source-file snapshots or plugin arguments.
 * Output can still contain arbitrary user data; redact common credential
 * formats before writing, keep small per-item and global limits, and explain
 * that these filters cannot recognize every possible secret.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { homeDir } from '../transport/pairing.js';

const MAX_ITEM_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const quotaBytes=()=>{
  const configured=Number(process.env.BRC_JOB_OUTPUT_QUOTA_BYTES);
  return Number.isFinite(configured)&&configured>0
    ?Math.min(MAX_TOTAL_BYTES,Math.max(2*1024*1024,Math.floor(configured)))
    :MAX_TOTAL_BYTES;
};
const MAX_FILES = 128;
const TTL_MS = 7 * 24 * 60 * 60_000;
const MAX_PAGE_BYTES = 32_000;
const JOB_ID = /^j[a-z0-9]{7,64}$/;
const STEP_MAX = 49;
const home = () => path.join(homeDir(), 'job-output');
// Short-lived integrity verification for an unchanged filesystem object.
// Fingerprinting uses dev/ino/size and BOTH data and metadata modification
// times; any observed change triggers a new complete SHA-256 verification.
// This does not defend against a privileged actor spoofing file identity and
// all timestamps or changing bytes concurrently outside the fstat windows.
const VERIFICATION_TTL_MS=30_000,MAX_VERIFIED=32;
const spillCacheEnabled=()=>process.env.BRC_SPILL_VERIFICATION_CACHE!=='0';
interface VerifiedSpill {sha:string;identity:string;at:number}
const verifiedSpills=new Map<string,VerifiedSpill>();
let fullHashes=0,verifiedCacheHits=0,identityChanges=0;
const identity=(st:import('node:fs').Stats)=>[
  st.dev,st.ino,st.size,st.mtimeMs,st.ctimeMs,st.birthtimeMs
].join(':');
function cacheVerified(file:string,sha:string,tag:string){
  verifiedSpills.delete(file);
  verifiedSpills.set(file,{sha,identity:tag,at:Date.now()});
  if(verifiedSpills.size>MAX_VERIFIED)verifiedSpills.delete(verifiedSpills.keys().next().value!);
}
export const spillVerificationStatus=()=>({
  enabled:spillCacheEnabled(),cachedFiles:verifiedSpills.size,maxCachedFiles:MAX_VERIFIED,
  ttlMs:VERIFICATION_TTL_MS,fullHashes,verifiedCacheHits,identityChanges,
  storesOutputInRam:false,
  note:'A fresh SHA-256 is required after file identity/timestamps change or cache expiry. This is a metadata-validated performance optimization, not OS-enforced immutability.'
});
const fileName = (id: string, step: number) => {
  if (!JOB_ID.test(id) || !Number.isInteger(step) || step < 0 || step > STEP_MAX)
    throw new Error('INVALID_JOB_OUTPUT_REF');
  return path.join(home(), id + '.' + step + '.spill');
};

export interface SpillRef { bytes: number; sha256: string; partial: boolean; }
export interface SpillPage {
  text: string; byteOffset: number; nextByteOffset: number;
  totalBytes: number; hasMore: boolean;
}
export const spillEnabled = (jobSetting?: boolean): boolean =>
  jobSetting ?? process.env.BRC_JOB_OUTPUT_SPILL === '1';

/** Common patterns only. Do NOT promise full scrubbing of arbitrary stdout. */
export function redactJobOutput(input: string): string {
  return input
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi,'[PRIVATE KEY REDACTED]')
    .replace(/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+/gi,'[CONNECTION URI REDACTED]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi,'Bearer [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,}|brc_(?:dev|ak)_[A-Za-z0-9_-]{4,})\b/gi,'[CREDENTIAL REDACTED]')
    .replace(/((?:"|')?(?:password|passphrase|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization|credential)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi,'$1[REDACTED]')
    .replace(/((?:--(?:password|token|secret|api-key|access-key))\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi,'$1[REDACTED]')
    .replace(/[A-Za-z0-9+\/]{250,}={0,2}/g,'[LONG ENCODED DATA OMITTED]')
    .replace(/\x00/g,' ');
}

/** Keep the beginning and end (build errors usually appear in one or both).
 * Do not allocate a copy of an unbounded input before applying the item cap. */
function boundedText(input: string): {text:string;partial:boolean} {
  const budget = MAX_ITEM_BYTES / 2;
  if (input.length <= budget) return {text:input,partial:false};
  const head = input.slice(0,Math.floor(budget/4));
  const tail = input.slice(-(budget-Math.floor(budget/4)));
  return {text:head+'\n[... middle output omitted because diagnostic output exceeded its size cap ...]\n'+tail,partial:true};
}
let writeLane = Promise.resolve();
async function prune():Promise<void> {
  const dir=home();
  const names=(await fs.readdir(dir)).filter(n=>/^j[a-z0-9]{7,64}\.(?:[0-9]|[1-4][0-9])\.spill$/.test(n));
  const entries=(await Promise.all(names.map(async name=>{
    try{
      const stat=await fs.lstat(path.join(dir,name));
      return stat.isFile()?{name,bytes:stat.size,mtime:stat.mtimeMs}:null;
    }catch{return null;}
  }))).filter((e):e is {name:string;bytes:number;mtime:number}=>!!e).sort((a,b)=>b.mtime-a.mtime);
  let total=0;
  const now=Date.now();
  for (let i=0;i<entries.length;i++){
    const entry=entries[i];
    total+=entry.bytes;
    if (i>=MAX_FILES || total>quotaBytes() || now-entry.mtime>TTL_MS)
      {verifiedSpills.delete(path.join(dir,entry.name));await fs.unlink(path.join(dir,entry.name)).catch(()=>{});}
  }
}
/** Writing a spill is strictly best effort: a full disk must not fail a build. */
export async function saveJobOutput(
  jobId:string,step:number,full:string,enabled?:boolean
):Promise<SpillRef|null>{
  if(!spillEnabled(enabled) || full.length<=16_000)return null;
  let destination:string;
  try{destination=fileName(jobId,step);}catch{return null;}
  const selected=boundedText(full);
  let sanitized=redactJobOutput(selected.text);
  let data=Buffer.from(sanitized,'utf8');
  if(data.length>MAX_ITEM_BYTES){
    sanitized=sanitized.slice(0,Math.floor(MAX_ITEM_BYTES/2));
    data=Buffer.from(sanitized,'utf8');
    selected.partial=true;
  }
  const sha256=createHash('sha256').update(data).digest('hex');
  const target:SpillRef={bytes:data.length,sha256,partial:selected.partial};
  const task=writeLane.catch(()=>{}).then(async()=>{
    const dir=home();
    const tmp=destination+'.'+process.pid+'.'+randomBytes(4).toString('hex')+'.tmp';
    try {
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      await fs.writeFile(tmp,data,{flag:'wx',mode:0o600});
      verifiedSpills.delete(destination);
      await fs.rename(tmp,destination);
      await prune();
      return target;
    } finally {await fs.unlink(tmp).catch(()=>{});}
  });
  writeLane=task.then(()=>{},()=>{});
  try {return await task;}catch{return null;}
}
/** Byte offsets are stable across Unicode; never read more than 32 KiB/page. */
export async function readJobOutput(
  jobId:string,step:number,offset=0,limit=8_000,expectedSha256?:string
):Promise<SpillPage|null>{
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isInteger(limit)||limit<1||limit>MAX_PAGE_BYTES)
    throw new Error('INVALID_JOB_OUTPUT_RANGE');
  let p:string;
  try{p=fileName(jobId,step);}catch{return null;}
  let fd:Awaited<ReturnType<typeof fs.open>>;
  try{fd=await fs.open(p,'r');}
  catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  try{
    const stat=await fd.stat();
    if(!stat.isFile() || stat.size>MAX_ITEM_BYTES || offset>stat.size)return null;
    const tag=identity(stat);
    if(expectedSha256){
      if(!/^[0-9a-f]{64}$/i.test(expectedSha256))return null;
      const expected=expectedSha256.toLowerCase();
      const cached=spillCacheEnabled()?verifiedSpills.get(p):undefined;
      // A wrong caller-supplied checksum must not invalidate an otherwise
      // trusted cached identity or force extra disk reads.
      if(cached&&cached.sha!==expected&&cached.identity===tag
         &&Date.now()-cached.at<VERIFICATION_TTL_MS)return null;
      const unchanged=cached&&cached.sha===expected&&cached.identity===tag
        &&Date.now()-cached.at<VERIFICATION_TTL_MS;
      if(unchanged){
        verifiedCacheHits++;
        // Move to end of bounded LRU map.
        verifiedSpills.delete(p);verifiedSpills.set(p,cached);
      }else{
        if(cached&&cached.identity!==tag)identityChanges++;
        verifiedSpills.delete(p);
        // Hash the full 2 MiB-max file only on the first read, after its
        // identity changes, or after cache expiry. Never cache corruption.
        const h=createHash('sha256'),buf=Buffer.alloc(32*1024);
        let position=0;
        fullHashes++;
        while(position<stat.size){
          const got=await fd.read(buf,0,Math.min(buf.length,stat.size-position),position);
          if(!got.bytesRead)return null;
          h.update(buf.subarray(0,got.bytesRead));
          position+=got.bytesRead;
        }
        if(identity(await fd.stat())!==tag)return null;
        if(h.digest('hex')!==expected)return null;
        if(spillCacheEnabled())cacheVerified(p,expected,tag);
      }
    }
    if(offset===stat.size){
      if(identity(await fd.stat())!==tag){verifiedSpills.delete(p);return null;}
      return {text:'',byteOffset:offset,nextByteOffset:offset,totalBytes:stat.size,hasMore:false};
    }
    const max=Math.min(stat.size-offset,limit+4);
    const chunk=Buffer.alloc(max);
    const r=await fd.read(chunk,0,max,offset);
    if(!r.bytesRead)return null;
    let start=0;
    // A user can give any byte offset; adjust forward to a UTF-8 boundary.
    while(start<r.bytesRead && (chunk[start]&0xc0)===0x80)start++;
    let end=Math.min(r.bytesRead,limit);
    const decoder=new TextDecoder('utf-8',{fatal:true});
    let text='';
    while(end>=start){
      try{text=decoder.decode(chunk.subarray(start,end));break;}
      catch {end--;}
    }
    if(end<start)return null;
    const next=offset+end;
    // A writer may replace the file or change it while this page is read.
    // Avoid presenting bytes from an unverified changed descriptor.
    if(identity(await fd.stat())!==tag){verifiedSpills.delete(p);return null;}
    return {text,byteOffset:offset+start,nextByteOffset:next,totalBytes:stat.size,hasMore:next<stat.size};
  }finally{await fd.close();}
}
export const outputSpillLimits=()=>({
  enabled:spillEnabled(),maxItemBytes:MAX_ITEM_BYTES,maxTotalBytes:quotaBytes(),
  maxPageBytes:MAX_PAGE_BYTES,retentionDays:7,verificationCache:spillVerificationStatus(),sensitiveOutput:'common patterns redacted, not a complete secret filter'
});
