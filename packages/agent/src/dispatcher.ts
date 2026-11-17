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
import { reclaimCaches } from './runtime/resource-limits.js';
import { CODING_TOOL_HANDLERS, buildCodingToolDefinitions, runBatch } from './tools/coding-tools.js';
import { activity } from './runtime/activity.js';
import { recordToolFailure, failureReason } from './runtime/failure-log.js';
import { POLYGLOT_TOOL_HANDLERS, buildPolyglotToolDefinitions } from './tools/polyglot-tools.js';
import { codeGraph } from './runtime/code-graph.js';
import { EXPERT_TOOL_HANDLERS, buildExpertToolDefinitions } from './tools/expert-tools.js';
import { AgentError, failure } from './runtime/errors.js';
import { assertHash, withFileLocks, readBounded, sha256, decodeCode } from './runtime/file-safety.js';
import { validatePath } from './core/tools/filesystem.js';
import { projectIndex } from './runtime/project-index.js';
import { getCallContext, withCallContext, checkCancelled } from './context.js';
import { isTermuxRuntime, availableOnTermux } from './runtime/platform-capabilities.js';

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
  ...Object.entries(EXPERT_TOOL_HANDLERS),
  ...Object.entries(POLYGLOT_TOOL_HANDLERS),
  ...Object.entries(DEVELOPER_TOOL_HANDLERS),
  ...Object.entries(WORKER_TOOL_HANDLERS),
  ['batch_tools', (a) => runBatch(a, callTool)],
]);

let cachedDefs: ToolDefinition[] | null = null;

export function listTools(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = [...buildToolDefinitions(), ...buildBrcToolDefinitions(), ...buildJobToolDefinitions(), ...buildPluginToolDefinitions(), ...buildAstGrepToolDefinitions(), ...buildCodingToolDefinitions(), ...buildExpertToolDefinitions(), ...buildPolyglotToolDefinitions(), ...buildDeveloperToolDefinitions(), ...buildWorkerToolDefinitions()]
      .filter((t) => TOOL_HANDLERS.has(t.name) && !EXCLUDED_TOOLS.has(t.name))
      .filter(t => process.env.BRC_TOOL_PROFILE !== 'coding' || !['write_pdf','prepare_file_transfer','send_file_transfer','receive_file_transfer','get_recent_tool_calls','get_usage_stats'].includes(t.name))
      .filter(t => !isTermuxRuntime() || availableOnTermux(t.name))
      .map(addToolChoice);
  }
  return cachedDefs;
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

function safeCommandDiagnostic(cause:unknown):string{
  if(typeof cause!=='string')return 'NONZERO_EXIT';
  if(cause==='Git was executed outside a repository.')return 'GIT_NOT_REPOSITORY';
  if(cause==='Project dependencies or runtime module resolution failed.')return 'MODULE_RESOLUTION';
  if(cause==='An executable or shell command could not be found.')return 'EXECUTABLE_NOT_FOUND';
  if(cause==='Windows PowerShell 5.1 rejected && / || command chaining.')return 'SHELL_CHAIN_SYNTAX';
  return 'NONZERO_EXIT';
}

const MUTATIONS = new Set(['write_file','edit_block','delete_file','move_file','create_directory','write_pdf']);
export async function callTool(name: string, args: Args): Promise<ToolResult> {
  const parent=getCallContext();
  if(!parent)return withCallContext({id:randomUUID(),client:null,remote:false},()=>callTool(name,args));
  reclaimCaches();
  const start=performance.now();
  activity.tool('START',name,parent.id);
  let out:ToolResult;
  try{
    checkCancelled();
    const handler=TOOL_HANDLERS.get(name);
    if(!handler || EXCLUDED_TOOLS.has(name))throw new AgentError('UNKNOWN_TOOL',`Unknown tool: ${name}`);
    if(isTermuxRuntime()&&!availableOnTermux(name))throw new AgentError('UNSUPPORTED_ON_TERMUX',
      `${name} needs a desktop/native feature unavailable on Android/Termux (Bionic). Use a supported file, search or terminal tool on this device, or run it on a desktop agent.`);
    args=args??{};
    await workerCoordinator.guardFileMutation(name,args);
    const perform=async()=>{
      checkCancelled();
      if((name==='write_file'||name==='edit_block')&&args.expected_sha256!==undefined){
        if(typeof args.expected_sha256!=='string'||!/^[a-fA-F0-9]{64}$/.test(args.expected_sha256))throw new AgentError('INVALID_ARGUMENT','expected_sha256 must be 64 hex characters.');
        const target=args.file_path??args.path;
        if(typeof target!=='string')throw new AgentError('INVALID_ARGUMENT','A file path is required for expected_sha256.');
        const validated = await validatePath(target);
        let checkedHash=args.expected_sha256;
        let rebased=false;
        try {
          await assertHash(validated,checkedHash);
        } catch (err) {
          if(name!=='edit_block' || !(err instanceof AgentError) || err.code!=='FILE_CONFLICT')throw err;
          const latestHash=await rebaseUnambiguousEditBlock(validated,args);
          if(!latestHash)throw err;
          checkedHash=latestHash;
          rebased=true;
        }
        // Keep the validated hash authoritative for the whole mutation.
        return withCallContext({...parent,writePrecondition:{path:validated,sha256:checkedHash}},async()=>{
          const response=await handler(args) as ToolResult;
          if(!rebased||response.isError)return response;
          return {...response,
            content:[...response.content,{type:'text' as const,text:'[BRC] Stale hash safely refreshed: all exact text anchors were unique; unrelated changes were preserved.'}],
            structuredContent:{...response.structuredContent,autoRebasedFromStaleHash:true}};
        });
      }
      return await handler(args) as ToolResult;
    };
    if(MUTATIONS.has(name)){
      const targets=[args.file_path,args.path,args.source,args.destination,args.outputPath].filter((p):p is string=>typeof p==='string'&&!!p);
      const checked=await Promise.all(targets.map(p=>validatePath(p)));
      out=await withFileLocks(checked,perform);
      projectIndex.invalidate();
      codeGraph.invalidate();
    }else out=await perform();
    if(out.isError && !out.structuredContent?.error){out={...out,structuredContent:{...out.structuredContent,error:{code:'TOOL_FAILED',retryable:false,callId:parent.id}}};}

  }catch(err){out=failure(err,parent.id);}
  const durationMs=Math.round(performance.now()-start);
  const error=out.structuredContent?.error as {code?:string}|undefined;
  activity.tool(out.isError?'ERROR':'OK',name,parent.id,durationMs,error?.code);
  if(out.isError){
    const code=error?.code??'TOOL_FAILED';
    const reason=failureReason(name,code);
    activity.log('error','FAILURE CAUSE '+name+' '+code+': '+reason);
    const meta=out.structuredContent as Record<string,unknown>|undefined;
    const cause=(meta?.recovery as Record<string,unknown>|undefined)?.cause;
    const exitCode=name==='run_command'&&code==='COMMAND_FAILED'&&typeof meta?.exitCode==='number'
      ?meta.exitCode:undefined;
    recordToolFailure({tool:name,code,durationMs,callId:parent.id,
      ...(exitCode!==undefined?{exitCode,diagnostic:safeCommandDiagnostic(cause)}:{})});
  }
  return {...out,_meta:{...out._meta,callId:parent.id,durationMs}};
}

// Job steps run through the same dispatcher (validation, usage tracking, error wrapping).
setJobToolExecutor(async (name, args) => (await callTool(name, args)) as ServerResult);
