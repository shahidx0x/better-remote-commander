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

test('job tools are registered', () => {
  const names = listTools().map((t) => t.name);
  for (const n of ['run_parallel', 'spawn_job', 'wait_jobs', 'get_job', 'list_jobs', 'cancel_job']) assert.ok(names.includes(n), n);
});

// Prints its own start and end time, so overlap can be checked without wall-clock thresholds
// (CI runners can be slow to start processes).
const stampCmd = (ms, tag) => `node -e "console.log('${tag}S'+Date.now());setTimeout(()=>console.log('${tag}E'+Date.now()),${ms})"`;

test('run_parallel runs calls concurrently and keeps input order', async () => {
  const r = await callTool('run_parallel', { calls: [
    { command: stampCmd(1500, 'A'), label: 'A' },
    { command: stampCmd(1500, 'B'), label: 'B' },
    { tool: 'read_file', args: { path: path.join(repo, 'package.json'), length: 2 } },
    { command: 'node -e "process.exit(3)"', label: 'bad' },
  ] });
  const text = out(r);
  const stamp = (k) => Number(text.match(new RegExp(`${k}(\\d{13})`))?.[1]);
  const [aS, aE, bS, bE] = ['AS', 'AE', 'BS', 'BE'].map(stamp);
  assert.ok([aS, aE, bS, bE].every(Number.isFinite), `timestamps missing:\n${text}`);
  assert.ok(aS < bE && bS < aE, `A [${aS}-${aE}] and B [${bS}-${bE}] should overlap`);
  assert.match(text, /4\/4 done, 1 failed/);
  assert.ok(text.indexOf('=== A') < text.indexOf('=== B') && text.indexOf('=== B') < text.indexOf('=== bad'));
  assert.match(text, /=== bad -> FAILED/);
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

const bigCmd = (n, tag) => `node -e "console.log('${tag}'.repeat(${n}))"`;
test('get_job pages through many large steps and never exceeds the MCP reply cap', async () => {
  const steps = Array.from({ length: 12 }, (_, i) => ({ command: bigCmd(20_000, String.fromCharCode(65 + i)) }));
  const r = await callTool('spawn_job', { label: 'big', steps });
  const id = out(r).match(/job (j\w+)/)[1];
  await callTool('wait_jobs', { ids: [id], timeout_ms: 30_000 });
  const g = await callTool('get_job', { id, step_limit: 20, output_chars: 32_000 });
  const first = out(g);
  assert.ok(first.length <= 128_000, `reply ${first.length} chars`);
  const more = first.match(/step_offset:(\d+)/);
  assert.ok(more, 'expected a continuation hint');
  const second = out(await callTool('get_job', { id, step_offset: Number(more[1]), step_limit: 20, output_chars: 32_000 }));
  assert.ok(second.length <= 128_000);
  assert.match(second, /(?:9|10|11|12)\. OK/, 'later steps are reachable');
});

test('run_parallel caps its combined reply and points to follow-up tools', async () => {
  const calls = Array.from({ length: 12 }, (_, i) => ({ command: bigCmd(30_000, String.fromCharCode(97 + i)), label: 'c' + i }));
  const r = await callTool('run_parallel', { calls, max_concurrency: 8, output_chars: 16_000, timeout_ms: 60_000 });
  const text = out(r);
  assert.ok(text.length <= 128_000, `reply ${text.length} chars`);
  assert.match(text, /MORE PARALLEL RESULTS|12\/12 done/);
});

test('BRC_MAX_JOBS cannot be raised past the hard cap', async () => {
  const src = await import('node:fs/promises').then((f) => f.readFile(path.join(repo, 'packages/agent/src/tools/jobs.ts'), 'utf8'));
  assert.match(src, /Math\.min\(8,configuredJobs\)/);
});
