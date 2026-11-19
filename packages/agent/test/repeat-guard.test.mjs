import {test} from 'node:test';
import assert from 'node:assert/strict';
const {RepeatFailureGuard}=await import('../dist/runtime/repeat-guard.js');

test('three identical failures trigger a correction hint without blocking calls',()=>{
 let now=1234;
 const guard=new RepeatFailureGuard(()=>now);
 const a={path:'C:\\fixture\\src\\x.ts',old_string:'old',new_string:'new'};
 assert.equal(guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND'),null);
 assert.equal(guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND'),null);
 const third=guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND');
 assert.equal(third?.count,3);
 assert.match(third.hint,/Read the current file/);
 assert.equal(guard.status().argumentTextStored,false);
 assert.ok(!JSON.stringify(guard.status()).includes('fixture'));
 assert.equal(guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND'),null);
 assert.equal(guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND').count,5);
 guard.observe('edit_block',a,false);
 assert.equal(guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND'),null);
 now+=11*60_000;
 assert.equal(guard.observe('edit_block',a,true,'EDIT_TEXT_NOT_FOUND'),null);
});

test('repeated polling never triggers retry warnings',()=>{
 const guard=new RepeatFailureGuard();
 for(let i=0;i<20;i++)assert.equal(guard.observe('get_job',{id:'same'},true,'JOB_NOT_FOUND'),null);
 assert.equal(guard.status().trackedFingerprints,0);
});


test('semantically identical object keys at different orders share a fingerprint',()=>{
 const guard=new RepeatFailureGuard(()=>34500);
 const one={path:'C:\\tests\\project\\src\\main.ts',edits:[
  {old_string:'one',new_string:'two',expected_replacements:1},
  {old_string:'third',new_string:'fourth',expected_replacements:1}],
  settings:{mode:'strict',nested:{from:1,to:2}}};
 const same={settings:{nested:{to:2,from:1},mode:'strict'},
  edits:[{expected_replacements:1,new_string:'two',old_string:'one'},
   {new_string:'fourth',expected_replacements:1,old_string:'third'}],
  path:'C:\\tests\\project\\src\\main.ts'};
 assert.equal(guard.observe('edit_files',one,true,'FILE_CONFLICT'),null);
 assert.equal(guard.observe('edit_files',same,true,'FILE_CONFLICT'),null);
 const third=guard.observe('edit_files',one,true,'FILE_CONFLICT');
 assert.equal(third?.count,3);
 assert.equal(guard.status().trackedFingerprints,1);
 assert.equal(guard.status().canonicalizedJsonKeys,true);
 assert.equal(guard.status().argumentTextStored,false);
 assert.ok(!JSON.stringify(guard).includes('C:\\tests\\project'));
});
test('argument array order remains significant; oversized/cyclic args are ignored',()=>{
 const guard=new RepeatFailureGuard(()=>1111);
 const a={steps:['validate','edit']},b={steps:['edit','validate']};
 assert.equal(guard.observe('workspace_batch',a,true,'TOOL_FAILED'),null);
 assert.equal(guard.observe('workspace_batch',b,true,'TOOL_FAILED'),null);
 assert.equal(guard.observe('workspace_batch',a,true,'TOOL_FAILED'),null);
 assert.equal(guard.status().trackedFingerprints,2);
 assert.equal(guard.observe('run_command',{command:'a'.repeat(20_000)},true,'COMMAND_FAILED'),null);
 const cyclic={};
 cyclic.loop=cyclic;
 assert.equal(guard.observe('run_command',cyclic,true,'COMMAND_FAILED'),null);
 assert.equal(guard.status().trackedFingerprints,2);
});
