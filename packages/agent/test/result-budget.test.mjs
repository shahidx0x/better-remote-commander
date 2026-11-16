import {test} from 'node:test';
import assert from 'node:assert/strict';
import {boundedAgentFrame,maxResultFrameBytes,DEFAULT_RESULT_FRAME_BYTES} from '../dist/transport/result-budget.js';

test('normal WebSocket result is unchanged and default budget is bounded',()=>{
 assert.equal(maxResultFrameBytes(undefined),DEFAULT_RESULT_FRAME_BYTES);
 assert.equal(maxResultFrameBytes('1'),DEFAULT_RESULT_FRAME_BYTES);
 assert.equal(maxResultFrameBytes('99999999'),DEFAULT_RESULT_FRAME_BYTES);
 assert.equal(maxResultFrameBytes('262144'),262144);
 const msg={type:'result',id:'x',result:{content:[{type:'text',text:'hello'}]}};
 const frame=boundedAgentFrame(msg);
 assert.equal(frame.replaced,false);
 assert.deepEqual(JSON.parse(frame.encoded),msg);
});

test('oversized tool output becomes a small structured recovery error, never a giant frame',()=>{
 const msg={type:'result',id:'write-123',result:{
  content:[{type:'text',text:'X'.repeat(700000)}],
  structuredContent:{nested:'A'.repeat(650000)},
 }};
 const frame=boundedAgentFrame(msg);
 assert.equal(frame.replaced,true);
 assert.ok(Buffer.byteLength(frame.encoded)<15000);
 const decoded=JSON.parse(frame.encoded);
 assert.equal(decoded.type,'result');
 assert.equal(decoded.id,msg.id);
 assert.equal(decoded.result.isError,true);
 assert.equal(decoded.result.structuredContent.error.code,'RESULT_TOO_LARGE');
 assert.equal(decoded.result.structuredContent.recovery.automaticRetry,false);
 assert.match(decoded.result.content[0].text,/MAY already have completed/);
});

test('uncodable result never crashes response channel; non-result still fails closed',()=>{
 const bad={type:'result',id:'bad',result:{content:[],count:1n}};
 const safe=boundedAgentFrame(bad);
 assert.equal(safe.replaced,true);
 assert.equal(JSON.parse(safe.encoded).result.structuredContent.error.code,'RESULT_TOO_LARGE');
 assert.throws(()=>boundedAgentFrame({type:'ping',ts:1n}));
});
