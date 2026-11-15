/** One round trip, bounded parallel reads, ordered mutation barriers. No executable mini-language. */
import { z } from 'zod';
import type { ToolResult } from 'brc-shared';
import { AgentError, failure, result } from './errors.js';
import { checkCancelled, getCallContext, withCallContext } from '../context.js';
export const BatchSchema = z.object({
    calls: z.array(z.object({ tool: z.string().min(1), arguments: z.record(z.unknown()).default({}) })).min(1).max(64),
    mode: z.enum(['auto', 'sequential', 'parallel']).default('auto'),
    concurrency: z.number().int().min(1).max(4).default(4),
    stopOnError: z.boolean().default(true),
    maxChars: z.number().int().min(4000).max(256000).default(96000),
    compact: z.boolean().default(true),
});
const READS = new Set([
    'read_file', 'read_multiple_files', 'list_directory', 'get_file_info', 'read_code_file',
    'read_code_ranges', 'read_symbol', 'code_outline', 'git_status', 'git_diff', 'git_log',
    'vscode_tasks', 'language_capabilities', 'docker_inventory', 'docker_inspect',
]);
const ALLOWED = new Set([...READS, 'start_search', 'read_code_context', 'edit_block', 'write_file',
    'edit_files', 'create_directory', 'project_context', 'project_map', 'find_symbols',
    'replace_symbol', 'edit_code_ranges', 'find_references', 'related_files', 'code_diagnostics',
    'discover_checks', 'test_impact', 'review_changes', 'code_graph', 'context_pack', 'session_handoff']);
export async function runBatch(raw: unknown, invoke: (tool: string, args: Record<string, unknown>) => Promise<ToolResult>): Promise<ToolResult> {
    const a = BatchSchema.parse(raw), parent = getCallContext();
    if ((parent?.depth ?? 0) > 0)
        throw new AgentError('NESTED_BATCH', 'Nested batches are not allowed.');
    if (Buffer.byteLength(JSON.stringify(a.calls)) > 8 * 1024 * 1024)
        throw new AgentError('BATCH_TOO_LARGE', 'Batch arguments exceed 8 MiB.');
    for (const c of a.calls) {
        if (!ALLOWED.has(c.tool))
            throw new AgentError('BATCH_TOOL_DENIED', `Tool ${c.tool} is not allowed in a coding batch.`);
        if (a.mode === 'parallel' && !READS.has(c.tool))
            throw new AgentError('PARALLEL_WRITE_DENIED', 'Parallel mode accepts independent reads only. Use auto for ordered write barriers.');
    }
    const started = performance.now(), results: Record<string, unknown>[] = [];
    let next = 0, failed = false, used = 0, outputLimited = false, waves = 0;
    const one = async (index: number) => {
        const c = a.calls[index];
        const args = c.tool === 'start_search' ? { ...c.arguments, wait: true } : c.arguments;
        try {
            checkCancelled();
            return await withCallContext({ ...parent, id: `${parent?.id ?? 'batch'}:${index}`, client: parent?.client ?? null, remote: parent?.remote ?? false, depth: 1 }, () => invoke(c.tool, args));
        }
        catch (error) {
            return failure(error, `${parent?.id ?? 'batch'}:${index}`);
        }
    };
    while (next < a.calls.length) {
        checkCancelled();
        if (used >= a.maxChars - 2000) {
            outputLimited = true;
            break;
        }
        const begin = next, indices = [next++];
        if (a.mode !== 'sequential' && READS.has(a.calls[begin].tool)) {
            while (indices.length < a.concurrency && next < a.calls.length && READS.has(a.calls[next].tool))
                indices.push(next++);
        }
        waves++;
        const wave = await Promise.all(indices.map(one));
        for (let j = 0; j < indices.length; j++) {
            const index = indices[j], r = wave[j];
            failed ||= !!r.isError;
            // Never hide an image's base64 inside text JSON. Image previews have a dedicated tool.
            const view = a.compact && r.structuredContent
                ? { isError: !!r.isError, structuredContent: r.structuredContent, _meta: r._meta }
                : { ...r, content: r.content.map(b => b.type === 'image' ? { type: 'text', text: '[Image omitted from generic batch; use read_images for actual image content.]' } : b) };
            const text = JSON.stringify(view), room = Math.max(0, Math.min(24000, a.maxChars - used - 1200));
            const entry = { index, tool: a.calls[index].tool, isError: !!r.isError,
                ...(text.length > room ? { truncated: true, preview: text.slice(0, room), callId: r._meta?.callId } : { result: view }) };
            used += JSON.stringify(entry).length;
            results.push(entry);
        }
        if (failed && a.stopOnError)
            break;
    }
    return result({ results, skipped: a.calls.length - next, executed: next, outputLimited,
        mode: a.mode, concurrency: a.mode === 'sequential' ? 1 : a.concurrency, waves,
        durationMs: Math.round(performance.now() - started), transactional: false,
        note: 'Independent consecutive reads may overlap. Writes and stateful tools are ordered barriers. In-flight reads finish after an error; later writes are skipped with stopOnError. Earlier writes are not rolled back. Use workspace_batch for coordinated file changes.' }, failed);
}
