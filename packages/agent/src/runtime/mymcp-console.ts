/**
 * Small, privacy-conscious LOCAL console summaries.
 *
 * A tool's actual MCP result is untouched. Only the temporary on-screen
 * preview is summarized: never print file source, JSON result bodies, shell
 * output, credentials, edits, scripts, or client identifiers.
 */
import {redactTrace} from './tool-trace.js';

export const MYMCP_CONSOLE_PREVIEW_BYTES=4096;
export const MYMCP_ARGUMENT_PREVIEW_BYTES=2048;
type Input=Record<string,unknown>;
const PRIVATE_FILE=/(?:^|[\\/])(?:\.env(?:\..*)?|id_(?:rsa|ed25519)|credentials?(?:\..*)?|secrets?(?:\..*)?|private[-_.]?key(?:\..*)?)(?:$|[\\/])|\.(?:pem|p12|pfx|key)$/i;

const SUCCESS:Record<string,string>={
  read_file:'File read successfully',
  read_code_file:'Source file read successfully',
  read_multiple_files:'Files read successfully',
  list_directory:'Directory listed successfully',
  get_file_info:'File information retrieved',
  write_file:'File saved successfully',
  edit_block:'File updated successfully',
  edit_files:'Files updated successfully',
  apply_patch:'Patch applied successfully',
  create_directory:'Directory created successfully',
  move_file:'File moved successfully',
  delete_file:'File deleted successfully',
  run_command:'Command finished successfully',
  start_process:'Process started successfully',
  read_process_output:'Process output checked',
  interact_with_process:'Process interaction completed',
  git_status:'Git status checked',
  git_diff:'Git changes inspected',
  git_log:'Git history checked',
  start_search:'Search started',
  get_more_search_results:'Search results retrieved',
  project_context:'Project context retrieved',
  project_map:'Project map retrieved',
  code_mode:'Code workflow completed',
  run_parallel:'Parallel calls completed',
  spawn_job:'Job submitted',
  get_job:'Job status checked',
  wait_jobs:'Jobs checked',
  agent_status:'Agent status checked',
  run_project_checks:'Project checks completed',
  discover_checks:'Available project checks retrieved',
  list_plugin_tools:'Available plugin tools listed',
  call_plugin_tool:'Plugin tool completed',
  lsp_query:'Language server query completed',
  code_graph:'Code graph inspected',
  context_pack:'Project context prepared',
  ast_search:'Code structure search completed',
  find_symbols:'Symbols located',
  find_references:'References located',
  list_sessions:'Process sessions listed',
  list_jobs:'Jobs listed',
  cancel_job:'Job cancellation processed',
};

const HINTS:Record<string,string>={
  CODE_MODE_UNAWAITED_CALLS:'Await all tools.call() operations before returning',
  CODE_MODE_SCRIPT_FAILED:'Inspect the script error returned to ChatGPT',
  CODE_MODE_TIMEOUT:'The workflow exceeded its deadline',
  FILE_CONFLICT:'Re-read the file before editing again',
  ENOENT:'Check the path and try again',
  COMMAND_FAILED:'Inspect the command output returned to ChatGPT',
  CODE_MODE_BUSY:'A workflow is already running',
  CODE_MODE_TOOL_DENIED:'The requested tool is not permitted in Code Mode',
  CODE_MODE_CALL_LIMIT:'The nested tool budget was reached',
  PROJECT_NOT_FOUND:'Check the directory path and try again',
  INVALID_ARGUMENT:'Check required arguments and their values',
  CHECK_FAILED:'Inspect the failed project checks returned to ChatGPT',
  WRITE_MODE_REQUIRED:'Choose a supported file write mode',
  WRITE_SIZE_LIMIT:'Split the write into smaller chunks',
  WRITE_LINE_LIMIT:'Use fewer lines per write',
};
function record(v:unknown):Input{
  return v&&typeof v==='object'&&!Array.isArray(v)?v as Input:{};
}
function bounded(v:unknown,limit=100):string|undefined{
  if(typeof v!=='string'||!v.trim())return;
  return redactTrace(v.replace(/[\r\n\t]+/g,' ').trim(),limit).slice(0,limit);
}
function number(v:unknown):number|undefined{
  return typeof v==='number'&&Number.isSafeInteger(v)&&v>=0&&v<1_000_000_000?v:undefined;
}
function quantity(n:number,unit:string):string{
  return n+' '+unit+(n===1?'':'s');
}
/** Display the final 2-3 path segments, not a long workspace prefix. */
function targetPath(value:unknown):string|undefined{
  const raw=bounded(value,500);
  if(!raw)return;
  if(PRIVATE_FILE.test(raw))return '[private file]';
  const parts=raw.split(/[\\/]/).filter(Boolean);
  const last=parts.length>3?'…/'+parts.slice(-3).join('/'):raw;
  return last.slice(0,115);
}
function target(args:Input):string|undefined{
  const direct=targetPath(args.file_path??args.path??args.destination??
    args.cwd??args.directory??args.root);
  if(direct)return direct;
  const batch=args.paths??args.files;
  if(Array.isArray(batch))return quantity(batch.length,'file');
  const pid=number(args.pid);
  if(pid!==undefined)return 'PID '+pid;
  return;
}
function firstText(result:Input):string{
  const content=result.content;
  if(!Array.isArray(content))return '';
  const block=record(content[0]);
  return typeof block.text==='string'?block.text.slice(0,18_000):'';
}
function countSummary(tool:string,result:Input,meta:Input,args:Input):string|undefined{
  const read=record(meta.read);
  if(tool==='read_file'||tool==='read_code_file'){
    const shown=number(read.returnedLines)??number(meta.returnedLines);
    const total=number(read.totalLines)??number(meta.totalLines);
    if(shown!==undefined)return total!==undefined
      ?shown+' of '+quantity(total,'line'):quantity(shown,'line');
    // Read only the standard BRC header. Source lines are NEVER logged.
    const match=/^\[Reading (\d{1,7}) lines? from [^\r\n]{1,90}\(total: (\d{1,7}) lines?/.exec(firstText(result).slice(0,190));
    if(match)return match[1]+' of '+quantity(Number(match[2]),'line');
    if(total!==undefined)return quantity(total,'line');
  }
  if(tool==='read_multiple_files'){
    const files=args.paths??args.files;
    if(Array.isArray(files))return quantity(files.length,'file');
  }
  if(tool==='list_directory'){
    // Count just BRC's [FILE]/[DIR] markers, never log names or file content.
    const sample=firstText(result);
    const files=(sample.match(/^\[FILE\]/gm)??[]).length;
    const dirs=(sample.match(/^\[DIR\]/gm)??[]).length;
    if(files+dirs)return quantity(files,'file')+', '+quantity(dirs,'folder');
  }
  if(tool==='run_command'){
    const code=number(meta.exitCode);
    if(code!==undefined)return 'exit '+code;
  }
  if(tool==='code_mode'){
    const calls=number(meta.completedCalls);
    if(calls!==undefined)return quantity(calls,'local call');
  }
  if(tool==='start_search'||tool==='get_more_search_results'){
    const count=number(meta.totalMatches);
    if(count!==undefined)return quantity(count,'match');
  }
  if(tool==='write_file'){
    const bytes=number(meta.bytesWritten);
    if(bytes!==undefined)return bytes+' bytes written';
  }
  if(tool==='start_process'){
    const match=/Process started with PID (\d{1,9})/.exec(firstText(result).slice(0,180));
    if(match)return 'PID '+match[1];
  }
  if(tool==='get_job'||tool==='wait_jobs'){
    const s=bounded(meta.status,32);
    if(s&&/^[a-z_-]+$/i.test(s))return s;
  }
  return;
}
/** No source or entire arguments: target and origin are enough to trace a call. */
export function mymcpCallPreview(_tool:string,args:unknown,_client?:{
  name?:string;version?:string
}|null,remote=false):string{
  const obj=record(args);
  return JSON.stringify({
    ...(target(obj)?{target:target(obj)}:{}),
    origin:remote?'remote':'local',
  });
}
/** Return safe, human-sized status info only; never include the raw tool result. */
export function mymcpResultPreview(tool:string,result:unknown,args?:unknown):string{
  const r=record(result);
  const meta=record(r.structuredContent);
  const input=record(args);
  const pending=meta.pending===true;
  const failed=r.isError===true;
  const error=record(meta.error);
  const code=bounded(error.code,70);
  const summary=failed?'Operation failed':pending?'Operation is still running':
    SUCCESS[tool]??'Tool completed successfully';
  const detail=failed?
    (code&&number(meta.exitCode)!==undefined?code+' • exit '+meta.exitCode:code):
    countSummary(tool,r,meta,input);
  const hint=failed&&code?HINTS[code]:undefined;
  const preview={
    summary,
    ...(detail?{detail:detail.slice(0,110)}:{}),
    ...(hint?{hint}:{}),
    ...(target(input)?{target:target(input)}:{}),
  };
  // Kept as JSON for robust parsing by the console formatter, never printed raw.
  const encoded=JSON.stringify(preview);
  return Buffer.byteLength(encoded,'utf8')<=MYMCP_CONSOLE_PREVIEW_BYTES?
    encoded:JSON.stringify({summary,detail:'Preview shortened'});
}
