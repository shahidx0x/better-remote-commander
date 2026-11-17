/** Same-directory atomic replacement + optimistic content checks. Not a filesystem sandbox. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AgentError } from './errors.js';
import { checkCancelled, getCallContext } from '../context.js';
const locks = new Map<string, Promise<void>>();
export const sha256 = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
export async function lockKey(p: string): Promise<string> {
  let canonical = await fs.realpath(p).catch(async () => path.join(await fs.realpath(path.dirname(p)).catch(() => path.resolve(path.dirname(p))), path.basename(p)));
  canonical = path.normalize(canonical);
  return process.platform === 'win32' ? canonical.toLowerCase() : canonical;
}
export async function withFileLocks<T>(paths: string[], fn: () => Promise<T>): Promise<T> {
  const keys = [...new Set(await Promise.all(paths.map(lockKey)))].sort();
  const releases: (() => void)[] = [];
  try {
    for (const key of keys) {
      const previous = locks.get(key) ?? Promise.resolve();
      let release!: () => void;
      const gate = new Promise<void>(r => { release = r; });
      const tail = previous.then(() => gate);
      locks.set(key, tail);
      await previous;
      releases.push(() => { release(); if (locks.get(key) === tail) locks.delete(key); });
      checkCancelled();
    }
    return await fn();
  } finally { for (const release of releases.reverse()) release(); }
}
export async function readBounded(file: string, max = 8 * 1024 * 1024): Promise<Buffer> {
  checkCancelled();
  const fd = await fs.open(file, 'r');
  try {
    const stat = await fd.stat();
    if (!stat.isFile()) throw new AgentError('NOT_A_FILE', 'Expected a regular file.');
    if (stat.size > max) throw new AgentError('FILE_TOO_LARGE', `File exceeds ${max} bytes; use ranged read_file instead.`);
    // Bounded even if another process grows the file after stat().
    const buffer = Buffer.alloc(Math.min(stat.size + 1, max + 1));
    let n = 0;
    while (n < buffer.length) { checkCancelled(); const r = await fd.read(buffer, n, buffer.length - n, n); if (!r.bytesRead) break; n += r.bytesRead; }
    if (n > stat.size || n > max) throw new AgentError('FILE_CHANGED', 'File grew while reading. Read again.', true);
    return buffer.subarray(0,n);
  } finally { await fd.close(); }
}
export async function assertHash(file: string, expected: string): Promise<void> {
  const actual = sha256(await readBounded(file, 32 * 1024 * 1024));
  if (actual !== expected.toLowerCase()) throw new AgentError('FILE_CONFLICT', 'File changed since it was read. Re-read it before editing.');
}
export async function atomicWrite(file: string, data: string | Buffer, expectedHash?: string, allowCancelled = false): Promise<void> {
  if (!allowCancelled) checkCancelled();
  const condition = getCallContext()?.writePrecondition;
  if (condition && await lockKey(condition.path) === await lockKey(file)) {
    // Never let an intervening external write silently reset an earlier
    // caller-supplied precondition, even when the handler re-reads the file.
    if (expectedHash && expectedHash.toLowerCase() !== condition.sha256.toLowerCase())
      throw new AgentError('FILE_CONFLICT', 'File changed after precondition validation. No replacement was made.');
    expectedHash = condition.sha256;
  }
  const stat = await fs.lstat(file).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT') return null; throw e; });
  if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new AgentError('UNSAFE_TARGET', 'Atomic replacement requires a regular, non-symlink file.');
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.brc-${randomUUID()}.tmp`);
  try {
    const fd = await fs.open(temp, 'wx', stat ? stat.mode & 0o777 : 0o600);
    try { await fd.writeFile(data); await fd.sync(); } finally { await fd.close(); }
    if (expectedHash) {
      // Rollback ignores cancellation but never overwrites an externally modified file.
      const bytes = allowCancelled ? await fs.readFile(file) : await readBounded(file, 32 * 1024 * 1024);
      if (sha256(bytes) !== expectedHash.toLowerCase()) throw new AgentError('FILE_CONFLICT', 'File changed before commit. No replacement was made.');
    }
    if (!allowCancelled) checkCancelled();
    for (let attempt = 0; ; attempt++) {
      try { await fs.rename(temp, file); break; }
      catch (err) {
        if (attempt >= 4 || !['EPERM','EACCES','EBUSY'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
        await new Promise(r => setTimeout(r, 25 * (attempt + 1)));
        if (!allowCancelled) checkCancelled();
        if (expectedHash && sha256(await fs.readFile(file)) !== expectedHash.toLowerCase()) throw new AgentError('FILE_CONFLICT', 'File changed while waiting for Windows to release it.');
      }
    }
  } finally { await fs.unlink(temp).catch(() => {}); }
}
export function decodeCode(bytes: Buffer): string {
  if (bytes.includes(0)) throw new AgentError('UNSUPPORTED_ENCODING', 'Use ordinary file tools for binary or UTF-16 files. Code snapshots/patches require UTF-8.');
  try { return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { throw new AgentError('UNSUPPORTED_ENCODING', 'Code snapshot is not valid UTF-8.'); }
}
