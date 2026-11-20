import {test} from 'node:test';
import assert from 'node:assert/strict';
import {executeCodeMode} from '../dist/runtime/code-mode.js';

const catalog=[{
  name:'read_file',
  description:'Read a file in the allowed project',
  inputSchema:{type:'object',properties:{path:{type:'string'}}}
}];
const params=(source)=>({source,max_runtime_ms:6000,max_calls:16});
const success=(value)=>({content:[{type:'text',text:value}]});

test('unawaited async guest RPC is reported without a QuickJS runtime assertion',async()=>{
  let finished=0;
  const out=await executeCodeMode(
    params('tools.call("read_file",{path:"later.txt"});return "completed too early";'),
    catalog,async()=>{
      await new Promise(resolve=>setTimeout(resolve,50));
      finished++;
      return success('late result');
    });
  assert.equal(out.isError,true,'Unawaited operations must not be reported as successful.');
  assert.match(JSON.stringify(out),/CODE_MODE_UNAWAITED_CALLS/);
  assert.doesNotMatch(JSON.stringify(out),/list_empty|JS_FreeRuntime|Assertion failed/);
  assert.equal(finished,1,'Return only after a started local call has finished.');
});

test('awaited guest RPCs continue to work without a QuickJS assertion',async()=>{
  const out=await executeCodeMode(
    params('const x=await tools.call("read_file",{path:"a.txt"}); return x.text;'),
    catalog,async()=>success('safe'));
  assert.equal(out.isError,undefined,JSON.stringify(out.structuredContent));
  assert.equal(out.structuredContent.result,'safe');
});
