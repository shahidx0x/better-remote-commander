/** Enabled-by-default bounded shared filename discovery for agent code navigation.
 * One ripgrep enumeration feeds both source and filename-index projections.
 * Only relative FILE NAMES are cached. A fresh verification listing always
 * rescans; callers still enforce individual file/path permissions on access.
 *
 * No extra filesystem watchers, persistent logs, file contents, source hashes
 * or project/CLI execution. Never treat cached names as access authorization.
 */
import {spawn} from 'node:child_process';
import path from 'node:path';
import {getRipgrepPath} from '../core/utils/ripgrep-resolver.js';
import {getCallContext,checkCancelled} from '../context.js';
import {AgentError} from './errors.js';
import {enabledByDefault} from './feature-defaults.js';
import {observeManagedChild,stopManagedChild} from './process-termination.js';
import {spawnManaged} from './managed-spawn.js';

const MAX_ROOTS=4,MAX_FILES=20_000,MAX_BYTES=4*1024*1024;
const MAX_SCAN_MS=15_000,MAX_IDLE_MS=60_000;
const WATCHED_TTL_MS=1_500;
const COMMON=['.git','node_modules','.next','dist','build','coverage','.turbo'];
const SOURCE_EXTRA=new Set(['.venv','venv','__pycache__','target','obj','.vs','.gradle','.dart_tool','.pub-cache']);
type Profile='source'|'index';
interface Entry {
 root:string; files:string[]; builtAt:number; accessedAt:number;
 bytes:number;truncated:boolean;dirty:boolean;version:number;
 building?:Promise<void>;controller?:AbortController;waiters:number;
}
export const sharedManifestEnabled=()=>enabledByDefault('BRC_SHARED_PROJECT_MANIFEST');
const relativeInside=(root:string,file:string)=>{
 const rel=path.relative(root,file);
 return rel===''||(rel!=='..'&&!rel.startsWith('..'+path.sep)&&!path.isAbsolute(rel));
};
const keyOf=(root:string)=>process.platform==='win32'?root.toLowerCase():root;
const normal=(name:string)=>name.replace(/\\/g,'/').replace(/^\.\//,'');
const isSensitive=(name:string)=>{
 const base=path.posix.basename(name).toLowerCase();
 return /^\.env(?:\.|$)/.test(base)
   || /^(?:id_rsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(base)
   || /\.(?:pem|p12|pfx|key)$/.test(base);
};
function acceptable(name:string,profile:Profile):boolean{
 const segments=name.split('/');
 if(profile==='index'){
  // Default "rg --files" does not list hidden directories/files.
  return !segments.some(part=>part.startsWith('.'));
 }
 if(isSensitive(name)||segments.some(part=>SOURCE_EXTRA.has(part)))return false;
 for(let i=0;i<segments.length-1;i++)
  if(segments[i]==='bin'&&(segments[i+1]==='Debug'||segments[i+1]==='Release'))
   return false;
 return true;
}
export interface ManifestListing {
 files:string[];truncated:boolean;baseTruncated:boolean;
 fromCache:boolean;shared:boolean;scanPending:boolean;
}
export class SharedProjectManifest {
 private entries=new Map<string,Entry>();
 private scans=0;
 private cacheHits=0;
 private joins=0;
 private evictions=0;
 private aborts=0;
 status(){
  const entries=[...this.entries.values()];
  return {enabled:sharedManifestEnabled(),
   roots:entries.length,files:entries.reduce((n,e)=>n+e.files.length,0),
   inflightScans:entries.filter(e=>!!e.building).length,
   retainedBytes:entries.reduce((n,e)=>n+e.bytes,0),
   scans:this.scans,cacheHits:this.cacheHits,inflightJoins:this.joins,
   evictions:this.evictions,abortedUnusedScans:this.aborts,
   maxRoots:MAX_ROOTS,maxFilesPerRoot:MAX_FILES,
   maxBytesPerRoot:MAX_BYTES,cacheTtlMs:WATCHED_TTL_MS,
   persistent:false,storedContent:false,
   note:'Enabled by default (BRC_SHARED_PROJECT_MANIFEST=0 disables). Names are hints only; paths are revalidated and verification rescans.'};
 }
 invalidate(file?:string){
  for(const entry of this.entries.values())
   if(!file||relativeInside(entry.root,file)){
    entry.version++;entry.dirty=true;
   }
 }
 pruneIdle(now=Date.now(),force=false,ttl=MAX_IDLE_MS):number{
  let removed=0;
  for(const [key,e] of this.entries)
   if(!e.building&&(force||now-e.accessedAt>=ttl)){
    this.entries.delete(key);removed++;this.evictions++;
   }
  return removed;
 }
 clear(){
  for(const entry of this.entries.values())entry.controller?.abort();
  this.entries.clear();
 }
 private entry(root:string):Entry{
  this.pruneIdle();
  const key=keyOf(root);
  let e=this.entries.get(key);
  if(e){e.accessedAt=Date.now();return e;}
  if(this.entries.size>=MAX_ROOTS){
   const oldest=[...this.entries.entries()].filter(([,v])=>!v.building)
     .sort((a,b)=>a[1].accessedAt-b[1].accessedAt)[0];
   if(oldest){this.entries.delete(oldest[0]);this.evictions++;}
  }
  if(this.entries.size>=MAX_ROOTS)
   throw new AgentError('MANIFEST_BUSY','All shared project manifest slots are currently building. Retry a narrower query.',true);
  e={root,files:[],builtAt:0,accessedAt:Date.now(),
   bytes:0,truncated:false,dirty:true,version:0,waiters:0};
  this.entries.set(key,e);
  return e;
 }
 private async scan(entry:Entry,signal:AbortSignal){
  const rg=await getRipgrepPath();
  if(signal.aborted)throw signal.reason??new AgentError('CANCELLED','No project enumeration was started.');
  const version=entry.version,files:string[]=[];
  let bytes=0,partial='',truncated=false,error='',timedOut=false;
  // A base listing intentionally includes hidden entries, and only excludes
  // directories both legacy consumers excluded. Each projection applies its
  // own remaining exclusions without losing index files to graph filters.
  const args=['--files','--hidden','--null','--no-config',
   ...COMMON.flatMap(d=>['-g','!**/'+d+'/**']),'--','.'];
  await new Promise<void>((resolve,reject)=>{
   let child:ReturnType<typeof spawn>;
   try{child=spawnManaged(rg,args,{cwd:entry.root,windowsHide:true,stdio:['ignore','pipe','pipe']},'fast-read');observeManagedChild(child);}
   catch(e){reject(e);return;}
   let settled=false;
   const clean=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
   const finish=(reason?:unknown)=>{
    if(settled)return;
    settled=true;clean();
    if(reason)reject(reason);else resolve();
   };
   const abort=()=>{stopManagedChild(child);};
   const timer=setTimeout(()=>{timedOut=true;abort();},MAX_SCAN_MS);
   signal.addEventListener('abort',abort,{once:true});
   child.stdout?.setEncoding('utf8');
   child.stdout?.on('data',(part:string)=>{
    if(truncated)return;
    bytes+=Buffer.byteLength(part);
    if(bytes>MAX_BYTES){truncated=true;abort();return;}
    partial+=part;
    const split=partial.split('\0');partial=split.pop()??'';
    for(const item of split){
     const name=normal(item);
     if(!name)continue;
     if(files.length>=MAX_FILES){truncated=true;abort();break;}
     files.push(name);
    }
   });
   child.stderr?.on('data',(part:Buffer)=>{error=(error+part.toString()).slice(0,1000);});
   child.on('error',e=>finish(e));
   child.on('close',code=>{
    if(signal.aborted)finish(signal.reason??new AgentError('CANCELLED','Project enumeration cancelled.'));
    else if(timedOut)finish(new AgentError('MANIFEST_TIMEOUT','Project listing took longer than 15 seconds.'));
    else if(code!==0&&code!==1&&!truncated)
      finish(new AgentError('MANIFEST_FAILED',error||'Could not list project files.'));
    else finish();
   });
   if(signal.aborted)abort();
  });
  if(signal.aborted)throw signal.reason??new AgentError('CANCELLED','Project enumeration cancelled.');
  // Do not let an external write invalidate an in-progress listing silently:
  // cache stays dirty and authoritative verification refuses a partial scan.
  const modified=entry.version!==version;
  entry.files=files.sort();
  entry.bytes=files.reduce((n,f)=>n+f.length*2+48,0);
  entry.builtAt=Date.now();entry.truncated=truncated||modified;
  entry.dirty=modified;
  this.scans++;
 }
 private async wait(entry:Entry,signal?:AbortSignal):Promise<void>{
  entry.waiters++;
  try{
   if(!entry.building)return;
   if(!signal)return await entry.building;
   if(signal.aborted)throw signal.reason??new AgentError('CANCELLED','Listing cancelled.');
   await new Promise<void>((resolve,reject)=>{
    let done=false;
    const finish=(reason?:unknown)=>{
     if(done)return;done=true;signal.removeEventListener('abort',abort);
     if(reason)reject(reason);else resolve();
    };
    const abort=()=>finish(signal.reason??new AgentError('CANCELLED','Listing cancelled.'));
    signal.addEventListener('abort',abort,{once:true});
    entry.building!.then(()=>finish(),e=>finish(e));
    if(signal.aborted)abort();
   });
  }finally{
   entry.waiters--;
   if(entry.waiters===0&&entry.building&&entry.controller&&!entry.controller.signal.aborted){
    this.aborts++;
    entry.controller.abort(new AgentError('CANCELLED','All waiting project manifest callers cancelled.'));
   }
  }
 }
 async list(root:string,profile:Profile,limit:number,
  opts:{fresh?:boolean;signal?:AbortSignal}={}):Promise<ManifestListing>{
  if(!sharedManifestEnabled())
   throw new AgentError('MANIFEST_DISABLED','Shared project manifest is not enabled.');
  checkCancelled();
  if(opts.signal?.aborted)throw opts.signal.reason??new AgentError('CANCELLED','Listing cancelled.');
  const max=Math.min(MAX_FILES,Math.max(1,Math.trunc(limit)));
  const e=this.entry(root);
  if(e.building&&e.controller?.signal.aborted){
   // All previous waiters abandoned a scan. Wait for its child process to
   // settle before starting a replacement; never join a cancelled scan.
   await e.building.catch(()=>{});
   checkCancelled();
  }
  const age=Date.now()-e.builtAt;
  let fromCache=!!e.builtAt&&!e.dirty&&age<WATCHED_TTL_MS&&!opts.fresh;
  if(!fromCache){
   if(e.building)this.joins++;
   else{
    const controller=new AbortController();
    e.controller=controller;
    e.building=this.scan(e,controller.signal).finally(()=>{
     e.building=undefined;e.controller=undefined;
    });
   }
   await this.wait(e,opts.signal);
  }else this.cacheHits++;
  checkCancelled();
  if(opts.fresh&&e.dirty){
   // A watcher may discover an external write while the first scan runs.
   // Retry only this READ-ONLY enumeration once; never replay mutations.
   // If the tree continues changing, fail closed instead of presenting a
   // seemingly authoritative but unstable source fingerprint.
   if(e.building)this.joins++;
   else{
    const controller=new AbortController();
    e.controller=controller;
    e.building=this.scan(e,controller.signal).finally(()=>{
     e.building=undefined;e.controller=undefined;
    });
   }
   await this.wait(e,opts.signal);
   if(e.dirty)throw new AgentError('VERIFICATION_CHANGED',
    'Project files changed during two verification scans. Repeat after filesystem activity settles.');
  }
  // Defensive copy: a caller can never mutate shared metadata.
  const files:string[]=[];
  let matches=0;
  for(const name of e.files){
   if(!acceptable(name,profile))continue;
   matches++;
   if(files.length<max)files.push(name);
  }
  return {files,truncated:e.truncated||matches>max,baseTruncated:e.truncated,
   fromCache,shared:true,scanPending:!!e.building};
 }
}
export const sharedProjectManifest=new SharedProjectManifest();
