/** Lazy TypeScript language-service subprocess.
 * Enabled by default, but consumes NO child RAM before the first semantic
 * query; one worker at a time; bounded V8 heap and request timeout.
 * The Node heap cap is NOT an OS-level total RSS limit.
 */
import {fork,type ChildProcess} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {AgentError} from './errors.js';
import {rootPath,projectPath,slash} from './workspace.js';
import {pluginEnvironment} from '../plugins/plugin-environment.js';
import {getCallContext,checkCancelled} from '../context.js';
import {readBounded,sha256} from './file-safety.js';
import {pluginStartupAdmission} from './resource-admission.js';
import {enabledByDefault} from './feature-defaults.js';
import {observeManagedChild,stopManagedChild} from './process-termination.js';

export interface SemanticResult {
 file:string;symbol:string;
 references:Array<{file:string;line:number;column:number;endLine:number;endColumn:number;isDefinition:boolean}>;
 definitions:Array<{file:string;line:number;column:number;endLine:number;endColumn:number;isDefinition:boolean}>;
 totalReferences:number;truncated:boolean;sourceFilesLoaded:number;projectFilesTruncated:boolean;
 semantics:string;modelCalls:0;execution:false;
 sourceSha256?:string;
}
const MAX_HEAP_MIB=160, IDLE_MS=60_000, TIMEOUT_MS=10_000,MAX_RESULTS=200;
const MAX_MESSAGE_CHARS=80_000;
const TYPE_SCRIPT=/\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/i;
const WORKER=fileURLToPath(new URL('./semantic-ts-worker.js',import.meta.url));
export const semanticEnabled=()=>enabledByDefault('BRC_TS_SEMANTIC');

interface Pending {
 id:number;resolve:(out:SemanticResult)=>void;reject:(error:Error)=>void;
 timer:NodeJS.Timeout;abort?:()=>void;signal?:AbortSignal;
}
export class SemanticTSManager {
 private proc?:ChildProcess;
 private root?:string;
 private pending?:Pending;
 private reserving=false;
 private idle?:NodeJS.Timeout;
 private requestId=0;
 private spawned=0;
 private released=0;
 private failures=0;
 private lastUsed=0;
 status(){
  return {enabled:semanticEnabled(),activeProcess:!!this.proc,
   busy:this.reserving||!!this.pending,spawned:this.spawned,released:this.released,failures:this.failures,
   maxWorkers:1,heapLimitMiB:MAX_HEAP_MIB,
   idleTimeoutMs:IDLE_MS,requestTimeoutMs:TIMEOUT_MS,
   modelCalls:0,automaticExecution:false,
   note:'TypeScript compiler language-service in a separate Node worker. Heap cap is not an OS total RSS cap; outputs are bounded saved-file references only.'};
 }
 private rejectPending(error:Error){
  const p=this.pending;
  if(!p)return;
  this.pending=undefined;
  clearTimeout(p.timer);
  if(p.abort&&p.signal)p.signal.removeEventListener('abort',p.abort);
  p.reject(error);
 }
 private stopped(reason:string){
  const child=this.proc;
  this.proc=undefined;this.root=undefined;
  clearTimeout(this.idle);this.idle=undefined;
  if(child){
   child.removeAllListeners('message');
   child.removeAllListeners('exit');
   // Keep the managed-owner error observer. The existing worker error handler
   // becomes a no-op once this.proc is cleared, preventing an unhandled error.
   stopManagedChild(child);
   this.released++;
  }
  this.rejectPending(new AgentError('SEMANTIC_WORKER_EXITED',reason));
 }
 close(){this.stopped('Semantic worker closed; re-request if still needed.');}
 releaseIdle(now=Date.now()):number{
  if(!this.proc||this.reserving||this.pending||now-this.lastUsed<IDLE_MS)return 0;
  this.stopped('Semantic worker released after inactivity.');
  return 1;
 }
 private launch(root:string){
  if(this.proc&&this.root===root)return;
  if(this.proc)this.stopped('Switching semantic project.');
  const proc=fork(WORKER,[],{
   cwd:root,
   execArgv:['--max-old-space-size='+MAX_HEAP_MIB],
   env:pluginEnvironment(process.env),
   stdio:['ignore','ignore','ignore','ipc']
  });
  observeManagedChild(proc);
  this.proc=proc;this.root=root;this.lastUsed=Date.now();this.spawned++;
  proc.on('message',(raw:unknown)=>{
   const p=this.pending;
   if(!p||!raw||typeof raw!=='object')return;
   const message=raw as {id?:number;ok?:boolean;data?:SemanticResult;error?:string};
   if(message.id!==p.id)return;
   this.pending=undefined;
   clearTimeout(p.timer);
   if(p.abort&&p.signal)p.signal.removeEventListener('abort',p.abort);
   this.lastUsed=Date.now();
   if(message.ok!==true||!message.data){
    this.failures++;
    p.reject(new AgentError('SEMANTIC_QUERY_FAILED',
      String(message.error??'TypeScript language-service query failed.').slice(0,250)));
   }else p.resolve(message.data);
   this.armIdle();
  });
  proc.on('error',()=>{
   if(this.proc===proc){this.failures++;this.stopped('TypeScript worker failed to start.');}
  });
  proc.on('exit',()=>{
   if(this.proc===proc){this.failures++;this.stopped('TypeScript language service exited during a query.');}
  });
 }
 private armIdle(){
  clearTimeout(this.idle);
  if(!this.proc||this.pending)return;
  this.idle=setTimeout(()=>this.releaseIdle(),IDLE_MS);
  this.idle.unref();
 }
 async query(rawRoot:string,rawFile:string,symbol:string,line:number,column:number,maxResults=50):Promise<SemanticResult>{
  // Reserve admission synchronously, before any asynchronous validation or
  // file reads. Two concurrent calls must never overwrite one IPC request.
  if(this.reserving||this.pending)
    throw new AgentError('SEMANTIC_BUSY','A TypeScript semantic query is already active.',true);
  this.reserving=true;
  try{return await this.queryLocked(rawRoot,rawFile,symbol,line,column,maxResults);}
  finally{this.reserving=false;}
 }
 private async queryLocked(rawRoot:string,rawFile:string,symbol:string,line:number,column:number,maxResults:number):Promise<SemanticResult>{
  if(!semanticEnabled())throw new AgentError('SEMANTIC_DISABLED',
   'TypeScript semantic navigation is disabled. Set BRC_TS_SEMANTIC=1 for the next local agent start, or use ordinary lexical find_references.');
  if(!Number.isInteger(line)||line<1||!Number.isInteger(column)||column<1||column>100000||
     !Number.isInteger(maxResults)||maxResults<1||maxResults>MAX_RESULTS)
   throw new AgentError('SEMANTIC_ARGUMENTS','Provide 1-based line/column and maxResults 1-200.');
  checkCancelled();
  const root=await rootPath(rawRoot),file=await projectPath(root,rawFile);
  if(!TYPE_SCRIPT.test(file))
   throw new AgentError('SEMANTIC_LANGUAGE_UNSUPPORTED','Semantic mode currently supports saved TS/JS/TSX/JSX/MTS/CTS files only.');
  if(this.pending)throw new AgentError('SEMANTIC_BUSY','One semantic query is already active. Retry after it settles.',true);
  const before=sha256(await readBounded(file,1024*1024));
  const signal=getCallContext()?.signal;
  if(!this.proc||this.root!==root){
   const releaseStartup=await pluginStartupAdmission.acquire(signal,10000);
   try{
    checkCancelled();
    this.launch(root);
   }finally{releaseStartup();}
  }else this.launch(root);
  const id=++this.requestId;
  const reply=await new Promise<SemanticResult>((resolve,reject)=>{
   const timer=setTimeout(()=>{
    this.failures++;
    this.stopped('TypeScript semantic request timed out after 10 seconds.');
   },TIMEOUT_MS);
   const abort=()=>this.stopped('Semantic request cancelled by caller.');
   this.pending={id,resolve,reject,timer,signal,abort};
   if(signal?.aborted){abort();return;}
   signal?.addEventListener('abort',abort,{once:true});
   try{
    this.proc?.send({id,root,file,line,column,symbol,maxResults},error=>{
     if(error&&this.pending?.id===id){this.failures++;this.stopped('Semantic request delivery failed.');}
    });
   }catch{this.failures++;this.stopped('Could not send semantic request to worker.');}
  });
  checkCancelled();
  const after=sha256(await readBounded(file,1024*1024));
  if(before!==after)throw new AgentError('FILE_CHANGED','Source file changed during semantic navigation. Re-read before using references.');
  if(JSON.stringify(reply).length>MAX_MESSAGE_CHARS)
   throw new AgentError('SEMANTIC_OUTPUT_TOO_LARGE','Semantic output exceeded its fixed result budget.');
  // Revalidate each returned path against CURRENT permissions and project
  // boundaries. The child may resolve compiler libraries/dependencies outside
  // this project; those locations are intentionally not exposed.
  for(const ref of [...reply.references,...reply.definitions]){
   const canonical=await projectPath(root,ref.file);
   if(slash(path.relative(root,canonical))!==slash(ref.file))
    throw new AgentError('SEMANTIC_PATH_CHANGED','Semantic result path changed. Re-query the project.');
  }
  return {...reply,sourceSha256:after};
 }
}
export const semanticTsManager=new SemanticTSManager();
