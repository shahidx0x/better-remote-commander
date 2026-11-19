import {test,after} from 'node:test';
import assert from 'node:assert/strict';
import {
 compactDuplicatedToolText,resultDeduplicationStatus,resultPresentationStatus
} from '../dist/runtime/result-presentation.js';
import {boundedAgentFrame} from '../dist/transport/result-budget.js';
const previous=process.env.BRC_RESULT_TEXT_MODE;
after(()=>{if(previous===undefined)delete process.env.BRC_RESULT_TEXT_MODE;
 else process.env.BRC_RESULT_TEXT_MODE=previous;});
const large={files:Array.from({length:160},(_,i)=>({
 path:'src/entry-'+i+'.ts',sha256:'a'.repeat(64),symbols:['a','b','c'],
})),truncated:false,sourceVerified:true};
const raw=data=>({isError:false,structuredContent:data,
 content:[{type:'text',text:JSON.stringify(data,null,2)}],
 _meta:{source:'test',callId:'opaque'}});
test('a confirmed JSON duplicate compacts without dropping any structured fields or metadata',()=>{
 process.env.BRC_RESULT_TEXT_MODE='compact';
 const before=raw(large),first=JSON.stringify(before);
 const next=compactDuplicatedToolText(before);
 assert.equal(JSON.stringify(before),first,'the helper must not mutate the original');
 assert.deepEqual(next.structuredContent,large);
 assert.deepEqual(next._meta,before._meta);
 assert.equal(next.isError,false);
 assert.match(next.content[0].text,/structuredContent/);
 assert.ok(next.content[0].text.length<640);
 const old=boundedAgentFrame({type:'result',id:'dup',result:before});
 const small=boundedAgentFrame({type:'result',id:'dup',result:next});
 assert.equal(old.replaced,false);
 assert.equal(small.replaced,false);
 assert.ok(Buffer.byteLength(small.encoded)<Buffer.byteLength(old.encoded)*.55);
 assert.ok(resultDeduplicationStatus().rewritten>=1);
 assert.ok(resultPresentationStatus().deduplication.retainsStructuredContent);
});

test('legacy mode must preserve the complete text view for text-only consumers',()=>{
 process.env.BRC_RESULT_TEXT_MODE='legacy';
 const before=raw(large);
 assert.strictEqual(compactDuplicatedToolText(before),before);
});

test('independent human-readable file/search/job output is never rewritten',()=>{
 process.env.BRC_RESULT_TEXT_MODE='compact';
 const distinct={isError:false,structuredContent:{count:160,hasMore:true},
  content:[{type:'text',text:'File contents:\n'+ 'x'.repeat(10000)}]};
 assert.strictEqual(compactDuplicatedToolText(distinct),distinct);
 const multi={...raw(large),content:[
   {type:'text',text:JSON.stringify(large)},
   {type:'image',data:'AAAA',mimeType:'image/png'}]};
 assert.strictEqual(compactDuplicatedToolText(multi),multi);
 const failure={isError:true,structuredContent:{error:{code:'TIMEOUT'}},
  content:[{type:'text',text:'TIMEOUT: '+ 'text'.repeat(900)}]};
 assert.strictEqual(compactDuplicatedToolText(failure),failure);
});

test('error codes remain readable when a duplicated JSON error is compacted',()=>{
 process.env.BRC_RESULT_TEXT_MODE='compact';
 const data={error:{code:'TOOL_OUTCOME_UNCERTAIN',
  message:'Inspect actual side effects before repeating work'},
  payload:'x'.repeat(5000)};
 const next=compactDuplicatedToolText({...raw(data),isError:true});
 assert.equal(next.isError,true);
 assert.equal(next.structuredContent.error.code,'TOOL_OUTCOME_UNCERTAIN');
 assert.match(next.content[0].text,/TOOL_OUTCOME_UNCERTAIN/);
 assert.match(next.content[0].text,/Inspect actual side effects/);
});

test('does not compact mismatching, malformed, or small JSON',()=>{
 process.env.BRC_RESULT_TEXT_MODE='compact';
 const mismatch={...raw(large),content:[{type:'text',text:JSON.stringify({
   ...large,sourceVerified:false})}]};
 assert.strictEqual(compactDuplicatedToolText(mismatch),mismatch);
 const malformed={...raw(large),content:[{type:'text',text:'{notjson'+ 'x'.repeat(5000)}]};
 assert.strictEqual(compactDuplicatedToolText(malformed),malformed);
 const small=raw({ok:true});
 assert.strictEqual(compactDuplicatedToolText(small),small);
});
