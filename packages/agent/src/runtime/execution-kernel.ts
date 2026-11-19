/**
 * Shared execution boundary for BRC's MCP dispatcher, jobs and plugin tools.
 *
 * - Centralizes preflight, cooperative cancellation, canonical lock scope and
 *   metadata-only mutation receipts without changing public MCP tool names.
 * - NEVER retries a mutation, shell command or plugin tool call.
 * - Classification describes what the agent observed. 'failed' is NOT a
 *   rollback guarantee; an uncertain cancellation is explicitly marked.
 * - Filesystem scope checks remain enforced by each underlying tool as well.
 */
import {AgentError} from './errors.js';
import {checkCancelled} from '../context.js';
import {validatePath} from '../core/tools/filesystem.js';
import {lockKey,withFileLocks} from './file-safety.js';
import {beginMutationReceipt,settleMutationReceipt} from './operation-receipts.js';
import type {ToolResult} from 'brc-shared';

export type ExecutionOutcome = 'completed'|'failed'|'pending'|'uncertain';
export type ExecutionKind = 'read'|'filesystem_mutation'|'external_mutation';
type ExecutionOptions = {
  name:string;
  callId:string;
  kind:ExecutionKind;
  paths?:string[];
  recordReceipt?:boolean;
  preflight?:()=>Promise<void>;
  perform:()=>Promise<ToolResult>;
};

const UNCERTAIN_CODES=new Set([
  'TOOL_OUTCOME_UNCERTAIN','PLUGIN_CALL_OUTCOME_UNCERTAIN',
  'EXECUTION_OUTCOME_UNCERTAIN','OPERATION_OUTCOME_UNCERTAIN'
]);
const AMBIGUOUS_INTERRUPTS=new Set([
  'CANCELLED','TIMEOUT','ETIMEDOUT','ABORT_ERR','PLUGIN_TRANSPORT'
]);
type ObservedResult={isError?:boolean;structuredContent?:unknown};
function codeFrom(result:ObservedResult):string|undefined {
  const value=(result.structuredContent as {error?:{code?:unknown}}|undefined)?.error?.code;
  return typeof value==='string'?value:undefined;
}
export function classifyExecution(
  result:ObservedResult,kind:ExecutionKind='read'
):ExecutionOutcome {
  const meta=result.structuredContent as {pending?:unknown;error?:{code?:unknown}}|undefined;
  const code=codeFrom(result);
  if(meta?.pending===true)return 'pending';
  if(!result.isError)return 'completed';
  if((code && (UNCERTAIN_CODES.has(code) || /(?:^|_)UNCERTAIN$/.test(code))) ||
     (kind!=='read'&&code&&AMBIGUOUS_INTERRUPTS.has(code)))
    return 'uncertain';
  return 'failed';
}
export function attachExecutionOutcome(
  result:ToolResult,tool:string,callId:string,kind:ExecutionKind
):ToolResult{
  const state=classifyExecution(result,kind);
  // Use MCP _meta instead of inflating tool-owned structuredContent. Some
  // code_graph/context_pack results have strict maxChars budgets and the
  // original result must remain byte-for-byte within its advertised limit.
  return {...result,_meta:{
    ...result._meta,
    executionOutcome:{
      state,tool,callId,
      // Tool failure is not proof of rollback. No mutation auto-replay.
      automaticRetry:false,
      sideEffectsPossible:kind!=='read'&&
        (state!=='failed'||!!result.isError),
    }
  }};
}

const telemetry={calls:0,completed:0,failed:0,pending:0,uncertain:0,
  lockedMutations:0,totalLockWaitMs:0,maxLockWaitMs:0};
export function executionKernelStatus(){
  return {...telemetry,automaticMutationReplay:false,
    tracksArguments:false,retainsResults:false};
}
export function trackExecutionOutcome(outcome:ExecutionOutcome):void{
  telemetry.calls++;
  telemetry[outcome]++;
}
export async function executeToolKernel(options:ExecutionOptions):Promise<ToolResult>{
  checkCancelled();
  await options.preflight?.();
  checkCancelled();

  const mutate=options.kind!=='read';
  const run=async(canonicalPaths:string[]):Promise<ToolResult>=>{
    checkCancelled();
    const receipt=mutate&&options.recordReceipt
      ?await beginMutationReceipt(options.callId,options.name,canonicalPaths)
      :null;
    try{
      checkCancelled();
      const result=await options.perform();
      const outcome=classifyExecution(result,options.kind);
      const receiptOutcome=outcome==='uncertain'||outcome==='pending'
        ?'uncertain':outcome==='failed'?'reported_failure':'returned_success';
      await settleMutationReceipt(receipt,canonicalPaths,receiptOutcome,codeFrom(result));
      return result;
    }catch(error){
      await settleMutationReceipt(receipt,canonicalPaths,'uncertain',
        (error as {code?:string})?.code??'UNEXPECTED_EXCEPTION');
      throw error;
    }
  };

  if(options.kind!=='filesystem_mutation')return run([]);
  const paths=options.paths??[];
  // Validate before taking locks. Use canonical target identities to
  // serialize symlink aliases and writes to the same target.
  const checked=await Promise.all(paths.map(p=>validatePath(p)));
  const startWait=performance.now();
  return withFileLocks(checked,async()=>{
    const waited=Math.max(0,performance.now()-startWait);
    telemetry.lockedMutations++;
    telemetry.totalLockWaitMs+=waited;
    telemetry.maxLockWaitMs=Math.max(telemetry.maxLockWaitMs,waited);
    // A symlink/junction may be retargeted while waiting for the lock.
    // Revalidate inside the lock. A different canonical target is rejected,
    // rather than executing against an unprotected/unauthorized destination.
    for(let i=0;i<paths.length;i++){
      checkCancelled();
      const current=await validatePath(paths[i]);
      if(await lockKey(current)!==await lockKey(checked[i]))
        throw new AgentError('PATH_CHANGED',
          'The resolved file target changed while waiting for its lock. No operation was executed; re-read the path and retry only after confirming the target.');
    }
    return run(checked);
  });
}
