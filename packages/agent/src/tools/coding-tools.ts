/** Bounded coding workflows; existing policy validation remains the authority. */
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { DEFAULT_WORKFLOW, playwrightPolicy } from '../runtime/browser-workflow.js';
import { failureReason, failureLogPath } from '../runtime/failure-log.js';
import type { ToolResult } from 'brc-shared';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { validatePath } from '../core/tools/filesystem.js';
import { searchManager } from '../core/search-manager.js';
import { handleRunCommand } from './brc-tools.js';
import { runProgram } from '../runtime/program-runner.js';
import { codeGraph } from '../runtime/code-graph.js';
import { codeCacheStatus } from '../runtime/code-structure.js';
import { readBounded, decodeCode, sha256, atomicWrite, withFileLocks, lockKey } from '../runtime/file-safety.js';
import { AgentError, result, failure } from '../runtime/errors.js';
import { projectIndex } from '../runtime/project-index.js';
import { activity, RETENTION_MS } from '../runtime/activity.js';
import { operationStatus, cancelOperation } from '../runtime/operations.js';
import { checkCancelled, getCallContext, withCallContext } from '../context.js';

const SnapshotSchema = z.object({ path:z.string().min(1), offset:z.number().int().min(0).default(0), length:z.number().int().min(1).max(2000).default(200), charOffset:z.number().int().min(0).optional(), charLength:z.number().int().min(1).max(100000).default(50000) });
const ContextSchema = z.object({ path:z.string().min(1), pattern:z.string().min(1), literalSearch:z.boolean().default(true), filePattern:z.string().optional(), maxResults:z.number().int().min(1).max(50).default(10), contextLines:z.number().int().min(0).max(30).default(5) });
const EditSchema = z.object({ old_string:z.string().min(1), new_string:z.string(), expected_replacements:z.number().int().min(1).max(10000).default(1) });
const EditFilesSchema = z.object({ files:z.array(z.object({ path:z.string().min(1), expected_sha256:z.string().regex(/^[a-fA-F0-9]{64}$/), edits:z.array(EditSchema).min(1).max(100) })).min(1).max(16), dryRun:z.boolean().default(false) });
const VerifySchema = z.object({ cwd:z.string().min(1), commands:z.array(z.object({ name:z.string().min(1).max(80), command:z.string().min(1).max(10000).optional(), program:z.string().min(1).max(1000).optional(), args:z.array(z.string().max(2000)).max(100).default([]) }).refine(a=>!!a.command !== !!a.program, {message:'Supply command OR program/args, not both.'})).min(1).max(5), timeout_ms:z.number().int().min(1000).max(110000).default(110000), stopOnFailure:z.boolean().default(true) });
const IndexSchema = z.object({ path:z.string().min(1), action:z.enum(['enable','refresh','query','disable']).default('query'), query:z.string().max(1000).default(''), watch:z.boolean().default(true), limit:z.number().int().min(1).max(1000).default(100) });
const CancelSchema = z.object({ callId:z.string().min(1).max(100) });
const StatusSchema = z.object({lookupCallId:z.string().min(8).max(100).optional()});
import { BatchSchema, runBatch } from '../runtime/fast-batch.js';
export { BatchSchema, runBatch };
import { cacheStatus } from '../runtime/resource-limits.js';
import { platformCapabilities } from '../runtime/platform-capabilities.js';
import { repeatFailureGuard } from '../runtime/repeat-guard.js';
import {recentMutationReceipts,mutationReceiptStatus} from '../runtime/operation-receipts.js';
import {outputSpillLimits} from '../runtime/job-output-spill.js';
import {executionKernelStatus} from '../runtime/execution-kernel.js';
import {managedChildStatus} from '../runtime/process-termination.js';
import {managedSpawnStatus} from '../runtime/managed-spawn.js';
import {operationalRetentionStatus} from '../runtime/operational-retention.js';
import {workerPlanCheckpointStatus} from '../runtime/worker-plan-checkpoints.js';
import {commandEnvironmentStatus} from '../runtime/command-environment.js';
import {callOutcomeStatus,lookupCallOutcome} from '../runtime/call-outcomes.js';
import {sourceObservationStatus} from '../runtime/source-observations.js';
import {resultPresentationStatus} from '../runtime/result-presentation.js';
import {commandCpuAdmission,searchIoAdmission,pluginStartupAdmission} from '../runtime/resource-admission.js';
import {terminalManager} from '../core/terminal-manager.js';
import {missingFileResponse} from '../runtime/path-diagnostics.js';
import {terminalJournalStatus} from '../runtime/terminal-journal.js';
import {runningPluginIds} from '../plugins/host.js';
import {semanticTsManager} from '../runtime/semantic-ts-host.js';
import {lazyLanguageServer} from '../runtime/lazy-lsp.js';
import { connectionHealth } from '../transport/connection-health.js';
import {resultFrameTelemetry} from '../transport/result-budget.js';


export async function snapshot(file:string, offset=0, length=200, charOffset?:number, charLength=50000) {
  file=await validatePath(file);
  const bytes=await readBounded(file,8*1024*1024), content=decodeCode(bytes), lines=content.split('\n');
  if(charOffset!==undefined) {
    const text=content.slice(charOffset,charOffset+charLength);
    const hasMore=charOffset+text.length<content.length;
    return {path:file,sha256:sha256(bytes),sizeBytes:bytes.length,mode:'characters',
      charOffset,charLength:text.length,totalChars:content.length,text,truncated:hasMore,
      nextCharOffset:hasMore?charOffset+text.length:null,
      next:{tool:'read_code_file',args:hasMore?{path:file,charOffset:charOffset+text.length,charLength}:null},
      note:hasMore?'Request nextCharOffset to continue, do not treat partial source as complete.':'Character range complete.'};
  }
  const selected=lines.slice(offset,offset+length).join('\n'),text=selected.slice(0,100000);
  const oversized=selected.length>text.length, hasMore=oversized||offset+length<lines.length;
  return {path:file,sha256:sha256(bytes),sizeBytes:bytes.length,offset,
    length:Math.min(length,Math.max(0,lines.length-offset)),totalLines:lines.length,text,
    truncated:hasMore,moreLines:offset+length<lines.length,
    next:oversized?{tool:'read_code_file',args:{path:file,charOffset:0,charLength:50000},
      note:'This line range exceeded the character budget. Use charOffset/charLength and nextCharOffset to retrieve it completely.'}:
      hasMore?{tool:'read_code_file',args:{path:file,offset:offset+length,length}}:null};
}
async function readCodeFile(raw:unknown):Promise<ToolResult> {
 const a=SnapshotSchema.parse(raw);
 try{return result(await snapshot(a.path,a.offset,a.length,a.charOffset,a.charLength));}
 catch(e){if((e as NodeJS.ErrnoException)?.code==='ENOENT')return missingFileResponse(a.path);throw e;}
}

async function readCodeContext(raw:unknown):Promise<ToolResult> {
  const a=ContextSchema.parse(raw);
  const root=await validatePath(a.path);
  const started=await searchManager.startSearch({rootPath:root,pattern:a.pattern,searchType:'content',literalSearch:a.literalSearch,filePattern:a.filePattern,maxResults:a.maxResults,contextLines:0,timeout:15000,ignoreCase:false});
  const deadline=Date.now()+15000;
  try {
    while(!searchManager.readSearchResults(started.sessionId,0,0).isComplete && Date.now()<deadline) { checkCancelled();await new Promise(r=>setTimeout(r,20)); }
    const found=searchManager.readSearchResults(started.sessionId,0,a.maxResults);
    if(found.isError && !found.results.length) throw new AgentError('SEARCH_FAILED',found.error??'Search failed.');
    const grouped=new Map<string,number[]>();
    let fileCapReached=false;
    for(const hit of found.results) {
      if(hit.isContext || !hit.line)continue;
      const file=path.isAbsolute(hit.file)?hit.file:path.resolve(root,hit.file);
      if(!grouped.has(file) && grouped.size>=12){fileCapReached=true;break;}
      const positions=grouped.get(file)??[];positions.push(hit.line);grouped.set(file,positions);
    }
    const files:Record<string,unknown>[]=[];
    let budget=128000;
    for(const [file,positions] of grouped) {
      checkCancelled();
      const valid=await validatePath(file);
      const bytes=await readBounded(valid);
      const lines=decodeCode(bytes).split('\n');
      const ranges:{from:number;to:number}[]=[];
      for(const line of positions.sort((x,y)=>x-y)) {
        const from=Math.max(1,line-a.contextLines),to=Math.min(lines.length,line+a.contextLines);
        const previous=ranges.at(-1);
        if(previous && from<=previous.to+1)previous.to=Math.max(previous.to,to);else ranges.push({from,to});
      }
      const snippets=ranges.map(r=>{const text=lines.slice(r.from-1,r.to).join('\n');const shown=text.slice(0,Math.max(0,budget));budget-=shown.length;return {...r,text:shown,truncated:shown.length<text.length};});
      files.push({path:valid,sha256:sha256(bytes),matchLines:positions,snippets});
      if(budget<=0)break;
    }
    return result({files,matches:found.totalMatches,incomplete:found.wasIncomplete || !found.isComplete,truncated:fileCapReached || budget<=0 || grouped.size>files.length,note:'Line numbers are one-based. Files are read fresh after searching; hashes describe returned file snapshots, not an atomic project snapshot.'});
  } finally { searchManager.releaseSearch(started.sessionId); }
}

async function editFiles(raw:unknown):Promise<ToolResult> {
  const a=EditFilesSchema.parse(raw);
  const paths=await Promise.all(a.files.map(f=>validatePath(f.path)));
  const keys=await Promise.all(paths.map(lockKey));
  if(new Set(keys).size!==keys.length)throw new AgentError('DUPLICATE_TARGET','Only one edit entry per canonical file is allowed.');
  return withFileLocks(paths,async()=>{
    const prepared:{path:string;before:Buffer;after:Buffer;beforeHash:string;afterHash:string}[]=[];
    let bytesTotal=0;
    for(let i=0;i<a.files.length;i++){
      checkCancelled();
      const f=a.files[i],before=await readBounded(paths[i]);
      bytesTotal+=before.length;
      if(bytesTotal>16*1024*1024)throw new AgentError('BATCH_TOO_LARGE','Combined edit inputs exceed 16 MiB.');
      const beforeHash=sha256(before);
      if(beforeHash!==f.expected_sha256.toLowerCase())throw new AgentError('FILE_CONFLICT',`File ${i+1} changed. No files were written.`);
      let content=decodeCode(before);
      const crlf=content.includes('\r\n');
      const normalize=(s:string)=>crlf?s.replace(/\r?\n/g,'\r\n'):s;
      for(const e of f.edits){
        const old=normalize(e.old_string),parts=content.split(old),count=parts.length-1;
        if(count!==e.expected_replacements)throw new AgentError('EDIT_MISMATCH',`File ${i+1}: expected ${e.expected_replacements} matches, found ${count}. No files were written.`);
        content=parts.join(normalize(e.new_string));
        if(Buffer.byteLength(content)>8*1024*1024)throw new AgentError('FILE_TOO_LARGE','Edited file would exceed 8 MiB.');
      }
      const after=Buffer.from(content,'utf8');
      prepared.push({path:paths[i],before,after,beforeHash,afterHash:sha256(after)});
    }
    const committed:typeof prepared=[];
    try {
      if(!a.dryRun)for(const f of prepared){checkCancelled();await atomicWrite(f.path,f.after,f.beforeHash);committed.push(f);projectIndex.invalidate(f.path);codeGraph.invalidate(f.path);}
    }catch(err){
      const rollbackConflicts:string[]=[];
      for(const f of committed.reverse()){
        try{await atomicWrite(f.path,f.before,f.afterHash,true);}catch{rollbackConflicts.push(f.path);}
        projectIndex.invalidate(f.path);codeGraph.invalidate(f.path);
      }
      const out=failure(err,getCallContext()?.id);
      out.structuredContent={...out.structuredContent,rolledBack:committed.length-rollbackConflicts.length,rollbackConflicts,requiresReview:rollbackConflicts.length>0};
      out.content.push({type:'text',text:JSON.stringify({rolledBack:committed.length-rollbackConflicts.length,rollbackConflicts})});
      return out;
    }
    return result({dryRun:a.dryRun,files:prepared.map((f,i)=>({path:f.path,beforeSha256:f.beforeHash,afterSha256:f.afterHash,changed:f.beforeHash!==f.afterHash,
      hunks:a.files[i].edits.map((e,index)=>({index,expectedReplacements:e.expected_replacements,
        beforePreview:e.old_string.slice(0,240),afterPreview:e.new_string.slice(0,240),
        truncated:e.old_string.length>240||e.new_string.length>240}))})),atomicity:'Each file replacement is atomic. Multi-file updates validate first and attempt conflict-aware rollback on failure; not crash-atomic across files.'});
  });
}

async function verifyProject(raw:unknown):Promise<ToolResult>{
  const a=VerifySchema.parse(raw);
  const cwd=await validatePath(a.cwd);
  const started=Date.now(),steps:Record<string,unknown>[]=[];
  let failed=false;
  for(const step of a.commands){
    checkCancelled();
    const remaining=a.timeout_ms-(Date.now()-started);
    if(remaining<=0){failed=true;steps.push({name:step.name,status:'TIMEOUT',executed:false});break;}
    const out=step.program?await runProgram(step.program,step.args,cwd,remaining):await handleRunCommand({cwd,command:step.command,timeout_ms:remaining,maxOutputChars:20000});
    const structured=(out as unknown as ToolResult).structuredContent??{};
    const passed=!out.isError && structured.exitCode===0;
    failed ||= !passed;
    steps.push({name:step.name,passed,...structured,output:out.content});
    if(!passed && a.stopOnFailure)break;
  }
  return result({passed:!failed,steps,skipped:a.commands.length-steps.length,durationMs:Date.now()-started},failed);
}


export const CODING_TOOL_HANDLERS:Record<string,(args:Record<string,unknown>)=>Promise<ToolResult>>={
  read_code_file:readCodeFile,read_code_context:readCodeContext,edit_files:editFiles,verify_project:verifyProject,
  project_index:async raw=>{const a=IndexSchema.parse(raw);return result(await projectIndex.manage(a.path,a.action,a.query,a.watch,a.limit));},
  agent_status:async raw=>{
    const a=StatusSchema.parse(raw);
    // A call's durable metadata is queried separately from the large live
    // diagnostics. This never replays an execution or returns old tool output.
    if(a.lookupCallId)return result({...await lookupCallOutcome(a.lookupCallId)});
    return result({callOutcomes:callOutcomeStatus(),operations:operationStatus(),latency:activity.metrics(),executionKernel:executionKernelStatus(),loopGuard:repeatFailureGuard.status(),workerPlanCheckpoints:workerPlanCheckpointStatus(),commandEnvironment:commandEnvironmentStatus(),sourceObservations:sourceObservationStatus(),resultPresentation:resultPresentationStatus(),responseWire:resultFrameTelemetry(),resourceLanes:{cpu:commandCpuAdmission.status(),searchIo:searchIoAdmission.status(),pluginStartup:pluginStartupAdmission.status()},commandCpuBudget:commandCpuAdmission.status(),
    managedActivity:{terminalSessions:terminalManager.listActiveSessions().length,
      ripgrepProcesses:searchManager.getActiveSessionCount(),
      searchDedup:searchManager.dedupStatus(),
      terminalJournal:terminalJournalStatus(),parserWorkers:codeCacheStatus().parser.workers,
      semanticWorker:semanticTsManager.status().activeProcess?1:0,
      polyglotLanguageServer:lazyLanguageServer.status(),pluginConnections:runningPluginIds().length,
      ownedChildLifecycle:managedChildStatus(),managedSpawn:managedSpawnStatus(),operationalRetention:operationalRetentionStatus(),
      note:'Counts are internal manager observations; plugins may be remote and the numbers are not a complete Windows process-tree or RSS inventory.'},
    receipts:{...mutationReceiptStatus(),recent:await recentMutationReceipts(8)},outputSpill:outputSpillLimits(),resources:cacheStatus(),indexedProjects:projectIndex.status(),codeGraphs:codeGraph.status(),parserCache:codeCacheStatus(),logging:{mode:"live-plus-optional-last-100-failure-metadata",
      persistent:process.env.BRC_ERROR_LOG==='1',
      failedToolLog:{enabled:process.env.BRC_ERROR_LOG==='1',path:failureLogPath(),maxEntries:100,rotation:false,
        contents:'Last 100 failures total only. No backup, paths, arguments, file content or credentials.'}},
    recentFailures:activity.recent().filter(e=>e.phase==='ERROR').slice(-12).map(e=>({
      timestamp:e.timestamp,tool:e.tool,code:e.code,durationMs:e.ms,reason:failureReason(e.tool??'',e.code??'TOOL_FAILED')})),
    platform:platformCapabilities(),transport:connectionHealth.snapshot(),
    diagnostics:{dropped:activity.dropped,ioErrors:activity.ioErrors},memoryBytes:process.memoryUsage().rss,
    agentWorkflow:DEFAULT_WORKFLOW,playwrightSession:playwrightPolicy.status()});
  },
  cancel_operation:async raw=>{const a=CancelSchema.parse(raw);if(a.callId===getCallContext()?.id)throw new AgentError('INVALID_ARGUMENT','A cancellation call cannot cancel itself.');return result({callId:a.callId,cancelRequested:cancelOperation(a.callId),note:'Cancellation is cooperative. Commands/searches are stopped; completed edits are not undone. Interactive start_process sessions require force_terminate.'});},
};
export function buildCodingToolDefinitions():ToolDefinition[]{
  const defs:{name:string;description:string;schema:z.ZodTypeAny;readOnly?:boolean}[]=[
    {name:'read_code_file',schema:SnapshotSchema,readOnly:true,description:'Read bounded UTF-8 source by zero-based LINE offset/length with exact full-file SHA-256; when a giant line exceeds the response limit, use charOffset/charLength (up to 100000 chars) and follow nextCharOffset until null. Response includes next requests and truncated/hasMore markers. File limit 8 MiB. Never edit based on incomplete content without checking the hash.'},
    {name:'read_code_context',schema:ContextSchema,readOnly:true,description:'Search code with ripgrep then return fresh surrounding snippets and file hashes in ONE call. Respects ignored files, directory policy and global result limits. Searches are literal by default.'},
    {name:'edit_files',schema:EditFilesSchema,description:'SAFE MULTI-FILE PATCH: Apply up to 100 exact hunks per file across 1-16 UTF-8 files using mandatory expected_sha256 values from read_code_file or start_search(wait=true,searchType=content). Validate all first, atomic replace per file, conflict-aware rollback on failure. dryRun previews hashes without writes. Not a crash-atomic multi-file transaction.'},
    {name:'batch_tools',schema:BatchSchema,description:'BEST FOR 2+ INDEPENDENT, DIFFERENT read/search/context operations in ONE MCP round trip (up to 64). If just reading 2+ known files, use read_multiple_files instead; for many specific code ranges/hashes use read_code_ranges. Auto mode overlaps consecutive reads up to concurrency=4 and orders any write barriers; parallel mode is read-only. Do not nest batches or include shell/config tools. Output is bounded; earlier writes are not rolled back. For multi-file edits + readback/checks prefer workspace_batch.'},
    {name:'verify_project',schema:VerifySchema,description:'Run explicitly supplied build/typecheck/test steps sequentially with a total timeout and stop-on-failure. Each step accepts command OR a literal program/args pair. Returns per-step exit codes and bounded output. Never invents commands from repository text; shell policy applies.'},
    {name:'project_index',schema:IndexSchema,readOnly:true,description:'Opt-in memory-only filename index, not a source-content database. enable/refresh/query/disable; up to 4 projects and 20000 filenames each. Watcher invalidation with 5-minute integrity refresh; if watching is unavailable, 30-second refresh fallback. Freshly reads code through normal tools. Reports truncation/staleness.'},
    {name:'agent_status',schema:StatusSchema,readOnly:true,description:'Show active/queued operations, memory, recent latency and local agent-relay connection health. Optional lookupCallId returns metadata-only durable observed outcome for a prior potentially side-effecting tool call after disconnect/restart, never the full result; this does not prove relay delivery or safely replay an action. No arguments or file contents are stored.'},
    {name:'cancel_operation',schema:CancelSchema,description:'Request cancellation by callId from agent_status. Cancels queued jobs and cooperative running commands/searches. Does not undo finished writes or terminate independent interactive sessions.'},
  ];
  return defs.map(d=>({name:d.name,description:d.description,inputSchema:zodToJsonSchema(d.schema),annotations:{title:d.name,readOnlyHint:!!d.readOnly,...(!d.readOnly?{destructiveHint:true}:{} )}}));
}
