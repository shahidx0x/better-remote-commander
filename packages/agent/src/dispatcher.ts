/**
 * BRC agent tool dispatcher: name -> handler, ported from upstream server.ts CallTool switch.
 * Returns MCP-shaped results; errors become { isError: true } text blocks (never throws).
 */
import * as handlers from './core/handlers/index.js';
import { getConfig, setConfigValue } from './core/tools/config.js';
import { getUsageStats } from './core/tools/usage.js';
import { buildToolDefinitions, EXCLUDED_TOOLS, type ToolDefinition } from './core/tool-definitions.js';
import { addToolChoice } from './tool-routing.js';
import { BRC_TOOL_HANDLERS, buildBrcToolDefinitions } from './tools/brc-tools.js';
import { JOB_TOOL_HANDLERS, buildJobToolDefinitions, setJobToolExecutor } from './tools/jobs.js';
import { PLUGIN_TOOL_HANDLERS, buildPluginToolDefinitions } from './tools/plugin-tools.js';
import { AST_GREP_TOOL_HANDLERS, buildAstGrepToolDefinitions } from './tools/ast-grep.js';
import type { ToolResult } from 'brc-shared';
import type { ServerResult } from './core/types.js';
import { randomUUID } from 'node:crypto';
import { WORKER_TOOL_HANDLERS, buildWorkerToolDefinitions } from './tools/worker-tools.js';
import { workerCoordinator } from './runtime/worker-coordination.js';
import { DEVELOPER_TOOL_HANDLERS, buildDeveloperToolDefinitions } from './tools/developer-tools.js';
import { reclaimCaches, markToolStarted, markToolFinished } from './runtime/resource-limits.js';
import { CODING_TOOL_HANDLERS, buildCodingToolDefinitions, runBatch } from './tools/coding-tools.js';
import {LSP_TOOL_HANDLERS,buildLspToolDefinitions} from './tools/lsp-tools.js';
import {PATCH_TOOL_HANDLERS,buildPatchToolDefinitions} from './tools/patch-tools.js';
import {CODE_MODE_TOOL_HANDLERS,buildCodeModeToolDefinitions,setCodeModeToolExecutor} from './tools/code-mode-tools.js';
import { activity, activityAction } from './runtime/activity.js';
import { traceToolArguments, traceToolResult } from './runtime/tool-trace.js';
import { toolHistory } from './core/utils/toolHistory.js';
import { summarizeCommandActivity } from './runtime/command-log-summary.js';
import { summarizeToolOutcome } from './runtime/log-outcome.js';
import { recordToolFailure, failureReason } from './runtime/failure-log.js';
import { POLYGLOT_TOOL_HANDLERS, buildPolyglotToolDefinitions } from './tools/polyglot-tools.js';
import { codeGraph } from './runtime/code-graph.js';
import { EXPERT_TOOL_HANDLERS, buildExpertToolDefinitions } from './tools/expert-tools.js';
import { AgentError, failure, result } from './runtime/errors.js';
import {deferredProfileEnabled,deferredToolDefinitions,discoverNativeTools,DEFERRED_TOOL_NAMES} from './runtime/deferred-tool-catalog.js';
import { assertHash, readBounded, sha256, decodeCode } from './runtime/file-safety.js';
import { validatePath } from './core/tools/filesystem.js';
import { projectIndex } from './runtime/project-index.js';
import { getCallContext, withCallContext, checkCancelled } from './context.js';
import { isTermuxRuntime, availableOnTermux } from './runtime/platform-capabilities.js';
import { repeatFailureGuard } from './runtime/repeat-guard.js';
import {executeToolKernel,attachExecutionOutcome,classifyExecution,trackExecutionOutcome,type ExecutionKind} from './runtime/execution-kernel.js';
import {requireSourceObservation,sourceObservationMode,automaticSourcePrecondition} from './runtime/source-observations.js';
import {compactDuplicatedToolText} from './runtime/result-presentation.js';

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const TOOL_HANDLERS: Map<string, Handler> = new Map<string, Handler>([
  ['get_config', () => getConfig()],
  ['set_config_value', (a) => setConfigValue(a)],
  ['get_usage_stats', async () => ({content:[{type:'text',text:JSON.stringify({persistent:false,tools:activity.metrics()})}]})],
  ['get_recent_tool_calls', (a) => handlers.handleGetRecentToolCalls(a)],
  ['start_process', (a) => handlers.handleStartProcess(a)],
  ['read_process_output', (a) => handlers.handleReadProcessOutput(a)],
  ['interact_with_process', (a) => handlers.handleInteractWithProcess(a)],
  ['force_terminate', (a) => handlers.handleForceTerminate(a)],
  ['list_sessions', () => handlers.handleListSessions()],
  ['list_processes', () => handlers.handleListProcesses()],
  ['kill_process', (a) => handlers.handleKillProcess(a)],
  ['read_file', (a) => handlers.handleReadFile(a)],
  ['read_multiple_files', (a) => handlers.handleReadMultipleFiles(a)],
  ['write_file', (a) => handlers.handleWriteFile(a)],
  ['write_pdf', (a) => handlers.handleWritePdf(a)],
  ['create_directory', (a) => handlers.handleCreateDirectory(a)],
  ['list_directory', (a) => handlers.handleListDirectory(a)],
  ['move_file', (a) => handlers.handleMoveFile(a)],
  ['prepare_file_transfer', (a) => handlers.handlePrepareFileTransfer(a)],
  ['send_file_transfer', (a) => handlers.handleSendFileTransfer(a)],
  ['receive_file_transfer', (a) => handlers.handleReceiveFileTransfer(a)],
  ['get_file_info', (a) => handlers.handleGetFileInfo(a)],
  ['edit_block', (a) => handlers.handleEditBlock(a)],
  ['start_search', (a) => handlers.handleStartSearch(a)],
  ['get_more_search_results', (a) => handlers.handleGetMoreSearchResults(a)],
  ['stop_search', (a) => handlers.handleStopSearch(a)],
  ['list_searches', () => handlers.handleListSearches()],
  // BRC-native tools
  ...Object.entries(BRC_TOOL_HANDLERS),
  ...Object.entries(JOB_TOOL_HANDLERS),
  ...Object.entries(PLUGIN_TOOL_HANDLERS),
  ...Object.entries(AST_GREP_TOOL_HANDLERS),
  ...Object.entries(CODING_TOOL_HANDLERS),
  ...Object.entries(LSP_TOOL_HANDLERS),
  ...Object.entries(PATCH_TOOL_HANDLERS),
  ...Object.entries(CODE_MODE_TOOL_HANDLERS),
  ...Object.entries(EXPERT_TOOL_HANDLERS),
  ...Object.entries(POLYGLOT_TOOL_HANDLERS),
  ...Object.entries(DEVELOPER_TOOL_HANDLERS),
  ...Object.entries(WORKER_TOOL_HANDLERS),
  ['batch_tools', (a) => runBatch(a, callTool)],
  ['discover_tools', async a => result(discoverNativeTools(a,fullToolCatalog()))],
  ['invoke_tool', async a => {
    const name=a.name,args=a.args;
    if(typeof name!=='string'||!name||name.length>120||DEFERRED_TOOL_NAMES.has(name)||
      EXCLUDED_TOOLS.has(name)||!fullToolCatalog().some(t=>t.name===name))
      throw new AgentError('UNKNOWN_TOOL','Unknown or unavailable tool name. Use discover_tools to find the native tool.');
    if(!args||typeof args!=='object'||Array.isArray(args))
      throw new AgentError('INVALID_ARGUMENT','invoke_tool requires args to be an object.');
    // The original dispatcher is called recursively so its mutation guards,
    // scope checks, source hashes, cancellation and receipts remain active.
    return callTool(name,args as Args);
  }],
]);

let cachedDefs: ToolDefinition[] | null = null;
let cachedDeferredDefs: ToolDefinition[] | null = null;

function fullToolCatalog(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = [...buildToolDefinitions(), ...buildBrcToolDefinitions(), ...buildJobToolDefinitions(), ...buildPluginToolDefinitions(), ...buildAstGrepToolDefinitions(), ...buildCodingToolDefinitions(), ...buildLspToolDefinitions(), ...buildPatchToolDefinitions(), ...buildCodeModeToolDefinitions(), ...buildExpertToolDefinitions(), ...buildPolyglotToolDefinitions(), ...buildDeveloperToolDefinitions(), ...buildWorkerToolDefinitions()]
      .filter((t) => TOOL_HANDLERS.has(t.name) && !EXCLUDED_TOOLS.has(t.name))
      .filter(t => process.env.BRC_TOOL_PROFILE !== 'coding' || !['write_pdf','prepare_file_transfer','send_file_transfer','receive_file_transfer','get_recent_tool_calls','get_usage_stats'].includes(t.name))
      .filter(t => !isTermuxRuntime() || availableOnTermux(t.name))
      .map(addToolChoice);
  }
  return cachedDefs;
}

export function listTools(): ToolDefinition[] {
  // Opt-in for clients that accept an indirect two-tool discovery contract.
  // Full native names/schemas/handlers are preserved for normal clients.
  if(deferredProfileEnabled())return cachedDeferredDefs??=deferredToolDefinitions();
  return fullToolCatalog();
}

export function hasTool(name: string): boolean {
  return TOOL_HANDLERS.has(name) && (!isTermuxRuntime() || availableOnTermux(name));
}


/**
 * A stale hash can be safely refreshed only for explicit text substitutions
 * whose exact anchors still match once each in the current source. This never
 * applies to whole-file writes or structured edits. atomicWrite still enforces
 * the refreshed full-file hash before committing.
 */
async function rebaseUnambiguousEditBlock(file:string,args:Args):Promise<string|null>{
  if((args.range!==undefined && args.range!=='') ||
     (args.content!==undefined && args.content!==''))return null;
  const steps=Array.isArray(args.edits)?args.edits:
    (typeof args.old_string==='string'?[args]:[]);
  if(steps.length<1||steps.length>20)return null;
  let bytes:Buffer, source:string;
  try{
    bytes=await readBounded(file,32*1024*1024);
    source=decodeCode(bytes);
  }catch{return null;}
  const newline=source.includes('\r\n')?'\r\n':'\n';
  const normalize=(s:string)=>s.replace(/\r?\n/g,newline);
  for(const step of steps){
    if(!step||typeof step!=='object')return null;
    const edit=step as {old_string?:unknown;new_string?:unknown;expected_replacements?:unknown};
    if(typeof edit.old_string!=='string'||typeof edit.new_string!=='string'||
      edit.old_string.length<12 || (edit.expected_replacements??1)!==1)return null;
    const needle=normalize(edit.old_string),replacement=normalize(edit.new_string);
    const at=source.indexOf(needle);
    if(at===-1 || source.indexOf(needle,at+needle.length)!==-1)return null;
    source=source.slice(0,at)+replacement+source.slice(at+needle.length);
  }
  return sha256(bytes);
}

/** A rejected stale edit is a read-only operation: return an actual current
 * SHA-256 and a bounded, actionable read window, not a generic retry hint.
 * No text is logged or guessed into a new mutation.
 */
async function staleEditFailure(file:string,args:Args,err:AgentError):Promise<ToolResult>{
  const base=failure(err);
  let currentSha256:string|undefined;
  let exactAnchorMatches:number|undefined;
  const candidateLines:number[]=[];
  let nextOffset=0;
  try{
    const data=await readBounded(file,8*1024*1024);
    currentSha256=sha256(data);
    const content=decodeCode(data);
    const steps=Array.isArray(args.edits)?args.edits:[args];
    const first=steps[0] as {old_string?:unknown}|undefined;
    if(typeof first?.old_string==='string'&&first.old_string.length){
      const newline=content.includes('\r\n')?'\r\n':'\n';
      const needle=first.old_string.replace(/\r?\n/g,newline);
      let pos=0,count=0;
      while(count<2){
        const at=content.indexOf(needle,pos);
        if(at<0)break;
        count++;pos=at+Math.max(1,needle.length);
      }
      exactAnchorMatches=count;
      const probe=first.old_string.split(/\r?\n/).map(s=>s.trim()).find(s=>s.length>=6)?.slice(0,80);
      if(probe){
        let pos=0;
        while(candidateLines.length<5){
          const at=content.indexOf(probe,pos);
          if(at<0)break;
          let line=1,from=0;
          while(true){const e=content.indexOf('\n',from);if(e<0||e>=at)break;line++;from=e+1;}
          candidateLines.push(line);
          pos=at+probe.length;
        }
      }
      if(candidateLines.length)nextOffset=Math.max(0,candidateLines[0]-5);
    }
  }catch{/* Path/encoding was changed or became too large; a read tool remains the safe remedy. */}
  const next={tool:'read_code_file',args:{path:file,offset:nextOffset,length:24}};
  const suggestion='The source changed since the supplied SHA-256. Read the current version and examine the exact target before resubmitting; do not replay the unchanged edit. '+
    (exactAnchorMatches===0?'The original text is no longer present. ':
      exactAnchorMatches===2?'The original anchor is not unique. ':'')+
    'Use read_code_file at the suggested offset, then use the returned SHA-256.';
  const modelText='FILE_CONFLICT: no edit was committed.\n'+
    (currentSha256?'CURRENT_SHA256: '+currentSha256+'\n':'')+
    (exactAnchorMatches!==undefined?'EXACT_ANCHOR_MATCHES: '+(exactAnchorMatches===2?'2 or more':exactAnchorMatches)+'\n':'')+
    (candidateLines.length?'CANDIDATE_LINES: '+candidateLines.join(', ')+'\n':'')+
    'NEXT: read_code_file('+JSON.stringify(next.args)+')\n'+suggestion;
  return {...base,content:[{type:'text',text:modelText}],
    structuredContent:{...base.structuredContent,changed:false,
      ...(currentSha256?{currentSha256}:{}),
      ...(exactAnchorMatches!==undefined?{exactAnchorMatches}:{}),
      candidateLines,next,
      recovery:{suggestion,automaticRetry:false,next,hasSafeAutomaticRebase:false}}};
}

function safeCommandDiagnostic(cause:unknown):string{
  if(typeof cause!=='string')return 'NONZERO_EXIT';
  if(cause==='Git was executed outside a repository.')return 'GIT_NOT_REPOSITORY';
  if(cause==='Project dependencies or runtime module resolution failed.')return 'MODULE_RESOLUTION';
  if(cause==='An executable or shell command could not be found.')return 'EXECUTABLE_NOT_FOUND';
  if(cause==='Windows PowerShell 5.1 rejected && / || command chaining.')return 'SHELL_CHAIN_SYNTAX';
  return 'NONZERO_EXIT';
}

const MUTATIONS = new Set(['write_file','edit_block','delete_file','move_file','create_directory','write_pdf']);
const RECEIPT_ONLY_MUTATIONS=new Set(['edit_files','apply_patch','workspace_batch','edit_code_ranges','replace_symbol',
  'worker_patch','worker_integrate','call_plugin_tool','code_mode','git_stage','git_commit','git_push']);
let readOnlyToolCache:Set<string>|null=null;
function executionKindForTool(name:string):ExecutionKind{
  if(MUTATIONS.has(name))return 'filesystem_mutation';
  if(RECEIPT_ONLY_MUTATIONS.has(name))return 'external_mutation';
  // Tool catalog schemas are stable during this agent process. Derive this
  // once instead of scanning all advertised tool metadata on every call.
  if(!readOnlyToolCache)readOnlyToolCache=new Set(fullToolCatalog()
    .filter(t=>t.annotations?.readOnlyHint===true).map(t=>t.name));
  return readOnlyToolCache.has(name)?'read':'external_mutation';
}
export async function callTool(name: string, args: Args): Promise<ToolResult> {
  const parent=getCallContext();
  if(!parent)return withCallContext({id:randomUUID(),client:null,remote:false},()=>callTool(name,args));
  reclaimCaches();
  markToolStarted();
  try {
  const start=performance.now();
   const action=activityAction(name,args);
  activity.tool('START',name,parent.id,undefined,undefined,action,undefined,
    activity.getConsoleMode()==='verbose'?traceToolArguments(name,args):undefined);
  let out:ToolResult;
  try{
    const handler=TOOL_HANDLERS.get(name);
    args=args??{};
    const preflight=async()=>{
      checkCancelled();
      if(!handler || EXCLUDED_TOOLS.has(name))throw new AgentError('UNKNOWN_TOOL',`Unknown tool: ${name}`);
      if(isTermuxRuntime()&&!availableOnTermux(name))throw new AgentError('UNSUPPORTED_ON_TERMUX',
        `${name} needs a desktop/native feature unavailable on Android/Termux (Bionic). Use a supported file, search or terminal tool on this device, or run it on a desktop agent.`);
      await workerCoordinator.guardFileMutation(name,args);
    };
    const perform=async()=>{
      checkCancelled();
      // Idempotent appends reconcile a previously completed operation before
      // comparing the caller's original pre-write hash. Ordinary writes keep
      // the existing optimistic hash checks and strict observation policy.
      const replayableAppend=name==='write_file'&&args.mode==='append'&&
        typeof args.append_id==='string';
      const freshHash=replayableAppend?undefined:await automaticSourcePrecondition(name,args);
      if(freshHash)args={...args,expected_sha256:freshHash};
      if(!replayableAppend)await requireSourceObservation(name,args);
      if((name==='write_file'||name==='edit_block')&&!replayableAppend&&args.expected_sha256!==undefined){
        if(typeof args.expected_sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(args.expected_sha256))throw new AgentError('INVALID_ARGUMENT','expected_sha256 must be 64 hex characters.');
        const target=args.file_path??args.path;
        if(typeof target!=='string')throw new AgentError('INVALID_ARGUMENT','A file path is required for expected_sha256.');
        const validated = await validatePath(target);
        let checkedHash=args.expected_sha256;
        let rebased=false;
        try {
          await assertHash(validated,checkedHash);
        } catch (err) {
          if(!(err instanceof AgentError) || err.code!=='FILE_CONFLICT')throw err;
          // Only exact, unique, short text edits may be safely rebased in auto
          // and legacy modes. Strict mode never overrides a caller's stale hash.
          if(name!=='edit_block')throw err;
          if(sourceObservationMode()==='strict')return await staleEditFailure(validated,args,err);
          const latestHash=await rebaseUnambiguousEditBlock(validated,args);
          if(!latestHash)return await staleEditFailure(validated,args,err);
          checkedHash=latestHash;
          rebased=true;
        }
        // Keep the validated hash authoritative for the whole mutation.
        return withCallContext({...parent,writePrecondition:{path:validated,sha256:checkedHash}},async()=>{
          const response=await handler!(args) as ToolResult;
          if(!rebased||response.isError)return response;
          return {...response,
            content:[...response.content,{type:'text' as const,text:'[BRC] Stale hash safely refreshed: all exact text anchors were unique; unrelated changes were preserved.'}],
            structuredContent:{...response.structuredContent,autoRebasedFromStaleHash:true}};
        });
      }
      return await handler!(args) as ToolResult;
    };
    const kind=executionKindForTool(name);
    const targets=kind==='filesystem_mutation'
      ?[args.file_path,args.path,args.source,args.destination,args.outputPath]
        .filter((p):p is string=>typeof p==='string'&&!!p)
      :[];
    try{
      // Nested/batched tools may share the remote call ID. Give each
      // individual execution a unique receipt identity to avoid collisions.
      // The public MCP callId remains the original parent's ID.
      out=await executeToolKernel({name,callId:parent.id+':'+randomUUID(),kind,
        paths:targets,preflight,perform,
        recordReceipt:MUTATIONS.has(name)||RECEIPT_ONLY_MUTATIONS.has(name)});
    }finally{
      // Invalidate after a failed/uncertain write too. A partial mutation
      // might have changed a file even if no successful reply was returned.
      if(kind==='filesystem_mutation'){projectIndex.invalidate();codeGraph.invalidate();}
    }
    if(out.isError && !out.structuredContent?.error){out={...out,structuredContent:{...out.structuredContent,error:{code:'TOOL_FAILED',retryable:false,callId:parent.id}}};}

  }catch(err){out=failure(err,parent.id);}
  const kind=executionKindForTool(name);
  out=attachExecutionOutcome(out,name,parent.id,kind);
  // Only proven duplicate JSON text is shortened; independent file/search
  // output, images and full structured results remain byte-for-byte intact.
  out=compactDuplicatedToolText(out);
  trackExecutionOutcome(classifyExecution(out,kind));
  const durationMs=Math.round(performance.now()-start);
  const error=out.structuredContent?.error as {code?:string}|undefined;
  const repeated=repeatFailureGuard.observe(name,args,!!out.isError,error?.code);
  if(repeated){
    // Advisory only: keep the original error and never execute a retry.
    const content='BRC REPEATED FAILURE ('+repeated.count+' identical failures): '+repeated.hint;
    const previous=out.structuredContent as Record<string,unknown>|undefined;
    const recovery=previous?.recovery as Record<string,unknown>|undefined;
    out={...out,content:[...out.content,{type:'text' as const,text:content}],
      structuredContent:{...previous,repeatedFailureCount:repeated.count,
        recovery:{...recovery,automaticRetry:false,suggestion:repeated.hint}}};
  }
   const phase=out.isError?'ERROR':out.structuredContent?.pending===true?'PENDING':'OK';
  const managedId=out.structuredContent?.jobId;
  const note=phase==='PENDING'
    ? ('Job '+(typeof managedId==='string'?managedId:'pending')+' | running locally; not finished')
    : name==='run_command' ? summarizeCommandActivity(out).detail
    : name==='start_process' && phase==='OK' ? 'Process started; it may still be running'
    : phase==='ERROR' ? ((error?.code??'TOOL_FAILED')+': '+failureReason(name,error?.code??'TOOL_FAILED'))
    : summarizeToolOutcome(name,out);
  activity.tool(phase,name,parent.id,durationMs,error?.code,action,note,
    activity.getConsoleMode()==='verbose'?traceToolResult(name,out):undefined);
  // Persist sanitized metadata and a <=4-KiB output preview without adding
  // another in-memory history ring. Never log the history query itself.
  if(name!=='get_recent_tool_calls')
    toolHistory.addCall(name,args,out,durationMs,{phase,callId:parent.id,
      action,errorCode:error?.code,note});
  if(out.isError){
    const code=error?.code??'TOOL_FAILED';
    // Preserve classified failures in the bounded diagnostic records.
    // The compact 3-line tool entry already contains this safe diagnosis.
    // Do not print a fourth generic failure line; the detailed result remains available.
    const meta=out.structuredContent as Record<string,unknown>|undefined;
    const cause=(meta?.recovery as Record<string,unknown>|undefined)?.cause;
    const exitCode=name==='run_command'&&code==='COMMAND_FAILED'&&typeof meta?.exitCode==='number'
      ?meta.exitCode:undefined;
    recordToolFailure({tool:name,code,durationMs,callId:parent.id,
      ...(exitCode!==undefined?{exitCode,diagnostic:
        typeof meta?.commandFailureKind==='string' &&
          /^(?:NONZERO_EXIT|GIT_NOT_REPOSITORY|PROJECT_MANIFEST_MISSING|TYPECHECK_ERROR|SYNTAX_ERROR|MODULE_RESOLUTION|EXECUTABLE_NOT_FOUND|SHELL_CHAIN_SYNTAX)$/.test(meta.commandFailureKind)
          ?meta.commandFailureKind:safeCommandDiagnostic(cause)}:{})});
  }
  return {...out,_meta:{...out._meta,callId:parent.id,durationMs}};
  } finally {
    // Even unexpected logging/serialization failures must release idle tracking.
    markToolFinished();
  }
}

// Job steps run through the same dispatcher (validation, usage tracking, error wrapping).
setJobToolExecutor(async (name, args) => (await callTool(name, args)) as ServerResult);
setCodeModeToolExecutor(callTool,fullToolCatalog);
