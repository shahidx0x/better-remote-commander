/**
 * Encrypted, bounded and restart-readable terminal tail.
 * No commands, arguments, environment variables or source files are stored.
 * Uses the existing device pairing token to derive a separate AEAD key.
 * If the machine is unpaired or disabled, it stores nothing.
 *
 * This is a historical output snapshot, never an assertion that a process
 * survived a restart. "running" snapshots recover as "outcome_uncertain".
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,createCipheriv,createDecipheriv,randomBytes,hkdfSync} from 'node:crypto';
import {homeDir,loadCredentials} from '../transport/pairing.js';
const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE=/^[a-f0-9]{64}\.json$/,MAX_ITEMS=12,MAX_BYTES=8*1024*1024;
const TTL=24*60*60*1000,MAX_CONTENT=500*1024,MAX_DISK=740*1024;
type JournalState='running'|'completed'|'interrupted';
export interface TerminalSnapshot{
 sessionId:string;pid:number;startedAt:number;endedAt?:number;
 state:JournalState;exitCode:number|null;evictedLines:number;lines:string[];
}
type Envelope={version:1;id:string;iv:string;tag:string;ciphertext:string;storedAt:number};
const sha=(text:string)=>createHash('sha256').update(text).digest('hex');
const home=()=>path.join(homeDir(),'terminal-journal');
const file=(id:string)=>path.join(home(),sha(id)+'.json');
const enabled=()=>process.env.BRC_TERMINAL_JOURNAL!=='0';
const key=():Buffer|null=>{
 if(!enabled())return null;
 const creds=loadCredentials();
 if(!creds?.deviceToken||!creds.deviceId)return null;
 return Buffer.from(hkdfSync('sha256',Buffer.from(creds.deviceToken,'utf8'),
  Buffer.from('brc-terminal-journal-v1'),Buffer.from(creds.deviceId+'\0'+creds.relayUrl),32));
};
let lane:Promise<unknown>=Promise.resolve();
const metrics={saved:0,loaded:0,skipped:0,errors:0,pruned:0};
export function terminalJournalStatus(){return {enabled:!!key(),encryptedAtRest:true,
 retentionHours:24,maxSessions:MAX_ITEMS,maxDiskBytes:MAX_BYTES,
 maxPerSessionPlaintextBytes:MAX_CONTENT,storesCommandArguments:false,
 outputStoredOnlyWithExistingPairing:true,automaticProcessRetry:false,...metrics};}
async function prune(){
 // Enforce the on-disk cap at EVERY save. A time-based skip could allow a
 // burst of completed processes to exceed 12 files or 8 MiB until the next sweep.
 const dir=home();
 const names=(await fs.readdir(dir)).filter(n=>FILE.test(n));
 const rows=(await Promise.all(names.map(async name=>{
  try{const s=await fs.lstat(path.join(dir,name));return s.isFile()&&!s.isSymbolicLink()
   ?{name,bytes:s.size,time:s.mtimeMs}:null;}catch{return null;}
 }))).filter((r):r is {name:string;bytes:number;time:number}=>r!==null)
  .sort((a,b)=>b.time-a.time);
 let total=0,retained=0;
 for(const row of rows){
  if(Date.now()-row.time>TTL||retained>=MAX_ITEMS||total+row.bytes>MAX_BYTES){
   await fs.unlink(path.join(dir,row.name)).catch(()=>{});metrics.pruned++;
  }else{retained++;total+=row.bytes;}
 }
}
function capped(s:TerminalSnapshot):TerminalSnapshot{
 const lines=s.lines.filter(line=>typeof line==='string');
 let from=0,remaining=Buffer.byteLength(JSON.stringify({...s,lines}),'utf8');
 // Keep the newest complete lines, never drop whole session metadata.
 while(remaining>MAX_CONTENT&&from<lines.length){
  remaining-=Buffer.byteLength(JSON.stringify(lines[from]),'utf8')+1;from++;
 }
 return {...s,lines:lines.slice(from),evictedLines:s.evictedLines+from};
}
export async function saveTerminalSnapshot(snapshot:TerminalSnapshot):Promise<boolean>{
 if(!ID.test(snapshot.sessionId)||!Number.isSafeInteger(snapshot.pid)||snapshot.pid<=0)return false;
 const secret=key();
 if(!secret){metrics.skipped++;return false;}
 const current=lane.catch(()=>{}).then(async()=>{
  const dir=home(),dest=file(snapshot.sessionId);
  const selected=capped(snapshot);
  const plain=Buffer.from(JSON.stringify(selected),'utf8');
  if(plain.length>MAX_CONTENT){metrics.skipped++;return false;}
  const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',secret,iv);
  cipher.setAAD(Buffer.from(snapshot.sessionId));
  const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
  const body=Buffer.from(JSON.stringify({version:1,id:snapshot.sessionId,storedAt:Date.now(),
   iv:iv.toString('base64url'),tag:cipher.getAuthTag().toString('base64url'),
   ciphertext:encrypted.toString('base64url')} satisfies Envelope));
  if(body.length>MAX_DISK){metrics.skipped++;return false;}
  await fs.mkdir(dir,{recursive:true,mode:0o700});
  const stat=await fs.lstat(dir);
  if(!stat.isDirectory()||stat.isSymbolicLink())throw Error('UNSAFE_TERMINAL_JOURNAL_DIR');
  const temp=dest+'.'+process.pid+'.'+randomBytes(5).toString('hex')+'.tmp';
  try{
   const h=await fs.open(temp,'wx',0o600);
   try{await h.writeFile(body);await h.sync();}finally{await h.close();}
   await fs.rename(temp,dest);
   try{const h=await fs.open(dir,'r');try{await h.sync();}finally{await h.close();}}catch{}
   metrics.saved++;await prune().catch(()=>{});
   return true;
  }finally{await fs.unlink(temp).catch(()=>{});}
 });
 lane=current.then(()=>{},()=>{});
 return current.catch(()=>{metrics.errors++;return false;});
}
export async function loadTerminalSnapshot(id:string):Promise<TerminalSnapshot|null>{
 if(!ID.test(id))return null;
 const secret=key();
 if(!secret)return null;
 try{
  const st=await fs.lstat(file(id));
  if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_DISK||Date.now()-st.mtimeMs>TTL)return null;
  const row=JSON.parse(await fs.readFile(file(id),'utf8')) as Envelope;
  if(row.version!==1||row.id!==id)throw Error('Bad terminal snapshot header');
  const decipher=createDecipheriv('aes-256-gcm',secret,Buffer.from(row.iv,'base64url'));
  decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(row.tag,'base64url'));
  const body=Buffer.concat([decipher.update(Buffer.from(row.ciphertext,'base64url')),decipher.final()]);
  if(body.length>MAX_CONTENT)throw Error('Too large terminal snapshot');
  const value=JSON.parse(body.toString('utf8')) as TerminalSnapshot;
  if(value.sessionId!==id||!Array.isArray(value.lines)||value.lines.length>200_000||
    !Number.isSafeInteger(value.evictedLines)||!Number.isSafeInteger(value.pid))
   throw Error('Malformed terminal snapshot');
  metrics.loaded++;
  // Previously running processes may have been orphaned or terminated by
  // Job Objects. Never claim that they finished cleanly after a restart.
  return {...value,state:value.state==='running'?'interrupted':value.state};
 }catch(e){
  if((e as NodeJS.ErrnoException).code!=='ENOENT')metrics.errors++;
  return null;
 }
}
export async function flushTerminalJournal(){await lane.catch(()=>{});}
