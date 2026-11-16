/**
 * BRC: cheaper process start-up for one-shot commands (run_command, job steps).
 *
 * Starting the user's shell is often the slowest part of a short command:
 *   - Windows PowerShell / pwsh: ~150-250 ms of runtime start-up per command.
 *   - bash/zsh login shells (-l): every command re-reads the profile (nvm, conda, brew shellenv ...),
 *     often 50-500 ms.
 *
 * Fast paths (each falls back to the normal shell whenever it might change behaviour):
 *   - Windows + PowerShell: a "simple" command (program + plain arguments, no PowerShell syntax)
 *     whose program resolves to a .exe/.com/.cmd/.bat on PATH and is not a PowerShell alias or a
 *     cmd built-in runs through `cmd.exe /d /s /c` (~40 ms) instead.
 *   - bash/zsh: the login environment is captured once (refreshed every few minutes) and commands
 *     run as `<shell> -c` (no -l) with that environment, as long as the program is found on that
 *     PATH. Commands using shell functions defined in the profile (e.g. `nvm use`) still get a
 *     login shell.
 * Set BRC_FAST_EXEC=0 to disable.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const isWindows = process.platform === 'win32';
const ENABLED = process.env.BRC_FAST_EXEC !== '0';

export interface FastExecPlan {
  executable: string;
  args: string[];
  windowsVerbatim?: boolean;
  /** Environment to use instead of the caller's (login env for Unix shells). */
  env?: NodeJS.ProcessEnv;
  kind: 'native' | 'cmd' | 'cached-login-env';
}

// ---------------------------------------------------------------------------
// Program lookup on PATH (cached briefly; PATH rarely changes)
// ---------------------------------------------------------------------------
const LOOKUP_TTL_MS = 60_000;
const lookupCache = new Map<string, { at: number; found: string | null }>();

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

export function findOnPath(program: string, pathVar: string | undefined, exts: string[]): string | null {
  const key = `${program}\0${pathVar}\0${exts.join(';')}`;
  const hit = lookupCache.get(key);
  if (hit && Date.now() - hit.at < LOOKUP_TTL_MS) return hit.found;
  let found: string | null = null;
  const hasExt = exts.some((e) => e && program.toLowerCase().endsWith(e));
  const candidates = hasExt ? [''] : exts;
  if (program.includes('/') || program.includes('\\')) {
    for (const e of candidates) if (isFile(program + e)) { found = program + e; break; }
  } else {
    outer: for (const dir of (pathVar ?? '').split(path.delimiter)) {
      if (!dir) continue;
      for (const e of candidates) {
        const p = path.join(dir.replace(/^"|"$/g, ''), program + e);
        if (isFile(p)) { found = p; break outer; }
      }
    }
  }
  lookupCache.set(key, { at: Date.now(), found });
  return found;
}

/** First word of a command line, with surrounding double quotes removed. */
function firstToken(command: string): string | null {
  const m = command.trimStart().match(/^"([^"]+)"|^(\S+)/);
  return m ? (m[1] ?? m[2]) : null;
}

// ---------------------------------------------------------------------------
// Windows: PowerShell -> cmd.exe for simple commands
// ---------------------------------------------------------------------------

// PowerShell syntax (or cmd syntax) that the two shells would treat differently.
const PS_SPECIAL = /[|&;<>()$`{}%^@,'#\r\n\[\]!*?~]|--%/;

// PowerShell aliases / cmd built-ins: these names must keep going through PowerShell even if an
// executable with the same name exists (e.g. curl -> Invoke-WebRequest, sort -> Sort-Object).
const PS_ALIASES_AND_CMD_BUILTINS = new Set([
  // PowerShell built-in aliases (5.1 and 7)
  'ac', 'asnp', 'cat', 'cd', 'cfs', 'chdir', 'clc', 'clear', 'clhy', 'cli', 'clp', 'cls', 'clv', 'cnsn', 'compare',
  'copy', 'cp', 'cpi', 'cpp', 'curl', 'cvpa', 'dbp', 'del', 'diff', 'dir', 'dnsn', 'ebp', 'echo', 'epal', 'epcsv',
  'epsn', 'erase', 'etsn', 'exsn', 'fc', 'fhx', 'fl', 'foreach', 'ft', 'fw', 'gal', 'gbp', 'gc', 'gcb', 'gci', 'gcm',
  'gcs', 'gdr', 'ghy', 'gi', 'gin', 'gjb', 'gl', 'gm', 'gmo', 'gp', 'gps', 'gpv', 'group', 'gsn', 'gsnp', 'gsv', 'gtz',
  'gu', 'gv', 'gwmi', 'h', 'history', 'icm', 'iex', 'ihy', 'ii', 'ipal', 'ipcsv', 'ipmo', 'ipsn', 'irm', 'ise', 'iwmi',
  'iwr', 'kill', 'lp', 'ls', 'man', 'md', 'measure', 'mi', 'mkdir', 'mount', 'move', 'mp', 'mv', 'nal', 'ndr', 'ni',
  'nmo', 'npssc', 'nsn', 'nv', 'ogv', 'oh', 'popd', 'ps', 'pushd', 'pwd', 'r', 'rbp', 'rcjb', 'rcsn', 'rd', 'rdr',
  'ren', 'ri', 'rjb', 'rm', 'rmdir', 'rmo', 'rni', 'rnp', 'rp', 'rsn', 'rsnp', 'rujb', 'rv', 'rvpa', 'rwmi', 'sajb',
  'sal', 'saps', 'sasv', 'sbp', 'sc', 'scb', 'select', 'set', 'shcm', 'si', 'sl', 'sleep', 'sls', 'sort', 'sp', 'spjb',
  'spps', 'spsv', 'start', 'stz', 'sujb', 'sv', 'swmi', 'tee', 'trcm', 'type', 'wget', 'where', 'wjb', 'write',
  // cmd.exe built-ins
  'assoc', 'break', 'call', 'color', 'date', 'endlocal', 'exit', 'for', 'ftype', 'goto', 'if', 'mklink', 'path',
  'pause', 'prompt', 'rem', 'rename', 'setlocal', 'shift', 'time', 'title', 'ver', 'verify', 'vol',
]);

const WIN_EXEC_EXTS = ['.exe', '.com', '.cmd', '.bat'];

function windowsPlan(shellName: string, command: string): FastExecPlan | null {
  if (shellName !== 'powershell' && shellName !== 'pwsh') return null;
  if (PS_SPECIAL.test(command)) return null;
  // balanced double quotes only, and no quote inside a word (PowerShell and cmd differ there)
  if ((command.match(/"/g) ?? []).length % 2 !== 0) return null;
  if (/[^\s]"[^\s]/.test(command.replace(/"[^"]*"/g, (q) => q.replace(/[^"]/g, 'x')))) return null;
  const prog = firstToken(command);
  if (!prog) return null;
  const base = path.basename(prog).toLowerCase();
  if (PS_ALIASES_AND_CMD_BUILTINS.has(base)) return null;
  if (/^[a-z]+-[a-z]+$/i.test(base)) return null; // Verb-Noun cmdlet
  const pathExt = (process.env.PATHEXT ?? '').toLowerCase().split(';').filter((e) => WIN_EXEC_EXTS.includes(e));
  const exts = pathExt.length ? pathExt : WIN_EXEC_EXTS;
  const resolved = findOnPath(prog, process.env.PATH ?? process.env.Path, exts);
  if (!resolved || !WIN_EXEC_EXTS.includes(path.extname(resolved).toLowerCase())) return null;
  // For unquoted, literal argv and a genuine executable, avoid launching cmd.exe at all.
  // Quotes, interpolation, shell operators, scripts and ambiguous syntax retain the shell.
  // This is a conservative subset: on Windows it saves one process for common git/node/rg calls.
  if (['.exe', '.com'].includes(path.extname(resolved).toLowerCase()) &&
      /^[A-Za-z0-9_./:\\-]+(?:[ \t]+[A-Za-z0-9_./:\\-]+)*$/.test(command.trim())) {
    return { executable: resolved, args: command.trim().split(/[ \t]+/).slice(1), kind: 'native' };
  }
  const comspec = process.env.COMSPEC || 'cmd.exe';
  // /d: skip AutoRun registry commands; /s: strip exactly the outer quotes we add.
  return { executable: comspec, args: ['/d', '/s', '/c', `"${command}"`], windowsVerbatim: true, kind: 'cmd' };
}

// ---------------------------------------------------------------------------
// Unix: cached login environment for bash/zsh
// ---------------------------------------------------------------------------
const LOGIN_ENV_TTL_MS = 5 * 60_000;
const loginEnvCache = new Map<string, { at: number; env: NodeJS.ProcessEnv | null }>();
const loginEnvPending = new Map<string, Promise<NodeJS.ProcessEnv | null>>();

function captureLoginEnv(shellPath: string): Promise<NodeJS.ProcessEnv | null> {
  const pending = loginEnvPending.get(shellPath);
  if (pending) return pending;
  const marker = '__BRC_ENV__';
  const script = `printf '%s' '${marker}'; "${process.execPath}" -e 'process.stdout.write(JSON.stringify(process.env))'`;
  const p = new Promise<NodeJS.ProcessEnv | null>((resolve) => {
    execFile(shellPath, ['-l', '-c', script], { timeout: 15_000, maxBuffer: 8 * 1024 * 1024, env: process.env }, (err, stdout) => {
      if (err) return resolve(null);
      const i = String(stdout).lastIndexOf(marker);
      if (i === -1) return resolve(null);
      try { resolve(JSON.parse(String(stdout).slice(i + marker.length)) as NodeJS.ProcessEnv); } catch { resolve(null); }
    });
  }).then((env) => {
    loginEnvCache.set(shellPath, { at: Date.now(), env });
    loginEnvPending.delete(shellPath);
    return env;
  });
  loginEnvPending.set(shellPath, p);
  return p;
}

async function unixPlan(shellPath: string, shellName: string, command: string, baseEnv: NodeJS.ProcessEnv): Promise<FastExecPlan | null> {
  if (!/^(bash|zsh)$/.test(shellName)) return null;
  const cached = loginEnvCache.get(shellPath);
  let env: NodeJS.ProcessEnv | null;
  if (cached && Date.now() - cached.at < LOGIN_ENV_TTL_MS) env = cached.env;
  else if (cached) { env = cached.env; void captureLoginEnv(shellPath); } // serve stale, refresh in background
  else env = await captureLoginEnv(shellPath);
  if (!env) return null;
  const prog = firstToken(command);
  // Only when the program is a real file on the login PATH (not a profile function or alias).
  if (!prog || /[=]/.test(prog) || !findOnPath(prog, env.PATH, [''])) return null;
  return { executable: shellPath, args: ['-c', command], env: { ...baseEnv, ...env }, kind: 'cached-login-env' };
}

/** A faster way to run `command` with `shellPath`, or null to use the normal shell invocation. */
export async function planFastExec(shellPath: string, command: string, baseEnv: NodeJS.ProcessEnv): Promise<FastExecPlan | null> {
  if (!ENABLED) return null;
  const shellName = path.basename(shellPath).toLowerCase().replace(/\.exe$/, '');
  try {
    return isWindows ? windowsPlan(shellName, command) : await unixPlan(shellPath, shellName, command, baseEnv);
  } catch {
    return null;
  }
}
