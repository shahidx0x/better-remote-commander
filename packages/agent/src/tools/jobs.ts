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
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { runCommandCore, RunCommandArgsSchema } from './brc-tools.js';
import { activity, activityAction } from '../runtime/activity.js';
import { traceToolResult } from '../runtime/tool-trace.js';
import { summarizeCommandActivity } from '../runtime/command-log-summary.js';
import type { CommandActivityResult } from '../runtime/command-log-summary.js';
import { getCallContext, withCallContext, type CallContext } from '../context.js';
import type { CommandProgress } from './brc-tools.js';
import { homeDir } from '../transport/pairing.js';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { isHeavyTool } from '../runtime/operations.js';
import { saveJobOutput,readJobOutput,redactJobOutput,spillEnabled,type SpillRef } from '../runtime/job-output-spill.js';
import {classifyExecution} from '../runtime/execution-kernel.js';
import {AgentError,failure} from '../runtime/errors.js';
import {linkCallJobs} from '../runtime/call-outcomes.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------
const MAX_WAIT_MS = 100_000; // stay well below the relay's 120 s call timeout
const DEFAULT_WAIT_MS = 5_000;
const DEFAULT_JOB_TIMEOUT_MS = 30 * 60_000;
const MAX_JOB_TIMEOUT_MS = 6 * 60 * 60_000;
const CPU_PARALLELISM = Math.max(1, typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length);
// At most three background workers, scaled down on very small CPUs. A separate
// heavy-work gate below permits only one CPU-heavy job at a time.
const HARDWARE_WORKER_LIMIT = Math.max(1, Math.min(3, CPU_PARALLELISM));
const MAX_CONCURRENT_JOBS = HARDWARE_WORKER_LIMIT;
const MAX_QUEUED_JOBS = 64;
const MAX_CONCURRENT_HEAVY_JOBS = 1;
const MAX_STORED_STEP_OUTPUT = 16_000;
const KEEP_IN_MEMORY = 32;
const MAX_MCP_JOB_OUTPUT = 128_000;
const KEEP_ON_DISK = 100;
const MAX_JOB_HISTORY_DISK_BYTES = 32 * 1024 * 1024;
const CANCEL_SETTLE_GRACE_MS = Math.min(10_000,Math.max(100,Number(process.env.BRC_JOB_CANCEL_GRACE_MS)||10_000));

export const JOB_TOOL_NAMES = new Set(['spawn_job', 'wait_jobs', 'get_job', 'list_jobs', 'cancel_job', 'run_parallel']);
const FAST_PARALLEL_READS = new Set([
  'read_file','read_code_file','read_multiple_files','list_directory','get_file_info',
  'git_status','git_diff','git_log','agent_status','list_sessions','get_more_search_results'
]);
const PARALLEL_FILE_IO_TOOLS = new Set([
  'read_file','read_code_file','read_multiple_files','write_file','edit_block',
  'move_file','delete_file','create_directory','get_file_info'
]);
const MUTATING_FILE_IO_TOOLS = new Set(['write_file','edit_block','move_file','delete_file','create_directory']);
const HEAVY_FILE_EXTENSIONS = new Set([
  '.pdf','.xlsx','.xls','.docx','.pptx','.png','.jpg','.jpeg','.webp','.gif','.tif','.tiff','.avif'
]);

// One enormous combined job report can break an MCP client's message stream.
const capJobReply=(s:string):string=>s.length<=MAX_MCP_JOB_OUTPUT?s:
  s.slice(0,MAX_MCP_JOB_OUTPUT-360)+
  '\n[OUTPUT TRUNCATED: MCP job response reached 128000 characters. Request fewer jobs, smaller output_chars, or use get_job with step_offset/step_limit. Already-started jobs are not cancelled; inspect them before retrying mutations.]';
const text = (t: string, isError = false): ServerResult => ({
  content: [{ type: 'text', text: capJobReply(t) }], ...(isError ? { isError: true } : {})
});
/** Classify pre-execution job-tool errors instead of reporting TOOL_FAILED.
 * Never auto-retry a mutation, job batch, or uncertain request. */
function jobToolError(code:string, message:string, suggestion:string,
  next?:{tool:string;args:Record<string,unknown>}):ServerResult {
  return {
    isError:true,
    content:[{type:'text',text:capJobReply(code+': '+message+'\n'+suggestion)}],
    structuredContent:{
      error:{code,message,retryable:false},
      commandExecuted:false,
      recovery:{automaticRetry:false,suggestion,...(next?{next}:{})}
    }
  };
}

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
  maxOutputChars: z.number().int().min(1000).max(1_000_000).optional(),
  label: z.string().max(120).optional(),
});

const ToolStepSchema = z.object({
  tool: z.string().min(1).describe('Name of any BRC tool, e.g. read_file, edit_block, start_search, git_diff, run_command.'),
  args: z.record(z.unknown()).optional().default({}).describe('Arguments for that tool, exactly as you would pass them directly.'),
  label: z.string().max(120).optional(),
});

const StepSchema = z.union([CommandStepSchema, ToolStepSchema]);
type Step = z.infer<typeof StepSchema>;

/** Extract safe absolute file paths for the bounded parallel file-I/O lane. */
function fileIoPaths(step: Step): string[] | null {
  if (!('tool' in step) || !PARALLEL_FILE_IO_TOOLS.has(step.tool)) return null;
  const args = step.args as Record<string, unknown>;
  let values: unknown[];
  switch (step.tool) {
    case 'edit_block': values = [args.file_path]; break;
    case 'move_file': values = [args.source, args.destination]; break;
    case 'read_multiple_files': {
      const paths = Array.isArray(args.paths) ? args.paths : [];
      const files = Array.isArray(args.files) ? args.files : [];
      values = [...paths, ...files.map(entry =>
        entry && typeof entry === 'object' ? (entry as Record<string, unknown>).path : undefined)];
      break;
    }
    default: values = [args.path]; break;
  }
  if (!values.length || values.some(value => typeof value !== 'string' || !path.isAbsolute(value))) return null;
  const paths = values as string[];
  if (paths.some(value => HEAVY_FILE_EXTENSIONS.has(path.extname(value).toLowerCase()))) return null;
  return paths.map(value => {
    const absolute = path.resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  });
}

function pathContains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}

/** Only disjoint ordinary file operations may share the responsive I/O lane. */
export function isDisjointFileIoBatch(calls: readonly Step[]): boolean {
  const groups = calls.map(fileIoPaths);
  if (!groups.length || groups.some(group => !group)) return false;
  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      for (const a of groups[i]!) for (const b of groups[j]!) {
        if (pathContains(a, b) || pathContains(b, a)) return false;
      }
    }
  }
  return true;
}

export const SpawnJobArgsSchema = z.object({
  command: z.string().optional().describe('Shortcut for a one-command job. Use either command or steps.'),
  cwd: z.string().optional().describe('Working directory for the command shortcut.'),
  steps: z.array(StepSchema).min(1).max(50).optional().describe('Sequence run in order: each item is {command, cwd?, timeout_ms?} or {tool, args}.'),
  label: z.string().max(120).optional().describe('Short human name shown in results, e.g. "unit tests".'),
  group: z.string().max(60).optional().describe('Group name; wait_jobs/cancel_job/list_jobs can target a whole group.'),
  continue_on_error: z.boolean().optional().default(false).describe('Keep running later steps after a failed step (default: stop).'),
  retain_output: z.boolean().optional().describe('Opt in/out of redacted, quota-limited diagnostic output storage (up to 2 MiB per step). Default follows BRC_JOB_OUTPUT_SPILL=1.'),
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
  output_step: z.number().int().min(0).max(49).optional().describe('Read a retained output page for this zero-based job step, without rerunning the job.'),
  output_byte_offset: z.number().int().min(0).optional().default(0).describe('Byte offset for output_step; use nextByteOffset from the previous page.'),
});

export const ListJobsArgsSchema = z.object({
  group: z.string().optional(),
  status: z.enum(['queued', 'running', 'succeeded', 'failed', 'cancelled', 'timed_out', 'interrupted', 'active', 'finished']).optional(),
  limit: z.number().int().min(1).max(500).optional().default(50),
});

export const CancelJobArgsSchema = z.object({
  ids: z.array(z.string()).optional(),
  group: z.string().optional(),
  all: z.boolean().optional().default(false).describe('Cancel every queued or running job.'),
});

const DependenciesSchema=z.array(z.number().int().min(0).max(49)).max(20).optional().default([]);
const ParallelStepSchema=z.union([
  CommandStepSchema.extend({depends_on:DependenciesSchema}),
  ToolStepSchema.extend({depends_on:DependenciesSchema})
]);
export const RunParallelArgsSchema = z.object({
  calls: z.array(ParallelStepSchema).min(1).max(50).describe('Items execute concurrently when independent; optional depends_on:[0,1] names earlier zero-based call indices. Dependent calls start only when all prerequisites succeed.'),
  max_concurrency: z.number().int().min(1).max(3).optional().default(3),
  timeout_ms: z.number().int().min(1_000).max(MAX_WAIT_MS).optional().default(90_000)
    .describe('How long to wait for results. Calls still running then continue as background jobs.'),
  output_chars: z.number().int().min(200).max(50_000).optional().default(4_000).describe('Max output characters shown per call.'),
  retain_output: z.boolean().optional().describe('Opt in/out of bounded redacted diagnostic output for every call in the batch.'),
});

// ---------------------------------------------------------------------------
// Job model
// ---------------------------------------------------------------------------
type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted';

interface StepResult {
  index: number;
  name: string;
  ok: boolean;
  ms: number;
  output: string;
  spill?: SpillRef;
}

interface Job {
  id: string;
  label?: string;
  group?: string;
  /** Per-run_parallel group cap; global worker and heavy-work limits still apply. */
  groupConcurrency?: number;
  /** Pooled run_parallel predecessor IDs. Never execute until each succeeds. */
  dependsOn?:string[];
  status: JobStatus;
  steps: Step[];
  results: StepResult[];
  currentStep: number;
  continueOnError: boolean;
  timeoutMs: number;
  retainOutput?: boolean;
  createdAt: number;
  startedAt?: number;
  endedAt?: number;
  /** true once a finished job's result has been returned to the AI. */
  reported: boolean;
  // runtime only
  quickReturnPending?: boolean;
  quickResult?: ServerResult;
  consoleOutcome?: CommandActivityResult;
  consoleTrace?: string;
  progress?: CommandProgress;
  abort?: AbortController;
  ownerClient?: CallContext['client'];
  ownerRemote?: boolean;
  cancelRequested?: boolean;
  timedOut?: boolean;
  done?: Promise<void>;
  resolveDone?: () => void;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let runningPooled = 0;
let runningHeavy = 0;
const runningByGroup = new Map<string, number>();
const runningFileIo: Array<{ jobId: string; access: { paths: string[]; mutating: boolean } }> = [];
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

function createJob(steps: Step[], opts: { label?: string; group?: string; groupConcurrency?: number; dependsOn?:string[]; continueOnError?: boolean; timeoutMs?: number; retainOutput?:boolean }): Job {
  const job: Job = {
    id: newId(),
    label: opts.label,
    group: opts.group,
    groupConcurrency: opts.groupConcurrency,
    dependsOn:opts.dependsOn,
    status: 'queued',
    steps,
    results: [],
    currentStep: -1,
    continueOnError: !!opts.continueOnError,
    retainOutput: opts.retainOutput,
    timeoutMs: opts.timeoutMs ?? DEFAULT_JOB_TIMEOUT_MS,
    createdAt: Date.now(),
    reported: false,
    abort: new AbortController(),
    ownerClient:getCallContext()?.client??null,
    ownerRemote:getCallContext()?.remote??false,
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

/** A cancelled nested tool may still commit side effects. Wait briefly for
 * its real settlement; if it cannot confirm termination, mark it uncertain.
 * Never report definite cancellation while a mutation may still be running. */
function awaitToolSettlement(p:Promise<ServerResult>,signal:AbortSignal):Promise<ServerResult>{
  return new Promise((resolve,reject)=>{
    let settled=false,grace:NodeJS.Timeout|undefined;
    const done=(f:()=>void)=>{
      if(settled)return;
      settled=true;
      clearTimeout(grace);
      signal.removeEventListener('abort',onAbort);
      f();
    };
    const onAbort=()=>{
      if(grace||settled)return;
      grace=setTimeout(()=>done(()=>resolve({
        isError:true,
        content:[{type:'text',text:'TOOL_OUTCOME_UNCERTAIN: Cancellation was requested, but the tool did not settle within 10 seconds. It may still commit side effects. Inspect actual file/external state before retrying.'}],
        structuredContent:{error:{code:'TOOL_OUTCOME_UNCERTAIN',retryable:false},
          recovery:{automaticRetry:false,suggestion:'Revalidate the actual state; do not blindly replay the tool.'}}
      })),CANCEL_SETTLE_GRACE_MS);
    };
    signal.addEventListener('abort',onAbort,{once:true});
    if(signal.aborted)onAbort();
    p.then(v=>done(()=>resolve(v)),e=>done(()=>reject(e)));
  });
}

async function execStep(step: Step, signal: AbortSignal, remainingMs: number,
  onProgress?: (p: CommandProgress) => void,jobCallId?:string,
  owner?:{client:CallContext['client'];remote:boolean}): Promise<ServerResult> {
  if ('command' in step) {
    return runCommandCore(
      { command: step.command, cwd: step.cwd, shell: step.shell, raw: step.raw, maxOutputChars: step.maxOutputChars, timeout_ms: Math.max(1, Math.min(step.timeout_ms ?? remainingMs, remainingMs)) },
      { maxTimeoutMs: remainingMs, signal, failOnNonZero: true, onProgress },
    );
  }
  if (JOB_TOOL_NAMES.has(step.tool)) return text(`Tool "${step.tool}" cannot be used inside a job.`, true);
  if (step.tool === 'run_command') {
    const a = step.args as Record<string, unknown>;
    const t = typeof a.timeout_ms === 'number' ? Math.min(a.timeout_ms, remainingMs) : remainingMs;
    return runCommandCore({ ...a, timeout_ms: Math.max(1, t) }, { maxTimeoutMs: remainingMs, signal, failOnNonZero: true, onProgress });
  }
  if (!executor) return text('Job executor not initialised', true);
  if(signal.aborted)return text('CANCELLED: Job stopped before tool dispatch.',true);
  // Detach from the original MCP call's deadline. A background job must not
  // be aborted merely because ChatGPT's initial tool response has returned.
  const invoked=withCallContext({
    id:jobCallId??('job_'+Date.now()),client:owner?.client??null,remote:owner?.remote??false,
    signal,deadline:Date.now()+remainingMs
  },()=>executor!(step.tool,step.args as Record<string,unknown>));
  return awaitToolSettlement(invoked,signal);
}

async function runJob(job: Job): Promise<void> {
  if (job.status !== 'queued') return;
  job.status = 'running';
  job.startedAt = Date.now();
  void persist(job); // restart recovery can identify an interrupted in-flight step
  const signal = job.abort!.signal;
  const timer = setTimeout(() => { job.timedOut = true; job.abort!.abort(); }, job.timeoutMs);
  let anyFailed = false, uncertain = false;
  try {
    for (let i = 0; i < job.steps.length; i++) {
      if (signal.aborted) break;
      job.currentStep = i;
      const step = job.steps[i];
      const t0 = Date.now();
      let res: ServerResult;
      try {
        res = await execStep(step, signal, Math.max(1, job.timeoutMs - (t0 - job.startedAt)), p => { job.progress = p; },job.id+'-step'+i,
          {client:job.ownerClient??null,remote:job.ownerRemote??false});
      } catch (e) {
        res = text(`Error: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      if (job.quickReturnPending) job.quickResult = res;
      if (job.label === 'run_command') {
        job.consoleOutcome = summarizeCommandActivity(res);
        job.consoleTrace = activity.getConsoleMode()==='verbose' ? traceToolResult('run_command',res) : undefined;
      }
      const isRead='tool' in step && FAST_PARALLEL_READS.has(step.tool);
      const rawCommand='command' in step || ('tool' in step && step.tool==='run_command');
      const stepError=(res.structuredContent as {error?:{code?:string}}|undefined)?.error?.code;
      const observed=classifyExecution(res,isRead?'read':'external_mutation');
      // The native command runner confirms process-tree termination on
      // cooperative cancel/timeout; keep its existing CANCELLED/TIMED_OUT
      // job statuses. This never means prior filesystem effects rolled back.
      // A plugin/tool that explicitly reports an uncertain outcome still
      // makes the entire multi-step job INTERRUPTED, even after cancellation.
      const confirmedCommandStop=rawCommand && (job.cancelRequested||job.timedOut) &&
        ['CANCELLED','TIMEOUT','ETIMEDOUT'].includes(stepError??'');
      if(observed==='uncertain'&&!confirmedCommandStop)uncertain=true;
      const ok = !res.isError;
      const full=(res.content??[]).map((c:any)=>c?.type==='text'?String(c.text??''):'[non-text content omitted]').join('\n');
      const spill=await saveJobOutput(job.id,i,full,job.retainOutput);
      job.results.push({ index: i, name: stepName(step), ok, ms: Date.now() - t0,
        output: resultText(res),...(spill?{spill}:{}) });
      void persist(job); // durable progress after each settled step
      if (!ok) {
        anyFailed = true;
        // A previous mutation may have committed despite its failed reply.
        // Subsequent steps must not run against uncertain state, even when
        // continue_on_error=true was requested for ordinary failures.
        if (uncertain || !job.continueOnError) break;
      }
    }
  } finally {
    clearTimeout(timer);
    job.status = uncertain ? 'interrupted' : job.cancelRequested ? 'cancelled' : job.timedOut ? 'timed_out' : anyFailed ? 'failed' : 'succeeded';
    job.endedAt = Date.now();
    job.currentStep = -1;
    // If it finished inside the synchronous window, the original run_command
    // response already logs the result. After a PENDING handoff, emit exactly
    // one FINAL event using the same tool name and the stable job ID.
    if (job.label === 'run_command' && !job.quickReturnPending) {
      const first = job.steps[0];
      const action = first && 'command' in first
        ? activityAction('run_command',{command:first.command,cwd:first.cwd})
        : 'managed shell command';
      const ok = job.status === 'succeeded';
      const exit = job.consoleOutcome?.exitCode;
      const code = ok ? undefined : job.status === 'failed' && exit !== null &&
        exit !== undefined ? 'EXIT_'+exit : job.status.toUpperCase();
      const note = 'Job '+job.id+' | '+(job.consoleOutcome?.detail ??
        (ok ? 'finished' : job.status.toUpperCase()));
      activity.tool(ok ? 'OK' : 'ERROR','run_command',job.id,
        job.endedAt - (job.startedAt ?? job.createdAt),code,action,note,job.consoleTrace);
    }
    job.consoleOutcome=undefined;
    job.consoleTrace=undefined;
    // A completed wait_jobs/get_job receipt must not race the final disk
    // checkpoint. Persist atomically before notifying waiting callers.
    await persist(job);
    job.resolveDone!();
    prune();
  }
}

function jobFileIoAccess(job: Job): { paths: string[]; mutating: boolean } | null {
  if (job.steps.length !== 1 || !('tool' in job.steps[0])) return null;
  const step = job.steps[0];
  const paths = fileIoPaths(step);
  if (!paths) return null;
  return { paths, mutating: MUTATING_FILE_IO_TOOLS.has(step.tool) };
}

function fileIoConflicts(
  a: { paths: string[]; mutating: boolean },
  b: { paths: string[]; mutating: boolean },
): boolean {
  if (!a.mutating && !b.mutating) return false;
  for (const left of a.paths) for (const right of b.paths) {
    if (pathContains(left, right) || pathContains(right, left)) return true;
  }
  return false;
}

/** Commands and explicitly expensive tools share one serialized CPU-heavy lane. */
function isHeavyJob(job: Job): boolean {
  if (job.steps.length > 1 && job.steps.some(step => 'tool' in step && MUTATING_FILE_IO_TOOLS.has(step.tool))) return true;
  return job.steps.some(step => {
    if ('command' in step) return true;
    // Ordinary file I/O has its own path-aware concurrency gate below.
    if (fileIoPaths(step)) return false;
    return isHeavyTool(step.tool) || MUTATING_FILE_IO_TOOLS.has(step.tool);
  });
}

/** Pooled jobs share three bounded worker slots; at most one may be CPU-heavy. */
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
    // Skip cancelled entries and allow lightweight work to pass a queued heavy
    // task that is waiting for the single heavy slot to become available.
    let index = -1;
    for (let i = 0; i < queue.length; i++) {
      const candidate = queue[i];
      if (candidate.status !== 'queued') {
        queue.splice(i--, 1);
        continue;
      }
      if(candidate.dependsOn?.length){
        const predecessors=candidate.dependsOn.map(id=>jobs.get(id));
        const missing=predecessors.some(item=>!item);
        const failed=predecessors.some(item=>item&&isFinished(item)&&item.status!=='succeeded');
        if(missing||failed){
          queue.splice(i--,1);
          candidate.status='failed';candidate.endedAt=Date.now();
          candidate.results.push({index:0,name:'dependency validation',ok:false,ms:0,
            output:'DEPENDENCY_FAILED: A required predecessor did not succeed or is missing. This step was NOT executed. Inspect the previous job; no automatic retry.'});
          void persist(candidate).finally(()=>{candidate.resolveDone?.();pump();});
          continue;
        }
        if(predecessors.some(item=>item&&!isFinished(item)))continue;
      }
      const heavy = isHeavyJob(candidate);
      if (heavy && runningHeavy >= MAX_CONCURRENT_HEAVY_JOBS) continue;
      const access = jobFileIoAccess(candidate);
      if (access && runningFileIo.some(active => fileIoConflicts(access, active.access))) continue;
      if (candidate.group && candidate.groupConcurrency &&
          (runningByGroup.get(candidate.group) ?? 0) >= candidate.groupConcurrency) continue;
      index = i;
      break;
    }
    if (index < 0) break;
    const job = queue.splice(index, 1)[0];
    const heavy = isHeavyJob(job);
    const access = jobFileIoAccess(job);
    runningPooled++;
    if (heavy) runningHeavy++;
    if (access) runningFileIo.push({ jobId: job.id, access });
    if (job.group) runningByGroup.set(job.group, (runningByGroup.get(job.group) ?? 0) + 1);
    void runJob(job).catch(e=>markInternalJobFailure(job,e))
      .finally(() => {
        runningPooled--;
        if (heavy) runningHeavy--;
        const activeIoIndex = runningFileIo.findIndex(active => active.jobId === job.id);
        if (activeIoIndex >= 0) runningFileIo.splice(activeIoIndex, 1);
        if (job.group) {
          const left = (runningByGroup.get(job.group) ?? 1) - 1;
          if (left > 0) runningByGroup.set(job.group, left);
          else runningByGroup.delete(job.group);
        }
        pump();
      });
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
  const { abort, done, resolveDone, cancelRequested, timedOut, quickReturnPending, quickResult,
    progress, consoleOutcome, consoleTrace, ownerClient, ownerRemote, ...rest } = job;
  // Completed/interrupted jobs are never replayed from disk. Do not persist
  // arbitrary shell strings, plugin args, edit text, or secrets in job history.
  const safeSteps=rest.steps.map(s=>('command' in s)
    ?{command:'[command omitted from persisted history]',label:s.label?redactJobOutput(s.label).slice(0,120):undefined}
    :{tool:s.tool,args:{},label:s.label?redactJobOutput(s.label).slice(0,120):undefined});
  return {...rest,steps:safeSteps,
    results:rest.results.map(r=>({...r,
      name:r.name.startsWith('$ ')?'$ [command omitted]':redactJobOutput(r.name).slice(0,150),
      output:redactJobOutput(r.output)}))};
}

const diskWrites=new Map<string,Promise<void>>();
async function persist(job:Job):Promise<void>{
  // Freeze the snapshot before scheduling I/O: writes for one job may be
  // triggered from the running step and completion at nearly the same time.
  let body:string;
  try{body=JSON.stringify(serialisable(job));}catch{return;}
  if(Buffer.byteLength(body)>1024*1024)return;
  const prior=diskWrites.get(job.id)??Promise.resolve();
  const id=job.id;
  const current=prior.catch(()=>{}).then(async()=>{
    const dir=jobsDir();
    const dest=path.join(dir,id+'.json');
    const tmp=path.join(dir,id+'.'+process.pid+'.'+Math.random().toString(16).slice(2)+'.tmp');
    try{
      await fs.mkdir(dir,{recursive:true,mode:0o700});
      await fs.writeFile(tmp,body,{mode:0o600,flag:'wx'});
      await fs.rename(tmp,dest);
      if(!isFinished(job))return;
      const names=(await fs.readdir(dir)).filter(n=>n.endsWith('.json'));
      const entries=(await Promise.all(names.map(async name=>{
        try{const st=await fs.stat(path.join(dir,name));return{name,time:st.mtimeMs,bytes:st.size};}
        catch{return null;}
      }))).filter((e):e is {name:string;time:number;bytes:number}=>!!e).sort((a,b)=>b.time-a.time);
      let total=0;
      for(let i=0;i<entries.length;i++){
        const e=entries[i];total+=e.bytes;
        if(i>=KEEP_ON_DISK || (total>MAX_JOB_HISTORY_DISK_BYTES && i>=1))
          await fs.unlink(path.join(dir,e.name)).catch(()=>{});
      }
    }finally{await fs.unlink(tmp).catch(()=>{});}
  });
  diskWrites.set(id,current);
  try{await current;}catch{/* persistence is best effort */}
  finally{if(diskWrites.get(id)===current)diskWrites.delete(id);}
}

async function loadHistory(): Promise<void> {
  if (historyLoaded) return;
  historyLoaded = true;
  try {
    const dir=jobsDir();
    const names=(await fs.readdir(dir)).filter(f=>f.endsWith('.json'));
    const ordered=(await Promise.all(names.map(async name=>{
      try{return{name,mtime:(await fs.stat(path.join(dir,name))).mtimeMs};}
      catch{return null;}
    }))).filter((v):v is {name:string;mtime:number}=>!!v).sort((a,b)=>b.mtime-a.mtime).slice(0,KEEP_ON_DISK);
    for (const {name:f} of ordered) {
      try {
        const j = JSON.parse(await fs.readFile(path.join(jobsDir(), f), 'utf8')) as Job;
        if (!j?.id || jobs.has(j.id)) continue;
        if (j.status === 'queued' || j.status === 'running') {
          j.status = 'interrupted'; // completion/side effects were never confirmed
          j.endedAt = j.endedAt ?? Date.now();
          j.results.push({index:j.currentStep,name:'Interrupted by agent restart',ok:false,ms:0,
            output:'Previous agent stopped before this job settled. Inspect files/external effects before retrying any work.'});
        }
        j.reported = true;
        j.done = Promise.resolve();
        jobs.set(j.id, j);
      } catch { /* skip bad file */ }
    }
  } catch { /* no dir yet */ }
}

function prune(): void {
  const finished = [...jobs.values()].filter(isFinished).sort((a, b) => (a.endedAt ?? 0) - (b.endedAt ?? 0));
  const required=new Set([...jobs.values()].filter(j=>!isFinished(j)).flatMap(j=>j.dependsOn??[]));
  const removable=finished.filter(j=>!required.has(j.id));
  for (const j of removable.slice(0, Math.max(0, removable.length - KEEP_IN_MEMORY))) jobs.delete(j.id);
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
  if (j.status === 'running' && j.progress) {
    const p = j.progress;
    const idle = p.lastOutputAt === null ? 'no output yet' :
      secs(Math.max(0, Date.now()-p.lastOutputAt)) + ' since last output';
    s += '\n  LIVE: pid=' + (p.pid ?? 'starting') + ', ' + p.outputChars +
      ' output chars, ' + idle + '. Process is still running.';
    if (p.lastOutputAt && Date.now()-p.lastOutputAt > 120000)
      s += '\n  WARNING: no output for 2 minutes; inspect before deciding it is stuck.';
  }
  const selected=j.results.slice(stepOffset,stepOffset+stepLimit);
  let rendered=0;
  for (const r of selected) {
    const head=`\n  ${r.index + 1}. ${r.ok ? 'OK ' : 'ERR'} ${r.name} (${secs(r.ms)})`;
    const body=r.output ? '\n'+clip(r.output,Math.min(outputChars,32_000)).split('\n').map(l=>'     '+l).join('\n') : '';
    if(s.length+head.length+body.length>MAX_MCP_JOB_OUTPUT-600)break;
    s+=head+body;
    if(r.spill)s+=`\n     [Retained output: ${r.spill.bytes} bytes${r.spill.partial?', partial':''}. Read with get_job({id:"${j.id}",output_step:${r.index},output_byte_offset:0,output_chars:${Math.min(outputChars,8000)}}).]`;
    rendered++;
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
export async function handleManagedRunCommand(args: unknown): Promise<ServerResult> {
  const parsed = RunCommandArgsSchema.safeParse(args);
  if (!parsed.success) return failure(new AgentError('INVALID_ARGUMENT',
    'Invalid run_command arguments: '+parsed.error.message.slice(0,800)));
  await loadHistory();
  if (queue.length >= MAX_QUEUED_JOBS) return failure(new AgentError('BUSY',
    'Job queue is full. No command started; wait for current jobs to settle before submitting new work.'));
  const a = parsed.data, runtimeMs = a.max_runtime_ms ?? (6 * 60 * 60_000);
  const directStep=a.program
    ?{tool:'run_command',args:{program:a.program,args:a.args,cwd:a.cwd,raw:a.raw,
        maxOutputChars:a.maxOutputChars,timeout_ms:runtimeMs}}
    :{command:a.command!,cwd:a.cwd,shell:a.shell,raw:a.raw,
        maxOutputChars:a.maxOutputChars,timeout_ms:runtimeMs};
  const job = createJob([directStep],{timeoutMs:runtimeMs,label:'run_command'});
  job.quickReturnPending=true;
  await persist(job);
  const origin=getCallContext();
  if(origin?.remote)await linkCallJobs(origin.id,[job.id]);
  enqueue(job);
  // An explicit cancel_operation BEFORE the handoff still cancels this job.
  // After a PENDING receipt, it is independent from relay call deadlines and
  // can only be intentionally cancelled through cancel_job.
  const callerSignal=getCallContext()?.signal;
  const abortBeforeHandoff=()=>{cancel(job);};
  callerSignal?.addEventListener('abort',abortBeforeHandoff,{once:true});
  if(callerSignal?.aborted) abortBeforeHandoff();
  let timer: NodeJS.Timeout | undefined;
  try {
    // Most pnpm lint/test/build checks here finish in ~4-5 seconds. Returning
    // PENDING after only 1.8s forces needless additional AI tool calls.
    // Keep non-package commands low-latency, and never hold near relay limits.
    const quickWaitMs=/^(?:pnpm|npm|yarn|bun|cargo|dotnet)(?:\s|\.|$)/i.test(
      a.command?.trim()??path.basename(a.program??''))?6000:1800;
    await Promise.race([job.done!,new Promise<void>(resolve=>{timer=setTimeout(resolve,quickWaitMs);})]);
  } finally {
    if(timer)clearTimeout(timer);
    callerSignal?.removeEventListener('abort',abortBeforeHandoff);
  }
  if(callerSignal?.aborted) {
    if(!isFinished(job)) {
      let grace:NodeJS.Timeout|undefined;
      await Promise.race([job.done!,new Promise<void>(resolve=>{grace=setTimeout(resolve,2600);})]);
      if(grace)clearTimeout(grace);
    }
    job.quickReturnPending=false;
    const stopped=job.quickResult;
    job.quickResult=undefined;
    if(stopped?.isError)return stopped;
    return {
      isError:true,
      content:[{type:'text',text:'CANCELLED: explicit cancellation requested before command handoff. Check job '+job.id+' if cleanup is still pending.'}],
      structuredContent:{cancelled:true,jobId:job.id,pending:false,
        error:{code:'CANCELLED',retryable:false},
        recovery:{automaticRetry:false,suggestion:'Inspect job state before rerunning any side effects.'}}
    };
  }
  job.quickReturnPending=false;
  const result=job.quickResult;
  job.quickResult=undefined;
  if(isFinished(job)&&result)return result;
  return {
    content:[{type:'text',text:'PENDING: command still running on local machine, not completed.\n'+detail(job,1200)+
      '\nNEXT: get_job({id:"'+job.id+'"}), then wait_jobs({ids:["'+job.id+
      '"],timeout_ms:5000}) until final status. Do not rerun the command or declare the AI task complete.'}],
    structuredContent:{pending:true,jobId:job.id,status:job.status,maxRuntimeMs:runtimeMs,
      next:{tool:'get_job',args:{id:job.id}}}
  };
}
export async function handleSpawnJob(args: unknown): Promise<ServerResult> {
  const parsed = SpawnJobArgsSchema.safeParse(args);
  if (!parsed.success) return jobToolError('INVALID_ARGUMENT',
    'Invalid spawn_job arguments: '+parsed.error.message.slice(0,700),
    'Provide one command or a sequence of valid tool/command steps. No job was started.');
  const a = parsed.data;
  const steps: Step[] = [...(a.command ? [{ command: a.command, cwd: a.cwd }] : []), ...(a.steps ?? [])];
  if (!steps.length) return jobToolError('INVALID_ARGUMENT',
    'spawn_job requires command or steps.', 'Provide a command or at least one step; no job was started.');
  const bad = steps.find((s) => 'tool' in s && JOB_TOOL_NAMES.has(s.tool));
  if (bad) return jobToolError('NESTED_JOB_TOOL',
    `Tool "${(bad as { tool: string }).tool}" cannot run inside a background job.`,
    'Use job-control tools separately. No job was started.');
  await loadHistory();
  if (queue.length >= MAX_QUEUED_JOBS)
    return jobToolError('JOB_QUEUE_FULL',
      `${MAX_QUEUED_JOBS} jobs are already queued; no job was started.`,
      'Wait for existing jobs to finish, then inspect list_jobs before scheduling another.',
      {tool:'list_jobs',args:{limit:50}});
  const job = createJob(steps, { label: a.label, group: a.group, continueOnError: a.continue_on_error, timeoutMs: a.timeout_ms, retainOutput:a.retain_output });
  await persist(job);
  const origin=getCallContext();
  if(origin?.remote)await linkCallJobs(origin.id,[job.id]);
  enqueue(job);
  const pos = job.status === 'queued' ? ` (queued: ${MAX_CONCURRENT_JOBS} jobs run at once)` : '';
  const message=`Started job ${job.id}${job.label ? ` "${job.label}"` : ''}${job.group ? ` in group ${job.group}` : ''} with ${steps.length} step(s)${pos}.\nUse wait_jobs to collect the result.`;
  return {content:[{type:'text',text:message}],structuredContent:{jobId:job.id,group:job.group??null,pending:true,status:job.status,next:{tool:'get_job',args:{id:job.id}}}};
}

export async function handleWaitJobs(args: unknown): Promise<ServerResult> {
  const parsed = WaitJobsArgsSchema.safeParse(args);
  if (!parsed.success) return jobToolError('INVALID_ARGUMENT',
    'Invalid wait_jobs arguments: '+parsed.error.message.slice(0,700),
    'Pass known ids or a group, and a timeout_ms within the allowed range.');
  const a = parsed.data;
  await loadHistory();
  const { picked, missing } = select(a);
  if (!picked.length && missing.length) return jobToolError('JOB_NOT_FOUND',
    `Unknown or expired job IDs: ${missing.slice(0,15).join(', ')}`,
    'Inspect list_jobs for retained IDs and verify completed effects before repeating work.',
    {tool:'list_jobs',args:{limit:50}});
  if (!picked.length) return text('No jobs to wait for.');
  const cond = a.mode === 'any'
    ? () => picked.every(isFinished) || picked.some((j) => isFinished(j) && !j.reported)
    : () => picked.every(isFinished);
  await waitUntil(picked, cond, a.timeout_ms);
  return text(summary(picked, a.output_chars, missing));
}

export async function handleGetJob(args: unknown): Promise<ServerResult> {
  const parsed = GetJobArgsSchema.safeParse(args);
  if (!parsed.success) return jobToolError('INVALID_ARGUMENT',
    'Invalid get_job arguments: '+parsed.error.message.slice(0,700),
    'Supply a known job id from list_jobs and valid output_chars/step_offset/step_limit.',
    {tool:'list_jobs',args:{limit:50}});
  await loadHistory();
  const j = jobs.get(parsed.data.id);
  if (!j) return jobToolError('JOB_NOT_FOUND',
    `Unknown or expired job id: ${parsed.data.id}`,
    'Call list_jobs to find retained job IDs. A job may have been pruned; do not replay a previous command or mutation without checking its effects.',
    {tool:'list_jobs',args:{limit:50}});
  if(parsed.data.output_step!==undefined){
    const step=parsed.data.output_step;
    const result=j.results.find(r=>r.index===step);
    if(!result)return jobToolError('JOB_STEP_NOT_FOUND','No settled result for job step '+step,
      'Inspect get_job for completed step indices. Do not repeat the job.');
    if(!result.spill)return jobToolError('JOB_OUTPUT_NOT_RETAINED',
      'No retained large output exists for this job step.',
      'Use get_job normal preview. Future long jobs can explicitly set retain_output:true; no command was rerun.');
    let page;
    try{page=await readJobOutput(j.id,step,parsed.data.output_byte_offset,parsed.data.output_chars,result.spill.sha256);}
    catch{return jobToolError('JOB_OUTPUT_READ_FAILED','Could not read retained output.',
      'Inspect the job preview. The output store may be unavailable; do not replay the job.');}
    if(!page)return jobToolError('JOB_OUTPUT_NOT_FOUND',
      'Retained output was evicted, corrupted, or the requested offset is beyond its end.',
      'Inspect the available preview and existing job effects; do not rerun mutations blindly.');
    const next=page.hasMore?{tool:'get_job',args:{id:j.id,output_step:step,output_byte_offset:page.nextByteOffset,output_chars:parsed.data.output_chars}}:null;
    return {content:[{type:'text',text:'JOB OUTPUT '+j.id+' step='+step+
      ' bytes '+page.byteOffset+'..'+page.nextByteOffset+'/'+page.totalBytes+
      (result.spill.partial?' (retained output was size-capped)':'')+'\n'+page.text+
      (page.hasMore?'\n[MORE OUTPUT: call get_job with output_byte_offset='+page.nextByteOffset+']':'')}],
      structuredContent:{jobId:j.id,step,byteOffset:page.byteOffset,
        nextByteOffset:page.nextByteOffset,totalBytes:page.totalBytes,hasMore:page.hasMore,
        retainedOutputPartial:result.spill.partial, ...(next?{next}:{})}};
  }
  const out = detail(j, parsed.data.output_chars,parsed.data.step_offset,parsed.data.step_limit);
  if (isFinished(j) && !out.includes('[MORE JOB STEPS:')) j.reported = true;
  const answer=text(out);
  const retention={enabled:spillEnabled(j.retainOutput),optInRequiredByDefault:true,
    storedStepCount:j.results.filter(x=>!!x.spill).length,
    retainedSteps:j.results.filter(x=>!!x.spill).map(x=>({step:x.index,bytes:x.spill!.bytes,
      partial:x.spill!.partial})),
    storeCommandArguments:false,automaticJobReplay:false,
    note:'Large output retention is disabled by default unless explicitly requested or enabled in the local environment. Redaction is best effort; retained output can still contain sensitive data.'};
  return {...answer,structuredContent:{jobId:j.id,status:j.status,steps:j.steps.length,
    results:j.results.length,stepOffset:parsed.data.step_offset,
    hasMoreSteps:parsed.data.step_offset+parsed.data.step_limit<j.results.length,
    outputRetention:retention}};
}

export async function handleListJobs(args: unknown): Promise<ServerResult> {
  const parsed = ListJobsArgsSchema.safeParse(args);
  if (!parsed.success) return jobToolError('INVALID_ARGUMENT',
    'Invalid list_jobs arguments: '+parsed.error.message.slice(0,700),
    'Use a valid status, group and a limit between 1 and 500.');
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
  if (!parsed.success) return jobToolError('INVALID_ARGUMENT',
    'Invalid cancel_job arguments: '+parsed.error.message.slice(0,700),
    'Pass job IDs, a group, or all:true. No cancellation was requested.');
  const a = parsed.data;
  if (!a.all && !a.ids?.length && !a.group) return jobToolError('INVALID_ARGUMENT',
    'cancel_job requires IDs, group or all:true.',
    'Select target jobs explicitly; no cancellation was requested.');
  const picked = a.all ? [...jobs.values()] : select(a).picked;
  const cancelled = picked.filter(cancel);
  await Promise.race([Promise.all(cancelled.map((j) => j.done)), new Promise((r) => setTimeout(r, 5_000))]);
  return text(cancelled.length
    ? `Cancelled ${cancelled.length} job(s):\n${cancelled.map((j) => `  ${headline(j)}`).join('\n')}`
    : 'Nothing to cancel (no matching queued or running jobs).');
}

export async function handleRunParallel(args: unknown): Promise<ServerResult> {
  const parsed = RunParallelArgsSchema.safeParse(args);
  if (!parsed.success) return jobToolError('INVALID_ARGUMENT',
    'Invalid run_parallel arguments: '+parsed.error.message.slice(0,700),
    'Supply 1-50 independent calls containing {tool,args} or {command,cwd}. No tasks were started.');
  const a = parsed.data;
  const bad = a.calls.find((s) => 'tool' in s && JOB_TOOL_NAMES.has(s.tool));
  if (bad) return jobToolError('NESTED_JOB_TOOL',
    `Tool "${(bad as { tool: string }).tool}" cannot run inside run_parallel.`,
    'Call job-control tools separately; only independent ordinary tools or commands may be grouped. Nothing was started.');
  // Validate every dependency before creating any persistent job. Only
  // earlier indices are allowed, so cycles and self-dependencies are impossible.
  for(let i=0;i<a.calls.length;i++){
    const deps=a.calls[i].depends_on;
    if(new Set(deps).size!==deps.length||deps.some(index=>index>=i))
      return jobToolError('INVALID_DEPENDENCY',
        'Call #'+(i+1)+' has a duplicate, self, or future dependency.',
        'Use zero-based depends_on indices strictly smaller than the current call index. No tasks were started.');
  }
  await loadHistory();

  if (queue.length + a.calls.length > MAX_QUEUED_JOBS)
    return jobToolError('JOB_QUEUE_FULL',
      `The batch would exceed the ${MAX_QUEUED_JOBS}-job queue; no calls were started.`,
      'Wait for existing jobs to finish and inspect list_jobs before submitting another batch.',
      {tool:'list_jobs',args:{limit:50}});
  const group = `par-${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const batch = a.calls.map((c, i) => createJob([c], {
    label: c.label ?? `#${i + 1} ${stepName(c)}`,
    group,
    groupConcurrency: a.max_concurrency,
    retainOutput:a.retain_output,
  }));
  // Resolve dependency IDs after all jobs exist; indices were validated above.
  for(let i=0;i<batch.length;i++)
    batch[i].dependsOn=a.calls[i].depends_on.map(index=>batch[index].id);
  // Save all job identities and associate the originating remote call before
  // dispatch. A lost result can be recovered by lookupCallId, with no replay.
  await Promise.all(batch.map(job=>persist(job)));
  const origin=getCallContext();
  if(origin?.remote)await linkCallJobs(origin.id,batch.map(job=>job.id));
  // Feed the shared scheduler: at most three workers globally, one CPU-heavy
  // job at a time, and lightweight work can pass a queued heavy job.
  for (const job of batch) enqueue(job);

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
  return {content:[{type:'text',text:capJobReply(s)}],structuredContent:{group,jobIds:batch.map(j=>j.id),
    dependencies:a.calls.map(c=>c.depends_on),finished:finished.length,total:batch.length,
    failed:failed.length,failedJobIds:failed.map(j=>j.id),
    executionCompleted:finished.length===batch.length,
    allCallsSucceeded:finished.length===batch.length&&failed.length===0,
    pending:finished.length<batch.length,
    next:finished.length<batch.length?{tool:'wait_jobs',args:{group}}:null}};
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
        'Run independent tool calls/shell commands concurrently, or add explicit depends_on:[0,1] zero-based earlier indices for a bounded dependency-aware workflow. A dependent call runs ONLY after every predecessor succeeds. Failed or interrupted predecessors skip dependent commands and writes without execution.',
        'Up to three workers run globally, but only one CPU-heavy command/build/check runs at a time; lightweight file reads continue while it runs.',
        'Use it for independent reads, file operations on separate paths, searches and lightweight checks.',
        'Heavy builds/tests/commands are serialized; lightweight reads can finish while a heavy job continues.',
        'Each item is {tool,args,depends_on?:number[]} or {command,cwd?,timeout_ms?,depends_on?:number[]}. Dependencies reference earlier array items only. No model, hidden retries, or invented arguments.',
        'Results come back in input order, with bounded output and an explicit group for follow-up. Do not run writes to the same file concurrently. Items still running at timeout_ms (default 90s, max 100s) continue as',
        'background jobs; collect them with wait_jobs({group}). Heavy jobs are serialized; independent light work can run alongside them. Total combined reply is capped at 128K characters.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(RunParallelArgsSchema),
      annotations: { title: 'Run in parallel', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'spawn_job',
      description: [
        'Start a background worker job on this device and return its id immediately.',
        'Use for work that takes longer than one call (builds, test suites, installs, long scripts) or to run several',
        'workstreams: spawn one job per piece, then call wait_jobs. Up to three workers run globally; only one CPU-heavy job runs at a time, while light file work can continue. A job is either a single "command"',
        'or "steps": a list run in order, each {command, cwd?, timeout_ms?} or {tool, args} (e.g. edit_block then run tests).',
        'A failed step stops the job unless continue_on_error=true. Jobs are not limited by the 2-minute call timeout',
        `(default limit ${DEFAULT_JOB_TIMEOUT_MS / 60_000} min, max 6 h). Up to ${MAX_CONCURRENT_JOBS} jobs run at once; CPU-heavy jobs are serialized and light reads may run beside one heavy job.`,
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
      description: 'Get job status and bounded step previews. For long output retained via retain_output:true or BRC_JOB_OUTPUT_SPILL=1, page safely using output_step (zero-based), output_byte_offset and output_chars; pages are read-only and never repeat execution.',
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
