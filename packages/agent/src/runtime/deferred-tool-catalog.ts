/** Optional host-compatible two-stage MCP tool registry.
 *
 * The relay already forwards the agent's advertised tool definitions. In
 * BRC_TOOL_PROFILE=deferred, advertise two stable tools: a read-only catalog
 * search/inspection and a strictly forwarded invocation of a named native
 * tool. Native tool schemas/handlers and their policy stay authoritative.
 *
 * Default remains the existing complete tool list. Do not activate this mode
 * silently for clients that expect the original 80 direct tool names.
 */
import type {ToolDefinition} from '../core/tool-definitions.js';
import {TOOL_CHOICES} from '../tool-routing.js';
import {AgentError} from './errors.js';

export const deferredProfileEnabled=()=>process.env.BRC_TOOL_PROFILE==='deferred';
export const DEFERRED_TOOL_NAMES=new Set(['discover_tools','invoke_tool']);
export function deferredToolDefinitions():ToolDefinition[]{
 return [
  {name:'discover_tools',
   description:'Search BRC tools by task words or exact names. Returns short when-to-use rules; includeSchema=true to retrieve exact JSON input schemas for selected tools. For unknown names or ambiguous tasks, discover before invoking. Pagination uses offset/limit. This never runs a tool.',
   inputSchema:{type:'object',additionalProperties:false,properties:{
    query:{type:'string',maxLength:256},names:{type:'array',items:{type:'string',minLength:1,maxLength:120},maxItems:16},
    includeSchema:{type:'boolean',default:false},
    offset:{type:'integer',minimum:0,maximum:80,default:0},
    limit:{type:'integer',minimum:1,maximum:12,default:8}
   }},
   annotations:{readOnlyHint:true}},
  {name:'invoke_tool',
   description:'Invoke ONE exact BRC native tool after discover_tools identifies its name and inputSchema. Arguments must match that tool schema. All native validation, filesystem policy, cancellation, audit and outcome rules still apply; never replay uncertain writes/commands. This can mutate files or execute code. Do not invoke itself or discover_tools.',
   inputSchema:{type:'object',additionalProperties:false,required:['name','args'],
    properties:{name:{type:'string',minLength:1,maxLength:120},
      args:{type:'object',additionalProperties:true}}},
   annotations:{readOnlyHint:false}}
 ];
}
function normalized(value:string):string[]{
 return value.toLowerCase().split(/[^a-z0-9]+/).filter(s=>s.length>=2).slice(0,24);
}
/** Common user task wording not identical to an MCP tool name. This guide
 * augments, but does not replace, the exact per-tool input schema/policies.
 * Keep phrases generic enough to work for new user requests, not benchmarks.
 */
const TASK_ALIASES:Readonly<Record<string,readonly string[]>>={
 edit_block:['text replacement','exact replacement','precise edit','replace text in one file'],
 workspace_batch:['coordinated edits','multiple file edits','multi file edits','several source files'],
 read_symbol:['declaration by name','read declaration','named declaration'],
};
function scoreTool(tool:ToolDefinition,query:string,tokens:string[]):number{
 const name=tool.name.toLowerCase(),rule=TOOL_CHOICES[tool.name];
 const use=rule?.use.toLowerCase()??'',instead=rule?.instead.toLowerCase()??'';
 const all=name.replace(/_/g,' ')+' '+use;
 const raw=query.toLowerCase().trim();
 let score=name===raw?1000:name.replace(/_/g,' ')===raw?900:0;
 if(raw&&all.includes(raw))score+=90;
 // Prefer a few unambiguous user-task phrases over incidental common terms
 // like "file" and "read" appearing across many tools.
 if((TASK_ALIASES[tool.name]??[]).some(phrase=>raw.includes(phrase)))score+=110;
 for(const token of tokens){
  if(name.split('_').includes(token))score+=20;
  else if(name.includes(token))score+=10;
  if(use.includes(token))score+=5;
  if(instead.includes(token))score-=1;
 }
 return score;
}
export function discoverNativeTools(raw:Record<string,unknown>,catalog:ToolDefinition[]):Record<string,unknown>{
 const query=typeof raw.query==='string'?raw.query.trim():'';
 if(query.length>256)throw new AgentError('INVALID_ARGUMENT','query must not exceed 256 characters.');
 const names=raw.names===undefined?[]:raw.names;
 if(!Array.isArray(names)||names.length>16||names.some(x=>typeof x!=='string'||!x||x.length>120))
  throw new AgentError('INVALID_ARGUMENT','names must be an array of up to 16 exact tool names.');
 const offset=raw.offset===undefined?0:typeof raw.offset==='number'?raw.offset:NaN;
 const limit=raw.limit===undefined?8:typeof raw.limit==='number'?raw.limit:NaN;
 if(!Number.isSafeInteger(offset)||offset<0||offset>80||!Number.isSafeInteger(limit)||limit<1||limit>12)
  throw new AgentError('INVALID_ARGUMENT','offset and limit must be within their schema bounds.');
 if(raw.includeSchema!==undefined&&typeof raw.includeSchema!=='boolean')
  throw new AgentError('INVALID_ARGUMENT','includeSchema must be boolean.');
 const includeSchema=raw.includeSchema===true;
 const known=new Map(catalog.map(t=>[t.name,t]));
 const requested=names as string[];
 const missing=requested.filter(n=>!known.has(n));
 const tokens=normalized(query);
 const byName=requested.length?requested.flatMap(n=>known.has(n)?[known.get(n)!]:[]):
  [...catalog].map(t=>({t,score:scoreTool(t,query,tokens)}))
   .filter(e=>!query||e.score>0).sort((a,b)=>b.score-a.score||a.t.name.localeCompare(b.t.name))
   .map(e=>e.t);
 const matched=requested.length?byName:byName;
 const selected=matched.slice(offset,offset+limit);
 const tools=selected.map(t=>{
  const rule=TOOL_CHOICES[t.name];
  return {name:t.name,use:rule?.use??'',instead:rule?.instead??'',
   readOnly:t.annotations?.readOnlyHint===true,
   ...(includeSchema?{inputSchema:t.inputSchema}:{}),
   next:{tool:'invoke_tool',args:{name:t.name,args:{}}}};
 });
 const hasMore=offset+tools.length<matched.length;
 return {mode:'deferred',catalogCount:catalog.length,matchedCount:matched.length,
  tools,missingNames:missing,hasMore,offset,
  ...(hasMore?{next:{tool:'discover_tools',args:{query,names:requested,offset:offset+tools.length,limit,includeSchema}}}:{}),
  note:includeSchema?'Exact native schemas returned. No tools executed. Invoke with validated arguments.':
   'Short routing summaries only; request includeSchema=true for exact native argument requirements.'};
}
