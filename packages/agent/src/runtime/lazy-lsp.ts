/**
 * On-demand, bounded LSP transport for C# (.cs), Rust (.rs) and Python (.py).
 * This is a READ-ONLY LSP client. It does not install servers or execute
 * project commands; language-server processes themselves are trusted tools.
 * One active language server at a time, zero LSP child RAM until first query.
 */
import path from 'node:path';
import fs from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {type ChildProcess} from 'node:child_process';
import {spawnManaged} from './managed-spawn.js';
import {stopManagedChild,observeManagedChild} from './process-termination.js';
import {findOnPath} from '../tools/fast-exec.js';
import {rootPath,projectPath} from './workspace.js';
import {readBounded,decodeCode,sha256} from './file-safety.js';
import {commandEnvironment} from './command-environment.js';
import {getCallContext,checkCancelled} from '../context.js';
import {AgentError} from './errors.js';

type Language='csharp'|'rust'|'python';
type Action='definition'|'references'|'hover'|'document_symbols'|'implementation';
type Launcher=(language:Language)=>{command:string;args:string[]}|null;
interface Waiter{
 resolve:(result:unknown)=>void;reject:(error:Error)=>void;
 timer:NodeJS.Timeout;abort?:()=>void;signal?:AbortSignal;
}
const LANGUAGE_SPECS={
 csharp:{ext:'.cs',bin:'csharp-ls',languageId:'csharp'},
 rust:{ext:'.rs',bin:'rust-analyzer',languageId:'rust'},
 python:{ext:'.py',bin:'pylsp',languageId:'python'}
} as const;
const FRAME_MAX=1024*1024,RESULT_MAX=36_000,SOURCE_MAX=1024*1024;
const IDLE_MS=90_000,INIT_MS=25_000,REQUEST_MS=15_000;
const CLIENT_NAME='brc-readonly-lsp';
const extLanguage=(file:string):Language|null=>{
 const ext=path.extname(file).toLowerCase();
 return (Object.keys(LANGUAGE_SPECS) as Language[]).find(l=>LANGUAGE_SPECS[l].ext===ext)??null;
};
const defaultLauncher:Launcher=(lang)=>{
 const spec=LANGUAGE_SPECS[lang];
 const p=findOnPath(spec.bin,process.env.PATH??process.env.Path,
  process.platform==='win32'?['.exe']:['']);
 // We only launch concrete native executables, never shell scripts, commands
 // supplied by the model, or arbitrary project-local toolchains.
 return p?{command:p,args:[]}:null;
};
const err=(code:string,message:string)=>new AgentError(code,message);
export class LazyLanguageServer {
 private proc?:ChildProcess;
 private root?:string;
 private language?:Language;
 private buffer=Buffer.alloc(0);
 private nextId=0;
 private readonly pending=new Map<number,Waiter>();
 private startup?:Promise<void>;
 private busy=false;
 private opened=new Map<string,{version:number;hash:string}>();
 private idle?:NodeJS.Timeout;
 private lastUsed=0;
 private stats={launched:0,closed:0,failed:0,completedQueries:0};
 constructor(private readonly launcher:Launcher=defaultLauncher){}
 status(){
  return {active:!!this.proc,language:this.language??null,root:this.root??null,
   busy:this.busy,available:Object.fromEntries((Object.keys(LANGUAGE_SPECS) as Language[])
    .map(lang=>[lang,!!this.launcher(lang)])),
   idleTimeoutMs:IDLE_MS,initTimeoutMs:INIT_MS,queryTimeoutMs:REQUEST_MS,
   maxOpenSourceBytes:SOURCE_MAX,maxResultChars:RESULT_MAX,maxProcesses:1,
   autoInstall:false,automaticExecution:false,modelCalls:0,...this.stats,
   note:'Read-only client. Each actual language server is a local third-party process that may load project code; no server starts before a semantic query.'};
 }
 private send(message:Record<string,unknown>){
  const stdin=this.proc?.stdin;
  if(!stdin?.writable)throw err('LSP_DISCONNECTED','Language server is not connected.');
  const data=Buffer.from(JSON.stringify(message),'utf8');
  if(data.length>FRAME_MAX)throw err('LSP_MESSAGE_TOO_LARGE','Message exceeds bounded LSP transport limit.');
  stdin.write('Content-Length: '+data.length+'\r\n\r\n','ascii');
  stdin.write(data);
 }
 private respond(id:number|string,result:unknown){
  try{this.send({jsonrpc:'2.0',id,result});}catch{/* server is exiting */}
 }
 private onMessage(message:unknown){
  if(!message||typeof message!=='object')return;
  const msg=message as Record<string,unknown>;
  if(typeof msg.id==='number'){
   const pending=this.pending.get(msg.id);
   if(pending){
    this.pending.delete(msg.id);clearTimeout(pending.timer);
    if(pending.abort&&pending.signal)pending.signal.removeEventListener('abort',pending.abort);
    if(msg.error){
     pending.reject(err('LSP_SERVER_ERROR',JSON.stringify(msg.error).slice(0,450)));
    }else pending.resolve(msg.result);
    return;
   }
  }
  if((typeof msg.id==='number'||typeof msg.id==='string')&&typeof msg.method==='string'){
   if(msg.method==='workspace/configuration')this.respond(msg.id,[]);
   else if(msg.method==='workspace/workspaceFolders')
    this.respond(msg.id,this.root?[{uri:pathToFileURL(this.root).href,name:path.basename(this.root)}]:[]);
   else this.respond(msg.id,null);
  }
 }
 private onData(chunk:Buffer){
  if(chunk.length>FRAME_MAX+200){this.close();return;}
  this.buffer=Buffer.concat([this.buffer,chunk],this.buffer.length+chunk.length);
  if(this.buffer.length>FRAME_MAX+16_384){this.close();return;}
  while(this.buffer.length){
   const marker=this.buffer.indexOf('\r\n\r\n');
   if(marker<0){if(this.buffer.length>8192)this.close();return;}
   if(marker>8192){this.close();return;}
   const header=this.buffer.subarray(0,marker).toString('ascii');
   const match=/(?:^|\r\n)Content-Length:\s*(\d+)\s*(?:\r\n|$)/i.exec(header);
   if(!match){this.close();return;}
   const size=Number(match[1]),start=marker+4;
   if(!Number.isSafeInteger(size)||size<0||size>FRAME_MAX){this.close();return;}
   if(this.buffer.length<start+size)return;
   const body=this.buffer.subarray(start,start+size);
   this.buffer=this.buffer.subarray(start+size);
   try{this.onMessage(JSON.parse(body.toString('utf8')));}catch{/* malformed upstream message */}
  }
 }
 private request(method:string,params:Record<string,unknown>,timeoutMs:number,signal?:AbortSignal):Promise<unknown>{
  const id=++this.nextId;
  return new Promise((resolve,reject)=>{
   if(signal?.aborted){reject(err('LSP_CANCELLED','Request cancelled before dispatch.'));return;}
   const timer=setTimeout(()=>{
    this.pending.delete(id);signal?.removeEventListener('abort',abort);
    try{this.send({jsonrpc:'2.0',method:'$/cancelRequest',params:{id}});}catch{}
    reject(err('LSP_TIMEOUT',method+' exceeded '+timeoutMs+' ms.'));this.stats.failed++;
   },timeoutMs);
   const abort=()=>{
    this.pending.delete(id);clearTimeout(timer);signal?.removeEventListener('abort',abort);
    try{this.send({jsonrpc:'2.0',method:'$/cancelRequest',params:{id}});}catch{}
    reject(err('LSP_CANCELLED','Language-server request cancelled.'));
   };
   this.pending.set(id,{resolve,reject,timer,abort,signal});
   signal?.addEventListener('abort',abort,{once:true});
   try{this.send({jsonrpc:'2.0',id,method,params});}
   catch(e){this.pending.delete(id);clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(e);}
  });
 }
 close():void{
  clearTimeout(this.idle);this.idle=undefined;
  const child=this.proc;this.proc=undefined;this.root=undefined;this.language=undefined;
  this.startup=undefined;this.opened.clear();this.buffer=Buffer.alloc(0);
  for(const [id,p] of this.pending){
   clearTimeout(p.timer);
   if(p.abort&&p.signal)p.signal.removeEventListener('abort',p.abort);
   p.reject(err('LSP_DISCONNECTED','Language-server process stopped.'));
  }
  this.pending.clear();
  if(child){stopManagedChild(child);this.stats.closed++;}
 }
 private async start(root:string,language:Language,signal?:AbortSignal){
  if(this.proc&&this.root===root&&this.language===language&&this.startup){
   await this.startup;return;
  }
  if(this.proc)this.close();
  const selected=this.launcher(language);
  if(!selected)throw err('LSP_SERVER_NOT_INSTALLED',
   'No '+LANGUAGE_SPECS[language].bin+' language-server executable is installed on the agent PATH. Install it explicitly if semantic navigation is needed; lexical code search remains available.');
  const proc=spawnManaged(selected.command,selected.args,{
   cwd:root,env:commandEnvironment(process.env),windowsHide:true,
   stdio:['pipe','pipe','pipe']});
  observeManagedChild(proc);
  this.proc=proc;this.root=root;this.language=language;this.stats.launched++;
  this.lastUsed=Date.now();
  proc.stdout?.on('data',(chunk:Buffer)=>this.onData(chunk));
  // Consume diagnostic output without persisting project contents.
  proc.stderr?.on('data',()=>{});
  proc.on('error',()=>{if(this.proc===proc){this.stats.failed++;this.close();}});
  proc.on('exit',()=>{if(this.proc===proc){this.stats.failed++;this.close();}});
  this.startup=this.request('initialize',{
   processId:process.pid,
   rootUri:pathToFileURL(root).href,
   workspaceFolders:[{uri:pathToFileURL(root).href,name:path.basename(root)}],
   clientInfo:{name:CLIENT_NAME,version:'1'},
   capabilities:{textDocument:{definition:{},references:{},hover:{},
    documentSymbol:{},implementation:{}}},
   initializationOptions:{}
  },INIT_MS,signal).then(()=>{
   this.send({jsonrpc:'2.0',method:'initialized',params:{}});
  }).catch(e=>{this.close();throw e;});
  await this.startup;
 }
 private armIdle(){
  clearTimeout(this.idle);
  if(!this.proc||this.busy||this.pending.size)return;
  this.idle=setTimeout(()=>{if(!this.busy&&Date.now()-this.lastUsed>=IDLE_MS)this.close();},IDLE_MS);
  this.idle.unref();
 }
 async query(raw:{path:string;file:string;action:Action;line?:number;column?:number;maxResults?:number}):
 Promise<Record<string,unknown>>{
  if(this.busy)throw err('LSP_BUSY','Another language-server query is active. Retry after it finishes.');
  this.busy=true;
  try{
   checkCancelled();
   const root=await rootPath(raw.path);
   const file=await projectPath(root,raw.file);
   const lang=extLanguage(file);
   if(!lang)throw err('LSP_LANGUAGE_UNSUPPORTED','Supported semantic files: .cs, .rs, .py; TypeScript uses BRC built-in semantic worker.');
   if(raw.action!=='document_symbols'&&(!Number.isInteger(raw.line)||!Number.isInteger(raw.column)||
     (raw.line??0)<1||(raw.column??0)<1))
    throw err('LSP_POSITION_REQUIRED','Provide a valid 1-based line and column.');
   const bytes=await readBounded(file,SOURCE_MAX);
   const sourceHash=sha256(bytes),source=decodeCode(bytes),uri=pathToFileURL(file).href;
   const signal=getCallContext()?.signal;
   await this.start(root,lang,signal);
   const previous=this.opened.get(uri);
   if(!previous){
    this.send({jsonrpc:'2.0',method:'textDocument/didOpen',
     params:{textDocument:{uri,languageId:LANGUAGE_SPECS[lang].languageId,version:1,text:source}}});
    this.opened.set(uri,{hash:sourceHash,version:1});
   }else if(previous.hash!==sourceHash){
    this.send({jsonrpc:'2.0',method:'textDocument/didChange',
     params:{textDocument:{uri,version:previous.version+1},contentChanges:[{text:source}]}});
    this.opened.set(uri,{hash:sourceHash,version:previous.version+1});
   }
   const method=raw.action==='document_symbols'?'textDocument/documentSymbol':
    raw.action==='definition'?'textDocument/definition':
    raw.action==='references'?'textDocument/references':
    raw.action==='implementation'?'textDocument/implementation':'textDocument/hover';
   const params:Record<string,unknown>={textDocument:{uri}};
   if(raw.action!=='document_symbols')params.position={line:(raw.line??1)-1,character:(raw.column??1)-1};
   if(raw.action==='references')params.context={includeDeclaration:true};
   const response=await this.request(method,params,REQUEST_MS,signal);
   const arrayCap=Math.max(1,Math.min(raw.maxResults??50,100));
   const candidate=Array.isArray(response)?response.slice(0,arrayCap):response;
   const limited=Array.isArray(response)&&response.length>arrayCap;
   let representation='';
   try{representation=JSON.stringify(candidate??null);}catch{representation='null';}
   const partial=representation.length>RESULT_MAX;
   this.stats.completedQueries++;this.lastUsed=Date.now();
   return {language:lang,provider:LANGUAGE_SPECS[lang].bin,root,file,
    sourceSha256:sourceHash,action:raw.action,
    data:JSON.parse(partial?JSON.stringify({summary:representation.slice(0,RESULT_MAX),truncated:true}):representation),
    truncated:partial||limited,projectMayChange: true,execution:false,modelCalls:0,
    note:'Saved-file LSP result from a trusted local language-server process; inspect definitions before editing. No fixes or commands are automatically applied.'};
  }finally{
   this.busy=false;this.lastUsed=Date.now();this.armIdle();
  }
 }
}
export const lazyLanguageServer=new LazyLanguageServer();
