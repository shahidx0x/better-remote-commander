/**
 * Bounded encrypted disk spool for results that already finished locally.
 * This NEVER persists command arguments and NEVER re-executes a tool.
 * Files contain authenticated ciphertext and a non-secret operation UUID.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash,createCipheriv,createDecipheriv,randomBytes,hkdfSync} from 'node:crypto';
import type {ToolResult} from 'brc-shared';
import {homeDir} from './pairing.js';

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const FILE=/^[0-9a-f]{64}\.json$/;
const TTL=7*86_400_000,MAX_FILES=128,MAX_TOTAL=64*1024*1024;
const MAX_PLAINTEXT=500*1024,MAX_DISK_FILE=720*1024;
type Stored={version:1;id:string;createdAt:number;iv:string;tag:string;ciphertext:string};
export type SpoolResult={tool:string;result:ToolResult};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const folder=()=>path.join(homeDir(),'result-spool');
const destination=(id:string)=>path.join(folder(),sha(id)+'.json');
const enabled=()=>process.env.BRC_DURABLE_AGENT_SPOOL!=='0';

export class ResultSpool {
 private readonly key:Buffer;
 private lane:Promise<unknown>=Promise.resolve();
 private counts={saved:0,acked:0,failed:0,replayed:0,pruned:0};
 private lastPruned=0;
 constructor(deviceId:string,deviceToken:string,relayUrl:string){
  this.key=Buffer.from(hkdfSync('sha256',Buffer.from(deviceToken,'utf8'),
   Buffer.from('brc-local-agent-result-spool-v1'),
   Buffer.from(deviceId+'\0'+relayUrl,'utf8'),32));
 }
 status(){return {enabled:enabled(),maxFiles:MAX_FILES,maxDiskBytes:MAX_TOTAL,
  maxResultBytes:MAX_PLAINTEXT,retentionDays:7,encryptedAtRest:true,
  storesArguments:false,automaticExecutionRetry:false,...this.counts};}
 private serial<T>(f:()=>Promise<T>):Promise<T>{
  const next=this.lane.catch(()=>{}).then(f);
  this.lane=next.then(()=>{},()=>{});
  return next;
 }
 private async safeDir(create=false):Promise<void>{
  if(create)await fs.mkdir(folder(),{recursive:true,mode:0o700});
  const stat=await fs.lstat(folder());
  if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('UNSAFE_SPOOL_DIRECTORY');
 }
 private async entries():Promise<{name:string;mtime:number;bytes:number}[]>{
  await this.safeDir();
  const names=(await fs.readdir(folder())).filter(n=>FILE.test(n));
  const rows=await Promise.all(names.map(async name=>{
   try{const st=await fs.lstat(path.join(folder(),name));
    return st.isFile()&&!st.isSymbolicLink()?{name,mtime:st.mtimeMs,bytes:st.size}:null;}
   catch{return null;}
  }));
  return rows.filter((r):r is {name:string;mtime:number;bytes:number}=>!!r)
   .sort((a,b)=>b.mtime-a.mtime);
 }
 private async prune():Promise<void>{
  this.lastPruned=Date.now();
  let entries:Awaited<ReturnType<ResultSpool['entries']>>;
  try{entries=await this.entries();}catch{return;}
  let retained=0,total=0;
  for(const item of entries){
   const expired=Date.now()-item.mtime>TTL;
   if(expired||retained>=MAX_FILES||total+item.bytes>MAX_TOTAL){
    await fs.unlink(path.join(folder(),item.name)).catch(()=>{});
    this.counts.pruned++;
   }else{retained++;total+=item.bytes;}
  }
 }
 async save(id:string,tool:string,result:ToolResult):Promise<boolean>{
  if(!enabled()||!ID.test(id)||!tool||tool.length>80)return false;
  let plain:Buffer;
  try{plain=Buffer.from(JSON.stringify({tool,result}),'utf8');}
  catch{this.counts.failed++;return false;}
  if(plain.length>MAX_PLAINTEXT){this.counts.failed++;return false;}
  return this.serial(async()=>{
   const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',this.key,iv);
   cipher.setAAD(Buffer.from(id,'utf8'));
   const encrypted=Buffer.concat([cipher.update(plain),cipher.final()]);
   const value:Stored={version:1,id,createdAt:Date.now(),iv:iv.toString('base64url'),
    tag:cipher.getAuthTag().toString('base64url'),ciphertext:encrypted.toString('base64url')};
   const body=Buffer.from(JSON.stringify(value),'utf8');
   if(body.length>MAX_DISK_FILE){this.counts.failed++;return false;}
   const dest=destination(id),temp=dest+'.'+process.pid+'.'+randomBytes(5).toString('hex')+'.tmp';
   try{
    await this.safeDir(true);
    const handle=await fs.open(temp,'wx',0o600);
    try{await handle.writeFile(body);await handle.sync();}
    finally{await handle.close();}
    await fs.rename(temp,dest);
    // Directory sync is available on POSIX; Windows may decline it.
    try{const dir=await fs.open(folder(),'r');try{await dir.sync();}finally{await dir.close();}}catch{}
    this.counts.saved++;
    await this.prune();
    return true;
   }catch{this.counts.failed++;return false;}
   finally{await fs.unlink(temp).catch(()=>{});}
  });
 }
 async get(id:string):Promise<SpoolResult|null>{
  if(!enabled()||!ID.test(id))return null;
  try{
   await this.safeDir();
   const dest=destination(id),st=await fs.lstat(dest);
   if(!st.isFile()||st.isSymbolicLink()||st.size>MAX_DISK_FILE||st.size<90||Date.now()-st.mtimeMs>TTL)return null;
   const value:Stored=JSON.parse(await fs.readFile(dest,'utf8'));
   if(value.version!==1||value.id!==id||typeof value.ciphertext!=='string')return null;
   const iv=Buffer.from(value.iv,'base64url'),tag=Buffer.from(value.tag,'base64url');
   if(iv.length!==12||tag.length!==16)return null;
   const dec=createDecipheriv('aes-256-gcm',this.key,iv);
   dec.setAAD(Buffer.from(id,'utf8'));dec.setAuthTag(tag);
   const plain=Buffer.concat([dec.update(Buffer.from(value.ciphertext,'base64url')),dec.final()]);
   if(plain.length>MAX_PLAINTEXT)return null;
   const obj:SpoolResult=JSON.parse(plain.toString('utf8'));
   if(typeof obj.tool!=='string'||!obj.result||!Array.isArray(obj.result.content))return null;
   return obj;
  }catch{return null;}
 }
 async ids():Promise<string[]>{
  if(!enabled())return [];
  try{
   if(Date.now()-this.lastPruned>3_600_000)
    await this.serial(()=>this.prune());
   const rows=await this.entries(),ids:string[]=[];
   for(const entry of rows){
    if(Date.now()-entry.mtime>TTL||entry.bytes>MAX_DISK_FILE)continue;
    try{
     // The operation UUID is in the first 160 bytes of the JSON record.
     // Read ONLY that small prefix instead of 500 KiB of ciphertext per file.
     const handle=await fs.open(path.join(folder(),entry.name),'r');
     const prefix=Buffer.alloc(160);
     try{await handle.read(prefix,0,prefix.length,0);}finally{await handle.close();}
     const found=/"id":"([0-9a-fA-F-]{36})"/.exec(prefix.toString('utf8'));
     if(found&&ID.test(found[1])&&sha(found[1])+'.json'===entry.name)ids.push(found[1]);
    }catch{}
   }
   return ids;
  }catch{return [];}
 }
 async ack(id:string):Promise<boolean>{
  if(!ID.test(id))return false;
  return this.serial(async()=>{
   try{
    await this.safeDir();
    const dest=destination(id),st=await fs.lstat(dest);
    if(!st.isFile()||st.isSymbolicLink())return false;
    await fs.unlink(dest);this.counts.acked++;return true;
   }catch{return false;}
  });
 }
 recordReplay(){this.counts.replayed++;}
}
