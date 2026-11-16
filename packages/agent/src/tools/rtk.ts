/**
 * BRC: compress run_command output with rtk (github.com/rtk-ai/rtk) when it helps.
 *
 * rtk is a CLI proxy that runs a command and rewrites its output for LLMs (`rtk git status`,
 * `rtk cargo test`, `rtk tsc` ...), propagating the wrapped command's exit code. BRC uses it only:
 *   - for commands on RTK_ALLOW_LIST (program + subcommand; taken from rtk's own rewrite registry,
 *     src/discover/rules.rs, restricted to filters that keep the command's meaning),
 *   - for a "simple" command (program + plain arguments: no pipes, redirection, chaining,
 *     variables, globs or quoting the shells would treat differently), which BRC then runs as
 *     `rtk <args>` directly (no shell),
 *   - when rtk is installed+enabled as a BRC plugin (id "rtk", $BRC_HOME/bin) or found on PATH,
 *   - unless run_command gets raw=true or BRC_RTK=0 is set.
 * Everything here except resolveRtk() is pure so the decision logic is unit-testable.
 */
import fs from 'node:fs';
import path from 'node:path';
import { getPlugin } from '../plugins/store.js';
import { pluginPaths, exeName } from '../plugins/paths.js';
import { findOnPath } from './fast-exec.js';

const isWindows = process.platform === 'win32';

// ---------------------------------------------------------------------------
// Allow-list
// ---------------------------------------------------------------------------
export interface RtkRule {
  /** Allowed first arguments (subcommands). Omitted: any arguments. */
  sub?: readonly string[];
  /** rtk subcommand when it differs from the program name (eslint -> lint). */
  rtk?: string;
}

/**
 * Programs (and subcommands) whose rtk filter keeps the information an AI needs while cutting
 * noise. Source: rtk's rewrite registry (src/discover/rules.rs, the rules behind `rtk rewrite`)
 * and `rtk <cmd> --help` for rtk 1.2.0. Deliberately left out: cat/head/tail/grep/rg/ls/find/tree/
 * diff/wc (rtk rewrites them to different commands or changes their output format), curl/wget/
 * aws/psql/gh api (lossy JSON/table summaries), docker run/exec, kubectl apply (interactive or
 * state-changing with long output) and generic TOML-filtered tools.
 */
export const RTK_ALLOW_LIST: Readonly<Record<string, RtkRule>> = {
  git: { sub: ['status', 'log', 'diff', 'show', 'branch', 'fetch', 'pull', 'push', 'add', 'commit', 'stash', 'worktree'] },
  gh: { sub: ['pr', 'issue', 'run', 'repo', 'release'] },
  glab: { sub: ['mr', 'issue', 'ci', 'pipeline', 'release'] },
  cargo: { sub: ['build', 'test', 'clippy', 'check'] },
  go: { sub: ['test', 'build', 'vet'] },
  pnpm: { sub: ['list', 'ls', 'install', 'i', 'outdated'] },
  npm: { sub: ['run', 'run-script'] },
  npx: { sub: ['tsc', 'eslint', 'prisma', 'vitest', 'jest', 'playwright', 'next', 'prettier'] },
  tsc: {},
  vitest: {},
  jest: {},
  playwright: { sub: ['test'] },
  next: { sub: ['build'] },
  prisma: {},
  eslint: { rtk: 'lint' },
  prettier: {},
  pytest: {},
  mypy: {},
  ruff: { sub: ['check', 'format'] },
  'golangci-lint': { sub: ['run'] },
  dotnet: { sub: ['build', 'test', 'restore', 'format'] },
  docker: { sub: ['ps', 'images', 'logs', 'build'] },
  kubectl: { sub: ['get', 'logs', 'describe'] },
  pip: { sub: ['list', 'outdated', 'install', 'show'] },
  rspec: {},
  rubocop: {},
  rake: { sub: ['test'] },
};

// ---------------------------------------------------------------------------
// Simple-command tokenizer
// ---------------------------------------------------------------------------
// Characters some shell (cmd, PowerShell, bash/zsh/sh) gives a meaning to. A command containing
// any of them outside a plain double-quoted word keeps going through the shell.
const UNSAFE_ANY = /[|&;<>()$`{}%^!*?[\]'#,\r\n]/;

/**
 * Split a "simple" command into argv, or null when running it without a shell could change its
 * meaning. Accepted: words of plain characters separated by spaces/tabs, and whole words in double
 * quotes without special characters inside. `posix`: the shell is sh/bash/zsh (backslash escapes).
 */
export function parseSimpleCommand(command: string, opts: { posix?: boolean } = {}): string[] | null {
  const posix = opts.posix ?? !isWindows;
  if (!command.trim()) return null;
  if (UNSAFE_ANY.test(command)) return null;
  if (posix && command.includes('\\')) return null;
  const out: string[] = [];
  const re = /"([^"]*)"(?=\s|$)|([^\s"]+)(?=\s|$)|(\S)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(command))) {
    if (m[3] !== undefined) return null; // a quote inside a word, or an unbalanced quote
    if (m[1] !== undefined) {
      if (!m[1]) return null; // "" is dropped by some PowerShell versions
      out.push(m[1]);
      continue;
    }
    const w = m[2];
    // @ at word start: PowerShell splatting; ~ at word start or after = / : -> home expansion
    if (w.startsWith('@') || w.startsWith('~') || /[=:]~/.test(w)) return null;
    // VAR=value prefix (posix env assignment) is not a program
    if (out.length === 0 && w.includes('=')) return null;
    out.push(w);
  }
  return out.length ? out : null;
}

/** Program name for matching: lower-case on Windows, without .exe/.cmd; null when it is a path. */
function programName(token: string): string | null {
  if (token.includes('/') || token.includes('\\')) return null;
  let p = isWindows ? token.toLowerCase() : token;
  if (isWindows) p = p.replace(/\.(exe|cmd|bat|com)$/, '');
  return p;
}

/** rtk argv for an already-tokenized command, or null when rtk should not be used. */
export function rtkArgsFor(argv: string[]): string[] | null {
  if (!argv.length) return null;
  const prog = programName(argv[0]);
  if (!prog || !Object.prototype.hasOwnProperty.call(RTK_ALLOW_LIST, prog)) return null;
  const rule = RTK_ALLOW_LIST[prog];
  if (rule.sub) {
    const sub = argv[1];
    if (!sub || !rule.sub.includes(sub)) return null;
  }
  // Help/version output is short and rtk may print its own help instead.
  if (argv.slice(1).some((a) => a === '--help' || a === '-h' || a === '--version' || a === '-V')) return null;
  return [rule.rtk ?? prog, ...argv.slice(1)];
}

export interface RtkDecisionInput {
  command: string;
  raw?: boolean;
  /** Process environment (BRC_RTK=0 disables). */
  env?: NodeJS.ProcessEnv;
  /** sh/bash/zsh semantics (backslash is an escape). Default: not Windows. */
  posix?: boolean;
}

/** Pure decision: the rtk argv to run instead of `command`, or null to run it normally. */
export function planRtkCommand(input: RtkDecisionInput): string[] | null {
  if (input.raw) return null;
  if ((input.env ?? process.env).BRC_RTK === '0') return null;
  const argv = parseSimpleCommand(input.command, { posix: input.posix });
  return argv ? rtkArgsFor(argv) : null;
}

// ---------------------------------------------------------------------------
// Output post-processing
// ---------------------------------------------------------------------------
const HOOK_WARNING = /^\[rtk\][^\n]*(?:No hook installed|Hook outdated|rtk init)[^\n]*\r?\n?/gm;
const FULL_OUTPUT_HINT = /^[ \t]*\[full output: ([^\n]+?)\][ \t]*\r?$/m;
const FULL_DIFF_HINT = /^[ \t]*\[full diff: rtk [^\n]*\][ \t]*\r?\n?/gm;

export interface RtkAnnotated {
  stdout: string;
  stderr: string;
  /** One line for the result, e.g. "[compressed by rtk; full output: C:\...\x.log]". */
  note: string;
  /** Path of the saved full output (rtk "tee"), when rtk saved one. */
  teePath?: string;
}

/** Turn rtk's quoted/escaped display path back into a file path. */
function unquotePath(s: string): string {
  let p = s.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) {
    p = p.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
  }
  return path.normalize(p);
}

/**
 * Remove rtk's own hints (hook warnings, "[full output: ...]", "[full diff: rtk ...]") from the
 * output and produce the single annotation line BRC adds. `fileExists` is injectable for tests.
 */
export function annotateRtkOutput(
  stdout: string,
  stderr: string,
  fileExists: (p: string) => boolean = (p) => { try { return fs.statSync(p).isFile(); } catch { return false; } },
): RtkAnnotated {
  let teePath: string | undefined;
  const take = (s: string): string => {
    let t = s.replace(HOOK_WARNING, '').replace(FULL_DIFF_HINT, '');
    for (;;) {
      const m = FULL_OUTPUT_HINT.exec(t);
      if (!m) break;
      const target = m[1].trim();
      // Legacy tee mode names a file; sqlite mode says "rtk recall <hash>" (not reachable for the AI).
      if (!teePath && !/^rtk\s+recall\b/.test(target)) {
        const p = unquotePath(target);
        if (fileExists(p)) teePath = p;
      }
      t = t.slice(0, m.index) + t.slice(m.index + m[0].length).replace(/^\n/, '');
    }
    return t;
  };
  const out = take(stdout);
  const err = take(stderr);
  const note = teePath
    ? `[compressed by rtk; full output: ${teePath}]`
    : '[compressed by rtk; rerun with raw=true for full output]';
  return { stdout: out, stderr: err, note, teePath };
}

/** rtk itself rejected the arguments (clap usage error) before running anything: rerun without rtk. */
export function isRtkUsageError(exitCode: number | null, stderr: string): boolean {
  return exitCode === 2 && /^error: /m.test(stderr) && /Usage: rtk/i.test(stderr);
}

// ---------------------------------------------------------------------------
// Locating rtk + environment
// ---------------------------------------------------------------------------
const RESOLVE_TTL_MS = 30_000;
let resolved: { at: number; path: string | null } | null = null;

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

/**
 * Path of the rtk executable to use, or null. A BRC plugin record "rtk" wins: disabled -> null;
 * installed -> $BRC_HOME/bin/rtk[.exe]. Otherwise (no record, not installed yet, file missing)
 * an `rtk` on PATH is used.
 */
export function resolveRtk(): string | null {
  if (resolved && Date.now() - resolved.at < RESOLVE_TTL_MS) return resolved.path;
  let found: string | null = null;
  const rec = getPlugin('rtk');
  if (rec && !rec.enabled) {
    found = null;
  } else {
    if (rec?.status === 'installed') {
      const bin = rec.source.type === 'binary' ? rec.source.binName : 'rtk';
      const p = path.join(pluginPaths.binDir(), exeName(bin || 'rtk'));
      if (isFile(p)) found = p;
    }
    if (!found) {
      const exts = isWindows ? ['.exe'] : [''];
      found = findOnPath('rtk', process.env.PATH ?? process.env.Path, exts);
    }
  }
  resolved = { at: Date.now(), path: found };
  return found;
}

/** For tests / after an install: forget the cached location. */
export function resetRtkCache(): void {
  resolved = null;
}

/** Environment for rtk: no hook nag, no telemetry, tracking DB and tee files under $BRC_HOME. */
export function rtkEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const dir = path.join(pluginPaths.root(), 'rtk');
  return {
    ...base,
    RTK_SUPPRESS_HOOK_WARNING: base.RTK_SUPPRESS_HOOK_WARNING ?? '1',
    RTK_TELEMETRY_DISABLED: base.RTK_TELEMETRY_DISABLED ?? '1',
    RTK_TEE_DIR: base.RTK_TEE_DIR ?? path.join(dir, 'tee'),
    RTK_DB_PATH: base.RTK_DB_PATH ?? path.join(dir, 'tracking.db'),
  };
}
