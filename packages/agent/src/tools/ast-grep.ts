/**
 * BRC tools backed by ast-grep (https://ast-grep.github.io), a structural (syntax-tree) code
 * search and rewrite tool:
 *   ast_search  - find code by AST pattern, compact grep-like results with meta-variable captures
 *   ast_rewrite - rewrite code by AST pattern (or YAML rule); dry run (diff preview) by default
 *
 * ast-grep is a BRC "binary" plugin (id "ast-grep", npm package @ast-grep/cli installed into
 * $BRC_HOME/plugins/node by the plugin installer). The native executable is run directly (no npm
 * .cmd shim, no shell), so patterns like `$$$ARGS` need no quoting. Falls back to ast-grep on PATH.
 *
 * Paths go through validatePath() (allowedDirectories); the command through
 * commandManager.validateCommand() (blockedCommands).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { validatePath } from '../core/tools/filesystem.js';
import { commandManager } from '../core/command-manager.js';
import { getPlugin } from '../plugins/store.js';
import { pluginPaths } from '../plugins/paths.js';
import { findOnPath } from './fast-exec.js';
import {stopManagedChild} from '../runtime/process-termination.js';
import {spawnManaged} from '../runtime/managed-spawn.js';
import {guardedAstRewrite,type MatchedRewrite} from '../runtime/ast-rewrite-guard.js';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';

const isWindows = process.platform === 'win32';
// Stay below the relay's 120 s per-call timeout.
const MAX_TIMEOUT_MS = 100_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_OUTPUT_CHARS = 80_000;
const MAX_REWRITE_MATCHES = 10_000;
const MAX_STDERR = 20_000;

const text = (t: string, isError = false): ServerResult => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });

// ---------------------------------------------------------------------------
// Locating the executable
// ---------------------------------------------------------------------------
export interface AstGrepExe {
  command: string;
  /** Extra leading args (the JS shim when only that is available). */
  prefixArgs: string[];
  via: 'plugin' | 'path';
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

function isScript(p: string): boolean {
  try {
    const fd = fs.openSync(p, 'r');
    const b = Buffer.alloc(2);
    fs.readSync(fd, b, 0, 2, 0);
    fs.closeSync(fd);
    return b.toString('latin1') === '#!';
  } catch { return false; }
}

/** Names of the @ast-grep/cli platform packages that may hold the native binary here. */
export function astGrepPlatformPackages(platform: NodeJS.Platform = process.platform, arch: string = process.arch): string[] {
  if (platform === 'win32') return [`cli-win32-${arch}-msvc`];
  if (platform === 'darwin') return [`cli-darwin-${arch}`];
  if (platform === 'linux') return [`cli-linux-${arch}-gnu`, `cli-linux-${arch}-musl`];
  return [];
}

/** Native executable (or JS shim) inside a node_modules directory that contains @ast-grep/cli. */
function fromNodeModules(nodeModules: string, binName: string): { command: string; prefixArgs: string[] } | null {
  const exe = isWindows ? `${binName}.exe` : binName;
  const scope = path.join(nodeModules, '@ast-grep');
  const cli = path.join(scope, 'cli');
  for (const pkg of astGrepPlatformPackages()) {
    for (const dir of [path.join(scope, pkg), path.join(cli, 'node_modules', '@ast-grep', pkg)]) {
      const p = path.join(dir, exe);
      if (isFile(p)) return { command: p, prefixArgs: [] };
    }
  }
  // postinstall copies/links the native binary into the cli package itself
  const inCli = path.join(cli, exe);
  if (isFile(inCli) && !isScript(inCli)) return { command: inCli, prefixArgs: [] };
  // last resort: the package's JS launcher, run with this Node
  const shim = path.join(cli, binName);
  if (isFile(shim) && isScript(shim)) return { command: process.execPath, prefixArgs: [shim] };
  return null;
}

const RESOLVE_TTL_MS = 30_000;
let resolvedExe: { at: number; exe: AstGrepExe | null } | null = null;

/** Locate ast-grep: installed BRC plugin first, then PATH. null when unavailable or disabled. */
export function resolveAstGrep(): AstGrepExe | null {
  if (resolvedExe && Date.now() - resolvedExe.at < RESOLVE_TTL_MS) return resolvedExe.exe;
  let exe: AstGrepExe | null = null;
  const rec = getPlugin('ast-grep');
  if (!rec || rec.enabled) {
    if (rec?.status === 'installed') {
      const bin = rec.source.type === 'binary' && rec.source.binName ? rec.source.binName : 'ast-grep';
      const hit = fromNodeModules(path.join(pluginPaths.npmPrefix(), 'node_modules'), bin)
        ?? fromNodeModules(path.join(pluginPaths.npmPrefix(), 'node_modules'), 'ast-grep');
      if (hit) exe = { ...hit, via: 'plugin' };
    }
    if (!exe) {
      const pathVar = process.env.PATH ?? process.env.Path;
      const names = process.platform === 'linux' ? ['ast-grep'] : ['ast-grep', 'sg']; // sg is setgroups on Linux
      for (const n of names) {
        const p = findOnPath(n, pathVar, isWindows ? ['.exe'] : ['']);
        if (p) { exe = { command: p, prefixArgs: [], via: 'path' }; break; }
      }
      if (!exe && isWindows) {
        // npm global install: <prefix>\ast-grep.cmd + <prefix>\node_modules\@ast-grep\...
        const shim = findOnPath('ast-grep', pathVar, ['.cmd']);
        const hit = shim ? fromNodeModules(path.join(path.dirname(shim), 'node_modules'), 'ast-grep') : null;
        if (hit) exe = { ...hit, via: 'path' };
      }
    }
  }
  resolvedExe = { at: Date.now(), exe };
  return exe;
}

export function resetAstGrepCache(): void {
  resolvedExe = null;
}

function notInstalledMessage(): string {
  const rec = getPlugin('ast-grep');
  if (rec && !rec.enabled) return 'ast-grep is disabled on this device (plugin "ast-grep"). The device owner can enable it in BRC plugin settings.';
  let msg = 'ast-grep is not installed on this device yet; it is installed automatically in the background - try again shortly (list_plugin_tools shows plugin status).';
  if (rec?.status === 'failed' && rec.error) msg += `\nLast install attempt failed: ${rec.error}`;
  else if (rec?.status === 'needs-user' && rec.userAction) msg += `\nWaiting for the user: ${rec.userAction}`;
  else if (rec?.status === 'unsupported') msg = `ast-grep cannot run on this device${rec.error ? `: ${rec.error}` : '.'}`;
  return msg;
}

// ---------------------------------------------------------------------------
// Running ast-grep (JSON stream output)
// ---------------------------------------------------------------------------
export interface AstMatch {
  text: string;
  file: string;
  range: { byteOffset: { start: number; end: number }; start: { line: number; column: number }; end: { line: number; column: number } };
  lines?: string;
  language?: string;
  replacement?: string;
  replacementOffsets?: { start: number; end: number };
  metaVariables?: {
    single?: Record<string, { text: string }>;
    multi?: Record<string, Array<{ text: string }>>;
  };
  ruleId?: string;
  message?: string;
}

interface RunOutcome {
  matches: AstMatch[];
  truncated: boolean;
  exitCode: number | null;
  stderr: string;
  timedOut: boolean;
  ms: number;
  spawnError?: string;
}

function runAstGrep(exe: AstGrepExe, args: string[], cwd: string, limit: number, timeoutMs: number): Promise<RunOutcome> {
  const started = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnManaged(exe.command, [...exe.prefixArgs, ...args], {
        cwd,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: !isWindows,
        env: { ...process.env, NO_COLOR: '1' },
      });
    } catch (e) {
      resolve({ matches: [], truncated: false, exitCode: null, stderr: '', timedOut: false, ms: 0, spawnError: e instanceof Error ? e.message : String(e) });
      return;
    }
    const matches: AstMatch[] = [];
    let truncated = false;
    let timedOut = false;
    let settled = false;
    let buf = '';
    let stderr = '';
    const timer = setTimeout(() => { timedOut = true; stopManagedChild(child); }, timeoutMs);
    child.stdout!.setEncoding('utf8');
    child.stderr!.setEncoding('utf8');
    child.stdout!.on('data', (d: string) => {
      if (truncated) return;
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try { matches.push(JSON.parse(line) as AstMatch); } catch { /* ignore partial/non-JSON */ }
        if (matches.length >= limit) { truncated = true; stopManagedChild(child); return; }
      }
    });
    child.stderr!.on('data', (d: string) => { if (stderr.length < MAX_STDERR) stderr += d; });
    const finish = (exitCode: number | null, spawnError?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const rest = buf.trim();
      if (rest && !truncated) { try { matches.push(JSON.parse(rest) as AstMatch); } catch { /* ignore */ } }
      resolve({ matches, truncated, exitCode, stderr: stderr.slice(0, MAX_STDERR), timedOut, ms: Date.now() - started, spawnError });
    };
    child.on('error', (e) => finish(null, e.message));
    child.on('close', (code) => finish(code));
  });
}

/** ast-grep's own failure (bad pattern/rule/lang/path), as opposed to "no matches" (exit 1). */
function failureText(r: RunOutcome): string | null {
  if (r.spawnError) return `Failed to start ast-grep: ${r.spawnError}`;
  if (r.timedOut) return null;
  if (r.truncated) return null;
  if (r.exitCode === 0 || (r.exitCode === 1 && !/\berror\b/i.test(r.stderr))) return null;
  return `ast-grep failed (exit code ${r.exitCode}):\n${r.stderr.trim() || '(no error output)'}`;
}

// ---------------------------------------------------------------------------
// Formatting helpers (pure; exported for tests)
// ---------------------------------------------------------------------------
function oneLine(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
}

export function displayFile(file: string): string {
  return file.replace(/^\.[\\/]/, '').replace(/\\/g, '/');
}

/** "$A=name $B=args $$$ARGS=a, b" (empty when no captures). */
export function formatCaptures(m: AstMatch): string {
  const parts: string[] = [];
  const byName = <T>(o: Record<string, T>) => Object.entries(o).sort(([a], [b]) => a.localeCompare(b));
  for (const [k, v] of byName(m.metaVariables?.single ?? {})) parts.push(`$${k}=${oneLine(v.text, 80)}`);
  for (const [k, v] of byName(m.metaVariables?.multi ?? {})) {
    const items = v.map((x) => x.text).filter((t) => t.trim() && t.trim() !== ',');
    parts.push(`$$$${k}=${oneLine(items.join(', '), 120)}`);
  }
  return parts.join(' ');
}

/** One grep-like line per match: "file:line:col: text  [captures]". Lines are 1-based. */
export function formatMatchLine(m: AstMatch): string {
  const first = m.text.split('\n');
  let t = oneLine(first[0], 200);
  if (first.length > 1) t += ` ... (+${first.length - 1} lines)`;
  const caps = formatCaptures(m);
  return `${displayFile(m.file)}:${m.range.start.line + 1}:${m.range.start.column + 1}: ${t}${caps ? `  [${caps}]` : ''}`;
}

interface Edit { start: number; end: number; replacement: Buffer }

/** Line start byte offsets of a buffer. */
function lineStarts(buf: Buffer): number[] {
  const starts = [0];
  for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) starts.push(i + 1);
  return starts;
}

function lineOf(starts: number[], offset: number): number {
  let lo = 0, hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Apply non-overlapping byte-offset edits and return the new content plus a unified diff
 * (`context` lines around each change). Overlapping edits after the first are skipped.
 */
export function applyEdits(old: Buffer, editsIn: Edit[], displayName: string, context = 2): { content: Buffer; diff: string; applied: number } {
  const edits = [...editsIn].sort((a, b) => a.start - b.start || a.end - b.end);
  const kept: Edit[] = [];
  for (const e of edits) {
    if (kept.length && e.start < kept[kept.length - 1].end) continue;
    kept.push(e);
  }
  if (!kept.length) return { content: old, diff: '', applied: 0 };

  const parts: Buffer[] = [];
  let pos = 0;
  for (const e of kept) { parts.push(old.subarray(pos, e.start), e.replacement); pos = e.end; }
  parts.push(old.subarray(pos));
  const content = Buffer.concat(parts);

  // Changes = groups of edits touching the same lines; each covers old lines [from, to].
  const starts = lineStarts(old);
  const oldLines = old.toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  const lineEndExcl = (line: number) => (line + 1 < starts.length ? starts[line + 1] - 1 : old.length);
  type Change = { from: number; to: number; edits: Edit[] };
  const changes: Change[] = [];
  for (const e of kept) {
    const from = lineOf(starts, e.start);
    const to = lineOf(starts, Math.max(e.start, e.end - 1));
    const last = changes[changes.length - 1];
    if (last && from <= last.to) { last.to = Math.max(last.to, to); last.edits.push(e); }
    else changes.push({ from, to, edits: [e] });
  }
  const newLinesOf = (c: Change): string[] => {
    const segs: Buffer[] = [];
    let p = starts[c.from];
    for (const e of c.edits) { segs.push(old.subarray(p, e.start), e.replacement); p = e.end; }
    segs.push(old.subarray(p, lineEndExcl(c.to)));
    return Buffer.concat(segs).toString('utf8').split('\n').map((l) => l.replace(/\r$/, ''));
  };

  // Hunks = changes closer than 2*context lines.
  const hunks: Change[][] = [];
  for (const c of changes) {
    const h = hunks[hunks.length - 1];
    if (h && c.from - h[h.length - 1].to - 1 <= 2 * context) h.push(c);
    else hunks.push([c]);
  }
  let out = `--- a/${displayName}\n+++ b/${displayName}\n`;
  let delta = 0; // new-line offset accumulated from earlier hunks
  for (const h of hunks) {
    const s = Math.max(0, h[0].from - context);
    const e = Math.min(oldLines.length - 1, h[h.length - 1].to + context);
    const body: string[] = [];
    let oldCount = 0, newCount = 0;
    let l = s;
    for (const c of h) {
      for (; l < c.from; l++) { body.push(` ${oldLines[l]}`); oldCount++; newCount++; }
      for (let k = c.from; k <= c.to; k++) { body.push(`-${oldLines[k]}`); oldCount++; }
      const nl = newLinesOf(c);
      for (const x of nl) { body.push(`+${x}`); newCount++; }
      l = c.to + 1;
    }
    for (; l <= e; l++) { body.push(` ${oldLines[l]}`); oldCount++; newCount++; }
    out += `@@ -${s + 1},${oldCount} +${s + 1 + delta},${newCount} @@\n${body.join('\n')}\n`;
    delta += newCount - oldCount;
  }
  return { content, diff: out, applied: kept.length };
}

// ---------------------------------------------------------------------------
// Common argument handling
// ---------------------------------------------------------------------------
async function resolveTarget(p: string): Promise<{ cwd: string; target: string; abs: string; isDir: boolean }> {
  const abs = await validatePath(p);
  const st = await fsp.stat(abs).catch(() => null);
  if (!st) throw new Error(`Path not found: ${p}`);
  if (st.isDirectory()) return { cwd: abs, target: '.', abs, isDir: true };
  return { cwd: path.dirname(abs), target: path.basename(abs), abs, isDir: false };
}

function globArgs(globs?: string[]): string[] {
  const out: string[] = [];
  for (const g of globs ?? []) if (g.trim()) out.push('--globs', g);
  return out;
}

async function preflight(): Promise<{ exe: AstGrepExe } | { error: ServerResult }> {
  if (!(await commandManager.validateCommand('ast-grep'))) return { error: text('Error: Command not allowed: ast-grep', true) };
  const exe = resolveAstGrep();
  if (!exe) return { error: text(notInstalledMessage(), true) };
  return { exe };
}

function capOutput(s: string, max = MAX_OUTPUT_CHARS): string {
  return s.length > max ? `${s.slice(0, max)}\n\n[... output truncated at ${max} characters; narrow path/globs or lower maxResults ...]` : s;
}

// ---------------------------------------------------------------------------
// ast_search
// ---------------------------------------------------------------------------
export const AstSearchArgsSchema = z.object({
  pattern: z.string().min(1).optional().describe('AST pattern, written as code. $X = one node, $$$X = zero or more nodes, $_ = wildcard.'),
  rule: z.string().optional().describe('Alternative to pattern: an ast-grep YAML rule (id, language, rule: {...}).'),
  lang: z.string().optional().describe('Language of the pattern, e.g. ts, tsx, js, py, rust, go, java, c, cpp, cs, rb, kotlin, swift, html, css. Omit to infer from file extensions.'),
  path: z.string().min(1).describe('Directory or file to search (absolute; inside allowed directories).'),
  globs: z.array(z.string()).optional().describe('Include/exclude globs, e.g. ["**/*.ts", "!**/*.test.ts"].'),
  maxResults: z.number().int().min(1).max(5_000).optional().default(200),
  contextLines: z.number().int().min(0).max(10).optional().default(0).describe('Source lines to show around each match.'),
  timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().default(DEFAULT_TIMEOUT_MS),
});

function contextBlock(file: string, m: AstMatch, n: number, cache: Map<string, string[] | null>): string {
  let lines = cache.get(file);
  if (lines === undefined) {
    try { lines = fs.readFileSync(file, 'utf8').split('\n').map((l) => l.replace(/\r$/, '')); } catch { lines = null; }
    cache.set(file, lines);
  }
  if (!lines) return '';
  const s = Math.max(0, m.range.start.line - n);
  const e = Math.min(lines.length - 1, m.range.end.line + n);
  const w = String(e + 1).length;
  const out: string[] = [];
  for (let i = s; i <= e; i++) {
    const mark = i >= m.range.start.line && i <= m.range.end.line ? '>' : ' ';
    out.push(`  ${mark}${String(i + 1).padStart(w)}| ${lines[i].length > 300 ? `${lines[i].slice(0, 297)}...` : lines[i]}`);
  }
  return out.join('\n');
}

export async function handleAstSearch(args: unknown): Promise<ServerResult> {
  const parsed = AstSearchArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for ast_search: ${parsed.error.message}`, true);
  const a = parsed.data;
  if (!a.pattern === !a.rule) return text('ast_search needs exactly one of "pattern" or "rule".', true);
  const pre = await preflight();
  if ('error' in pre) return pre.error;
  let t;
  try { t = await resolveTarget(a.path); } catch (e) { return text(e instanceof Error ? e.message : String(e), true); }

  const cli = a.rule
    ? ['scan', '--inline-rules', a.rule]
    : ['run', '--pattern', a.pattern!, ...(a.lang ? ['--lang', a.lang] : [])];
  cli.push('--json=stream', '--color', 'never', ...globArgs(a.globs), t.target);
  const r = await runAstGrep(pre.exe, cli, t.cwd, a.maxResults + 1, a.timeout_ms);
  const fail = failureText(r);
  if (fail) return text(fail, true);

  const shown = r.matches.slice(0, a.maxResults);
  const more = r.matches.length > a.maxResults || r.truncated;
  const files = new Set(shown.map((m) => m.file));
  let out = `ast_search ${a.rule ? 'rule' : `pattern ${JSON.stringify(a.pattern)}`}${a.lang ? ` (${a.lang})` : ''} in ${t.abs}\n`;
  if (!shown.length) {
    out += r.timedOut ? `No matches before the ${a.timeout_ms} ms timeout.` : 'No matches.';
    const warn = r.stderr.trim();
    if (warn) out += `\nast-grep: ${oneLine(warn, 500)}`;
    if (!r.timedOut) out += '\nTips: the pattern must be valid code in the target language; set lang; use $X / $$$X for variable parts.';
    return text(out);
  }
  out += `${shown.length}${more ? '+' : ''} match(es) in ${files.size} file(s)${more ? ` (stopped at maxResults=${a.maxResults})` : ''}${r.timedOut ? ` (TIMED OUT after ${a.timeout_ms} ms; results incomplete)` : ''} · ${r.ms}ms\n\n`;
  const cache = new Map<string, string[] | null>();
  const lines: string[] = [];
  for (const m of shown) {
    lines.push(formatMatchLine(m));
    if (a.contextLines > 0) lines.push(contextBlock(path.resolve(t.cwd, m.file), m, a.contextLines, cache));
  }
  out += lines.join('\n');
  return text(capOutput(out));
}

// ---------------------------------------------------------------------------
// ast_rewrite
// ---------------------------------------------------------------------------
export const AstRewriteArgsSchema = z.object({
  pattern: z.string().min(1).optional().describe('AST pattern to match (use with rewrite and lang).'),
  rewrite: z.string().optional().describe('Replacement code; may reuse meta-variables from the pattern ($X, $$$X).'),
  rule: z.string().optional().describe('Alternative to pattern/rewrite: an ast-grep YAML rule with a fix (id, language, rule: {...}, fix: ...).'),
  lang: z.string().optional().describe('Language of the pattern (required with pattern), e.g. ts, tsx, js, py, rust, go, java.'),
  path: z.string().min(1).describe('Directory or file to rewrite (absolute; inside allowed directories).'),
  globs: z.array(z.string()).optional().describe('Include/exclude globs, e.g. ["src/**/*.ts", "!**/*.d.ts"].'),
  dry_run: z.boolean().optional().default(true).describe('Default true: preview plus SHA-256 hashes. Set false for guarded atomic per-file writes.'),
  expected_sha256_by_file: z.record(z.string().regex(/^[a-fA-F0-9]{64}$/)).optional().describe('Optional exact source hashes keyed by path displayed in dry run. Required when BRC_REQUIRE_SOURCE_HASH=1. Reject stale edits rather than rebasing.'),
  contextLines: z.number().int().min(0).max(10).optional().default(2).describe('Context lines in the diff.'),
  timeout_ms: z.number().int().min(1_000).max(MAX_TIMEOUT_MS).optional().default(DEFAULT_TIMEOUT_MS),
});

export async function handleAstRewrite(args: unknown): Promise<ServerResult> {
  const parsed = AstRewriteArgsSchema.safeParse(args);
  if (!parsed.success) return text(`Invalid arguments for ast_rewrite: ${parsed.error.message}`, true);
  const a = parsed.data;
  if (a.rule && (a.pattern || a.rewrite !== undefined)) return text('ast_rewrite: pass either rule, or pattern + rewrite + lang - not both.', true);
  if (!a.rule) {
    if (!a.pattern || a.rewrite === undefined) return text('ast_rewrite needs pattern and rewrite (or a YAML rule with a fix).', true);
    if (!a.lang) return text('ast_rewrite needs lang with a pattern (e.g. "ts", "py", "rust") so the pattern is parsed correctly.', true);
  }
  const pre = await preflight();
  if ('error' in pre) return pre.error;
  let t;
  try { t = await resolveTarget(a.path); } catch (e) { return text(e instanceof Error ? e.message : String(e), true); }

  const cli = a.rule
    ? ['scan', '--inline-rules', a.rule]
    : ['run', '--pattern', a.pattern!, '--rewrite', a.rewrite!, '--lang', a.lang!];
  cli.push('--json=stream', '--color', 'never', ...globArgs(a.globs), t.target);
  const r = await runAstGrep(pre.exe, cli, t.cwd, MAX_REWRITE_MATCHES + 1, a.timeout_ms);
  const fail = failureText(r);
  if (fail) return text(fail, true);
  if (r.timedOut) return text(`ast-grep timed out after ${a.timeout_ms} ms; nothing was changed. Narrow path or globs.`, true);
  if (r.truncated) return text(`More than ${MAX_REWRITE_MATCHES} matches; nothing was changed. Narrow path or globs.`, true);

  // Group edits per file.
  const byFile = new Map<string, MatchedRewrite[]>();
  let noFix = 0;
  for (const m of r.matches) {
    if (m.replacement === undefined) { noFix++; continue; }
    const list = byFile.get(m.file) ?? [];
    list.push({text:m.text,range:m.range,replacement:m.replacement,replacementOffsets:m.replacementOffsets});
    byFile.set(m.file, list);
  }
  const head = `ast_rewrite ${a.rule ? 'rule' : `${JSON.stringify(a.pattern)} -> ${JSON.stringify(a.rewrite)}`}${a.lang ? ` (${a.lang})` : ''} in ${t.abs}`;
  if (!byFile.size) {
    let out = `${head}\nNo matches${noFix ? ` with a fix (${noFix} match(es) without a fix; does the rule have "fix:"?)` : ''}. Nothing changed.`;
    const warn = r.stderr.trim();
    if (warn) out += `\nast-grep: ${oneLine(warn, 500)}`;
    return text(out);
  }

  // Scanner byte offsets are only hints. Under per-file write locks, first
  // revalidate every exact matched byte span and any caller-observed SHA-256;
  // atomicWrite then compares the same fresh snapshot again before commit.
  // Preflight all files before writing any file; never use raw writeFile().
  const prepared=await guardedAstRewrite(
    [...byFile].map(([file,matches])=>({
      file:path.resolve(t.cwd,file),display:displayFile(file),matches
    })),
    {dryRun:a.dry_run,contextLines:a.contextLines,
      expectedSha256ByFile:a.expected_sha256_by_file},applyEdits);
  let out=`${head}\n`;
  out+=a.dry_run
    ? `DRY RUN: ${prepared.totalEdits} replacement(s) in ${prepared.prepared.length} file(s). Nothing was written.\n`
    : `APPLIED: ${prepared.totalEdits} replacement(s) in ${prepared.written.length} file(s) through guarded atomic writes.\n`;
  out+='Source SHA-256 snapshots (pass as expected_sha256_by_file to require exact version):\n';
  for(const item of prepared.prepared)
    out+=`  ${item.display}: ${item.beforeHash}\n`;
  out+='The preview protects exact matched bytes; never assume a multi-file write is a crash-atomic transaction.\n';
  out+='\n'+prepared.prepared.map(item=>item.diff).join('');
  return text(capOutput(out));
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------
export const AST_GREP_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
  ast_search: handleAstSearch,
  ast_rewrite: handleAstRewrite,
};

const PATTERN_HELP = [
  'Pattern syntax: write the code you are looking for; $NAME matches exactly one AST node (expression, identifier, ...),',
  '$$$NAME matches zero or more nodes (arguments, statements), $_ matches any node without capturing.',
  'Reusing a name ($A ... $A) requires the same code in both places. Whitespace and formatting do not matter.',
].join('\n');

export function buildAstGrepToolDefinitions(): ToolDefinition[] {
  return [
    {
      name: 'ast_search',
      description: [
        'Structural code search with ast-grep: matches syntax trees, not text, so it ignores formatting, comments and strings',
        'that merely contain the words. Use it instead of regex search for code shapes (calls, definitions, imports, JSX...).',
        PATTERN_HELP,
        'Examples: {"pattern":"callTool($NAME, $ARGS)","lang":"ts","path":"/repo/src"} finds every two-argument callTool call;',
        '{"pattern":"console.log($$$ARGS)","lang":"js","path":"/repo"} finds console.log calls with any arguments.',
        'Returns "file:line:col: matched code [captures]" relative to path. Respects .gitignore. maxResults default 200;',
        'contextLines shows surrounding source. Alternatively pass rule = an ast-grep YAML rule (id, language, rule) for',
        'relational queries (inside / has / not).',
      ].join('\n'),
      inputSchema: zodToJsonSchema(AstSearchArgsSchema),
      annotations: { title: 'AST Search', readOnlyHint: true },
    },
    {
      name: 'ast_rewrite',
      description: [
        'Structural code rewrite with ast-grep. DRY RUN BY DEFAULT: returns a unified diff and counts without changing',
        'files; call again with dry_run=false to write the changes.',
        PATTERN_HELP,
        'Meta-variables captured by pattern can be used in rewrite.',
        'Examples: {"pattern":"oldApi($A, $B)","rewrite":"newApi({ a: $A, b: $B })","lang":"ts","path":"/repo/src"};',
        '{"pattern":"assertEquals($X, $Y)","rewrite":"assert $X == $Y","lang":"py","path":"/repo/tests"}.',
        'Alternatively pass rule = an ast-grep YAML rule with a fix (id, language, rule: {...}, fix: ...).',
        'lang is required with pattern. globs narrows files. Respects .gitignore.',
      ].join('\n'),
      inputSchema: zodToJsonSchema(AstRewriteArgsSchema),
      annotations: { title: 'AST Rewrite', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
  ];
}
