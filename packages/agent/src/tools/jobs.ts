/**
 * BRC workers: background jobs and parallel fan-out for the controlling AI.
 *
 * The AI in the chat (Claude / ChatGPT / Gemini) stays the only "brain". It splits work and
 * hands pieces to workers on this machine, which run them in parallel and report back:
 *
 *   spawn_job    - start a background job (a command, or a sequence of BRC tool calls); returns an id
 *   wait_jobs    - block up to ~100 s until all (or any) selected jobs finish; returns their results
 *   get_job      - full status / output of one job
 *   list_jobs    - one line per job
 *   cancel_job   - stop jobs (kills running command process trees)
 *   run_parallel - run several tool calls / commands at once and return all results in one call;
 *                  anything still running at the deadline keeps going as a background job
 *
 * Jobs are not bound by the relay's 120 s per-call timeout (default job limit 30 min, max 6 h).
 * Every step goes through the normal tool dispatcher, so allowedDirectories and blockedCommands apply.
 * Finished jobs are persisted to $BRC_HOME/jobs/<id>.json and reloaded after an agent restart.
 */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { runCommandCore } from './brc-tools.js';
import { homeDir } from '../transport/pairing.js';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const MAX_WAIT_MS = 100_000; // stay well below the relay's 120 s call timeout
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;
const MAX_JOB_TIMEOUT_MS = 6 * 60 * 60_000;
// Bounded even if the environment variable is accidentally set very high.
const configuredJobs=Number(process.env.BRC_MAX_JOBS);
const MAX_CONCURRENT_JOBS = Number.isInteger(configuredJobs) && configuredJobs>0 ? Math.min(8,configuredJobs) : 4;
const MAX_STORED_STEP_OUTPUT = (process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1') ? 16_000 : 32_000;
const KEEP_IN_MEMORY = (process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1') ? 32 : 64;
const MAX_MCP_JOB_OUTPUT = 128_000;
const KEEP_ON_DISK = (process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1') ? 100 : 500;

export const JOB_TOOL_NAMES = new Set(['spawn_job', 'wait_jobs', 'get_job', 'list_jobs', 'cancel_job', 'run_parallel']);
const RESPONSIVE = process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1';
const FAST_PARALLEL_READS = new Set([
  'read_file','read_code_file','read_multiple_files','list_directory','get_file_info',
  'git_status','git_diff','git_log','agent_status','list_sessions','get_more_search_results'
]);

// One enormous combined job report can break an MCP client's message stream.
const capJobReply=(s:string):string=>s.length<=MAX_MCP_JOB_OUTPUT?s:
  s.slice(0,MAX_MCP_JOB_OUTPUT-360)+
  '\n[OUTPUT TRUNCATED: MCP job response reached 128000 characters. Request fewer jobs, smaller output_chars, or use get_job with step_offset/step_limit. Already-started jobs are not cancelled; inspect them before retrying mutations.]';
const text = (t: string, isError = false): ServerResult => ({
  content: [{ type: 'text', text: capJobReply(t) }], ...(isError ? { isError: true } : {})
});

// The dispatcher injects itself here (avoids a circular import).
type Executor = (tool: string, args: Record<string, unknown>) => Promise<ServerResult>;
let executor: Executor | null = null;
export function setJobToolExecutor(fn: Executor): void { executor = fn; }

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------
const CommandStepSchema = z.object({
  command: z.string().min(1).describe('Shell command to run (non-interactive; stdin is closed).'),
  cwd: z.string().optional().describe('Working directory (absolute, inside allowed directories).'),
  timeout_ms: z.number().int().min(1).optional().describe('Per-command timeout. Default: whatever is left of the job timeout.'),
  shell: z.string().optional(),
  raw: z.boolean().optional().describe('Bypass rtk output compression (full output).'),
  label: z.string().max(120).optional(),
});

const ToolStepSchema = z.object({
  tool: z.string().min(1).describe('Name of any BRC tool, e.g. read_file, edit_block, start_search, git_diff, run_command.'),
  args: z.record(z.unknown()).optional().default({}).describe('Arguments for that tool, exactly as you would pass them directly.'),
  label: z.string().max(120).optional(),
});

const StepSchema = z.union([CommandStepSchema, ToolStepSchema]);
type Step = z.infer<typeof StepSchema>;

export const SpawnJobArgsSchema = z.object({
  command: z.string().optional().describe('Shortcut for a one-command job. Use either command or steps.'),
  cwd: z.string().optional().describe('Working directory for the command shortcut.'),
  steps: z.array(StepSchema).min(1).max(50).optional().describe('Sequence run in order: each item is {command, cwd?, timeout_ms?} or {tool, args}.'),
  label: z.string().max(120).optional().describe('Short human name shown in results, e.g. "unit tests".'),
  group: z.string().max(60).optional().describe('Group name; wait_jobs/cancel_job/list_jobs can target a whole group.'),
  continue_on_error: z.boolean().optional().default(false).describe('Keep running later steps after a failed step (default: stop).'),
  timeout_ms: z.number().int().min(1_000).max(MAX_JOB_TIMEOUT_MS).optional().default(DEFAULT_JOB_TIMEOUT_MS)
    .describe(`Whole-job time limit (default ${DEFAULT_JOB_TIMEOUT_MS / 60_000} min, max ${MAX_JOB_TIMEOUT_MS / 3_600_000} h).`),
});

export const WaitJobsArgsSchema = z.object({
  ids: z.array(z.string()).optional().describe('Job ids to wait for.'),
  group: z.string().optional().describe('Wait for every job in this group.'),
  mode: z.enum(['all', 'any']).optional().default('all').describe('all: return when every selected job is done. any: return as soon as one more finishes.'),
  timeout_ms: z.number().int().min(0).max(MAX_WAIT_MS).optional().default(DEFAULT_WAIT_MS),
  output_chars: z.number().int().min(200).max(50_000).optional().default(3_000).describe('Max output characters shown per step.'),
});

export const GetJobArgsSchema = z.object({
  id: z.string().min(1),
  output_chars: z.number().int().min(200).max(32_000).optional().default(8_000),
  step_offset: z.number().int().min(0).max(50).optional().default(0),
  step_limit: z.number().int().min(1).max(20).optional().default(10),
});

export const ListJobsArgsSchema = z.object({
  group: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'active', 'finished']).optional(),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

export const CancelJobArgsSchema = z.object({
  ids: z.array(z.string()).optional(),
  group: z.string().optional(),
  all: z.boolean().optional().default(false).describe('Cancel every queued or running job.'),
});

export const RunParallelArgsSchema = z.object({
  calls: z.array(StepSchema).min(1).max((process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1') ? 24 : 50).describe('Items run concurrently: {tool, args} or {command, cwd?, timeout_ms?}.'),
  max_concurrency: z.number().int().min(1).max(8).optional().default(4),
  timeout_ms: z.number().int().min(1_000).max(MAX_WAIT_MS).optional().default(90_000)
    .describe('How long to wait for results. Calls still running then continue as background jobs.'),
  output_chars: z.number().int().min(200).max(50_000).optional().default(4_000).describe('Max output characters shown per call.'),
});

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out';

interface StepResult {
  index: number;
  name: string;
  ok: boolean;
  ms: number;
  output: string;
}

interface Job {
  id: string;
  label?: string;
  group?: string;
  status: JobStatus;
  steps: Step[];
  results: StepResult[];
  currentStep: number;
  continueOnError: boolean;
  timeoutMs: number;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** true once a finished job's result has been returned to the AI. */
  reported: boolean;
  // runtime only
  abort?: AbortController;
  cancelRequested?: boolean;
  timedOut?: boolean;
  done?: Promise<void>;
  resolveDone?: () => void;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let runningPooled = 0;
let historyLoaded = false;

const isFinished = (j: Job) => j.status !== 'queued' && j.status !== 'running';
const jobsDir = () => path.join(homeDir(), 'jobs');

function newId(): string {
  return `j${Date.now().toString(36)}${randomBytes(2).toString('hex')}`;
}

function stepName(s: Step): string {
  if ('command' in s) return s.label ?? `$ ${s.command.length > 80 ? s.command.slice(0, 77) + '...' : s.command}`;
  return s.label ?? s.tool;
}

function createJob(steps: Step[], opts: { label?: string; group?: string; continueOnError?: boolean; timeoutMs?: number }): Job {
  const job: Job = {
    id: newId(),
    label: opts.label,
    group: opts.group,
    status: 'queued',
    steps,
    results: [],
    currentStep: -1,
    continueOnError: !!opts.continueOnError,
    timeoutMs: opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    createdAt: Date.now(),
    reported: false,
    abort: new AbortController(),
  };
  job.done = new Promise<void>((r) => { job.resolveDone = r; });
  jobs.set(job.id, job);
  return job;
}

function resultText(r: ServerResult): string {
  const parts = (r.content ?? []).map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : `[${c?.type ?? 'unknown'} content omitted]`));
  const s = parts.join('\n').replace(/\s+$/, '');
  return s.length > MAX_STORED_STEP_OUTPUT
    ? `${s.slice(0, MAX_STORED_STEP_OUTPUT / 4)}\n\n[... ${s.length - MAX_STORED_STEP_OUTPUT} characters truncated ...]\n\n${s.slice(-(MAX_STORED_STEP_OUTPUT * 3) / 4)}`
    : s;
}

function abortable<T>(p: Promise<T>, signal: AbortSignal, onAbort: () => T): Promise<T> {
  if (signal.aborted) return Promise.resolve(onAbort());
  return new Promise<T>((resolve, reject) => {
    const h = () => resolve(onAbort());
    signal.addEventListener('abort', h, { once: true });
    p.then((v) => { signal.removeEventListener('abort', h); resolve(v); },
      (e) => { signal.removeEventListener('abort', h); reject(e); });
  });
}

async function execStep(step: Step, signal: AbortSignal, remainingMs: number): Promise<ServerResult> {
  if ('command' in step) {
    return runCommandCore(
      { command: step.command, cwd: step.cwd, shell: step.shell, raw: step.raw, timeout_ms: Math.max(1, Math.min(step.timeout_ms ?? remainingMs, remainingMs)) },
      { maxTimeoutMs: remainingMs, signal, failOnNonZero: true },
    );
  }
  if (JOB_TOOL_NAMES.has(step.tool)) return text(`Tool "${step.tool}" cannot be used inside a job.`, true);
  if (step.tool === 'run_command') {
    const a = step.args as Record<string, unknown>;
    const t = typeof a.timeout_ms === 'number' ? Math.min(a.timeout_ms, remainingMs) : remainingMs;
    return runCommandCore({ ...a, timeout_ms: Math.max(1, t) }, { maxTimeoutMs: remainingMs, signal, failOnNonZero: true });
  }
  if (!executor) return text('Job executor not initialised', true);
  return abortable(executor(step.tool, step.args as Record<string, unknown>), signal, () => text('CANCELLED', true));
}

async function runJob(job: Job): Promise<void> {
  if (job.status !== 'queued') return;
  job.status = 'running';
  job.startedAt = Date.now();
  const signal = job.abort!.signal;
  const timer = setTimeout(() => { job.timedOut = true; job.abort!.abort(); }, job.timeoutMs);
  let anyFailed = false;
  try {
    for (let i = 0; i < job.steps.length; i++) {
      if (signal.aborted) break;
      job.currentStep = i;
      const step = job.steps[i];
      const t0 = Date.now();
      let res: ServerResult;
      try {
        res = await execStep(step, signal, Math.max(1, job.timeoutMs - (t0 - job.startedAt)));
      } catch (e) {
        res = text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const ok = !res.isError;
      job.results.push({ index: i, name: stepName(step), ok, ms: Date.now() - t0, output: resultText(res) });
      if (!ok) {
        anyFailed = true;
        if (!job.continueOnError) break;
      }
    }
  } finally {
    clearTimeout(timer);
    job.status = job.cancelRequested ? 'cancelled' : job.timedOut ? 'timed_out' : anyFailed ? 'failed' : 'succeeded';
    job.endedAt = Date.now();
    job.currentStep = -1;
    job.resolveDone!();
    void persist(job);
    prune();
  }
}

/** Pooled jobs (spawn_job) share MAX_CONCURRENT_JOBS slots. */
function enqueue(job: Job): void {
  queue.push(job);
  pump();
}
/** Recover from unexpected job executor faults without losing the next jobs.
 * Ordinary tool failures are already handled by runJob; this is the last-resort
 * path for unforeseen formatter/persistence exceptions.
 */
function markInternalJobFailure(job:Job,error:unknown):void {
  const message=(error instanceof Error?error.message:String(error)).slice(0,800);
  job.status='failed';
  job.endedAt=Date.now();
  job.currentStep=-1;
  job.results.push({index:job.results.length,name:'internal job execution',ok:false,ms:0,output:'JOB_FAILED: '+message});
  job.resolveDone?.();
}

function pump(): void {
  while (runningPooled < MAX_CONCURRENT_JOBS && queue.length) {
    const job = queue.shift()!;
    if (job.status !== 'queued') continue; // cancelled while queued
    runningPooled++;
    void runJob(job).catch(e=>markInternalJobFailure(job,e))
      .finally(() => { runningPooled--; pump(); });
  }
}

function cancel(job: Job): boolean {
  if (isFinished(job)) return false;
  job.cancelRequested = true;
  if (job.status === 'queued') {
    job.status = 'cancelled';
    job.endedAt = Date.now();
    job.resolveDone?.();
    void persist(job);
  } else {
    job.abort?.abort();
  }
  return true;
}

// ---------------------------------------------------------------------------
// Persistence (best effort)
// ---------------------------------------------------------------------------
function serialisable(job: Job) {
  const { abort, done, resolveDone, cancelRequested, timedOut, ...rest } = job;
  return rest;
}

async function persist(job: Job): Promise<void> {
  try {
    const dir = jobsDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `${job.id}.json`), JSON.stringify(serialisable(job)), 'utf8');
    const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.json')).sort();
    for (const f of files.slice(0, Math.max(0, files.length - KEEP_ON_DISK))) await fs.unlink(path.join(dir, f)).catch(() => {});
  } catch { /* ignore */ }
}

async function loadHistory(): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const files = (await fs.readdir(jobsDir())).filter((f) => f.endsWith('.json')).sort().slice(-100);
    for (const f of files) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(jobsDir(), f), 'utf8')) as Job;
        if (!j?.id || jobs.has(j.id)) continue;
        if (j.status === 'queued' || j.status === 'running') j.status = 'cancelled';
        j.reported = true;
        j.done = Promise.resolve();
        jobs.set(j.id, j);
      } catch { /* skip bad file */ }
    }
  } catch { /* no dir yet */ }
}

function prune(): void {
  const finished = [...jobs.values()].filter(isFinished).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  for (const j of finished.slice(0, Math.max(0, finished.length - KEEP_IN_MEMORY))) jobs.delete(j.id);
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------
const secs = (ms: number) => (ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`);

function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const head = Math.floor(max * 0.3);
  const tail = max - head;
  return `${s.slice(0, head)}\n[... ${s.length - max} chars omitted; use get_job for more ...]\n${s.slice(-tail)}`;
}

function headline(j: Job): string {
  const name = j.label ? ` "${j.label}"` : '';
  const grp = j.group ? ` group=${j.group}` : '';
  const now = Date.now();
  let timing = '';
  if (j.status === 'queued') timing = `queued ${secs(now - j.createdAt)}`;
  else if (j.status === 'running') timing = `running ${secs(now - (j.startedAt ?? now))}, step ${j.currentStep + 1}/${j.steps.length}: ${stepName(j.steps[j.currentStep] ?? j.steps[0])}`;
  else timing = `${secs((j.endedAt ?? now) - (j.startedAt ?? j.createdAt))}`;
  const okCount = j.results.filter((r) => r.ok).length;
  const failCount = j.results.length - okCount;
  const counts = isFinished(j) ? ` · ${okCount}/${j.steps.length} steps ok${failCount ? `, ${failCount} failed` : ''}` : '';
  return `[${j.id}${name}${grp}] ${j.status.toUpperCase()} · ${timing}${counts}`;
}

function detail(j: Job, outputChars: number, stepOffset=0, stepLimit=10): string {
  let s = headline(j);
  const selected=j.results.slice(stepOffset,stepOffset+stepLimit);
  let rendered=0;
  for (const r of selected) {
    const head=`\n  ${r.index + 1}. ${r.ok ? 'OK ' : 'ERR'} ${r.name} (${secs(r.ms)})`;
    const body=r.output ? '\n'+clip(r.output,Math.min(outputChars,32_000)).split('\n').map(l=>'     '+l).join('\n') : '';
    if(s.length+head.length+body.length>MAX_MCP_JOB_OUTPUT-600)break;
    s+=head+body;rendered++;
  }
  const next=stepOffset+rendered;
  if(next<j.results.length)s+=`\n[MORE JOB STEPS: ${j.results.length-next} results remain. Call get_job({id:"${j.id}",step_offset:${next},step_limit:${stepLimit},output_chars:${Math.min(outputChars,8000)}}).]`;
  const skipped = j.steps.length - j.results.length;
  if (isFinished(j) && skipped > 0) s += `\n  (${skipped} step(s) not run)`;
  return s;
}

function select(a: { ids?: string[]; group?: string }): { picked: Job[]; missing: string[] } {
  if (a.ids?.length) {
    const missing = a.ids.filter((id) => !jobs.has(id));
    return { picked: a.ids.map((id) => jobs.get(id)).filter((j): j is Job => !!j), missing };
  }
  if (a.group) return { picked: [...jobs.values()].filter((j) => j.group === a.group), missing: [] };
  return { picked: [...jobs.values()].filter((j) => !isFinished(j) || !j.reported), missing: [] };
}

function summary(picked: Job[], outputChars: number, missing: string[] = []): string {
  const finished = picked.filter(isFinished);
  const running = picked.filter((j) => j.status === 'running');
  const queued = picked.filter((j) => j.status === 'queued');
  const failed = finished.filter((j) => j.status !== 'succeeded');
  let s = `${finished.length} finished (${failed.length} not successful), ${running.length} running, ${queued.length} queued.`;
  if (missing.length) s += `\nUnknown job ids: ${missing.join(', ')}`;
  const fresh = finished.filter((j) => !j.reported);
  const old = finished.filter((j) => j.reported);
  const displayed:Job[]=[];
  for(const j of fresh){
    const report='\n\n'+detail(j,Math.min(outputChars,6000),0,10);
    if(s.length+report.length>MAX_MCP_JOB_OUTPUT-1200)break;
    s+=report;displayed.push(j);
  }
  if(displayed.length<fresh.length)
    s+=`\n[MORE JOB REPORTS: ${fresh.length-displayed.length} not yet shown. Call wait_jobs again with this group or fewer ids; these reports remain unreported.]`;
  if (old.length) {
    const report='\n\nAlready reported earlier:\n'+old.map(j=>'  '+headline(j)).join('\n');
    s+=report.slice(0,Math.max(0,MAX_MCP_JOB_OUTPUT-s.length-200));
  }
  if (running.length || queued.length) {
    s += `\n\nStill in progress:\n${[...running, ...queued].map((j) => `  ${headline(j)}`).join('\n')}`;
    s += '\nCall wait_jobs again to keep waiting.';
  }
  for (const j of displayed) j.reported = true;
  return capJobReply(s);
}

async function waitUntil(picked: Job[], cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    const left = deadline - Date.now();
    if (left <= 0) return;
    const pending = picked.filter((j) => !isFinished(j)).map((j) => j.done!);
    if (!pending.length) return;
    let t: NodeJS.Timeout | undefined;
    await Promise.race([...pending.map((p) => p.then(() => undefined)), new Promise<void>((r) => { t = setTimeout(r, left); })]);
    if (t) clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------
export async function handleSpawnJob(args: unknown): Promise<ServerResult> {
  const parsed = SpawnJobArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for spawn_job: ${parsed.error.message}`, true);
  const a = parsed.data;
  const steps: Step[] = [...(a.command ? [{ command: a.command, cwd: a.cwd }] : []), ...(a.steps ?? [])];
  if (!steps.length) return text('spawn_job needs "command" or "steps".', true);
  const bad = steps.find((s) => 'tool' in s && JOB_TOOL_NAMES.has(s.tool));
  if (bad) return text(`Tool "${(bad as { tool: string }).tool}" cannot be used inside a job.`, true);
  await loadHistory();
  if ((process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1') && queue.length >= 8)
    return text('BUSY: eight jobs are already queued. Wait for earlier work to finish; no new job was started.', true);
  const job = createJob(steps, { label: a.label, group: a.group, continueOnError: a.continue_on_error, timeoutMs: a.timeout_ms });
  enqueue(job);
  const pos = job.status === 'queued' ? ` (queued: ${MAX_CONCURRENT_JOBS} jobs run at once)` : '';
  return text(`Started job ${job.id}${job.label ? ` "${job.label}"` : ''}${job.group ? ` in group ${job.group}` : ''} with ${steps.length} step(s)${pos}.\nUse wait_jobs to collect the result.`);
}

export async function handleWaitJobs(args: unknown): Promise<ServerResult> {
  const parsed = WaitJobsArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for wait_jobs: ${parsed.error.message}`, true);
  const a = parsed.data;
  await loadHistory();
  const { picked, missing } = select(a);
  if (!picked.length) return text(missing.length ? `Unknown job ids: ${missing.join(', ')}` : 'No jobs to wait for.', !!missing.length);
  const cond = a.mode === 'any'
    ? () => picked.every(isFinished) || picked.some((j) => isFinished(j) && !j.reported)
    : () => picked.every(isFinished);
  await waitUntil(picked, cond, a.timeout_ms);
  return text(summary(picked, a.output_chars, missing));
}

export async function handleGetJob(args: unknown): Promise<ServerResult> {
  const parsed = GetJobArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for get_job: ${parsed.error.message}`, true);
  await loadHistory();
  const j = jobs.get(parsed.data.id);
  if (!j) return text(`Unknown job id: ${parsed.data.id}`, true);
  const out = detail(j, parsed.data.output_chars,parsed.data.step_offset,parsed.data.step_limit);
  if (isFinished(j) && !out.includes('[MORE JOB STEPS:')) j.reported = true;
  return text(out);
}

export async function handleListJobs(args: unknown): Promise<ServerResult> {
  const parsed = ListJobsArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for list_jobs: ${parsed.error.message}`, true);
  const a = parsed.data;
  await loadHistory();
  let list = [...jobs.values()];
  if (a.group) list = list.filter((j) => j.group === a.group);
  if (a.status === 'active') list = list.filter((j) => !isFinished(j));
  else if (a.status === 'finished') list = list.filter(isFinished);
  else if (a.status) list = list.filter((j) => j.status === a.status);
  list.sort((x, y) => y.createdAt - x.createdAt);
  if (!list.length) return text('No jobs.');
  const shown = list.slice(0, a.limit);
  return text(`${list.length} job(s)${list.length > shown.length ? `, showing ${shown.length}` : ''}:\n${shown.map((j) => `  ${headline(j)}`).join('\n')}`);
}

export async function handleCancelJob(args: unknown): Promise<ServerResult> {
  const parsed = CancelJobArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for cancel_job: ${parsed.error.message}`, true);
  const a = parsed.data;
  if (!a.all && !a.ids?.length && !a.group) return text('cancel_job needs ids, group or all=true.', true);
  const picked = a.all ? [...jobs.values()] : select(a).picked;
  const cancelled = picked.filter(cancel);
  await Promise.race([Promise.all(cancelled.map((j) => j.done)), new Promise((r) => setTimeout(r, 5_000))]);
  return text(cancelled.length
    ? `Cancelled ${cancelled.length} job(s):\n${cancelled.map((j) => `  ${headline(j)}`).join('\n')}`
    : 'Nothing to cancel (no matching queued or running jobs).');
}

export async function handleRunParallel(args: unknown): Promise<ServerResult> {
  const parsed = RunParallelArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for run_parallel: ${parsed.error.message}`, true);
  const a = parsed.data;
  const bad = a.calls.find((s) => 'tool' in s && JOB_TOOL_NAMES.has(s.tool));
  if (bad) return text(`Tool "${(bad as { tool: string }).tool}" cannot be used inside run_parallel.`, true);
  await loadHistory();

  const group = `par-${Date.now().toString(36)}`;
  const batch = a.calls.map((c, i) => createJob([c], { label: c.label ?? `#${i + 1} ${stepName(c)}`, group }));
  // Keep file/metadata reads fast even when the system is busy. Mixed and
  // command batches run one at a time to avoid parallel CPU-heavy processes.
  const readsOnly = a.calls.every(s => 'tool' in s && FAST_PARALLEL_READS.has(s.tool));
  const workerLimit = RESPONSIVE ? (readsOnly ? 3 : 1) : 8;
  let next = 0;
  const worker = async () => {
    while (next < batch.length) {
      const job=batch[next++];
      try {await runJob(job);}
      catch(e) {markInternalJobFailure(job,e);}
    }
  };
  for (let w = 0; w < Math.min(a.max_concurrency, workerLimit, batch.length); w++)
    void worker().catch(()=>{ /* Last resort: job-level exceptions are handled above. */ });

  await waitUntil(batch, () => batch.every(isFinished), a.timeout_ms);

  const finished = batch.filter(isFinished);
  const failed = finished.filter((j) => j.status !== 'succeeded');
  let s = `run_parallel: ${finished.length}/${batch.length} done${failed.length ? `, ${failed.length} failed` : ''}.`;
  let shown=0;
  for (const j of batch) {
    const r=j.results[0];
    let part='\n\n'+(isFinished(j)
      ? `=== ${j.label} -> ${j.status === 'succeeded' ? 'OK' : j.status.toUpperCase()} (${secs((j.endedAt ?? 0) - (j.startedAt ?? j.createdAt))}) jobId=${j.id}`
      : `=== ${j.label} -> STILL ${j.status.toUpperCase()} as background job ${j.id}`);
    if(isFinished(j)&&r?.output)part+='\n'+clip(r.output,Math.min(a.output_chars,16000));
    if(s.length+part.length>MAX_MCP_JOB_OUTPUT-800)break;
    s+=part;shown++;
    if(isFinished(j))j.reported=true;
  }
  if(shown<batch.length)
    s+=`\n[MORE PARALLEL RESULTS: ${batch.length-shown} omitted from this reply. Call wait_jobs({group:"${group}"}) for unreported results or get_job({id:"..."}) by job ID. Do not rerun already-completed mutations.]`;
  if (finished.length < batch.length) s += `\n\nUnfinished calls keep running. Collect them with wait_jobs({"group":"${group}"}).`;
  return text(s);
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const JOB_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
  spawn_job: handleSpawnJob,
  wait_jobs: handleWaitJobs,
  get_job: handleGetJob,
  list_jobs: handleListJobs,
  cancel_job: handleCancelJob,
  run_parallel: handleRunParallel,
};

export function buildJobToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'run_parallel',
      description: [
        'Run independent tool calls/shell commands concurrently on this device. Total combined reply is capped at 128K characters; use wait_jobs(group) and get_job(id,step_offset) for omitted results without rerunning side effects.',
        'Use it whenever you would otherwise make several independent calls in a row: reading many files, several searches,',
        'git_status in many repos, running lint + typecheck + tests together, etc.',
        'Each item is {tool, args} (any BRC tool, args exactly as for a direct call) or {command, cwd?, timeout_ms?}.',
        'Results come back in input order, with bounded output and an explicit group for follow-up. Do not run writes to the same file concurrently. Items still running at timeout_ms (default 90s, max 100s) continue as',
        'background jobs; collect them with wait_jobs({group}). Commands that exit non-zero are reported as failed.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(RunParallelArgsSchema),
      annotations: { title: 'Run in parallel', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'spawn_job',
      description: [
        'Start a background worker job on this device and return its id immediately.',
        'Use for work that takes longer than one call (builds, test suites, installs, long scripts) or to run several',
        'workstreams in parallel: spawn one job per piece, then call wait_jobs. A job is either a single "command"',
        'or "steps": a list run in order, each {command, cwd?, timeout_ms?} or {tool, args} (e.g. edit_block then run tests).',
        'A failed step stops the job unless continue_on_error=true. Jobs are not limited by the 2-minute call timeout',
        `(default limit ${DEFAULT_JOB_TIMEOUT_MS / 60_000} min, max 6 h). Up to ${MAX_CONCURRENT_JOBS} jobs run at once; more are queued.`,
        'Give related jobs the same "group" to wait for or cancel them together.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(SpawnJobArgsSchema),
      annotations: { title: 'Spawn background job', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'wait_jobs',
      description: [
        `Wait (up to timeout_ms, default ${DEFAULT_WAIT_MS / 1000}s, max ${MAX_WAIT_MS / 1000}s) for background jobs and return their results.`,
        'Select jobs by ids or group; with neither, waits for all unfinished jobs plus finished ones not yet reported.',
        'mode=all (default) returns when every selected job is done; mode=any returns as soon as one more finishes,',
        'so you can react to results one by one. Each finished job\'s output is shown once; if some are still running,',
        'call wait_jobs again.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(WaitJobsArgsSchema),
      annotations: { title: 'Wait for jobs', readOnlyHint: true },
    },
    {
      name: 'get_job',
      description: 'Get the status and full step outputs of one background job (larger output limit than wait_jobs).',
      inputSchema: zodToJsonSchema(GetJobArgsSchema),
      annotations: { title: 'Get job', readOnlyHint: true },
    },
    {
      name: 'list_jobs',
      description: 'List background jobs (newest first), optionally filtered by group or status (queued, running, succeeded, failed, cancelled, timed_out, active, finished). Includes recent jobs from before an agent restart.',
      inputSchema: zodToJsonSchema(ListJobsArgsSchema),
      annotations: { title: 'List jobs', readOnlyHint: true },
    },
    {
      name: 'cancel_job',
      description: 'Cancel queued or running background jobs by ids, by group, or all=true. Running commands are killed with their whole process tree.',
      inputSchema: zodToJsonSchema(CancelJobArgsSchema),
      annotations: { title: 'Cancel jobs', readOnlyHint: false, destructiveHint: true },
    },
  ];
}
