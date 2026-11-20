/**
 * Desktop Commander-style tool history: last 1,000 records, a <=4 KiB
 * sanitized output preview, and one <=5 MiB local JSONL history file.
 *
 * No duplicate full history ring lives in RAM. We stream the disk file on
 * demand; only a small bounded write queue lives alongside ActivityLog.
 * Raw arguments, file contents, binary output and Code Mode source are NEVER
 * persisted. This log intentionally does not promise complete crash recovery.
 */
import fs from 'node:fs/promises';
import {createReadStream,createWriteStream} from 'node:fs';
import {createInterface} from 'node:readline';
import {pipeline} from 'node:stream/promises';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {activity,activityAction,MAX_HISTORY_WRITER_QUEUE_BYTES} from '../../runtime/activity.js';
import {traceToolResult,redactTrace} from '../../runtime/tool-trace.js';
import type {ServerResult} from '../types.js';

export const MAX_HISTORY_ENTRIES=1000;
export const MAX_STORED_OUTPUT_BYTES=4*1024;
export const MAX_HISTORY_FILE_SIZE_BYTES=5*1024*1024;
export const HISTORY_TRIM_TARGET_BYTES=4*1024*1024;
const TRIM_ENTRIES=850; // avoids rewriting on every call after entry 1,000
const MAX_PENDING_BYTES=MAX_HISTORY_WRITER_QUEUE_BYTES;
const MAX_LINE_BYTES=MAX_STORED_OUTPUT_BYTES+2048;
// Source reads, search results, plugin payloads and job-output aggregation
// may contain arbitrary user/private data; omit those payloads by default.
const PREVIEW_TOOLS=new Set(['run_command','start_process','read_process_output',
  'interact_with_process','verify_project','run_project_checks','git_status','git_log']);

export interface ToolCallRecord {
  timestamp:string;
  toolName:string;
  arguments:unknown;
  output:ServerResult;
  duration?:number;
  details?:{phase:string;callId?:string;action?:string;errorCode?:string;note?:string};
}
export interface HistoryOptions {
  maxResults?:number;
  toolName?:string;
  since?:string;
  offset?:number; // newest-first paging; returned rows are chronological
}
type EnqueueRecord={line:string;bytes:number};
type LineOffset={offset:number;bytes:number};
const safeName=(v:string)=>v.replace(/[^a-zA-Z0-9_-]/g,'_').slice(0,80);
function utf8Slice(text:string,maxBytes:number):string{
  const b=Buffer.from(text,'utf8');
  if(b.byteLength<=maxBytes)return text;
  const marker='\n[history preview clipped to 4 KiB]';
  const limit=Math.max(0,maxBytes-Buffer.byteLength(marker,'utf8'));
  let s=b.subarray(0,limit).toString('utf8');
  while(Buffer.byteLength(s,'utf8')>limit)s=s.slice(0,-1);
  return s+marker;
}
function safeRecord(tool:string,args:unknown,result:ServerResult,duration:number,
  details?:ToolCallRecord['details']):ToolCallRecord{
  const name=safeName(tool);
  const summary=activityAction(name,args&&typeof args==='object'&&!Array.isArray(args)?
    args as Record<string,unknown>:undefined);
  // traceToolResult has a strict source/file-body suppression policy. Cap the
  // full preview by UTF-8 bytes, not JS characters, before writing to disk.
  const meta=result.structuredContent as Record<string,unknown>|undefined;
  const error=meta?.error as {code?:unknown}|undefined;
  const safeCode=typeof error?.code==='string'?safeName(error.code):undefined;
  const source=PREVIEW_TOOLS.has(name)?traceToolResult(name,result):
    'Result: '+(result.isError?'FAILED':'OK')+(safeCode?' | '+safeCode:'')+
      '\nOutput payload omitted from persistent history (source/plugin data may be private).';
  const preview=utf8Slice(redactTrace(source,6_000),MAX_STORED_OUTPUT_BYTES);
  return {
    timestamp:new Date().toISOString(),toolName:name,
    arguments:{summary},duration:Math.max(0,Math.round(duration)),
    output:{isError:result.isError===true,content:[{type:'text',text:preview}]},
    details:{phase:details?.phase??(result.isError?'ERROR':'OK'),
      callId:details?.callId?.replace(/[^a-zA-Z0-9_-]/g,'').slice(0,16),
      action:summary,
      errorCode:typeof details?.errorCode==='string'?safeName(details.errorCode):undefined,
      note:typeof details?.note==='string'?redactTrace(details.note,180):undefined},
  };
}
/** Count byte offsets, not content; max 1,000 offsets kept in memory. */
async function scanOffsets(file:string):Promise<{lines:LineOffset[];count:number;fileBytes:number}>{
  const offsets:LineOffset[]=[];
  let seen=0,bytes=0,start=0;
  const stream=createReadStream(file,{highWaterMark:32*1024});
  for await(const chunk of stream){
    const data=chunk as Buffer;
    for(let i=0;i<data.length;i++){
      if(data[i]!==10)continue;
      const end=bytes+i+1,length=end-start;
      if(length>1&&length<=MAX_LINE_BYTES){
        offsets.push({offset:start,bytes:length});seen++;
        if(offsets.length>MAX_HISTORY_ENTRIES)offsets.shift();
      }
      start=end;
    }
    bytes+=data.length;
  }
  return {lines:offsets,count:seen,fileBytes:bytes};
}
export class ToolHistory {
  private readonly file:string;
  private enabled=false;
  private queue:EnqueueRecord[]=[];
  private queuedBytes=0;
  private inFlightBytes=0;
  private writer:Promise<void>|null=null;
  private fileBytes=0;
  private totalEntries=0;
  dropped=0;
  ioErrors=0;

  constructor(home=process.env.BRC_HOME??path.join(os.homedir(),'.brc')){
    this.file=path.join(home,'logs','tool-history.jsonl');
  }
  get path(){return this.file;}
  /** Explicit startup: importing dispatcher during tests never writes to user home. */
  async start():Promise<void>{
    if(this.enabled||process.env.BRC_TOOL_HISTORY==='0')return;
    const dir=path.dirname(this.file);
    await fs.mkdir(dir,{recursive:true,mode:0o700});
    const folder=await fs.lstat(dir);
    if(!folder.isDirectory()||folder.isSymbolicLink())
      throw new Error('Tool history directory must be a regular directory.');
    const existing=await fs.lstat(this.file).catch((error:NodeJS.ErrnoException)=>{
      if(error.code==='ENOENT')return null;
      throw error;
    });
    if(existing&&(!existing.isFile()||existing.isSymbolicLink()))
      throw new Error('Tool history path must be a regular file (symlinks are refused).');
    if(existing&&existing.size>64*1024*1024)
      throw new Error('Tool history file is unexpectedly oversized; refusing to load it.');
    if(!existing)await fs.writeFile(this.file,'',{flag:'wx',mode:0o600});
    await fs.chmod(this.file,0o600).catch(()=>{});
    const stats=await scanOffsets(this.file);
    this.totalEntries=stats.count;
    this.fileBytes=stats.fileBytes;
    // A pre-existing history may have the old retention policy.
    if(this.fileBytes>MAX_HISTORY_FILE_SIZE_BYTES||this.totalEntries>MAX_HISTORY_ENTRIES)
      await this.compact([]);
    this.enabled=true;
  }
  /** Always nonblocking for tool execution. Any full queue drops oldest logs,
   * never the result of the actual tool call.
   */
  addCall(tool:string,args:unknown,result:ServerResult,duration?:number,
    details?:ToolCallRecord['details']):void{
    if(!this.enabled)return;
    try{
      const entry=safeRecord(tool,args,result,duration??0,details);
      const line=JSON.stringify(entry)+'\n',bytes=Buffer.byteLength(line,'utf8');
      if(bytes>MAX_LINE_BYTES){this.dropped++;return;}
      while(this.queuedBytes+this.inFlightBytes+bytes>MAX_PENDING_BYTES&&this.queue.length){
        this.queuedBytes-=this.queue.shift()!.bytes;
        this.dropped++;
      }
      if(this.queuedBytes+this.inFlightBytes+bytes>MAX_PENDING_BYTES){this.dropped++;return;}
      this.queue.push({line,bytes});
      this.queuedBytes+=bytes;
      if(!this.writer)queueMicrotask(()=>{if(!this.writer)void this.drain();});
    }catch{this.ioErrors++;}
  }
  private async drain():Promise<void>{
    if(this.writer)return this.writer;
    this.writer=(async()=>{
      while(this.queue.length){
        const batch=this.queue.splice(0);
        this.queuedBytes=0;
        this.inFlightBytes=batch.reduce((n,x)=>n+x.bytes,0);
        try{
          const bytes=this.inFlightBytes;
          if(this.fileBytes+bytes>MAX_HISTORY_FILE_SIZE_BYTES||
             this.totalEntries+batch.length>MAX_HISTORY_ENTRIES){
            await this.compact(batch);
          }else{
            const current=await fs.lstat(this.file);
            if(!current.isFile()||current.isSymbolicLink())
              throw new Error('Tool history destination became unsafe.');
            await fs.appendFile(this.file,batch.map(x=>x.line).join(''),'utf8');
            this.fileBytes+=bytes;
            this.totalEntries+=batch.length;
          }
        }catch{this.ioErrors++;this.dropped+=batch.length;}
        finally{this.inFlightBytes=0;}
      }
    })();
    try{await this.writer;}finally{this.writer=null;}
    if(this.queue.length)void this.drain();
  }
  /** Rewrite only a recent suffix using streaming IO and one small offset
   * index. Atomic publication avoids half-written replacement histories.
   */
  private async compact(batch:EnqueueRecord[]):Promise<void>{
    const old=await fs.lstat(this.file);
    if(!old.isFile()||old.isSymbolicLink())
      throw new Error('Unsafe tool history destination.');
    const scanned=await scanOffsets(this.file);
    const entries:(LineOffset|EnqueueRecord)[]=[...scanned.lines,...batch];
    let retained=0,total=0;
    for(let i=entries.length-1;i>=0&&retained<TRIM_ENTRIES;i--){
      const bytes=entries[i].bytes;
      if(retained>0&&total+bytes>HISTORY_TRIM_TARGET_BYTES)break;
      total+=bytes;retained++;
    }
    const chosen=entries.slice(entries.length-retained);
    const keepFrom=chosen.find((v):v is LineOffset=>'offset' in v);
    const additions=chosen.filter((v):v is EnqueueRecord=>'line' in v);
    const temp=this.file+'.'+process.pid+'.'+randomUUID()+'.tmp';
    try{
      if(keepFrom&&scanned.fileBytes>keepFrom.offset){
        await pipeline(createReadStream(this.file,{start:keepFrom.offset,end:scanned.fileBytes-1}),
          createWriteStream(temp,{flags:'wx',mode:0o600}));
      }else await fs.writeFile(temp,'',{flag:'wx',mode:0o600});
      if(additions.length)
        await fs.appendFile(temp,additions.map(v=>v.line).join(''),'utf8');
      await fs.chmod(temp,0o600).catch(()=>{});
      await fs.rename(temp,this.file);
      this.fileBytes=total;
      this.totalEntries=retained;
    }finally{await fs.unlink(temp).catch(()=>{});}
  }
  async flush():Promise<void>{
    while(this.writer||this.queue.length){
      if(this.writer)await this.writer;
      else await this.drain();
    }
  }
  /** Disk-streaming retrieval: 1000 records may use transient memory for a
   * single query, but their 4KiB previews never sit in an idle RAM cache.
   */
  async getRecentCalls(options:HistoryOptions={}):Promise<ToolCallRecord[]>{
    if(!this.enabled){
      // In library/test mode, preserve useful live-only history without writes.
      return activity.recent().filter(e=>e.tool&&e.phase&&e.phase!=='START'&&
        (!options.toolName||e.tool===options.toolName)&&
        (!options.since||Date.parse(e.timestamp)>=Date.parse(options.since)))
        .slice(-Math.min(1000,Math.max(1,(options.maxResults??50)+(options.offset??0))))
        .slice(0,(options.offset??0)>0?-(options.offset??0):undefined)
        .map(e=>({timestamp:e.timestamp,toolName:e.tool!,arguments:{},duration:e.ms,
          details:{phase:e.phase!,callId:e.id?.slice(0,16),action:e.action,
            errorCode:e.code,note:e.note},
          output:{isError:e.phase==='ERROR',content:[{type:'text',text:e.code??e.phase!}]}}));
    }
    await this.flush();
    const max=Math.max(1,Math.min(1000,Math.floor(options.maxResults??50)));
    const skip=Math.max(0,Math.min(1000,Math.floor(options.offset??0)));
    const ring:ToolCallRecord[]=[];
    const reader=createInterface({input:createReadStream(this.file,{highWaterMark:16*1024}),
      crlfDelay:Infinity});
    for await(const line of reader){
      if(!line||Buffer.byteLength(line,'utf8')>MAX_LINE_BYTES)continue;
      try{
        const record=JSON.parse(line) as ToolCallRecord;
        if(typeof record.timestamp!=='string'||typeof record.toolName!=='string'||
           !record.output||!Array.isArray(record.output.content))continue;
        if(options.toolName&&record.toolName!==options.toolName)continue;
        if(options.since&&Date.parse(record.timestamp)<Date.parse(options.since))continue;
        ring.push(record);
        if(ring.length>MAX_HISTORY_ENTRIES)ring.shift();
      }catch{/* Invalid legacy line: ignore. */}
    }
    const end=ring.length-skip;
    return end>0?ring.slice(Math.max(0,end-max),end):[];
  }
  async getRecentCallsFormatted(options:HistoryOptions={}){
    const records=await this.getRecentCalls(options);
    return records.map(e=>({...e,localTime:new Date(e.timestamp)
      .toLocaleString('en-US',{hour12:false})}));
  }
  getStats(){
    return {totalEntries:this.enabled?this.totalEntries:activity.recent()
      .filter(e=>e.tool&&e.phase&&e.phase!=='START').length,
      historyFile:this.enabled?this.file:null,
      persisted:this.enabled,maxEntries:MAX_HISTORY_ENTRIES,
      maxOutputBytes:MAX_STORED_OUTPUT_BYTES,
      maxFileBytes:MAX_HISTORY_FILE_SIZE_BYTES,
      fileBytes:this.fileBytes,queuedWrites:this.queue.length,
      queuedBytes:this.queuedBytes+this.inFlightBytes,
      dropped:this.dropped,ioErrors:this.ioErrors};
  }
  async cleanup():Promise<void>{
    await this.flush();
    this.enabled=false;
  }
}
export const toolHistory=new ToolHistory();
