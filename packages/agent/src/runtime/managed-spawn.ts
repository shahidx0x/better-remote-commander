/** Windows native kill-on-close Job runner selection for ordinary subprocesses.
 *
 * When available, the target is NEVER launched through Node spawn directly:
 * a small bundled .NET helper creates it suspended, assigns it to a Job and
 * resumes it. A native failure must NOT rerun that command on a weaker path.
 * The wrapper's pid is the managed PID; its stdout/stderr are target streams.
 *
 * Weaker fallback is disclosed for unsupported shells, IPC child processes,
 * non-Windows systems, disabled mode, or missing native dependencies.
 */
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawn,type ChildProcess,type SpawnOptions} from 'node:child_process';
import {observeManagedChild,markNativeJobOwner} from './process-termination.js';

const runnerPath=fileURLToPath(new URL('../native/winjob/BrcWinJob.dll',import.meta.url));
type Containment='winjob'|'legacy';
const counters={nativeSpawns:0,legacySpawns:0,nativeStartErrors:0,
  peCacheHits:0,peCacheMisses:0,dotnetPathCacheHits:0};
const PE_CACHE_TTL_MS=30_000,PE_CACHE_MAX=64;
const peCache=new Map<string,{fingerprint:string;at:number;valid:boolean}>();
let dotnetCache:{path:string;at:number;resolved:string|undefined}|undefined;
const envPath=(env:NodeJS.ProcessEnv|undefined)=>Object.entries(env??process.env)
  .find(([key])=>key.toLowerCase()==='path')?.[1]??'';
const fallbackReasons=new Map<string,number>();
function countReason(reason:string):void{
 fallbackReasons.set(reason,(fallbackReasons.get(reason)??0)+1);
 if(fallbackReasons.size>16)fallbackReasons.delete(fallbackReasons.keys().next().value!);
}
function executableFromPath(cmd:string,env:NodeJS.ProcessEnv|undefined):string|undefined{
 const exists=(candidate:string)=>{
  try{return fs.statSync(candidate).isFile();}catch{return false;}
 };
 if(path.isAbsolute(cmd))
  return path.extname(cmd).toLowerCase()==='.exe'&&exists(cmd)?cmd:undefined;
 if(cmd.includes('/')||cmd.includes('\\')||cmd.includes('\0'))return;
 const envPath=Object.entries(env??process.env).find(([key])=>key.toLowerCase()==='path')?.[1]??'';
 const candidates=path.extname(cmd)?[cmd]:[cmd+'.exe'];
 for(const folder of envPath.split(path.delimiter)){
  const clean=folder.trim().replace(/^"|"$/g,'');
  if(!clean||!path.isAbsolute(clean))continue;
  for(const name of candidates){
   if(path.extname(name).toLowerCase()!=='.exe')continue;
   const candidate=path.join(clean,name);
   if(exists(candidate))return candidate;
  }
 }
}
/** Reject a fake .exe before wrapping it. Otherwise an invalid optional
 * command (such as rtk) produces a normal wrapper exit code 120 instead of
 * the original Windows spawn error that triggers a safe pre-execution fallback.
 * Only a bounded DOS/PE signature is read; no executable code is loaded.
 */
function isWindowsPe(candidate:string):boolean{
 let st:fs.Stats;
 try{st=fs.statSync(candidate);}catch{return false;}
 const fingerprint=[st.dev,st.ino,st.size,st.ctimeMs,st.mtimeMs].join(':');
 const hit=peCache.get(candidate);
 if(hit&&hit.fingerprint===fingerprint&&Date.now()-hit.at<PE_CACHE_TTL_MS){
  counters.peCacheHits++;return hit.valid;
 }
 counters.peCacheMisses++;
 const valid=inspectWindowsPe(candidate);
 peCache.delete(candidate);
 peCache.set(candidate,{fingerprint,at:Date.now(),valid});
 if(peCache.size>PE_CACHE_MAX)peCache.delete(peCache.keys().next().value!);
 return valid;
}
function inspectWindowsPe(candidate:string):boolean{
 let fd:number|undefined;
 try{
  fd=fs.openSync(candidate,'r');
  const size=fs.fstatSync(fd).size;
  if(size<64)return false;
  const dos=Buffer.allocUnsafe(64);
  if(fs.readSync(fd,dos,0,64,0)!==64||dos[0]!==0x4d||dos[1]!==0x5a)return false;
  const nt=dos.readUInt32LE(0x3c);
  if(nt<64||nt+4>size||nt>1024*1024)return false;
  const magic=Buffer.allocUnsafe(4);
  return fs.readSync(fd,magic,0,4,nt)===4&&magic.equals(Buffer.from([0x50,0x45,0,0]));
 }catch{return false;}finally{if(fd!==undefined)try{fs.closeSync(fd);}catch{}}
}
function availableDotnet(env:NodeJS.ProcessEnv|undefined):string|undefined{
 const currentPath=envPath(env),now=Date.now();
 if(dotnetCache&&dotnetCache.path===currentPath&&now-dotnetCache.at<(dotnetCache.resolved?60_000:3000)&&
   (!dotnetCache.resolved||fs.existsSync(dotnetCache.resolved))){
  counters.dotnetPathCacheHits++;
  return dotnetCache.resolved;
 }
 const resolved=executableFromPath('dotnet',env);
 dotnetCache={path:currentPath,at:now,resolved};
 return resolved;
}
type SpawnClass='ordinary'|'fast-read';
function jobLauncher(program:string,opts:SpawnOptions,spawnClass:SpawnClass='ordinary'):
 {program:string,argsPrefix:string[];error?:string}|{error:string} {
 if(process.platform!=='win32')return {error:'non_windows'};
 if(process.env.BRC_WIN_JOB_OBJECT==='0')return {error:'disabled'};
 // Tiny read-only discovery subprocesses are latency-critical. Native .NET
 // wrapper startup is measurably slower on this host; keep native ownership
 // available with BRC_WIN_JOB_SHORT_READS=1, but use existing bounded
 // cancellation/tree-stop by default for short no-side-effect rg scans.
 if(spawnClass==='fast-read'&&process.env.BRC_WIN_JOB_SHORT_READS!=='1'&&
    process.env.BRC_WIN_JOB_MODE!=='strict')
  return {error:'fast_read_latency'};
 if(!fs.existsSync(runnerPath))return {error:'runner_missing'};
 if(opts.shell)return {error:'shell_mode'};
 if(opts.windowsVerbatimArguments)return {error:'verbatim_argv'};
 if(Array.isArray(opts.stdio)&&opts.stdio.includes('ipc'))return {error:'ipc_stdio'};
 const target=executableFromPath(program,opts.env);
 if(!target)return {error:'non_exe_or_not_found'};
 if(!isWindowsPe(target))return {error:'invalid_windows_exe'};
 const dotnet=availableDotnet(opts.env);
 if(!dotnet)return {error:'dotnet_unavailable'};
 return {program:dotnet,argsPrefix:[runnerPath,'--parent',String(process.pid),'--',target]};
}

/** Spawn a real process with its owner wrapper for Windows Job Object
 * containment where supported. Drop-in replacement for node:child_process
 * spawn; callers still own timeout, cancellation, output capture and errors.
 */
export function spawnManaged(program:string,args:readonly string[],opts:SpawnOptions={},spawnClass:SpawnClass='ordinary'):ChildProcess{
 const selection=jobLauncher(program,opts,spawnClass);
 const native=!('error' in selection);
 // For explicit native-only workflows, never silently launch an unconfined
 // process on a failing/unsupported path. Ordinary compatibility mode retains
 // its existing best-effort fallback and reports the reason.
 if(!native && process.env.BRC_WIN_JOB_MODE==='strict')
   throw new Error('WIN_JOB_REQUIRED: refused to start without native Job containment ('+
     (selection.error??'unknown')+'). No program executed.');
 let child:ChildProcess;
 if(native){
  // Explicit applicationName and argv are passed unchanged to the native
  // launcher; it refuses to run the target if Job setup fails. No retry.
  counters.nativeSpawns++;
  child=spawn(selection.program,[...selection.argsPrefix,...args],{
   ...opts,shell:false,windowsVerbatimArguments:false
  });
  markNativeJobOwner(child);
  child.once('error',()=>{counters.nativeStartErrors++;});
 }else{
  counters.legacySpawns++;
  countReason(selection.error??'unknown');
  child=spawn(program,args as string[],opts);
  observeManagedChild(child);
 }
 return child;
}
export function managedSpawnStatus(){
 return {defaultEnabled:process.platform==='win32'&&process.env.BRC_WIN_JOB_OBJECT!=='0',
  strictMode:process.env.BRC_WIN_JOB_MODE==='strict',
  bundledRunnerPresent:fs.existsSync(runnerPath),
  nativeForShortReadScans:process.env.BRC_WIN_JOB_SHORT_READS==='1',
  nativeAvailable:process.platform==='win32'&&
    process.env.BRC_WIN_JOB_OBJECT!=='0'&&fs.existsSync(runnerPath)&&!!availableDotnet(process.env),
  ...counters,peCacheEntries:peCache.size,legacyReasons:Object.fromEntries(fallbackReasons),
  noAutomaticReplay:true,restrictedTokenSandbox:false,
  note:'Native for executable .exe without IPC/verbatim arguments. Short read-only scans stay on the lower-latency legacy path by default (BRC_WIN_JOB_SHORT_READS=1 opts in). This is not ACL/restricted-token isolation.'};
}
/** External stdio transports (the MCP SDK) create their own ChildProcess.
 * Return native wrapper launch arguments without spawning or re-executing a
 * target. The SDK still owns the stdio pipes and BRC observes its handle.
 */
export function managedLaunchSpec(program:string,args:readonly string[],opts:SpawnOptions={}):
 {command:string,args:string[],nativeJob:boolean,reason?:string}{
 const selection=jobLauncher(program,opts);
 if(!('program' in selection)){
  if(process.env.BRC_WIN_JOB_MODE==='strict')
    throw new Error('WIN_JOB_REQUIRED: refused local plugin start without native Job containment ('+
      selection.error+'). No plugin executed.');
  countReason('sdk_'+selection.error);
  return {command:program,args:[...args],nativeJob:false,reason:selection.error};
 }
 counters.nativeSpawns++;
 return {command:selection.program,args:[...selection.argsPrefix,...args],nativeJob:true};
}
