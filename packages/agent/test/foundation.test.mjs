import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {withFileLocks,atomicWrite,sha256} from '../dist/runtime/file-safety.js';
import {failure} from '../dist/runtime/errors.js';
import {ActivityLog} from '../dist/runtime/activity.js';

test('nested withFileLocks on the same file does not deadlock',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-fs-'));const f=path.join(d,'a.txt');await fs.writeFile(f,'x');
  const r=await Promise.race([withFileLocks([f],()=>withFileLocks([f],async()=>'ok')),new Promise(r=>setTimeout(()=>r('deadlock'),2000))]);
  assert.equal(r,'ok');
});
test('concurrent locks serialize',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-fs-'));const f=path.join(d,'a.txt');await fs.writeFile(f,'');
  const order=[];
  await Promise.all([1,2].map(n=>withFileLocks([f],async()=>{order.push('s'+n);await new Promise(r=>setTimeout(r,30));order.push('e'+n);})));
  assert.deepEqual(order,['s1','e1','s2','e2']);
});
test('atomicWrite enforces expected hash',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-fs-'));const f=path.join(d,'a.txt');await fs.writeFile(f,'one');
  await atomicWrite(f,'two',sha256('one'));assert.equal(await fs.readFile(f,'utf8'),'two');
  await assert.rejects(()=>atomicWrite(f,'three',sha256('one')),/changed/);
  assert.equal(await fs.readFile(f,'utf8'),'two');
});
test('failure() returns structured isError result',()=>{
  const r=failure(new Error('boom'),'c1');
  assert.equal(r.isError,true);assert.equal(r.structuredContent.error.code,'TOOL_FAILED');
});
test('activity log is bounded, redacts secrets and keeps no file',async()=>{
  const d=await fs.mkdtemp(path.join(os.tmpdir(),'brc-act-'));
  const a=new ActivityLog(d,true);
  for(let i=0;i<1100;i++)a.log('info','token=abc brc_dev_SECRET '+i);
  assert.equal(a.recent().length,1000);
  assert.ok(!JSON.stringify(a.recent()).includes('SECRET'));
  assert.deepEqual(await fs.readdir(d),[]);
});
