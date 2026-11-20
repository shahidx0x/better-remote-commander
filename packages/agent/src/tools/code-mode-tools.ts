/** Code Mode is one BRC MCP tool, backed by a local QuickJS/WASM worker. */
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolResult } from 'brc-shared';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { CodeModeArgsSchema, executeCodeMode } from '../runtime/code-mode.js';
import { AgentError, failure } from '../runtime/errors.js';
import { getCallContext } from '../context.js';

type Executor=(name:string,args:Record<string,unknown>)=>Promise<ToolResult>;
let executor:Executor|undefined;
let catalog:()=>ToolDefinition[]=()=>[];

export function setCodeModeToolExecutor(fn:Executor,getCatalog:()=>ToolDefinition[]):void{
  executor=fn;
  catalog=getCatalog;
}

export const CODE_MODE_TOOL_HANDLERS:Record<string,
  (args:Record<string,unknown>)=>Promise<ToolResult>>={
  code_mode:async(args)=>{
    if(!executor)return failure(new AgentError('CODE_MODE_UNAVAILABLE','Code Mode dispatcher is not initialized.'));
    const parsed=CodeModeArgsSchema.safeParse(args);
    if(!parsed.success)return failure(new AgentError('INVALID_ARGUMENT',
      'Invalid code_mode request: '+parsed.error.message.slice(0,600)));
    return executeCodeMode(parsed.data,catalog(),executor,getCallContext()?.signal);
  }
};

export function buildCodeModeToolDefinitions():ToolDefinition[]{
  return [{
    name:'code_mode',
    description:[
      'USE WHEN: PRIMARY DEFAULT for multi-step coding, testing, debugging, project research and installed-plugin workflows. Compose dependent calls, branching and filtered outputs in one MCP request.',
      'USE INSTEAD: Direct read_file/edit_block/run_command for a single simple action; spawn_job for long builds.',
      'IMPORTANT: Runs JavaScript in a bounded QuickJS/WASM sandbox ON THE PAIRED DEVICE (not the relay).',
      'The sandbox has NO Node.js process, filesystem, imports, browser, fetch or unrestricted host execution.',
      'Only tools.search(query), tools.describe(name) and tools.call(name,args) are available. describe returns JSON Schema and a TypeScript signature; each tool call',
      'runs through the normal BRC dispatcher, permissions, source hashes, and cancellation policy.',
      'Provide JavaScript statements in source and finish with return. Example:',
      'const a=await tools.call("git_status",{path:"D:/repo"});',
      'return {status:a.text.slice(0,1000)};',
      'Always await tools.search, tools.describe and tools.call. Loops and conditionals are supported. tools.call resolves to {text,structuredContent,pending,...}.',
      'A nested tool failure throws by default; use try/catch ONLY when recovery is understood. Caught tool failures remain flagged in the final structured status.',
      'For a long build use await tools.call("spawn_job", {command:"...",cwd:"..."}) and return the jobId;',
      'then use get_job/wait_jobs in subsequent direct MCP calls. Do not claim a pending job is complete.',
      'Never automatically repeat uncertain writes, and never use Code Mode to bypass user authorization.',
      'Discovery and tool-result payloads are bounded; binary previews should use direct tools.',
    ].join(' '),
    inputSchema:zodToJsonSchema(CodeModeArgsSchema),
    annotations:{title:'Code Mode (local sandbox)',readOnlyHint:false,destructiveHint:true},
  }];
}
