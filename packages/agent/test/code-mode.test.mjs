import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeCodeMode,CODE_MODE_ALLOWED_TOOLS} from '../dist/runtime/code-mode.js';
import {listTools} from '../dist/dispatcher.js';

const catalog=[
  {name:'read_file',description:'Read one known project file',inputSchema:{type:'object',properties:{path:{type:'string'}}}},
  {name:'write_file',description:'Write one project file',inputSchema:{type:'object',properties:{path:{type:'string'},content:{type:'string'}}}},
  {name:'run_command',description:'Execute a build or test command',inputSchema:{type:'object',properties:{command:{type:'string'}}}},
  {name:'set_config_value',description:'Change local access configuration',inputSchema:{type:'object'}},
];
const args=(source,opts={})=>({source,max_runtime_ms:6000,max_calls:12,...opts});
const text=value=>({content:[{type:'text',text:value}]});

test('Code Mode appears as a native agent tool and has a strict bounded schema',()=>{
 const def=listTools().find(x=>x.name==='code_mode');
 assert.ok(def);
 assert.match(def.description,/USE WHEN:/);
 assert.match(def.description,/USE INSTEAD:/);
 assert.ok(def.inputSchema.properties.source);
 assert.ok(CODE_MODE_ALLOWED_TOOLS.has('edit_files'));
 assert.ok(CODE_MODE_ALLOWED_TOOLS.has('call_plugin_tool'));
 assert.ok(!CODE_MODE_ALLOWED_TOOLS.has('set_config_value'));
 assert.ok(!CODE_MODE_ALLOWED_TOOLS.has('code_mode'),'recursive execution denied');
});

test('isolated Code Mode loops over dependent local calls with await, discovery and bounded output',async()=>{
 const calls=[];
 const executor=async(name,parameters)=>{
   calls.push({name,parameters});
   return text(name==='read_file'?'FILE:'+parameters.path:'COMMAND PASSED');
 };
 const source=[
   'const matches=await tools.search("file");',
   'const schema=await tools.describe("read_file");',
   'const files=[];',
   'for(const path of ["a.txt","b.txt"]){',
   ' const reply=await tools.call("read_file",{path});',
   ' files.push(reply.text);',
   '}',
   'if(files.length!==2)throw new Error("missing file");',
   'return {files,found:matches.length,tool:schema.name};'
 ].join('\n');
 const out=await executeCodeMode(args(source),catalog,executor);
 assert.equal(out.isError,undefined,JSON.stringify(out));
 assert.deepEqual(out.structuredContent.result,
   {files:['FILE:a.txt','FILE:b.txt'],found:2,tool:'read_file'});
 assert.deepEqual(calls.map(x=>x.name),['read_file','read_file']);
 assert.equal(out.structuredContent.completedCalls,2);
 assert.equal(out.structuredContent.executionCompleted,true);
});

test('focused discovery returns the actual schema plus a bounded TypeScript call signature',async()=>{
 const out=await executeCodeMode(args('const d=await tools.describe("read_file");return {name:d.name,typed:d.types.includes("call(name:"),schema:d.inputSchema.properties.path.type};'),catalog,async()=>text('unused'));
 assert.equal(out.isError,undefined);
 assert.deepEqual(out.structuredContent.result,{name:'read_file',typed:true,schema:'string'});
});

test('guest has no Node process, filesystem imports, require, fetch or global host APIs',async()=>{
 const out=await executeCodeMode(args([
   'return {process:typeof process,require:typeof require,fetch:typeof fetch,',
   '  module:typeof module,Buffer:typeof Buffer,brc:typeof __brcHost};'
 ].join('\n')),[],async()=>{throw new Error('unexpected host call')});
 assert.equal(out.isError,undefined);
 assert.deepEqual(out.structuredContent.result,{
   process:'undefined',require:'undefined',fetch:'undefined',module:'undefined',
   Buffer:'undefined',brc:'undefined'
 });
});

test('model-authored JavaScript cannot invoke configuration tools or Code Mode recursively',async()=>{
 let invoked=false;
 const code='await tools.call("set_config_value",{key:"allowedDirectories",value:["C:/"]}); return 1;';
 const out=await executeCodeMode(args(code),catalog,async()=>{
   invoked=true;return text('wrong');
 });
 assert.equal(out.isError,true);
 assert.match(out.structuredContent.error.code,/CODE_MODE_SCRIPT_FAILED/);
 assert.match(out.content[0].text,/CODE_MODE_TOOL_DENIED/);
 assert.equal(invoked,false);
});

test('composite jobs cannot tunnel excluded tools through the Code Mode allowlist',async()=>{
 let calls=0;
 const source='await tools.call("spawn_job",{steps:[{tool:"set_config_value",args:{key:"x"}}]});return 1;';
 const enhanced=[...catalog,{name:'spawn_job',description:'Run background steps',inputSchema:{type:'object'}}];
 const out=await executeCodeMode(args(source),enhanced,async()=>{calls++;return text('wrong');});
 assert.equal(out.isError,true);
 assert.equal(calls,0);
 assert.match(out.content[0].text,/CODE_MODE_NESTED_TOOL_DENIED/);
});

test('nested failure stops workflow by default; later writes are not started',async()=>{
 const calls=[];
 const out=await executeCodeMode(args([
   'await tools.call("run_command",{command:"bad"});',
   'await tools.call("write_file",{path:"after.txt",content:"NO"});',
   'return "done";',
 ].join('\n')),catalog,async(name)=>{
   calls.push(name);
   return {isError:true,content:[{type:'text',text:'COMMAND_FAILED: exit 1'}],
     structuredContent:{error:{code:'COMMAND_FAILED',message:'exit 1'},exitCode:1}};
 });
 assert.equal(out.isError,true);
 assert.deepEqual(calls,['run_command']);
 assert.equal(out.structuredContent.codeMode.partial,true);
 assert.equal(out.structuredContent.codeMode.completedCalls,1);
});

test('a pending build returns job IDs and does not pretend tests finished',async()=>{
 const source=[
   'const build=await tools.call("run_command",{command:"build"});',
   'return {pending:build.pending,jobId:build.structuredContent.jobId};'
 ].join('\n');
 const out=await executeCodeMode(args(source),catalog,async()=>({
   content:[{type:'text',text:'build started'}],
   structuredContent:{pending:true,jobId:'job-test-42'}
 }));
 assert.equal(out.isError,undefined);
 assert.equal(out.structuredContent.pending,true);
 assert.equal(out.structuredContent.executionCompleted,false);
 assert.deepEqual(out.structuredContent.pendingJobs,['job-test-42']);
});

test('max_calls enforces a hard limit without running an extra tool',async()=>{
 let calls=0;
 const out=await executeCodeMode(args([
   'for(let i=0;i<3;i++)await tools.call("read_file",{path:String(i)});',
   'return "unexpected";'
 ].join('\n'),{max_calls:2}),catalog,async()=>{
   calls++;return text('ok');
 });
 assert.equal(out.isError,true);
 assert.equal(calls,2);
 assert.match(out.content[0].text,/CODE_MODE_CALL_LIMIT/);
});

test('fifty dependent local tool calls fit inside one Code Mode execution when explicitly budgeted',async()=>{
 let calls=0;
 const source='let count=0;for(let i=0;i<50;i++){const reply=await tools.call("read_file",{path:"mock"});if(reply.text!=="ok")throw Error("unexpected response");count++}return count;';
 const out=await executeCodeMode(args(source,{max_calls:64,max_runtime_ms:15000}),catalog,async()=>{
   calls++;return text('ok');
 });
 assert.equal(out.isError,undefined,JSON.stringify(out.structuredContent));
 assert.equal(calls,50);
 assert.equal(out.structuredContent.completedCalls,50);
 assert.equal(out.structuredContent.result,50);
 assert.equal(out.structuredContent.status,'completed');
});

test('caught nested failures are clearly flagged rather than reported as clean',async()=>{
 const out=await executeCodeMode(args('try{await tools.call("run_command",{command:"bad"})}catch(e){}return "handled";'),catalog,async()=>({
   isError:true,content:[{type:'text',text:'exit 1'}],structuredContent:{error:{code:'COMMAND_FAILED'}}
 }));
 assert.equal(out.isError,undefined);
 assert.equal(out.structuredContent.status,'completed_with_step_errors');
 assert.equal(out.structuredContent.allCallsSucceeded,false);
 assert.equal(out.structuredContent.steps[0].outcome,'error');
});

test('infinite loops are interrupted and the worker slot is released',async()=>{
 const out=await executeCodeMode(args('while(true){}',{max_runtime_ms:1200}),
   [],async()=>{throw new Error('unexpected')});
 assert.equal(out.isError,true);
 assert.ok(['CODE_MODE_SCRIPT_FAILED','CODE_MODE_TIMEOUT'].includes(out.structuredContent.error.code));
 const next=await executeCodeMode(args('return 7;'),[],async()=>text('unused'));
 assert.equal(next.isError,undefined);
 assert.equal(next.structuredContent.result,7);
});

test('guest return payload is bounded, without storing source as an activity log',async()=>{
 const out=await executeCodeMode(args('return "a".repeat(90000);'),[],async()=>text('unused'));
 assert.equal(out.isError,true);
 assert.equal(out.structuredContent.error.code,'CODE_MODE_OUTPUT_LIMIT');
});
