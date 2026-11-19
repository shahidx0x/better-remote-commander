import {test} from 'node:test';
import assert from 'node:assert/strict';
import {
 boundedAgentFrame,recordResultFrameQueued,resultFrameTelemetry
} from '../dist/transport/result-budget.js';
test('result-wire metrics store only bounded encoded sizes, never full payloads',()=>{
 const initial=resultFrameTelemetry();
 const small=boundedAgentFrame({type:'result',id:'one',
   result:{content:[{type:'text',text:'ok'}]}});
 const bigger=boundedAgentFrame({type:'result',id:'two',
   result:{content:[{type:'text',text:'é'.repeat(1700)}]}});
 const tooLarge=boundedAgentFrame({type:'result',id:'three',
   result:{content:[{type:'text',text:'z'.repeat(150000)}]}},64000);
 assert.equal(tooLarge.replaced,true);
 recordResultFrameQueued(small.encoded,small.replaced);
 recordResultFrameQueued(bigger.encoded,bigger.replaced);
 recordResultFrameQueued(tooLarge.encoded,tooLarge.replaced);
 const metrics=resultFrameTelemetry();
 assert.equal(metrics.framesQueued,initial.framesQueued+3);
 assert.equal(metrics.oversizeReplacementsQueued,initial.oversizeReplacementsQueued+1);
 assert.equal(metrics.encodedBytesQueued-initial.encodedBytesQueued,
   Buffer.byteLength(small.encoded)+Buffer.byteLength(bigger.encoded)+Buffer.byteLength(tooLarge.encoded));
 assert.ok(metrics.p95Bytes>=metrics.p50Bytes);
 assert.equal(metrics.retainsPayloads,false);
 assert.equal(metrics.retainedFrames,false);
 assert.ok(!JSON.stringify(metrics).includes('é'));
 assert.ok(!JSON.stringify(metrics).includes('zzzz'));
 assert.match(metrics.note,/does not prove relay delivery/i);
});
