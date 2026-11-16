/**
 * BRC plugins: small helpers shared by the installer and the Python flow - child processes with
 * timeouts, sha256-verified downloads and single-file extraction from zip / tar.gz archives.
 * Pure Node (no extra dependencies, no external unzip/tar programs).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import type { InstallLog } from './types.js';

const isWindows = process.platform === 'win32';
const MAX_CAPTURE = 1_000_000;

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface RunOptions {
  env?: Record<string, string | undefined>;
  cwd?: string;
  timeoutMs?: number;
  log?: InstallLog;
  /** Needed only for .cmd/.bat on Windows; callers must pass pre-validated arguments. */
  shell?: boolean;
}

function killTree(pid: number | undefined): void {
  if (!pid) return;
  if (isWindows) {
    try { spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 }); } catch { /* ignore */ }
  } else {
    try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* ignore */ } }
  }
}

/** Run a program to completion (stdin closed, output captured, killed on timeout). Never throws. */
export function runProcess(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let child;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        env: opts.env as NodeJS.ProcessEnv | undefined,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        shell: opts.shell ?? false,
        detached: !isWindows, // own process group so a timeout kills the whole tree
      });
    } catch (e) {
      resolve({ code: null, stdout: '', stderr: e instanceof Error ? e.message : String(e), timedOut: false });
      return;
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => { timedOut = true; killTree(child.pid); }, opts.timeoutMs)
      : undefined;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (d: string) => { if (stdout.length < MAX_CAPTURE) stdout += d; });
    child.stderr?.on('data', (d: string) => {
      if (stderr.length < MAX_CAPTURE) stderr += d;
      if (opts.log) for (const line of d.split(/\r?\n/)) if (line.trim()) opts.log('debug', line.trim());
    });
    child.on('error', (e) => { stderr += `${stderr ? '\n' : ''}${e.message}`; });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });
}

/** One readable error line block from a failed run: "<what> failed (exit 1): <stderr tail>". */
export function runError(what: string, r: RunResult): string {
  const why = r.timedOut ? 'timed out' : `exit ${r.code ?? 'signal'}`;
  const out = (r.stderr.trim() || r.stdout.trim()).replace(/\u001b\[[0-9;]*m/g, '');
  const tail = out.length > 1500 ? `...${out.slice(-1500)}` : out;
  return `${what} failed (${why})${tail ? `: ${tail}` : ''}`;
}

/** Find a program on PATH without spawning anything (honours PATHEXT on Windows). */
export function whichSync(name: string): string | null {
  const dirs = (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean);
  const exts = isWindows ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean).map((e) => e.toLowerCase()) : [''];
  for (const dir of dirs) {
    for (const ext of isWindows && path.extname(name) ? [''] : exts) {
      const file = path.join(dir, name + ext);
      try { if (fs.statSync(file).isFile()) return file; } catch { /* next */ }
    }
  }
  return null;
}

export async function sha256File(file: string): Promise<string> {
  const h = createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex');
}

function checkUrl(url: string): void {
  const u = new URL(url);
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost' || u.hostname === '[::1]';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) throw new Error(`refusing non-https download: ${url}`);
}

/**
 * Download url to dest, verifying sha256 (required). On mismatch the file is deleted and an error
 * is thrown. If dest already exists with the right hash, nothing is downloaded.
 */
export async function downloadVerified(url: string, sha256: string, dest: string, log?: InstallLog, timeoutMs = 15 * 60_000): Promise<string> {
  checkUrl(url);
  const want = sha256.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(want)) throw new Error(`invalid pinned sha256 for ${url}`);
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest) && (await sha256File(dest)) === want) return dest;
  log?.('info', `downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'brc-agent' } });
  if (!res.ok || !res.body) throw new Error(`download ${url} failed: HTTP ${res.status}`);
  const tmp = `${dest}.${process.pid}.part`;
  const h = createHash('sha256');
  const src = Readable.fromWeb(res.body as import('node:stream/web').ReadableStream);
  src.on('data', (chunk: Buffer) => h.update(chunk));
  try {
    await pipeline(src, fs.createWriteStream(tmp));
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`download ${url} failed: ${e instanceof Error ? e.message : String(e)}`);
  }
  const got = h.digest('hex');
  if (got !== want) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`sha256 mismatch for ${url}: expected ${want}, got ${got}`);
  }
  await fsp.rename(tmp, dest);
  return dest;
}

// ---------------------------------------------------------------------------
// Archive extraction (one file out of a zip or tar.gz)
// ---------------------------------------------------------------------------
function normEntry(name: string): string {
  return name.replace(/\\/g, '/').replace(/^\.\//, '');
}

function matches(entry: string, want: { archivePath?: string; baseName: string }): boolean {
  const e = normEntry(entry);
  if (want.archivePath) return e === normEntry(want.archivePath);
  return path.posix.basename(e) === want.baseName;
}

function zipExtract(buf: Buffer, want: { archivePath?: string; baseName: string }): Buffer | null {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = buf.readUInt16LE(p + 10);
    const compSize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || !matches(name, want)) continue;
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt zip local header');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    if (method === 0) return Buffer.from(data);
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip compression method ${method} for ${name}`);
  }
  return null;
}

function tarString(b: Buffer, start: number, len: number): string {
  const s = b.subarray(start, start + len);
  const z = s.indexOf(0);
  return s.toString('utf8', 0, z < 0 ? len : z);
}

function tarExtract(tar: Buffer, want: { archivePath?: string; baseName: string }): Buffer | null {
  let p = 0;
  let longName: string | null = null;
  while (p + 512 <= tar.length) {
    const header = tar.subarray(p, p + 512);
    if (header.every((x) => x === 0)) break;
    const size = parseInt(tarString(header, 124, 12).trim() || '0', 8);
    const type = String.fromCharCode(header[156] || 48);
    let name = tarString(header, 0, 100);
    const prefix = tarString(header, 345, 155);
    if (prefix && tarString(header, 257, 6).startsWith('ustar')) name = `${prefix}/${name}`;
    const dataStart = p + 512;
    const data = tar.subarray(dataStart, dataStart + size);
    p = dataStart + Math.ceil(size / 512) * 512;
    if (type === 'L') { longName = tarString(data, 0, data.length); continue; }
    if (type === 'x') {
      const m = /\d+ path=([^\n]*)\n/.exec(data.toString('utf8'));
      if (m) longName = m[1];
      continue;
    }
    if (longName) { name = longName; longName = null; }
    if ((type === '0' || type === '\0' || type === '7') && matches(name, want)) return Buffer.from(data);
  }
  return null;
}

/** Kind of archive judged by URL / file name. */
export function archiveKind(name: string): 'zip' | 'tar.gz' | 'tar' | null {
  const n = name.toLowerCase().split('?')[0];
  if (n.endsWith('.zip')) return 'zip';
  if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
  if (n.endsWith('.tar')) return 'tar';
  return null;
}

/** Extract one file (by archivePath, else by base name) from a zip / tar(.gz) into dest. */
export async function extractOne(archive: string, kind: 'zip' | 'tar.gz' | 'tar', want: { archivePath?: string; baseName: string }, dest: string): Promise<void> {
  const buf = await fsp.readFile(archive);
  const out = kind === 'zip' ? zipExtract(buf, want) : tarExtract(kind === 'tar.gz' ? zlib.gunzipSync(buf) : buf, want);
  if (!out) throw new Error(`${want.archivePath ?? want.baseName} not found in ${path.basename(archive)}`);
  await writeExecutable(dest, out);
}

/** Write a file atomically-ish (temp + rename) with exec permission. */
export async function writeExecutable(dest: string, data: Buffer): Promise<void> {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  await fsp.writeFile(tmp, data, { mode: 0o755 });
  try {
    await fsp.rename(tmp, dest);
  } catch (e) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`cannot replace ${dest} (is it running?): ${e instanceof Error ? e.message : String(e)}`);
  }
  try { await fsp.chmod(dest, 0o755); } catch { /* windows */ }
}

/** Serialise async work per key (e.g. all npm operations on the shared prefix). */
const locks = new Map<string, Promise<unknown>>();
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  locks.set(key, next.catch(() => {}));
  return next;
}
