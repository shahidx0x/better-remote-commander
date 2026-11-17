/** Read/write/edit/check in one call. No cached authorization, no automatic planning, no nested tool program. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { ToolResult } from 'brc-shared';
import { rootPath, projectPath, textFile } from '../runtime/workspace.js';
import { readBounded, decodeCode, sha256, atomicWrite, withFileLocks, lockKey } from '../runtime/file-safety.js';
import { AgentError, result, failure } from '../runtime/errors.js';
import { checkCancelled, getCallContext } from '../context.js';
const Hash = z.string().regex(/^[a-fA-F0-9]{64}$/);
export const WorkspaceChangeSchema = z.object({
    path: z.string().min(1), expected_sha256: Hash.nullable(),
    content: z.string().max(2 * 1024 * 1024).optional(),
    edits: z.array(z.object({ old_string: z.string().min(1), new_string: z.string(), expected_replacements: z.number().int().min(1).max(10000).default(1) })).min(1).max(100).optional(),
}).refine(c => (c.content !== undefined) !== (c.edits !== undefined), { message: 'Supply full content OR exact edits.' })
    .refine(c => c.expected_sha256 !== null || c.content !== undefined, { message: 'New files require content and expected_sha256:null.' });
export const WorkspaceBatchSchema = z.object({
    path: z.string().min(1),
    changes: z.array(WorkspaceChangeSchema).max(64).default([]),
    reads: z.array(z.object({ path: z.string().min(1), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(2000).default(120), known_sha256: Hash.optional() })).max(64).default([]),
    writeConcurrency: z.number().int().min(1).max(4).default(1),
    dryRun: z.boolean().default(true), maxChars: z.number().int().min(2000).max(256000).default(96000),
}).refine(a => a.changes.length + a.reads.length > 0, { message: 'Provide changes or reads.' });
async function createExclusive(file: string, bytes: Buffer) {
    const temp = path.join(path.dirname(file), `.brc-create-${randomUUID()}.tmp`);
    try {
        const fd = await fs.open(temp, 'wx', 0o600);
        try {
            await fd.writeFile(bytes);
            await fd.sync();
        }
        finally {
            await fd.close();
        }
        checkCancelled();
        // link is an exclusive publication: unlike rename, it cannot replace a file created in the meantime.
        await fs.link(temp, file);
    }
    finally {
        await fs.unlink(temp).catch(() => { });
    }
}
interface Prepared {
    path: string;
    before: Buffer | null;
    after: Buffer;
    beforeHash: string | null;
    afterHash: string;
}
export async function workspaceBatch(raw: unknown): Promise<ToolResult> {
    const a = WorkspaceBatchSchema.parse(raw), root = await rootPath(a.path), started = performance.now();
    if (Buffer.byteLength(JSON.stringify(a.changes)) > 8 * 1024 * 1024)
        throw new AgentError('BATCH_TOO_LARGE', 'Combined change arguments exceed 8 MiB.');
    const paths = await Promise.all(a.changes.map(c => projectPath(root, c.path)));
    const keys = await Promise.all(paths.map(lockKey));
    if (new Set(keys).size !== keys.length)
        throw new AgentError('DUPLICATE_TARGET', 'Use one change entry per canonical file.');
    const prepared: Prepared[] = [];
    let mutationFailure: ToolResult | undefined;
    await withFileLocks(paths, async () => {
        let bytes = 0;
        for (let i = 0; i < a.changes.length; i++) {
            checkCancelled();
            const c = a.changes[i], p = paths[i];
            const stat = await fs.lstat(p).catch((e: NodeJS.ErrnoException) => {
                if (e.code === 'ENOENT')
                    return null;
                throw e;
            });
            if (stat && (!stat.isFile() || stat.isSymbolicLink()))
                throw new AgentError('UNSAFE_TARGET', 'Changes require regular non-symlink files.');
            if ((c.expected_sha256 === null) !== !stat)
                throw new AgentError('FILE_CONFLICT', 'Expected absence or existence changed. Re-read before writing.');
            const before = stat ? await readBounded(p, 4 * 1024 * 1024) : null, beforeHash = before ? sha256(before) : null;
            if (beforeHash !== c.expected_sha256?.toLowerCase() && !(beforeHash === null && c.expected_sha256 === null))
                throw new AgentError('FILE_CONFLICT', `File ${i + 1} changed; nothing written.`);
            let next: string = c.content ?? '';
            if (c.edits) {
                next = decodeCode(before!);
                const crlf = next.includes('\r\n');
                const normalize = (s: string) => crlf ? s.replace(/\r?\n/g, '\r\n') : s;
                for (const edit of c.edits) {
                    const old = normalize(edit.old_string), parts = next.split(old);
                    if (parts.length - 1 !== edit.expected_replacements)
                        throw new AgentError('EDIT_MISMATCH', `File ${i + 1}: exact replacement count differs; nothing written.`);
                    next = parts.join(normalize(edit.new_string));
                    if (Buffer.byteLength(next) > 4 * 1024 * 1024)
                        throw new AgentError('FILE_TOO_LARGE', 'Edited output exceeds 4 MiB.');
                }
            }
            const after = Buffer.from(next!, 'utf8');
            bytes += (before?.length ?? 0) + after.length;
            if (bytes > 16 * 1024 * 1024)
                throw new AgentError('BATCH_TOO_LARGE', 'Combined before/after snapshots exceed 16 MiB.');
            prepared.push({ path: p, before, after, beforeHash, afterHash: sha256(after) });
        }
        const committed: Prepared[] = [];
        try {
            if (!a.dryRun) {
                const pending = prepared.filter(p => p.beforeHash !== p.afterHash);
                for (let i = 0; i < pending.length; i += a.writeConcurrency) {
                    checkCancelled();
                    // Files are distinct and all their locks are held. Wait for EVERY in-flight
                    // publication before rolling back; never race rollback against a late rename.
                    const wave = await Promise.allSettled(pending.slice(i, i + a.writeConcurrency).map(async (p) => {
                        checkCancelled();
                        if (p.beforeHash === null)
                            await createExclusive(p.path, p.after);
                        else
                            await atomicWrite(p.path, p.after, p.beforeHash);
                        committed.push(p);
                    }));
                    const rejected = wave.find((v): v is PromiseRejectedResult => v.status === 'rejected');
                    if (rejected)
                        throw rejected.reason;
                    checkCancelled();
                }
            }
        }
        catch (error) {
            const conflicts: string[] = [];
            for (const p of committed.reverse()) {
                try {
                    if (p.before)
                        await atomicWrite(p.path, p.before, p.afterHash, true);
                    else {
                        if (sha256(await fs.readFile(p.path)) !== p.afterHash)
                            throw new Error('external change');
                        await fs.unlink(p.path);
                    }
                }
                catch {
                    conflicts.push(p.path);
                }
            }
            mutationFailure = failure(error, getCallContext()?.id);
            mutationFailure.content.push({ type: 'text', text: JSON.stringify({ rollbackConflicts: conflicts, rolledBack: committed.length - conflicts.length }) });
            mutationFailure.structuredContent = { ...mutationFailure.structuredContent, rollbackConflicts: conflicts, requiresReview: conflicts.length > 0, rolledBack: committed.length - conflicts.length };
        }
    });
    if (mutationFailure)
        return mutationFailure;
    // Read back final files after successful commits. Bounded four-wide reads, no stale content cache.
    const reads: Record<string, unknown>[] = [];
    let remaining = a.maxChars, readErrors = false;
    for (let i = 0; i < a.reads.length && remaining > 0; i += 4) {
        const wave = await Promise.all(a.reads.slice(i, i + 4).map(async (r) => {
            try {
                const file = await projectPath(root, r.path), f = await textFile(file, 4 * 1024 * 1024);
                if (r.known_sha256?.toLowerCase() === f.sha256)
                    return { path: file, sha256: f.sha256, unchanged: true, text: '' };
                const lines = f.text.split('\n');
                return { path: file, sha256: f.sha256, offset: r.offset, totalLines: lines.length, text: lines.slice(r.offset, r.offset + r.length).join('\n') };
            }
            catch (error) {
                return { path: r.path, error: failure(error).structuredContent?.error, text: '' };
            }
        }));
        for (const r of wave) {
            readErrors ||= !!r.error;
            const text = r.text.slice(0, Math.max(0, remaining));
            remaining -= text.length;
            reads.push({ ...r, text, truncated: text.length < r.text.length });
        }
    }
    return result({ root, dryRun: a.dryRun, changes: prepared.map(p => ({ path: p.path, beforeSha256: p.beforeHash, afterSha256: p.afterHash, created: p.before === null, changed: p.beforeHash !== p.afterHash })),
        reads, readsSkipped: a.reads.length - reads.length,
        writeConcurrency: a.writeConcurrency, durationMs: Math.round(performance.now() - started), note: 'Validate all changes, commit, then read back. dryRun (default true) validates without writing; set dryRun:false to commit. New parent directories must already exist. Per-file atomic publication; multi-file rollback is best-effort, not crash-atomic. Run tests/linters separately (run_command).' }, readErrors);
}

import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ServerResult } from '../core/types.js';
import type { ToolDefinition } from '../core/tool-definitions.js';

export const WORKSPACE_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
  workspace_batch: (a) => workspaceBatch(a) as Promise<ServerResult>,
};

export function buildWorkspaceToolDefinitions(): ToolDefinition[] {
  return [{
    name: 'workspace_batch',
    description: [
      'Edit several files and read them back in ONE call, safely. Give the project root as path, then changes[] and/or reads[].',
      'Each change names one file with expected_sha256 (the hash from a previous read; null to create a new file) and EITHER full content OR exact edits[{old_string,new_string,expected_replacements}].',
      'All changes are validated first; if any hash, edit count or path is wrong NOTHING is written. Committing is per-file atomic with best-effort rollback of already-written files.',
      'dryRun defaults to true (validate only); pass dryRun:false to write. Paths must stay inside the project root; symlinks are refused; new parent directories must already exist.',
      'Use edit_block for one small edit, write_file for new content without hashes. reads[] return the final file text and sha256 so you can chain the next edit without another read.',
    ].join('\n'),
    inputSchema: zodToJsonSchema(WorkspaceBatchSchema) as ToolDefinition['inputSchema'],
    annotations: { title: 'Workspace Batch', readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  }];
}
