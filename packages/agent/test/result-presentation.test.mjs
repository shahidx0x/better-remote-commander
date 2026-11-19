import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {result} from '../dist/runtime/errors.js';
import {boundedAgentFrame} from '../dist/transport/result-budget.js';
import {resultPresentationMode} from '../dist/runtime/result-presentation.js';
const before=process.env.BRC_RESULT_TEXT_MODE;
after(()=>{if(before===undefined)delete process.env.BRC_RESULT_TEXT_MODE;else process.env.BRC_RESULT_TEXT_MODE=before;});
const big={items:Array.from({length:300},(_,i)=>({path:'src/module-'+i+'.ts',
  sha256:'a'.repeat(64),symbols:['alpha','beta','gamma','delta','epsilon']})),
  count:300,partial:false,sourceVerified:true};

test('legacy mode retains existing pretty-printed response for compatibility',()=>{
 process.env.BRC_RESULT_TEXT_MODE='legacy';
 const r=result({hello:'world',nested:{a:1}});
 assert.equal(r.content[0].text,JSON.stringify(r.structuredContent,null,2));
 assert.equal(resultPresentationMode(),'legacy');
});

test('opt-in compact text cuts wire bytes while retaining full structuredContent',()=>{
 process.env.BRC_RESULT_TEXT_MODE='legacy';
 const original=result(big);
 const oldFrame=boundedAgentFrame({type:'result',id:'perf-test',result:original});
 assert.equal(oldFrame.replaced,false);
 process.env.BRC_RESULT_TEXT_MODE='compact';
 const compact=result(big);
 const nextFrame=boundedAgentFrame({type:'result',id:'perf-test',result:compact});
 assert.equal(nextFrame.replaced,false);
 assert.deepEqual(compact.structuredContent,original.structuredContent);
 assert.ok(compact.content[0].text.length<640);
 assert.match(compact.content[0].text,/structuredContent/);
 assert.ok(Buffer.byteLength(nextFrame.encoded)*2<Buffer.byteLength(oldFrame.encoded),
  'expected at least 50% response-byte reduction in this fixture');
 console.log('RESULT_PRESENTATION_BYTES='+JSON.stringify({
   legacy:Buffer.byteLength(oldFrame.encoded),compact:Buffer.byteLength(nextFrame.encoded)
 }));
});

test('small results and error codes remain readable in compact mode',()=>{
 process.env.BRC_RESULT_TEXT_MODE='compact';
 const small=result({ok:true,value:42});
 assert.match(small.content[0].text,/value/);
 const fault=result({error:{code:'SAMPLE_ERROR',message:'Do not run again'},payload:'x'.repeat(4000)},true);
 assert.equal(fault.isError,true);
 assert.equal(fault.structuredContent.error.code,'SAMPLE_ERROR');
 assert.match(fault.content[0].text,/SAMPLE_ERROR/);
 assert.match(fault.content[0].text,/Do not run again/);
});
