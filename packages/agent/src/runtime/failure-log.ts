/**
 * Opt-in local failure-only diagnostic log.
 *
 * Keep ONLY the latest 100 failures total (not daily or per session).
 * No backup, unbounded history, raw arguments, code, filenames, paths,
 * credentials, tool results or network telemetry.
 * Disabled by default; set BRC_ERROR_LOG=1 locally to opt in.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const MAX_FAILURE_LOG_ENTRIES=100;
const MAX_EXISTING_FILE_BYTES=512*1024;
let pending:Promise<void>=Promise.resolve();
let queued:Failure[]=[];
let scheduled=false;

const explanations:Record<string,string>={
  SEARCH_INVALID_PATTERN:'ripgrep rejected the regex; correct it or set literalSearch=true',
  SEARCH_INVALID_GLOB:'ripgrep rejected the filename glob; correct the wildcard syntax',
  SEARCH_RIPGREP_UNAVAILABLE:'ripgrep executable unavailable; install rg or configure BRC_RG_PATH',
  SEARCH_START_FAILED:'ripgrep could not start; check executable path and permission',
  SEARCH_ACCESS_DENIED:'search root is inaccessible or outside the agent allowed directories',
  SEARCH_TIMEOUT:'search exceeded its timeout; narrow the scope or pattern',
  SEARCH_BUSY:'bounded search admission queue was full or remained busy; wait for a free worker',
  SEARCH_CANCELLED:'pending search was cancelled before it started; no new ripgrep process was launched',
  SEARCH_SESSION_NOT_FOUND:'search session was missing or expired',
  SEARCH_FAILED:'search process failed; inspect the tool response for the specific cause',
  EDIT_TEXT_NOT_FOUND:'old_string did not exactly match the current file; re-read and include correct whitespace',
  EDIT_COUNT_MISMATCH:'old_string occurrence count differs from expected_replacements; use unique context',
  EDIT_PATH_INVALID:'edit target path could not be accessed or is unsupported',
  EDIT_UNSUPPORTED_RANGE:'range-based edit is not supported for this file type',
  EDIT_STRUCTURED_FAILED:'structured file edit failed; inspect the tool result and confirm current file state',
  INVALID_ARGUMENT:'tool argument validation failed; check required fields and types',
  FILE_CONFLICT:'expected_sha256 is stale or file changed during publication; re-read current source/hash',
  PATH_NOT_ALLOWED:'agent denied the requested file path',
  OUTSIDE_ALLOWED_DIRECTORY:'agent denied access outside allowed directories',
  TOOL_FAILED:'tool returned an unclassified failure; inspect its response',
  PLUGIN_NOT_FOUND:'unknown plugin identifier; use list_plugin_tools with no plugin to discover IDs',
  PLUGIN_NOT_MCP:'the requested plugin ID is a built-in binary, not an MCP tool server',
  PLUGIN_NOT_READY:'plugin is disabled, installing, or missing; check its status and finish setup',
  PLUGIN_DISCOVERY_FAILED:'plugin tool discovery failed; inspect the plugin status and its stderr log',
  PROCESS_ALREADY_EXITED:'the PID already completed; use read_process_output to inspect exit status',
  PROCESS_NOT_ACTIVE:'no active process has this PID; inspect list_sessions or get_job',
  PROCESS_INPUT_REJECTED:'stdin is unavailable or the process has exited; inspect the process before retrying',
  COMMAND_FAILED:'shell command returned nonzero exit; inspect stderr and exitCode',
  TIMEOUT:'tool timed out; for long commands use start_process and read_process_output, then verify partial effects',
  ENOENT:'requested file or path does not exist; verify the absolute path and parent directory',
  BUSY:'agent concurrency queue is full',
  RESULT_TOO_LARGE:'tool output exceeded the bounded transport response limit',
  CANCELLED:'tool was cancelled before completion',
};
export function failureReason(tool:string,code:string,diagnostic?:string):string {
  if(tool==='run_command' && code==='COMMAND_FAILED') {
    if(diagnostic==='MODULE_RESOLUTION')return 'runtime module resolution failed; check cwd, installed dependencies and pnpm workspace links';
    if(diagnostic==='GIT_NOT_REPOSITORY')return 'Git command used a non-repository cwd; set cwd to a valid repository';
    if(diagnostic==='EXECUTABLE_NOT_FOUND')return 'command or executable unavailable; check PATH, shell and working directory';
    if(diagnostic==='SHELL_CHAIN_SYNTAX')return 'PowerShell 5.1 cannot parse && or ||; use cmd.exe for native chains';
  }
  if(explanations[code])return explanations[code];
  if(tool==='start_search')return 'search failed; inspect its structured error and recovery guidance';
  if(tool==='edit_block')return 'edit failed; check exact text, occurrence count and current SHA-256';
  return 'tool failed; inspect its structured error and recovery guidance';
}
export function failureLogPath(home=process.env.BRC_HOME??path.join(os.homedir(),'.brc')):string {
  return path.join(home,'logs','agent-failures.jsonl');
}
type Failure={tool:string;code:string;durationMs:number;callId:string;exitCode?:number|null;diagnostic?:string};
type SafeEntry={timestamp:string;tool:string;code:string;durationMs:number;callId:string;reason:string;exitCode?:number;diagnostic?:string};
function clean(v:string,limit=80):string {return v.replace(/[^\w.-]/g,'_').slice(0,limit);}
// Never write command lines, stderr or arbitrary model/tool-supplied diagnostics.
const SAFE_DIAGNOSTICS=new Set(['GIT_NOT_REPOSITORY','MODULE_RESOLUTION','EXECUTABLE_NOT_FOUND','SHELL_CHAIN_SYNTAX','NONZERO_EXIT']);
function safeDiagnostic(value:unknown):string|undefined {
  return typeof value==='string'&&SAFE_DIAGNOSTICS.has(value)?value:undefined;
}
function safeExitCode(value:unknown):number|undefined {
  return typeof value==='number'&&Number.isSafeInteger(value)&&Math.abs(value)<=2147483647?value:undefined;
}
function newEntry(event:Failure):SafeEntry {
  const exitCode=safeExitCode(event.exitCode);
  const diagnostic=safeDiagnostic(event.diagnostic);
  return {timestamp:new Date().toISOString(),tool:clean(event.tool),
    code:clean(event.code),durationMs:Math.max(0,Math.round(event.durationMs)),
    callId:clean(event.callId,16),reason:failureReason(event.tool,event.code,diagnostic),
    ...(exitCode!==undefined?{exitCode}:{}),...(diagnostic?{diagnostic}:{})};
}
function parseEntry(line:string):SafeEntry|null {
  try{
    const v=JSON.parse(line) as Partial<SafeEntry>;
    if(typeof v.tool!=='string'||typeof v.code!=='string')return null;
    return {timestamp:typeof v.timestamp==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(v.timestamp)?
      v.timestamp.slice(0,30):new Date().toISOString(),
      tool:clean(v.tool),code:clean(v.code),
      durationMs:Number.isFinite(v.durationMs)?Math.max(0,Math.round(v.durationMs!)):0,
      callId:clean(typeof v.callId==='string'?v.callId:'',16),
      reason:failureReason(v.tool,v.code,safeDiagnostic(v.diagnostic)),
      ...(safeExitCode(v.exitCode)!==undefined?{exitCode:safeExitCode(v.exitCode)}:{}),
      ...(safeDiagnostic(v.diagnostic)?{diagnostic:safeDiagnostic(v.diagnostic)}:{})};
  }catch{return null;}
}
async function persistBatch(batch:Failure[]):Promise<void>{
  const file=failureLogPath();
  const folder=path.dirname(file);
  await fs.mkdir(folder,{recursive:true,mode:0o700});
  const dirStat=await fs.lstat(folder);
  if(!dirStat.isDirectory()||dirStat.isSymbolicLink())return;
  const old=await fs.lstat(file).catch((e:NodeJS.ErrnoException)=>{
    if(e.code==='ENOENT')return null;
    throw e;
  });
  if(old&&(!old.isFile()||old.isSymbolicLink()))return;
  let entries:SafeEntry[]=[];
  if(old&&old.size<=MAX_EXISTING_FILE_BYTES){
    const text=await fs.readFile(file,'utf8');
    entries=text.split(/\r?\n/).filter(Boolean).slice(-MAX_FAILURE_LOG_ENTRIES)
      .map(parseEntry).filter((x):x is SafeEntry=>x!==null);
  }
  entries.push(...batch.slice(-MAX_FAILURE_LOG_ENTRIES).map(newEntry));
  entries=entries.slice(-MAX_FAILURE_LOG_ENTRIES);
  // Existing file is agent-owned and was checked for symlinks above.
  await fs.writeFile(file,entries.map(e=>JSON.stringify(e)).join('\n')+'\n',{mode:0o600,flag:'w'});
  await fs.chmod(file,0o600).catch(()=>{});
  // Remove the old backup created by pre-cap implementations; no copies remain.
  const previous=file+'.previous';
  const stat=await fs.lstat(previous).catch(()=>null);
  if(stat?.isFile()&&!stat.isSymbolicLink())await fs.unlink(previous).catch(()=>{});
}
function schedule():void{
  if(scheduled)return;
  scheduled=true;
  pending=pending.catch(()=>{}).then(async()=>{
    const batch=queued.splice(0);
    if(batch.length)await persistBatch(batch);
  }).catch(()=>{/* Failure logging must never interrupt tool execution. */})
    .finally(()=>{
      // Do not signal completion until the file operation has actually settled.
      scheduled=false;
      if(queued.length)schedule();
    });
}
export function recordToolFailure(event:Failure):void{
  if(process.env.BRC_ERROR_LOG!=='1')return;
  queued.push(event);
  if(queued.length>MAX_FAILURE_LOG_ENTRIES)
    queued=queued.slice(-MAX_FAILURE_LOG_ENTRIES);
  schedule();
}
export async function flushToolFailureLogs():Promise<void>{
  while(scheduled||queued.length)await pending;
}
