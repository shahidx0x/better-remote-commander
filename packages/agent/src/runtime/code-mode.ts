/**
 * BRC-native Code Mode: one remote MCP invocation coordinates many LOCAL tool
 * calls. Model-supplied JavaScript executes in a bounded QuickJS/WASM worker,
 * never in Node's vm, eval, child_process, or the relay.
 *
 * Every guest tool call passes through the original dispatcher so filesystem
 * permissions, source preconditions, process policy, activity and receipts
 * still apply. No automatic replay of failed/uncertain writes is attempted.
 */
import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolResult } from 'brc-shared';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { AgentError, failure } from './errors.js';
import { getCallContext, withCallContext } from '../context.js';

type Args = Record<string,unknown>;
type Executor = (name:string,args:Args)=>Promise<ToolResult>;
type RpcRequest = {type:'call'|'search'|'describe';name?:unknown;args?:unknown;query?:unknown};
type RpcReply = {ok:boolean;value?:unknown;error?:{code:string;message:string}};
type Step = {tool:string;outcome:'ok'|'error'|'pending'|'uncertain';durationMs:number;errorCode?:string;jobId?:string;outputTruncated?:boolean};
type WorkerMessage =
  |{type:'rpc';id:number;request:RpcRequest}
  |{type:'done';value:unknown}
  |{type:'error';message:string};

export const CodeModeArgsSchema=z.object({
  source:z.string().min(1).max(50_000).describe(
    'JavaScript function BODY ending with return. Available API: tools.search(query), tools.describe(name), tools.call(name,args). Standard loops, branching, arrays, JSON and await are supported. No Node imports, filesystem access, fetch or process globals.'),
  max_runtime_ms:z.number().int().min(1000).max(105_000).optional().default(85_000).describe(
    'Total workflow deadline. For long builds use tools.call("spawn_job",...) and inspect the returned job ID in a later MCP call.'),
  max_calls:z.number().int().min(1).max(96).optional().default(48).describe(
    'Maximum nested local tool invocations. Tool discovery does not count against this budget.'),
});

// The source program cannot manufacture an arbitrary Node capability.
// These methods reuse existing BRC tools; they do not widen the account's
// allowedDirectories or bypass normal command, file and plugin policies.
export const CODE_MODE_ALLOWED_TOOLS=new Set([
  'read_file','read_multiple_files','read_code_file','list_directory','get_file_info',
  'start_search','get_more_search_results','stop_search','list_searches',
  'project_context','project_map','context_pack','code_graph','lsp_query',
  'write_file','edit_block','edit_files','apply_patch','create_directory','move_file','delete_file',
  'run_command','discover_checks','run_project_checks',
  'spawn_job','get_job','wait_jobs','cancel_job','run_parallel',
  'start_process','read_process_output','interact_with_process','list_sessions',
  'git_status','git_diff','git_log',
  'list_plugin_tools','call_plugin_tool','agent_status',
  'ast_search','find_symbols','find_references','write_pdf',
]);

const MAX_TOOL_TEXT=36_000;
const MAX_TOOL_RESPONSE=65_000;
const MAX_FINAL_RESPONSE=48_000;
const MAX_TOOL_DISCOVERY=24;
const MAX_SOURCE_OUTPUT=18_000;
let activeWorkflow=false;

function blocked(code:string,message:string,steps:Step[]=[]):ToolResult {
  const error=new AgentError(code,message,false);
  const base=failure(error);
  return {...base,structuredContent:{...base.structuredContent,
    codeMode:{completedSteps:steps,completedCalls:steps.length,partial:steps.length>0,
      automaticRetry:false}}};
}
function limited(value:unknown,size:number):string {
  let result='';
  try{result=JSON.stringify(value)??'null';}catch{return '[not JSON serializable]';}
  return result.length>size?result.slice(0,size):result;
}
/** Small, bounded schema-to-TypeScript hint similar to Cloudflare's
 * focused method declarations. JSON Schema remains the authority.
 */
function schemaAsTs(raw:unknown,depth=0):string{
  if(depth>5||!raw||typeof raw!=='object')return 'unknown';
  const s=raw as Record<string,unknown>;
  if(Array.isArray(s.enum)&&s.enum.length>0&&s.enum.length<=24)
    return s.enum.map(v=>JSON.stringify(v)).join(' | ');
  const variants=(s.anyOf??s.oneOf) as unknown[]|undefined;
  if(Array.isArray(variants)&&variants.length>0&&variants.length<=12)
    return variants.map(x=>schemaAsTs(x,depth+1)).join(' | ');
  if(Array.isArray(s.allOf)&&s.allOf.length>0&&s.allOf.length<=8)
    return (s.allOf as unknown[]).map(x=>schemaAsTs(x,depth+1)).join(' & ');
  if(s.type==='array')return '('+schemaAsTs(s.items,depth+1)+')[]';
  if(s.type==='object'||(s.properties&&typeof s.properties==='object')){
    const props=s.properties as Record<string,unknown>|undefined;
    const required=new Set(Array.isArray(s.required)?s.required:[]);
    const members=Object.entries(props??{}).slice(0,80).map(([name,child])=>
      JSON.stringify(name)+(required.has(name)?': ':'?: ')+schemaAsTs(child,depth+1)+';');
    if(s.additionalProperties===true)members.push('[key: string]: unknown;');
    return '{ '+members.join(' ')+' }';
  }
  if(s.type==='string'||s.type==='number'||s.type==='boolean'||s.type==='null')return s.type;
  if(s.type==='integer')return 'number';
  return 'unknown';
}
function describe(def:ToolDefinition):Record<string,unknown>{
  const signature='declare const tools: { call(name: '+JSON.stringify(def.name)+
    ', args: '+schemaAsTs(def.inputSchema)+'): Promise<ToolResult> };';
  return {name:def.name,description:def.description.slice(0,5000),
    inputSchema:def.inputSchema,types:signature.slice(0,6000)};
}
function search(catalog:ToolDefinition[],query:string):unknown {
  const terms=query.toLowerCase().trim().split(/[^a-z0-9_]+/).filter(x=>x.length>1).slice(0,12);
  if(!terms.length)return [];
  const hits=catalog.map(def=>{
    const name=def.name.toLowerCase();
    const desc=def.description.toLowerCase().slice(0,1300);
    const score=terms.reduce((sum,term)=>sum+
      (name===term?12:name.includes(term)?6:0)+(desc.includes(term)?1:0),0);
    return {def,score};
  }).filter(x=>x.score>0).sort((a,b)=>b.score-a.score||a.def.name.localeCompare(b.def.name));
  return hits.slice(0,12).map(x=>({name:x.def.name,description:x.def.description.slice(0,180)}));
}
function toolReply(result:ToolResult):{value:Record<string,unknown>;truncated:boolean}{
  const content=Array.isArray(result.content)?result.content:[];
  const textContent=content.filter(c=>c.type==='text').map(c=>c.text).join('\n');
  const mediaOmitted=content.some(c=>c.type!=='text');
  let value:Record<string,unknown>={
    text:textContent.slice(0,MAX_TOOL_TEXT),
    isError:!!result.isError,
    pending:result.structuredContent?.pending===true,
    mediaOmitted,
    ...(result.structuredContent?{structuredContent:result.structuredContent}:{})
  };
  let truncated=textContent.length>MAX_TOOL_TEXT;
  if(limited(value,MAX_TOOL_RESPONSE).length>=MAX_TOOL_RESPONSE){
    // Avoid truncated JSON, especially for image/PDF tool payloads. The
    // caller can request narrower ranges through the original tool.
    value={text:textContent.slice(0,MAX_SOURCE_OUTPUT),
      isError:!!result.isError,pending:result.structuredContent?.pending===true,
      outputTruncated:true,mediaOmitted,
      note:'The nested result exceeded the Code Mode limit. Request a smaller range or use the direct tool.'};
    truncated=true;
  }
  return {value,truncated};
}

export async function executeCodeMode(
  input:z.infer<typeof CodeModeArgsSchema>,catalog:ToolDefinition[],
  executor:Executor,outerSignal?:AbortSignal,
):Promise<ToolResult>{
  if(activeWorkflow)return blocked('CODE_MODE_BUSY','Another Code Mode workflow is already active on this device.');
  if(outerSignal?.aborted)return blocked('CODE_MODE_CANCELLED','The caller cancelled the workflow before it started.');
  activeWorkflow=true;
  const steps:Step[]=[];
  const pendingJobs:string[]=[];
  const parent=getCallContext();
  const controller=new AbortController();
  let activeTool=false;
  let closed=false;
  let calls=0;
  let discoveries=0;
  const catalogView=catalog.filter(t=>CODE_MODE_ALLOWED_TOOLS.has(t.name));
  const names=new Map(catalogView.map(t=>[t.name,t]));
  const started=Date.now();

  const handleRpc=async(request:RpcRequest):Promise<RpcReply>=>{
    if(controller.signal.aborted||closed)
      return {ok:false,error:{code:'CODE_MODE_CANCELLED',message:'Workflow has stopped.'}};
    if(!request||typeof request!=='object')
      return {ok:false,error:{code:'INVALID_ARGUMENT',message:'Invalid Code Mode request.'}};
    if(request.type==='search'||request.type==='describe'){
      if(++discoveries>MAX_TOOL_DISCOVERY)
        return {ok:false,error:{code:'CODE_MODE_DISCOVERY_LIMIT',message:'Too many schema lookups.'}};
      if(request.type==='search'){
        if(typeof request.query!=='string'||request.query.length>160)
          return {ok:false,error:{code:'INVALID_ARGUMENT',message:'Search query must be a short string.'}};
        return {ok:true,value:search(catalogView,request.query)};
      }
      const name=request.name;
      if(typeof name!=='string'||!names.has(name))
        return {ok:false,error:{code:'UNKNOWN_TOOL',message:'Tool is not available in Code Mode. Call tools.search first.'}};
      const result=describe(names.get(name)!);
      if(limited(result,MAX_TOOL_RESPONSE).length>=MAX_TOOL_RESPONSE)
        return {ok:false,error:{code:'CODE_MODE_SCHEMA_LIMIT',message:'Tool schema is too large to include in the sandbox.'}};
      return {ok:true,value:result};
    }
    if(request.type!=='call'||typeof request.name!=='string'||!names.has(request.name))
      return {ok:false,error:{code:'CODE_MODE_TOOL_DENIED',message:'Tool not permitted in Code Mode. Use tools.search for available tools.'}};
    if(!request.args||typeof request.args!=='object'||Array.isArray(request.args))
      return {ok:false,error:{code:'INVALID_ARGUMENT',message:'Tool arguments must be a JSON object.'}};
    if(++calls>input.max_calls)
      return {ok:false,error:{code:'CODE_MODE_CALL_LIMIT',message:'Nested tool call budget exhausted.'}};
    if(activeTool)
      return {ok:false,error:{code:'CODE_MODE_BUSY',message:'Nested calls must run sequentially.'}};
    const name=request.name;
    const args=request.args as Args;
    // Job/parallel composite tools accept nested tool names. Filter those
    // names as well so a hidden native capability cannot be tunneled through
    // an otherwise permitted wrapper.
    if(name==='spawn_job'||name==='run_parallel'){
      const steps=name==='spawn_job'?args.steps:args.calls;
      if(Array.isArray(steps))for(const step of steps){
        if(!step||typeof step!=='object'||Array.isArray(step))continue;
        const tool=(step as Record<string,unknown>).tool;
        if(tool!==undefined&&(!CODE_MODE_ALLOWED_TOOLS.has(String(tool))||
          tool==='spawn_job'||tool==='run_parallel'))
          return {ok:false,error:{code:'CODE_MODE_NESTED_TOOL_DENIED',
            message:'Nested job/parallel tool is not available in Code Mode.'}};
      }
    }
    if(limited(args,512*1024).length>=512*1024)
      return {ok:false,error:{code:'CODE_MODE_INPUT_LIMIT',message:'Nested tool arguments exceed 512 KiB.'}};
    const stepStart=Date.now();
    activeTool=true;
    try {
      const response=await (parent
        ?withCallContext({...parent,id:randomUUID(),signal:controller.signal,
          depth:(parent.depth??0)+1},()=>executor(name,args))
        :executor(name,args));
      const meta=(response.structuredContent??{}) as Record<string,unknown>;
      const pending=meta.pending===true;
      const error=meta.error as {code?:unknown}|undefined;
      const code=typeof error?.code==='string'?error.code:'TOOL_FAILED';
      const jobId=typeof meta.jobId==='string'?meta.jobId:undefined;
      const status=response.isError?'error':pending?'pending':'ok';
      const {value,truncated}=toolReply(response);
      steps.push({tool:name,outcome:status,durationMs:Date.now()-stepStart,
        ...(response.isError?{errorCode:code}:{}),
        ...(jobId?{jobId}:{}),...(truncated?{outputTruncated:true}:{})});
      if(pending&&jobId)pendingJobs.push(jobId);
      if(response.isError){
        const text=typeof value.text==='string'?value.text:'Tool failed.';
        return {ok:false,error:{code,message:text.slice(0,700)}};
      }
      return {ok:true,value};
    }catch(error){
      const code=controller.signal.aborted?'CODE_MODE_OUTCOME_UNCERTAIN':'CODE_MODE_TOOL_FAILED';
      steps.push({tool:name,outcome:controller.signal.aborted?'uncertain':'error',
        durationMs:Date.now()-stepStart,errorCode:code});
      return {ok:false,error:{code,message:error instanceof Error?error.message.slice(0,500):'Nested tool failed.'}};
    }finally{activeTool=false;}
  };

  let worker:Worker|undefined;
  let timer:NodeJS.Timeout|undefined;
  let abortListener:(()=>void)|undefined;
  try {
    return await new Promise<ToolResult>((resolve)=>{
      let settled=false;
      const clean=()=>{
        if(timer)clearTimeout(timer);
        if(abortListener)outerSignal?.removeEventListener('abort',abortListener);
        closed=true;
      };
      const finish=(out:ToolResult)=>{
        if(settled)return;
        settled=true;clean();resolve(out);
        void worker?.terminate().catch(()=>undefined);
      };
      const failureWithSteps=(code:string,message:string)=>blocked(code,message,steps);
      const stop=(code:string,message:string)=>{
        if(settled)return;
        controller.abort();
        worker?.postMessage({type:'cancel'});
        finish(failureWithSteps(code,
          message+(activeTool?' One nested tool may still be running; verify effects before retrying.':'')));
      };
      abortListener=()=>stop('CODE_MODE_CANCELLED','The workflow was cancelled.');
      outerSignal?.addEventListener('abort',abortListener,{once:true});
      timer=setTimeout(()=>stop('CODE_MODE_TIMEOUT',
        'The Code Mode deadline expired. Use spawn_job for a long build or test.'),input.max_runtime_ms);

      try{
        worker=new Worker(new URL('./code-mode-worker.js',import.meta.url),{
          workerData:{source:input.source,deadline:Date.now()+input.max_runtime_ms},
          resourceLimits:{maxOldGenerationSizeMb:96,maxYoungGenerationSizeMb:16,stackSizeMb:2},
        });
      }catch(error){
        finish(failureWithSteps('CODE_MODE_START_FAILED',
          error instanceof Error?error.message:'Could not start the sandbox.'));
        return;
      }
      worker.on('message',(message:WorkerMessage)=>{
        if(settled)return;
        if(message?.type==='rpc'){
          void handleRpc(message.request).then(reply=>{
            if(!settled)worker?.postMessage({type:'reply',id:message.id,reply});
          }).catch(error=>{
            if(!settled)worker?.postMessage({type:'reply',id:message.id,reply:{
              ok:false,error:{code:'CODE_MODE_BRIDGE_FAILED',
                message:error instanceof Error?error.message.slice(0,300):'RPC failed.'}}});
          });
          return;
        }
        if(message?.type==='error'){
          const code=message.message.startsWith('CODE_MODE_UNAWAITED_CALLS:')
            ?'CODE_MODE_UNAWAITED_CALLS':'CODE_MODE_SCRIPT_FAILED';
          finish(failureWithSteps(code,message.message.slice(0,900)));
          return;
        }
        if(message?.type==='done'){
          const rendered=limited(message.value,MAX_FINAL_RESPONSE);
          if(rendered.length>=MAX_FINAL_RESPONSE){
            finish(failureWithSteps('CODE_MODE_OUTPUT_LIMIT',
              'The returned result is too large. Return a bounded summary or use a direct read tool.'));
            return;
          }
          const pending=pendingJobs.length>0;
          const failedSteps=steps.filter(s=>s.outcome==='error'||s.outcome==='uncertain');
          // A script may catch a failed tool response and continue. Do not
          // present that as an entirely clean coding/testing run.
          const status=pending?'pending_jobs':failedSteps.length?'completed_with_step_errors':'completed';
          const summary='CODE MODE '+status.toUpperCase().replaceAll('_',' ')+
            ' | '+steps.length+' local tool call(s) | '+(Date.now()-started)+' ms'+
            (failedSteps.length?' | '+failedSteps.length+' failed/uncertain step(s)':'')+
            (pending?' | inspect jobs: '+pendingJobs.join(', '):'');
          finish({
            content:[{type:'text',text:summary+'\n'+rendered}],
            structuredContent:{
              result:message.value,steps,completedCalls:steps.length,
              status,allCallsSucceeded:failedSteps.length===0,
              pending,pendingJobs,executionCompleted:!pending,
              automaticRetry:false,
            },
          });
        }
      });
      worker.on('error',error=>finish(failureWithSteps('CODE_MODE_WORKER_FAILED',
        error.message.slice(0,500))));
      worker.on('exit',code=>{
        if(!settled)finish(failureWithSteps('CODE_MODE_WORKER_EXITED',
          'The sandbox exited before returning a result (exit '+code+').'));
      });
      if(outerSignal?.aborted)stop('CODE_MODE_CANCELLED','The workflow was cancelled.');
    });
  }finally{
    if(!controller.signal.aborted)controller.abort();
    activeWorkflow=false;
  }
}
