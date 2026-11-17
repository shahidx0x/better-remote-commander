/**
 * batch_tools engine: one round trip, bounded parallel reads, ordered mutation barriers.
 * No executable mini-language: every nested call is an ordinary tool call, re-validated by the dispatcher.
 */
import { z } from 'zod';
import type { ToolResult } from 'brc-shared';
import { AgentError, failure, result } from './errors.js';
import { checkCancelled, getCallContext, withCallContext } from '../context.js';

export const BATCH_LIMITS = Object.freeze({ calls: 64, concurrency: 4, argumentBytes: 4 * 1024 * 1024, entryChars: 24_000 });

export const BatchSchema = z.object({
    calls: z.array(z.object({ tool: z.string().min(1).max(100), arguments: z.record(z.string(), z.unknown()).default({}) })).min(1).max(BATCH_LIMITS.calls),
    mode: z.enum(['auto', 'sequential', 'parallel']).default('auto'),
    concurrency: z.number().int().min(1).max(BATCH_LIMITS.concurrency).default(BATCH_LIMITS.concurrency),
    stopOnError: z.boolean().default(true),
    maxChars: z.number().int().min(4000).max(256_000).default(96_000),
    compact: z.boolean().default(true),
});

/** Independent reads: may overlap in auto/parallel mode. Other agents may add their read-only tools here. */
export const BATCH_READ_TOOLS = new Set([
    'read_file', 'read_multiple_files', 'list_directory', 'get_file_info', 'read_code_file', 'read_symbol',
    'code_outline', 'find_symbols', 'find_references', 'related_files', 'project_context', 'project_map',
    'context_pack', 'code_graph', 'language_capabilities', 'discover_checks',
]);
/** Ordered barriers: each runs alone, after everything before it has finished. Never allowed in parallel mode. */
export const BATCH_BARRIER_TOOLS = new Set(['write_file', 'edit_block', 'create_directory', 'move_file', 'workspace_batch']);
// Everything else (shell/process tools, config, plugins, jobs tools, batch_tools itself) is refused by name.

export type BatchInvoker = (tool: string, args: Record<string, unknown>) => Promise<ToolResult>;

function reasonDenied(tool: string): string {
    if (tool === 'batch_tools') return 'Nested batches are not allowed.';
    return `Tool ${tool} is not allowed in batch_tools (only file/code reads and ordered file writes).`;
}

function duplicatesStructured(content: { type: string; text?: string }[], structured: unknown): boolean {
    if (content.length !== 1 || content[0].type !== 'text' || typeof content[0].text !== 'string') return false;
    try { return JSON.stringify(JSON.parse(content[0].text)) === JSON.stringify(structured); } catch { return false; }
}

export async function runBatch(raw: unknown, invoke: BatchInvoker): Promise<ToolResult> {
    const a = BatchSchema.parse(raw), parent = getCallContext();
    if ((parent?.depth ?? 0) > 0) throw new AgentError('NESTED_BATCH', 'batch_tools cannot be nested or run from a job step.');
    if (Buffer.byteLength(JSON.stringify(a.calls)) > BATCH_LIMITS.argumentBytes) throw new AgentError('BATCH_TOO_LARGE', 'Batch arguments exceed 4 MiB.');
    for (const c of a.calls) {
        if (c.tool === 'batch_tools') throw new AgentError('NESTED_BATCH', reasonDenied(c.tool));
        const read = BATCH_READ_TOOLS.has(c.tool);
        if (!read && !BATCH_BARRIER_TOOLS.has(c.tool)) throw new AgentError('BATCH_TOOL_DENIED', reasonDenied(c.tool));
        if (a.mode === 'parallel' && !read) throw new AgentError('PARALLEL_WRITE_DENIED', 'Parallel mode accepts independent reads only. Use auto for ordered write barriers.');
    }
    const started = performance.now(), results: Record<string, unknown>[] = [];
    const parentId = parent?.id ?? 'batch';
    let next = 0, failed = false, used = 0, outputLimited = false, waves = 0;
    const one = async (index: number): Promise<ToolResult> => {
        const c = a.calls[index], id = `${parentId}:${index}`;
        try {
            checkCancelled();
            // Fresh nested context: depth 1 forbids nesting; a parent's write precondition never leaks into children.
            return await withCallContext({ id, client: parent?.client ?? null, remote: parent?.remote ?? false, signal: parent?.signal, deadline: parent?.deadline, depth: 1 }, () => invoke(c.tool, c.arguments));
        } catch (error) { return failure(error, id); }
    };
    while (next < a.calls.length) {
        checkCancelled();
        if (used >= a.maxChars - 2000) { outputLimited = true; break; }
        const indices = [next++];
        if (a.mode !== 'sequential' && BATCH_READ_TOOLS.has(a.calls[indices[0]].tool)) {
            while (indices.length < a.concurrency && next < a.calls.length && BATCH_READ_TOOLS.has(a.calls[next].tool)) indices.push(next++);
        }
        waves++;
        const wave = await Promise.all(indices.map(one));
        for (let j = 0; j < indices.length; j++) {
            const index = indices[j], r = wave[j];
            failed ||= !!r.isError;
            // Never hide image base64 inside text JSON; previews have a dedicated tool.
            const content = (r.content ?? []).map(b => b.type === 'image' ? { type: 'text', text: '[Image omitted from batch_tools; use a dedicated image tool.]' } : b);
            // compact drops only text that merely repeats structuredContent (result() helper); real payload text (e.g. file bodies) is kept.
            const view = { isError: !!r.isError, ...(a.compact && r.structuredContent && duplicatesStructured(content, r.structuredContent) ? {} : { content }),
                ...(r.structuredContent ? { structuredContent: r.structuredContent } : {}), _meta: r._meta };            const text = JSON.stringify(view), room = Math.max(0, Math.min(BATCH_LIMITS.entryChars, a.maxChars - used - 1200));
            const entry = { index, tool: a.calls[index].tool, isError: !!r.isError,
                ...(text.length > room ? { truncated: true, preview: text.slice(0, room), callId: r._meta?.callId } : { result: view }) };
            used += JSON.stringify(entry).length;
            results.push(entry);
        }
        if (failed && a.stopOnError) break;
    }
    return result({ results, executed: next, skipped: a.calls.length - next, outputLimited,
        mode: a.mode, concurrency: a.mode === 'sequential' ? 1 : a.concurrency, waves,
        durationMs: Math.round(performance.now() - started), transactional: false,
        note: 'Consecutive independent reads may overlap; writes run alone, in order. In-flight reads finish after an error; later calls are skipped with stopOnError. Earlier writes are not rolled back. Use workspace_batch for hash-checked multi-file changes.' }, failed);
}
