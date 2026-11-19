/**
 * BRC-native tools (not part of the vendored Desktop Commander core):
 *   run_command  - one-shot command: run, wait, return exit code + stdout/stderr
 *   delete_file  - delete a file or directory inside allowed directories
 *   git_status / git_diff / git_log - structured, size-capped git helpers
 *
 * All path arguments go through the core validatePath() (allowedDirectories) and
 * all commands through commandManager.validateCommand() (blockedCommands).
 */
import { spawn, execFile } from 'node:child_process';
import { getCallContext, checkCancelled } from '../context.js';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { validatePath } from '../core/tools/filesystem.js';
import { commandManager } from '../core/command-manager.js';
import { configManager } from '../core/config-manager.js';
import { getShellSpawnArgs, getRepairedPathExt } from '../core/terminal-manager.js';
import { selectRunCommandShell } from './command-shell.js';
import {commandEnvironment,commandEnvironmentPolicy} from '../runtime/command-environment.js';
import {requestProcessTreeStop,observeManagedChild,stopManagedChild,managedTerminationState} from '../runtime/process-termination.js';
import {commandCpuAdmission} from '../runtime/resource-admission.js';
import {spawnManaged} from '../runtime/managed-spawn.js';
import { AgentError, failure } from '../runtime/errors.js';
import { planFastExec } from './fast-exec.js';
import { planRtkCommand, resolveRtk, rtkEnv, annotateRtkOutput, isRtkUsageError } from './rtk.js';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';

// Stay below the relay's 120s per-call timeout so we can always answer.
const MAX_TIMEOUT_MS = 110_000;
const isWindows = process.platform === 'win32';

const text = (t: string, isError = false): ServerResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// ---------------------------------------------------------------------------
// Bounded output capture: keeps the head and the tail of a stream.
// ---------------------------------------------------------------------------
export class CappedOutput {
  private head = '';
  // A capped ring of chunks avoids repeatedly concatenating/copying a 120 KB
  // string on every stdout event from chatty compilers or test runners.
  private tailChunks: string[] = [];
  private tailLength = 0;
  private dropped = 0;
  constructor(private readonly headCap: number, private readonly tailCap: number) {}
  push(chunk: string): void {
    if (this.head.length < this.headCap) {
      const room = this.headCap - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    if (this.tailCap <= 0) { this.dropped += chunk.length; return; }
    if (chunk.length >= this.tailCap) {
      this.dropped += this.tailLength + chunk.length - this.tailCap;
      this.tailChunks = [chunk.slice(-this.tailCap)];
      this.tailLength = this.tailCap;
      return;
    }
    this.tailChunks.push(chunk);
    this.tailLength += chunk.length;
    while (this.tailLength > this.tailCap) {
      const excess = this.tailLength - this.tailCap;
      const first = this.tailChunks[0];
      const removed = Math.min(excess, first.length);
      this.dropped += removed;
      this.tailLength -= removed;
      if (removed === first.length) this.tailChunks.shift();
      else this.tailChunks[0] = first.slice(removed);
    }
    if (this.tailChunks.length > 64) this.tailChunks = [this.tailChunks.join('')];
  }
  get truncated(): boolean { return this.dropped > 0; }
  toString(): string {
    const tail = this.tailChunks.join('');
    if (!this.dropped) return this.head + tail;
    return `${this.head}\n\n[... ${this.dropped} characters truncated ...]\n\n${tail}`;
  }
}

export function killTree(pid: number | undefined): void {
  // Shared stop request used by command and AST workers; only a subsequent
  // child "close" event can confirm the root exited (not full tree cleanup).
  requestProcessTreeStop(pid);
}

async function resolveShell(requested?: string): Promise<string> {
  if (requested) return requested;
  const config = await configManager.getConfig();
  if (config.defaultShell) return config.defaultShell as string;
  if (isWindows) return process.env.COMSPEC || 'cmd.exe';
  return process.env.SHELL || '/bin/sh';
}

// ---------------------------------------------------------------------------
// run_command
// ---------------------------------------------------------------------------
export const RunCommandArgsSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
  timeout_ms: z.number().int().min(1).optional().default(60_000),
  shell: z.string().optional(),
  maxOutputChars: z.number().int().min(1_000).max(1_000_000).optional().default(100_000),
  raw: z.boolean().optional().default(false),
  max_runtime_ms: z.number().int().min(1000).max(6*60*60_000).optional(),
});

export async function handleRunCommand(args: unknown): Promise<ServerResult> {
  if (getCallContext()?.remote) {
    const { handleManagedRunCommand } = await import('./jobs.js');
    return handleManagedRunCommand(args);
  }
  return runCommandCore(args, { maxTimeoutMs: MAX_TIMEOUT_MS });
}

/**
 * Shared implementation of run_command. Background jobs call it with a larger
 * timeout cap (they are not bound by the relay's per-call timeout) and an
 * AbortSignal so cancel_job can kill the process tree.
 */
export interface CommandProgress {
  pid: number | null;
  lastOutputAt: number | null;
  outputChars: number;
}
export async function runCommandCore(
  args: unknown,
  opts: { maxTimeoutMs: number; signal?: AbortSignal; failOnNonZero?: boolean;
    onProgress?: (p: CommandProgress) => void },
): Promise<ServerResult> {
  const parsed = RunCommandArgsSchema.safeParse(args);
  if (!parsed.success) return failure(new AgentError('INVALID_ARGUMENT',
    'Invalid run_command arguments: '+parsed.error.message.slice(0,900)));
  const { command, shell } = parsed.data;
  // Prevent a single command result from exceeding the agent's 512 KiB frame budget.
  const maxOutputChars = Math.min(parsed.data.maxOutputChars,160_000);
  if (!opts.signal) checkCancelled();
  if (opts.signal?.aborted) return failure(new AgentError('CANCELLED','Cancelled before command execution. No command was started.'));
  const abortSignal = opts.signal ? undefined : getCallContext()?.signal;
  const remaining = opts.signal ? opts.maxTimeoutMs : Math.max(1, (getCallContext()?.deadline ?? (Date.now() + opts.maxTimeoutMs)) - Date.now());
  const timeoutMs = Math.max(1, Math.min(parsed.data.timeout_ms, opts.maxTimeoutMs, remaining));

  if (!(await commandManager.validateCommand(command))) {
    return failure(new AgentError('COMMAND_BLOCKED',
      'This command is blocked by the local agent policy. No command executed.'));
  }

  let cwd: string | undefined;
  if (parsed.data.cwd) {
    if (!path.isAbsolute(parsed.data.cwd))
      return failure(new AgentError('INVALID_CWD',
        'cwd must be an absolute directory path on this device, for example D:\\project\\app. No command executed.'));
    try {
      cwd = await validatePath(parsed.data.cwd);
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) return failure(new AgentError('INVALID_CWD',
        'cwd is not a directory: '+parsed.data.cwd+'. No command executed.'));
    } catch (e) {
      return failure(new AgentError('INVALID_CWD',
        'Cannot access cwd '+parsed.data.cwd+': '+(e instanceof Error ? e.message : String(e))+'. No command executed.'));
    }
  }

  const configuredShell = await resolveShell(shell);
  const shellDecision = selectRunCommandShell(command, configuredShell, shell !== undefined);
  if(shellDecision.error) {
    const nextArgs=shellDecision.suggestedShell
      ? {command,...(cwd?{cwd}:{}),shell:shellDecision.suggestedShell,raw:true,timeout_ms:timeoutMs}
      : null;
    const message=shellDecision.error;
    return {
      isError:true,
      content:[{type:'text',text:'SHELL_SYNTAX: '+message+
        (nextArgs?'\nSUGGESTED CORRECTED CALL (not automatically executed): run_command('+JSON.stringify(nextArgs)+')':'')}],
      structuredContent:{
        error:{code:'SHELL_SYNTAX',message,retryable:false},
        commandExecuted:false,platform:process.platform,shell:configuredShell,cwd:cwd??null,
        recovery:{cause:'PowerShell 5.1 syntax mismatch',automaticRetry:false,
          suggestion:message,...(nextArgs?{next:{tool:'run_command',args:nextArgs}}:{})},
      },
    };
  }
  const shellPath = shellDecision.shell;
  // PowerShell's -Command does not propagate a native program's exit code
  // (it returns 1 for any failure). Forward $LASTEXITCODE explicitly. A newline
  // separator keeps this working when the command ends with a # comment.
  const shellName = path.basename(shellPath).toLowerCase().replace(/\.exe$/, '');
  const wrapped = shellName === 'powershell' || shellName === 'pwsh'
    ? `$global:LASTEXITCODE = $null\n${command}\n$__brcOk = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__brcOk) { exit 1 } else { exit 0 }`
    : command;
  const env=commandEnvironment(process.env,{COREPACK_ENABLE_NETWORK:'0'});
  if (isWindows) env.PATHEXT = getRepairedPathExt();
  const fast = await planFastExec(shellPath, command, env);
  const cfg = fast
    ? { executable: fast.executable, args: fast.args, windowsVerbatim: fast.windowsVerbatim }
    : getShellSpawnArgs(shellPath, wrapped);
  const spawnEnv = fast?.env ?? env;

  type SpawnCfg = { executable: string; args: string[]; useShellOption?: string | boolean; windowsVerbatim?: boolean };
  type Outcome = {
    exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error; spawnThrew?: boolean;
    timedOut: boolean; cancelled: boolean; terminationUnconfirmed?:boolean;
    out: string; err: string; ms: number; truncated:boolean;
  };

  // Spawn once and collect capped output. Never rejects.
  const execOnce = (c: SpawnCfg, spawnEnv: NodeJS.ProcessEnv): Promise<Outcome> => new Promise<Outcome>((resolve) => {
    const started = Date.now();
    const stdout = new CappedOutput(Math.floor(maxOutputChars * 0.25), Math.ceil(maxOutputChars * 0.75));
    const stderr = new CappedOutput(Math.floor(maxOutputChars * 0.1), Math.ceil(maxOutputChars * 0.2));
    const done = (o: Partial<Outcome>) => resolve({
      exitCode: null, signal: null, timedOut: false, cancelled: false,
      out: stdout.toString(), err: stderr.toString(), ms: Date.now() - started,
      truncated: stdout.truncated||stderr.truncated, ...o,
    });
    let child;
    try {
      child = spawnManaged(c.executable, c.args, {
        cwd,
        env: spawnEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
        ...(c.useShellOption ? { shell: c.useShellOption } : {}),
        ...(isWindows && c.windowsVerbatim ? { windowsVerbatimArguments: true } : {}),
      });
    } catch (e) {
      done({ spawnError: e instanceof Error ? e : new Error(String(e)), spawnThrew: true });
      return;
    }

    observeManagedChild(child);
    // Only the command spawned by BRC receives reduced scheduling priority.
    // Never alter system processes or force a CPU core affinity.
    if (isWindows && child.pid) {
      try { os.setPriority(child.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { /* Windows may deny priority changes; the command still runs at inherited priority. */ }
    }
    let timedOut = false, cancelled = false, settled = false, stopRequested = false;
    let graceTimer: NodeJS.Timeout | undefined;
    let outputChars = 0, lastOutputAt: number | null = null;
    let progressTimer: NodeJS.Timeout | undefined;
    const progress = () => {
      try { opts.onProgress?.({pid:child.pid ?? null,lastOutputAt,outputChars}); }
      catch { /* observers never interrupt execution */ }
    };
    const abort = () => { cancelled = true; requestStop(); };
    const onAbort = () => { cancelled = true; requestStop(); };
    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error, terminationUnconfirmed=false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      if (progressTimer) clearInterval(progressTimer);
      progress();
      abortSignal?.removeEventListener('abort', abort);
      opts.signal?.removeEventListener('abort', onAbort);
      done({ exitCode, signal, spawnError, timedOut, cancelled,terminationUnconfirmed });
    };
    // A delayed JS timer is not a CPU watchdog. Termination must be requested
    // only once, then the tool must release its streams/listeners even if a
    // Windows child fails to emit 'close' after taskkill.
    const requestStop = () => {
      if (settled || stopRequested) return;
      stopRequested = true;
      stopManagedChild(child);
      graceTimer = setTimeout(() => {
        if (settled) return;
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        // The child's close event did not arrive within grace time.
        // Never describe this as a definitively terminated process tree.
        finish(null, null, undefined, true);
      }, 3000);
      graceTimer.unref();
    };
    const timer = setTimeout(() => { timedOut = true; requestStop(); }, timeoutMs);
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    const received = (d: string) => {
      outputChars += d.length;
      lastOutputAt = Date.now();
    };
    child.stdout?.on('data', (d: string) => { stdout.push(d); received(d); });
    child.stderr?.on('data', (d: string) => { stderr.push(d); received(d); });
    if (opts.onProgress) {
      progressTimer = setInterval(progress, 3000);
      progressTimer.unref();
      progress();
    }
    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
    abortSignal?.addEventListener('abort', abort, { once: true });
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    if (abortSignal?.aborted) abort();
    if (opts.signal?.aborted) onAbort();
  });

  const format = (r: Outcome, note?: string): ServerResult => {
    const {exitCode,signal,cancelled,timedOut,terminationUnconfirmed} = r;
    const failed = !!terminationUnconfirmed || cancelled || timedOut || exitCode !== 0;
    const status = terminationUnconfirmed ? 'TERMINATION_UNCONFIRMED'
      : cancelled ? 'CANCELLED'
      : timedOut ? 'TIMEOUT after '+timeoutMs+'ms'
      : 'exit code '+(exitCode===null?'null':exitCode)+(signal?' (signal '+signal+')':'');
    const actualCwd=cwd??process.cwd();
    const details = '$ '+command+'\n['+status+' | '+r.ms+'ms | shell '+shellPath+
      ' | cwd '+actualCwd+']\n'+
      (shellDecision.reason?'[shell selection] '+shellDecision.reason+'\n':'')+
      (note?'[output processing] '+note+'\n':'')+
      (parsed.data.maxOutputChars>maxOutputChars
        ? '[output budget] requested '+parsed.data.maxOutputChars+
          ' chars; limited to '+maxOutputChars+' to protect the MCP response.\n':'')+
      (r.truncated?'[OUTPUT TRUNCATED: command completed or stopped, but some logs were omitted. Request narrower diagnostic output; do not treat this as the full log.]\n':'');
    let cause='',suggestion='';
    if(terminationUnconfirmed){
      cause='A stop was requested, but root-process exit was not observed before the grace deadline. Side effects may still occur.';
      suggestion='Inspect running processes and actual filesystem/external state; do not automatically repeat this command.';
    } else if(cancelled) {
      cause='Request was cancelled; the child process tree was signaled for termination.';
      suggestion='Inspect filesystem/job state before replaying any mutation. If appropriate, start a fresh read-only diagnostic command.';
    } else if(timedOut) {
      cause='The command exceeded the '+timeoutMs+'ms execution budget.';
      suggestion='Inspect partial stdout/stderr. For a short command, correct the cause or raise timeout_ms within the one-shot limit of '+
        opts.maxTimeoutMs+'ms. For interactive/longer work use start_process, then read_process_output. Verify side effects before retrying.';
    } else if(failed) {
      const combined=r.err+'\n'+r.out;
      if(/not a git repository/i.test(combined)) {
        cause='Git was executed outside a repository.';
        suggestion='Set cwd to the absolute Git repository directory, then re-run only the corrected command. Or use git_status / git_log for separate diagnostics.';
      } else if(/Could not find the Next\.js package|Cannot find package|Cannot find module|Module not found|ERR_MODULE_NOT_FOUND/i.test(combined)) {
        cause='Project dependencies or runtime module resolution failed.';
        suggestion='Check the absolute cwd, package.json and actual node_modules layout; for pnpm/Next.js confirm dependencies resolve from the project root. Re-run the smallest failing build step after correction.';
      } else if(/is not recognized as an internal or external command|The term .+ is not recognized|command not found|ENOENT/i.test(combined)) {
        cause='An executable or shell command could not be found.';
        suggestion='Check the selected shell and PATH (including PATHEXT on Windows). Confirm that the tool is installed and use an absolute cwd. Do not retry the unchanged command.';
      } else if(/The token .{0,20}(?:&&|\|\|).{0,80}not a valid statement separator/i.test(combined)) {
        cause='Windows PowerShell 5.1 rejected && / || command chaining.';
        suggestion='Use shell:"cmd.exe" with raw:true for a native command chain, or rewrite with PowerShell-compatible conditional statements. Check which shell is selected.';
      } else {
        cause='The executed shell or program returned a non-zero exit code '+String(exitCode)+'.';
        suggestion='Read the stderr and exit code, identify the failing argument, dependency, path or script, correct that issue, and rerun the smallest relevant check. Never replay an identical failing command without a correction.';
      }
    }
    const body=details+
      (r.out?'\n--- stdout ---\n'+r.out.trimEnd()+'\n':'\n(no stdout)\n')+
      (r.err?'\n--- stderr ---\n'+r.err.trimEnd()+'\n':'')+
      (failed?'\nDIAGNOSIS: '+cause+'\nNEXT ACTION: '+suggestion+'\n':'');
    const code=terminationUnconfirmed?'TOOL_OUTCOME_UNCERTAIN':cancelled?'CANCELLED':timedOut?'TIMEOUT':'COMMAND_FAILED';
    return {
      ...text(body,failed),
      structuredContent:{
        exitCode,signal,durationMs:r.ms,timedOut,cancelled,commandExecuted:true,
        terminationState:managedTerminationState(cancelled||timedOut,!terminationUnconfirmed),
        environmentPolicy:commandEnvironmentPolicy(),
        platform:process.platform,shell:shellPath,configuredShell,
        autoSelectedShell:shellDecision.changed,shellSelectionReason:shellDecision.reason??null,
        cwd:actualCwd,cwdProvided:!!cwd,raw:parsed.data.raw,
        outputTruncated:r.truncated,maxOutputCharsApplied:maxOutputChars,
        ...(failed?{
          error:{code,message:cause,retryable:false},
          recovery:{cause,suggestion,automaticRetry:false,repeatIdenticalCommand:false}
        }:{})
      },
    };
  };

  // rtk: compress the output of supported simple commands (see rtk.ts). Falls back to the
  // normal run when rtk cannot start or rejects the arguments before running anything.
  const rtkArgs = planRtkCommand({
    command,
    raw: parsed.data.raw,
    posix: !['cmd', 'powershell', 'pwsh'].includes(shellName),
  });
  const rtkPath = rtkArgs ? resolveRtk() : null;
  const releaseCpu=await commandCpuAdmission.acquire(opts.signal??abortSignal,Math.min(10000,timeoutMs));
  try {
  if(opts.signal?.aborted||abortSignal?.aborted)
    return failure(new AgentError('CANCELLED','Command cancelled while waiting for resource admission. No process was started.'));
  if (rtkArgs && rtkPath) {
    const r = await execOnce({ executable: rtkPath, args: rtkArgs }, rtkEnv(env));
    if (!r.spawnError && !(r.exitCode !== null && isRtkUsageError(r.exitCode, r.err))) {
      const a = annotateRtkOutput(r.out, r.err);
      return format({ ...r, out: a.stdout, err: a.stderr }, a.note);
    }
    if (opts.signal?.aborted) return format(r);
  }

  const r = await execOnce(cfg, spawnEnv);
  if (r.spawnThrew) return failure(new AgentError('SHELL_START_FAILED',
    'Unable to start command with shell '+shellPath+': '+(r.spawnError?.message??'unknown error')+'. No command executed.'));
  if (r.spawnError) return failure(new AgentError('SHELL_START_FAILED',
    'Shell '+shellPath+' could not start the command: '+r.spawnError.message+'. Check installed shell/PATH; no command executed.'));
  return format(r);
  }finally{releaseCpu();}
}

// ---------------------------------------------------------------------------
// delete_file
// ---------------------------------------------------------------------------
export const DeleteFileArgsSchema = z.object({
  path: z.string().min(1),
  recursive: z.boolean().optional().default(false),
});

function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? path.join(os.homedir(), p.slice(1)) : p;
}

export async function handleDeleteFile(args: unknown): Promise<ServerResult> {
  const parsed = DeleteFileArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for delete_file: ${parsed.error.message}`, true);

  let target: string;
  try {
    target = await validatePath(parsed.data.path);
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }

  const resolved = path.resolve(target);
  const norm = (p: string) => (isWindows ? path.resolve(p).toLowerCase() : path.resolve(p)).replace(/[\\/]+$/, '');
  // Refuse to delete a filesystem root, the home directory or an allowed root itself.
  const config = await configManager.getConfig();
  const protectedRoots = [
    os.homedir(),
    path.parse(resolved).root,
    ...((Array.isArray(config.allowedDirectories) ? config.allowedDirectories : []) as string[]).map(expandHome),
  ].map(norm);
  if (protectedRoots.includes(norm(resolved))) {
    return text(`Refusing to delete protected directory: ${resolved}`, true);
  }

  let st;
  try {
    st = await fs.lstat(resolved);
  } catch (e: any) {
    return text(e?.code === 'ENOENT' ? `Not found: ${resolved}` : `Cannot access ${resolved}: ${e?.message ?? e}`, true);
  }

  try {
    if (st.isDirectory()) {
      if (parsed.data.recursive) {
        await fs.rm(resolved, { recursive: true, force: false });
      } else {
        await fs.rmdir(resolved); // fails if not empty
      }
      return text(`Deleted directory: ${resolved}`);
    }
    await fs.unlink(resolved); // files and symlinks (link itself, not its target)
    return text(`Deleted ${st.isSymbolicLink() ? 'symlink' : 'file'}: ${resolved}`);
  } catch (e: any) {
    if (e?.code === 'ENOTEMPTY' || e?.code === 'EEXIST') {
      return text(`Directory is not empty: ${resolved}. Pass recursive=true to delete it and all its contents.`, true);
    }
    return text(`Failed to delete ${resolved}: ${e?.message ?? e}`, true);
  }
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------
const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_OUTPUT = 200_000;

const safeRef = z.string().min(1).refine((r) => !r.startsWith('-'), { message: 'ref must not start with "-"' });

async function runGit(repoPath: string, gitArgs: string[]): Promise<{ ok: boolean; out: string; err: string; cwd: string }> {
  const cwd = await validatePath(repoPath);
  const st = await fs.stat(cwd).catch(() => null);
  const dir = st?.isDirectory() ? cwd : path.dirname(cwd);
  if (!(await commandManager.validateCommand('git'))) {
    return { ok: false, out: '', err: 'Command not allowed: git', cwd: dir };
  }
  return await new Promise((resolve) => {
    execFile('git', ['-c', 'core.quotepath=off', '-c', 'color.ui=never', ...gitArgs], {
      cwd: dir,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: 64 * 1024 * 1024,
      windowsHide: true,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat', LC_ALL: 'C' },
    }, (error, stdout, stderr) => {
      resolve({ ok: !error, out: String(stdout ?? ''), err: String(stderr ?? '') || (error ? error.message : ''), cwd: dir });
    });
  });
}

function capText(s: string, max = GIT_MAX_OUTPUT): string {
  return s.length > max ? `${s.slice(0, max)}\n\n[... truncated ${s.length - max} characters; narrow with "file" or use stat=true ...]` : s;
}

export const GitStatusArgsSchema = z.object({
  path: z.string().min(1),
});

export async function handleGitStatus(args: unknown): Promise<ServerResult> {
  const parsed = GitStatusArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for git_status: ${parsed.error.message}`, true);
  try {
    const r = await runGit(parsed.data.path, ['status', '--porcelain=v1', '--branch', '--untracked-files=normal']);
    if (!r.ok) return text(`git status failed in ${r.cwd}: ${r.err.trim()}`, true);
    const lines = r.out.split('\n').filter(Boolean);
    const branch = lines[0]?.startsWith('## ') ? lines.shift()!.slice(3) : '(unknown)';
    const groups: Record<string, string[]> = { staged: [], unstaged: [], untracked: [], conflicted: [] };
    for (const l of lines) {
      const x = l[0], y = l[1], file = l.slice(3);
      if (x === '?' && y === '?') { groups.untracked.push(file); continue; }
      if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) { groups.conflicted.push(`${x}${y} ${file}`); continue; }
      if (x !== ' ') groups.staged.push(`${x} ${file}`);
      if (y !== ' ') groups.unstaged.push(`${y} ${file}`);
    }
    let out = `Repository: ${r.cwd}\nBranch: ${branch}\n`;
    if (!lines.length) return text(out + '\nWorking tree clean.');
    for (const [name, items] of Object.entries(groups)) {
      if (items.length) out += `\n${name} (${items.length}):\n${items.map((i) => `  ${i}`).join('\n')}\n`;
    }
    out += '\nCodes: M modified, A added, D deleted, R renamed, C copied, T type change.';
    return text(capText(out));
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

export const GitDiffArgsSchema = z.object({
  path: z.string().min(1),
  staged: z.boolean().optional().default(false),
  ref: safeRef.optional(),
  file: z.string().optional(),
  stat: z.boolean().optional().default(false),
  contextLines: z.number().int().min(0).max(50).optional().default(3),
});

export async function handleGitDiff(args: unknown): Promise<ServerResult> {
  const parsed = GitDiffArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for git_diff: ${parsed.error.message}`, true);
  const a = parsed.data;
  const gitArgs = ['diff', '--no-ext-diff', `-U${a.contextLines}`];
  if (a.staged) gitArgs.push('--cached');
  if (a.stat) gitArgs.push('--stat');
  if (a.ref) gitArgs.push(a.ref);
  if (a.file) gitArgs.push('--', a.file);
  try {
    const r = await runGit(a.path, gitArgs);
    if (!r.ok) return text(`git diff failed in ${r.cwd}: ${r.err.trim()}`, true);
    const what = a.ref ? `against ${a.ref}` : a.staged ? 'staged changes' : 'unstaged changes';
    if (!r.out.trim()) return text(`No differences (${what}) in ${r.cwd}${a.file ? ` for ${a.file}` : ''}.`);
    return text(capText(r.out));
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

export const GitLogArgsSchema = z.object({
  path: z.string().min(1),
  maxCount: z.number().int().min(1).max(500).optional().default(20),
  ref: safeRef.optional(),
  file: z.string().optional(),
  stat: z.boolean().optional().default(false),
});

export async function handleGitLog(args: unknown): Promise<ServerResult> {
  const parsed = GitLogArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for git_log: ${parsed.error.message}`, true);
  const a = parsed.data;
  const gitArgs = ['log', `--max-count=${a.maxCount}`, '--date=short', '--pretty=format:%h %ad %an%d%n    %s'];
  if (a.stat) gitArgs.push('--stat');
  if (a.ref) gitArgs.push(a.ref);
  if (a.file) gitArgs.push('--', a.file);
  try {
    const r = await runGit(a.path, gitArgs);
    if (!r.ok) return text(`git log failed in ${r.cwd}: ${r.err.trim()}`, true);
    return text(r.out.trim() ? capText(r.out) : 'No commits found.');
  } catch (e) {
    return text(e instanceof Error ? e.message : String(e), true);
  }
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const BRC_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
  run_command: handleRunCommand,
  delete_file: handleDeleteFile,
  git_status: handleGitStatus,
  git_diff: handleGitDiff,
  git_log: handleGitLog,
};

export function buildBrcToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'run_command',
      description: [
        'Quick commands return normally. Remote long-running commands return PENDING with a jobId after about 2 seconds. PENDING is not completion; get_job and wait_jobs must be called until final status, then continue the AI task.',
        'Local execution keeps its original timeout; remote managed commands have a 6-hour hard cap configurable with max_runtime_ms, not timeout_ms.',
        'Prefer this over start_process + read_process_output for non-interactive commands',
        '(builds, tests, git, package managers, scripts, one-off queries).',
        'Use start_process/interact_with_process only for interactive or long-running sessions (REPLs, servers).',
        'stdin is closed, so commands that prompt for input will fail fast instead of hanging.',
        `timeout_ms defaults to 60000 (max ${MAX_TIMEOUT_MS}); on timeout the whole process tree is killed.`,
        'Output is capped (maxOutputChars, default 100000) keeping the beginning and end.',
        'Pass an absolute cwd within allowed directories for project commands; omitting cwd uses the agent process directory, which may be the wrong repository.',
        'On Windows, default shell is Windows PowerShell 5.1 (powershell.exe) unless changed in config. PowerShell 5.1 does NOT support && or ||.',
        'For safe native CLI chains such as git status -s && git log -n 10 --oneline, run_command automatically selects cmd.exe when no shell is explicitly requested.',
        'For deliberate CMD syntax set shell:"cmd.exe"; for PowerShell-specific statements use PowerShell 5.1 syntax without &&/||, or pwsh.exe 7+ if installed.',
        'SHELL_SYNTAX means no command executed. COMMAND_FAILED means actual non-zero shell exit. TIMEOUT means command exceeded budget. Inspect structuredContent.error and recovery.',
        'Use raw:true to disable rtk compression during diagnosis (still bounded output). Do not blindly retry the identical command or an uncertain mutation.',
        'Blocked commands (config blockedCommands) are rejected.',
        'Output of common dev commands (git status/log/diff, cargo/go/pytest/vitest/jest/tsc/eslint, npm run, ...)',
        'may be compressed by rtk; such results say "[compressed by rtk ...]". Pass raw=true for the exact, uncompressed output.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(RunCommandArgsSchema),
      annotations: { title: 'Run Command', readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    {
      name: 'delete_file',
      description: [
        'Delete a file, symlink or directory inside the allowed directories.',
        'Directories are only deleted when empty unless recursive=true.',
        'Refuses to delete a filesystem root, the home directory or an allowed root directory itself.',
        'This is permanent (no recycle bin). Use absolute paths.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(DeleteFileArgsSchema),
      annotations: { title: 'Delete File or Directory', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    {
      name: 'git_status',
      description: 'Show git branch/upstream status and changed files grouped as staged, unstaged, untracked and conflicted. path = any directory (or file) inside the repository.',
      inputSchema: zodToJsonSchema(GitStatusArgsSchema),
      annotations: { title: 'Git Status', readOnlyHint: true },
    },
    {
      name: 'git_diff',
      description: [
        'Show a git diff for a repository. path = any directory inside the repo.',
        'Default: unstaged changes. staged=true: staged changes. ref: diff against a commit/branch (e.g. "HEAD~1", "main").',
        'file: limit to one path. stat=true: summary only (files changed, insertions, deletions). contextLines: default 3.',
        'Large diffs are truncated; use file or stat to narrow.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(GitDiffArgsSchema),
      annotations: { title: 'Git Diff', readOnlyHint: true },
    },
    {
      name: 'git_log',
      description: 'Show recent git commits (short hash, date, author, refs, subject). path = any directory inside the repo. maxCount default 20; optional ref (branch/range like "main..HEAD"), file (history of one path) and stat=true (files changed per commit).',
      inputSchema: zodToJsonSchema(GitLogArgsSchema),
      annotations: { title: 'Git Log', readOnlyHint: true },
    },
  ];
}
