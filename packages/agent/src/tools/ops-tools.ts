/** Operations tools: batch_tools (one round trip), agent_status (live queue/health) and cancel_operation. */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from '../core/tool-definitions.js';
import type { ServerResult } from '../core/types.js';
import { BatchSchema, runBatch, BATCH_LIMITS, type BatchInvoker } from '../runtime/fast-batch.js';
import { operationStatus, cancelOperation, schedulerStats } from '../runtime/operations.js';
import { activity } from '../runtime/activity.js';
import { cacheStatus } from '../runtime/resource-limits.js';
import { failureLogEnabled, recentFailures, MAX_FAILURE_LOG_ENTRIES } from '../runtime/failure-log.js';
import { projectIndex } from '../runtime/project-index.js';
import { codeGraph } from '../runtime/code-graph.js';
import { getCallContext } from '../context.js';
import { AgentError, result } from '../runtime/errors.js';

/** Tools the transport answers outside the admission queue, so a saturated agent can still be inspected and cancelled. */
export const QUEUE_BYPASS_TOOLS: ReadonlySet<string> = new Set(['agent_status', 'cancel_operation', 'stop_search', 'force_terminate']);

const CancelSchema = z.object({ callId: z.string().min(1).max(100) }).strict();
const StatusSchema = z.object({}).strict();

// The dispatcher injects itself (same pattern as the jobs executor) to avoid an import cycle.
let invoker: BatchInvoker | null = null;
export function setBatchInvoker(fn: BatchInvoker): void { invoker = fn; }

export const OPS_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
    batch_tools: async (raw) => {
        if (!invoker) throw new AgentError('TOOL_FAILED', 'batch_tools is not initialised.');
        return (await runBatch(raw, invoker)) as unknown as ServerResult;
    },
    agent_status: async (raw) => {
        StatusSchema.parse(raw);
        const operations = operationStatus().slice(0, 100);
        return result({
            operations, queue: schedulerStats(), latency: activity.metrics().slice(0, 50),
            resources: cacheStatus(), indexedProjects: projectIndex.status(), codeGraphs: codeGraph.status(),
            diagnostics: { dropped: activity.dropped, ioErrors: activity.ioErrors },
            logging: { mode: failureLogEnabled() ? 'live-plus-opt-in-failure-metadata' : 'live-only', failureLogLimit: MAX_FAILURE_LOG_ENTRIES },
            recentFailures: await recentFailures(20),
            note: 'Metadata only: no tool arguments, file paths or contents. Use cancel_operation with an operation id from this list.',
        }) as unknown as ServerResult;
    },
    cancel_operation: async (raw) => {
        const a = CancelSchema.parse(raw);
        if (a.callId === getCallContext()?.id) throw new AgentError('INVALID_ARGUMENT', 'A cancellation call cannot cancel itself.');
        return result({ callId: a.callId, cancelRequested: cancelOperation(a.callId),
            note: 'Cancellation is cooperative: queued calls never start; running calls are answered CANCELLED immediately but work that ignores the signal may finish in the background. Completed edits are not undone. Interactive start_process sessions require force_terminate.' }) as unknown as ServerResult;
    },
};

export function buildOpsToolDefinitions(): ToolDefinition[] {
    const defs: { name: string; schema: z.ZodTypeAny; description: string; readOnly: boolean; destructive: boolean }[] = [
        { name: 'batch_tools', schema: BatchSchema, readOnly: false, destructive: true,
            description: `Run up to ${BATCH_LIMITS.calls} independent file/code tool calls in ONE round trip. Each call is {tool, arguments}. Allowed: reads (read_file, read_multiple_files, list_directory, get_file_info, read_code_file, read_symbol, code_outline, find_symbols, find_references, related_files, project_context, project_map, context_pack, code_graph, language_capabilities, discover_checks) and ordered writes (write_file, edit_block, create_directory, move_file, workspace_batch). In auto mode consecutive reads overlap (concurrency up to ${BATCH_LIMITS.concurrency}) and each write runs alone, in order; parallel mode is reads only. No nesting, no shell/process/config/job tools, no variables between calls. Each nested call is validated like a normal call. Output is bounded (maxChars) and long entries are truncated; earlier writes are NOT rolled back. For 2+ known files use read_multiple_files; for hash-checked multi-file edits use workspace_batch.` },
        { name: 'agent_status', schema: StatusSchema, readOnly: true, destructive: false,
            description: 'Live agent health: running and queued operation ids with tool names and elapsed time, queue depth, recent per-tool latency (mean/p95/max), memory/cache status, indexed projects and, if the opt-in failure log is enabled, recent failure metadata. Never includes tool arguments, file paths or contents. Answered immediately even when the agent is busy.' },
        { name: 'cancel_operation', schema: CancelSchema, readOnly: false, destructive: false,
            description: 'Cancel a queued or running call by its id (from agent_status or the callId of an earlier result). Queued calls never start; running calls are answered CANCELLED. Does not undo finished writes and does not end interactive start_process sessions (use force_terminate). Answered immediately even when the agent is busy.' },
    ];
    return defs.map(d => ({ name: d.name, description: d.description, inputSchema: zodToJsonSchema(d.schema) as ToolDefinition['inputSchema'],
        annotations: { title: d.name, readOnlyHint: d.readOnly, destructiveHint: d.destructive, openWorldHint: false } }));
}
