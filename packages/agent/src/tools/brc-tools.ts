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
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { validatePath } from '../core/tools/filesystem.js';
import { commandManager } from '../core/command-manager.js';
import { configManager } from '../core/config-manager.js';
import { getShellSpawnArgs, getRepairedPathExt } from '../core/terminal-manager.js';
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
  private tail = '';
  private dropped = 0;
  constructor(private readonly headCap: number, private readonly tailCap: number) {}
  push(chunk: string): void {
    if (this.head.length < this.headCap) {
      const room = this.headCap - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
      if (!chunk) return;
    }
    this.tail += chunk;
    if (this.tail.length > this.tailCap) {
      const excess = this.tail.length - this.tailCap;
      this.dropped += excess;
      this.tail = this.tail.slice(excess);
    }
  }
  toString(): string {
    if (!this.dropped) return this.head + this.tail;
    return `${this.head}\n\n[... ${this.dropped} characters truncated ...]\n\n${this.tail}`;
  }
}

export function killTree(pid: number | undefined): void {
  if (!pid) return;
  try {
    if (isWindows) {
      spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    } else {
      process.kill(-pid, 'SIGKILL'); // detached => own process group
    }
  } catch {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
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
});

export async function handleRunCommand(args: unknown): Promise<ServerResult> {
  return runCommandCore(args, { maxTimeoutMs: MAX_TIMEOUT_MS });
}

/**
 * Shared implementation of run_command. Background jobs call it with a larger
 * timeout cap (they are not bound by the relay's per-call timeout) and an
 * AbortSignal so cancel_job can kill the process tree.
 */
export async function runCommandCore(
  args: unknown,
  opts: { maxTimeoutMs: number; signal?: AbortSignal; failOnNonZero?: boolean },
): Promise<ServerResult> {
  const parsed = RunCommandArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for run_command: ${parsed.error.message}`, true);
  const { command, shell, maxOutputChars } = parsed.data;
  const timeoutMs = Math.min(parsed.data.timeout_ms, opts.maxTimeoutMs);
  if (opts.signal?.aborted) return text(`Cancelled before start: ${command}`, true);

  if (!(await commandManager.validateCommand(command))) {
    return text(`Error: Command not allowed: ${command}`, true);
  }

  let cwd: string | undefined;
  if (parsed.data.cwd) {
    try {
      cwd = await validatePath(parsed.data.cwd);
      const st = await fs.stat(cwd);
      if (!st.isDirectory()) return text(`cwd is not a directory: ${parsed.data.cwd}`, true);
    } catch (e) {
      return text(`Invalid cwd: ${e instanceof Error ? e.message : String(e)}`, true);
    }
  }

  const shellPath = await resolveShell(shell);
  // PowerShell's -Command does not propagate a native program's exit code
  // (it returns 1 for any failure). Forward $LASTEXITCODE explicitly. A newline
  // separator keeps this working when the command ends with a # comment.
  const shellName = path.basename(shellPath).toLowerCase().replace(/\.exe$/, '');
  const wrapped = shellName === 'powershell' || shellName === 'pwsh'
    ? `$global:LASTEXITCODE = $null\n${command}\n$__brcOk = $?; if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif (-not $__brcOk) { exit 1 } else { exit 0 }`
    : command;
  const baseEnv: NodeJS.ProcessEnv = { ...process.env };
  if (isWindows) baseEnv.PATHEXT = getRepairedPathExt();
  // Skip slow shell start-up when it cannot change the result (see fast-exec.ts).
  const fast = await planFastExec(shellPath, command, baseEnv);
  const cfg = fast
    ? { executable: fast.executable, args: fast.args, useShellOption: false as const, windowsVerbatim: fast.windowsVerbatim }
    : getShellSpawnArgs(shellPath, wrapped);
  const env = fast?.env ?? baseEnv;

  type SpawnCfg = { executable: string; args: string[]; useShellOption?: string | boolean; windowsVerbatim?: boolean };
  type Outcome = {
    exitCode: number | null; signal: NodeJS.Signals | null; spawnError?: Error; spawnThrew?: boolean;
    timedOut: boolean; cancelled: boolean; out: string; err: string; ms: number;
  };

  // Spawn once and collect capped output. Never rejects.
  const execOnce = (c: SpawnCfg, spawnEnv: NodeJS.ProcessEnv): Promise<Outcome> => new Promise<Outcome>((resolve) => {
    const started = Date.now();
    const stdout = new CappedOutput(Math.floor(maxOutputChars * 0.25), Math.ceil(maxOutputChars * 0.75));
    const stderr = new CappedOutput(Math.floor(maxOutputChars * 0.1), Math.ceil(maxOutputChars * 0.2));
    const done = (o: Partial<Outcome>) => resolve({
      exitCode: null, signal: null, timedOut: false, cancelled: false,
      out: stdout.toString(), err: stderr.toString(), ms: Date.now() - started, ...o,
    });
    let child;
    try {
      child = spawn(c.executable, c.args, {
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

    let timedOut = false;
    let cancelled = false;
    let settled = false;
    const timer = setTimeout(() => { timedOut = true; killTree(child.pid); }, timeoutMs);
    const onAbort = () => { cancelled = true; killTree(child.pid); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => stdout.push(d));
    child.stderr?.on('data', (d: string) => stderr.push(d));

    const finish = (exitCode: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      done({ exitCode, signal, spawnError, timedOut, cancelled });
    };

    child.on('error', (e) => finish(null, null, e));
    child.on('close', (code, signal) => finish(code, signal));
  });

  const format = (r: Outcome, note?: string): ServerResult => {
    const { exitCode, signal, cancelled, timedOut } = r;
    const status = cancelled
      ? 'CANCELLED (process killed)'
      : timedOut
      ? `TIMED OUT after ${timeoutMs}ms (process killed)`
      : `exit code ${exitCode ?? 'null'}${signal ? ` (signal ${signal})` : ''}`;
    let body = `$ ${command}\n[${status} · ${r.ms}ms${cwd ? ` · cwd ${cwd}` : ''}]\n`;
    if (note) body += `${note}\n`;
    body += r.out ? `\n--- stdout ---\n${r.out.replace(/\s+$/, '')}\n` : '\n(no stdout)\n';
    if (r.err) body += `\n--- stderr ---\n${r.err.replace(/\s+$/, '')}\n`;
    // run_command never flags a completed process as an error (historical behaviour);
    // jobs opt in so a failing step can stop the job.
    return text(body, !!opts.failOnNonZero && (cancelled || timedOut || exitCode !== 0));
  };

  // rtk: compress the output of supported simple commands (see rtk.ts). Falls back to the
  // normal run when rtk cannot start or rejects the arguments before running anything.
  const rtkArgs = planRtkCommand({
    command,
    raw: parsed.data.raw,
    posix: !['cmd', 'powershell', 'pwsh'].includes(shellName),
  });
  const rtkPath = rtkArgs ? resolveRtk() : null;
  if (rtkArgs && rtkPath) {
    const r = await execOnce({ executable: rtkPath, args: rtkArgs }, rtkEnv(env));
    if (!r.spawnError && !(r.exitCode !== null && isRtkUsageError(r.exitCode, r.err))) {
      const a = annotateRtkOutput(r.out, r.err);
      return format({ ...r, out: a.stdout, err: a.stderr }, a.note);
    }
    if (opts.signal?.aborted) return format(r);
  }

  const r = await execOnce(cfg, env);
  if (r.spawnThrew) return text(`Failed to start command: ${r.spawnError?.message}`, true);
  if (r.spawnError) return text(`Failed to start command with shell "${shellPath}": ${r.spawnError.message}`, true);
  return format(r);
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
        'Run a shell command to completion and return its exit code, stdout and stderr in ONE call.',
        'Prefer this over start_process + read_process_output for non-interactive commands',
        '(builds, tests, git, package managers, scripts, one-off queries).',
        'Use start_process/interact_with_process only for interactive or long-running sessions (REPLs, servers).',
        'stdin is closed, so commands that prompt for input will fail fast instead of hanging.',
        `timeout_ms defaults to 60000 (max ${MAX_TIMEOUT_MS}); on timeout the whole process tree is killed.`,
        'Output is capped (maxOutputChars, default 100000) keeping the beginning and end.',
        'Pass cwd (absolute path, must be inside allowed directories) to choose the working directory.',
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
