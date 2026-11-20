// Worker/job tools: run_parallel, spawn_job, wait_jobs, get_job, list_jobs, cancel_job.
// Runs against the built agent (pnpm build first). Commands use `node -e "..."` so they
// work under cmd, PowerShell and POSIX shells alike.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

process.env.BRC_HOME = mkdtempSync(path.join(realpathSync.native(tmpdir()), 'brc-jobs-'));
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const { callTool, listTools } = await import(pathToFileURL(path.join(repo, 'packages/agent/dist/index.js')).href);
const out = (r) => r.content.map((c) => c.text ?? '').join('\n');
const sleepCmd = (ms, msg = 'done') => `node -e "setTimeout(()=>console.log('${msg}'),${ms})"`;


test('parallel output remains under 128K and unreported results can be fetched without re-execution',async()=>{
  const fs=await import('node:fs/promises');
  const file=path.join(process.env.BRC_HOME,'parallel-huge.txt');
  await fs.writeFile(file,'T'.repeat(38000));
  const calls=Array.from({length:12},(_,i)=>({tool:'read_file',args:{path:file,length:1},label:'read-'+i}));
  const result=await callTool('run_parallel',{calls,max_concurrency:3,output_chars:20000,timeout_ms:30000});
  const body=out(result);
  assert.ok(body.length<=128000,'Too-large combined reply '+body.length);
  assert.match(body,/MORE PARALLEL RESULTS/);
  const group=body.match(/wait_jobs\(\{group:"(par-[a-z0-9]+)"\}/)?.[1];
  assert.ok(group,'Recovery group missing: '+body.slice(-400));
  const remaining=await callTool('wait_jobs',{group,timeout_ms:0,output_chars:3000});
  assert.ok(out(remaining).length<=128000);
  assert.match(out(remaining),/read-/);
});
test('get_job paginates 50-step logs without emitting multi-megabyte responses',async()=>{
  const fs=await import('node:fs/promises');
  const file=path.join(process.env.BRC_HOME,'job-huge.txt');
  await fs.writeFile(file,'J'.repeat(37000));
  const steps=Array.from({length:12},()=>({tool:'read_file',args:{path:file,length:1}}));
  const started=await callTool('spawn_job',{label:'bounded job',steps});
  const id=out(started).match(/job (j\w+)/)?.[1];
  assert.ok(id);
  await callTool('wait_jobs',{ids:[id],timeout_ms:30000,output_chars:500});
  const first=await callTool('get_job',{id,output_chars:32000,step_limit:12});
  assert.ok(out(first).length<=128000);
  assert.match(out(first),/MORE JOB STEPS/);
  const offset=Number(out(first).match(/step_offset:(\d+)/)?.[1]);
  assert.ok(offset>0 && offset<12);
  const second=await callTool('get_job',{id,output_chars:32000,step_offset:offset,step_limit:4});
  assert.ok(out(second).length<=128000);
  assert.match(out(second),/read_file/);
});

test('job tools are registered', () => {
  const names = listTools().map((t) => t.name);
  for (const n of ['run_parallel', 'spawn_job', 'wait_jobs', 'get_job', 'list_jobs', 'cancel_job']) assert.ok(names.includes(n), n);
});

test('parallel file I/O allows disjoint paths but serializes overlapping and heavyweight paths', async () => {
  const { isDisjointFileIoBatch } = await import('../dist/tools/jobs.js');
  const one = path.join(process.env.BRC_HOME, 'one.txt');
  const two = path.join(process.env.BRC_HOME, 'two.txt');
  assert.equal(isDisjointFileIoBatch([
    { tool: 'write_file', args: { path: one } },
    { tool: 'edit_block', args: { file_path: two } },
  ]), true);
  assert.equal(isDisjointFileIoBatch([
    { tool: 'write_file', args: { path: one } },
    { tool: 'edit_block', args: { file_path: one } },
  ]), false);
  assert.equal(isDisjointFileIoBatch([
    { tool: 'write_file', args: { path: one } },
    { tool: 'create_directory', args: { path: process.env.BRC_HOME } },
  ]), false);
  assert.equal(isDisjointFileIoBatch([
    { tool: 'read_file', args: { path: path.join(process.env.BRC_HOME, 'large.pdf') } },
  ]), false);
  assert.equal(isDisjointFileIoBatch([{ command: 'node -v' }]), false);
});

// Prints its own start and end time, so overlap can be checked without wall-clock thresholds
// (CI runners can be slow to start processes).
const stampCmd = (ms, tag) => `node -e "console.log('${tag}S'+Date.now());setTimeout(()=>console.log('${tag}E'+Date.now()),${ms})"`;

test('run_parallel serializes heavy commands and keeps input order', async () => {
  const r = await callTool('run_parallel', { calls: [
    { command: stampCmd(700, 'A'), label: 'A' },
    { command: stampCmd(700, 'B'), label: 'B' },
    { tool: 'read_file', args: { path: path.join(repo, 'package.json'), length: 2 } },
    { command: 'node -e "process.exit(3)"', label: 'bad' },
  ] });
  const text = out(r);
  const stamp = (k) => Number(text.match(new RegExp(`${k}(\\d{13})`))?.[1]);
  const [aS, aE, bS, bE] = ['AS', 'AE', 'BS', 'BE'].map(stamp);
  assert.ok([aS, aE, bS, bE].every(Number.isFinite), `timestamps missing:\n${text}`);
  assert.ok(aE <= bS, `heavy commands must not overlap: A [${aS}-${aE}] B [${bS}-${bE}]`);
  assert.match(text, /4\/4 done, 1 failed/);
  assert.equal(r.structuredContent.failed,1);
  assert.equal(r.structuredContent.executionCompleted,true);
  assert.equal(r.structuredContent.allCallsSucceeded,false);
  assert.equal(r.structuredContent.failedJobIds.length,1);
  assert.ok(text.indexOf('=== A') < text.indexOf('=== B') && text.indexOf('=== B') < text.indexOf('=== bad'));
  assert.match(text, /=== bad -> FAILED/);
});

test('lightweight reads finish while a long heavy background command is still running', async () => {
  const r = await callTool('run_parallel', { timeout_ms: 1200, max_concurrency: 3, calls: [
    { command: sleepCmd(4000, 'heavy-finished'), label: 'heavy' },
    { tool: 'read_file', args: { path: path.join(repo, 'package.json'), length: 2 }, label: 'quick-read' },
  ] });
  const text = out(r);
  assert.match(text, /run_parallel: 1\/2 done/);
  assert.equal(r.structuredContent.pending,true);
  assert.equal(r.structuredContent.executionCompleted,false);
  assert.equal(r.structuredContent.allCallsSucceeded,false);
  assert.match(text, /=== heavy -> STILL RUNNING/);
  assert.match(text, /=== quick-read -> OK/);
  const group = text.match(/wait_jobs\(\{"group":"(par-[a-z0-9]+)"\}\)/)?.[1];
  assert.ok(group, text);
  const finished = await callTool('wait_jobs', { group, timeout_ms: 10_000 });
  assert.match(out(finished), /SUCCEEDED/);
  assert.match(out(finished), /heavy-finished/);
});

test('run_parallel hands unfinished calls over to background jobs', async () => {
  const r = await callTool('run_parallel', { timeout_ms: 1000, calls: [{ command: sleepCmd(2500, 'late'), label: 'late' }] });
  const group = out(r).match(/"group":"(par-[\w]+)"/)?.[1];
  assert.ok(group, out(r));
  const w = await callTool('wait_jobs', { group, timeout_ms: 20_000 });
  assert.match(out(w), /SUCCEEDED/);
  assert.match(out(w), /late/);
});

test('spawn_job runs steps in order and stops on the first failure', async () => {
  const r = await callTool('spawn_job', { label: 'seq', group: 'seq', steps: [
    { command: 'node -e "console.log(1)"' },
    { tool: 'list_directory', args: { path: path.join(repo, 'packages') } },
    { command: 'node -e "process.exit(2)"' },
    { command: 'node -e "console.log(4)"' },
  ] });
  const id = out(r).match(/job (j\w+)/)[1];
  const w = await callTool('wait_jobs', { ids: [id], timeout_ms: 20_000 });
  assert.match(out(w), /FAILED · .* 2\/4 steps ok, 1 failed/);
  assert.match(out(w), /1 step\(s\) not run/);
  // reported once: a second wait lists it as already reported
  const again = await callTool('wait_jobs', { ids: [id], timeout_ms: 0 });
  assert.match(out(again), /Already reported earlier/);
  const g = await callTool('get_job', { id });
  assert.match(out(g), /exit code 2/);
});

test('cancel_job kills a running command', async () => {
  const r = await callTool('spawn_job', { label: 'long', command: sleepCmd(60_000) });
  const id = out(r).match(/job (j\w+)/)[1];
  await new Promise((res) => setTimeout(res, 300));
  const c = await callTool('cancel_job', { ids: [id] });
  assert.match(out(c), /CANCELLED/);
  const l = await callTool('list_jobs', { status: 'cancelled' });
  assert.match(out(l), new RegExp(id));
});

test('job tools cannot be nested', async () => {
  const r = await callTool('spawn_job', { steps: [{ tool: 'run_parallel', args: { calls: [] } }] });
  assert.equal(r.isError, true);
  const p = await callTool('run_parallel', { calls: [{ tool: 'spawn_job', args: {} }] });
  assert.equal(p.isError, true);
});

test('get_job reports a specific missing-ID error with safe recovery rather than TOOL_FAILED',async()=>{
  const result=await callTool('get_job',{id:'job-does-not-exist-987654'});
  assert.equal(result.isError,true);
  assert.equal(result.structuredContent?.error?.code,'JOB_NOT_FOUND');
  assert.equal(result.structuredContent?.commandExecuted,false);
  assert.equal(result.structuredContent?.recovery?.automaticRetry,false);
  assert.equal(result.structuredContent?.recovery?.next?.tool,'list_jobs');
  assert.match(out(result),/list_jobs/);
});

test('invalid get_job and run_parallel inputs return classified pre-execution errors',async()=>{
  const invalidJob=await callTool('get_job',{});
  assert.equal(invalidJob.isError,true);
  assert.equal(invalidJob.structuredContent?.error?.code,'INVALID_ARGUMENT');
  const invalidParallel=await callTool('run_parallel',{calls:[]});
  assert.equal(invalidParallel.isError,true);
  assert.equal(invalidParallel.structuredContent?.error?.code,'INVALID_ARGUMENT');
  const nested=await callTool('run_parallel',{calls:[{tool:'spawn_job',args:{command:'echo side-effect'}}]});
  assert.equal(nested.isError,true);
  assert.equal(nested.structuredContent?.error?.code,'NESTED_JOB_TOOL');
  assert.equal(nested.structuredContent?.commandExecuted,false);
  assert.equal(nested.structuredContent?.recovery?.automaticRetry,false);
});


test('all job-control invalid requests have classified errors and no side effects',async()=>{
  const requests=[
    ['spawn_job',{},'INVALID_ARGUMENT'],
    ['spawn_job',{steps:[{tool:'get_job',args:{id:'missing'}}]},'NESTED_JOB_TOOL'],
    ['wait_jobs',{ids:['definitely-unknown-job-id'],timeout_ms:0},'JOB_NOT_FOUND'],
    ['wait_jobs',{timeout_ms:-2},'INVALID_ARGUMENT'],
    ['list_jobs',{limit:0},'INVALID_ARGUMENT'],
    ['cancel_job',{},'INVALID_ARGUMENT'],
    ['cancel_job',{all:'yes'},'INVALID_ARGUMENT'],
  ];
  for(const [tool,args,code] of requests){
    const r=await callTool(tool,args);
    assert.equal(r.isError,true,tool+': '+out(r));
    assert.equal(r.structuredContent?.error?.code,code,tool+': '+out(r));
    assert.equal(r.structuredContent?.commandExecuted,false,tool);
    assert.equal(r.structuredContent?.recovery?.automaticRetry,false,tool);
  }
});
