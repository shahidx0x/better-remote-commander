import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runProcess} from '../dist/plugins/util.js';
import {managedChildStatus} from '../dist/runtime/process-termination.js';

test('installer subprocess handles spawn errors without hanging or leaking lifecycle owners',async()=>{
  const before=managedChildStatus().active;
  const r=await runProcess('__brc_unknown_installer_exec_21__',[],{timeoutMs:2000});
  assert.equal(r.code,null);
  assert.equal(r.timedOut,false);
  assert.match(r.stderr,/ENOENT|not found|cannot find/i);
  assert.equal(managedChildStatus().active,before);
});

test('installer output capture has a hard bound in each stream',async()=>{
  const r=await runProcess(process.execPath,['-e',
    "process.stdout.write('a'.repeat(1250000));process.stderr.write('b'.repeat(1250000));"],
    {timeoutMs:7000});
  assert.equal(r.code,0,r.stderr.slice(-300));
  assert.equal(r.timedOut,false);
  assert.equal(r.terminationState,'not_requested');
  assert.equal(r.stdout.length,1000000);
  assert.equal(r.stderr.length,1000000);
});

test('installer timeout settles and distinguishes root close from uncertain termination',async()=>{
  const before=managedChildStatus().active;
  const r=await runProcess(process.execPath,['-e',"setInterval(()=>{},1000)"],{timeoutMs:500});
  assert.equal(r.timedOut,true);
  assert.notEqual(r.code,0);
  assert.ok(['root_exit_observed','unconfirmed'].includes(r.terminationState));
  assert.equal(managedChildStatus().active,before);
});
