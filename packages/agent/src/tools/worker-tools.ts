/** Three optional coordination tools. Native model workers belong to the MCP host, never this agent. */
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolDefinition } from '../core/tool-definitions.js';
import type { ServerResult } from '../core/types.js';
import { WorkspaceChangeSchema } from './workspace-batch.js';
import { workerCoordinator, WORKER_LIMITS } from '../runtime/worker-coordination.js';
import { AgentError, result } from '../runtime/errors.js';

const Id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/);
const Key = z.string().min(20).max(128);
const Task = z.object({ id: Id, goal: z.string().min(1).max(2000), scope: z.array(z.string().min(1).max(500)).min(1).max(16),
    dependsOn: z.array(Id).max(31).default([]), readOnly: z.boolean().default(false) }).strict();
export const WorkerTasksSchema = z.object({
    action: z.enum(['create', 'status', 'claim', 'renew', 'release', 'reset', 'cancel']),
    path: z.string().min(1).max(2000).optional(), goal: z.string().min(1).max(2000).optional(), tasks: z.array(Task).min(1).max(32).optional(),
    hostMode: z.enum(['native_workers', 'parallel_tools', 'single']).default('single'),
    maxWorkers: z.number().int().min(1).max(10).default(3),
    planId: z.string().uuid().optional(), taskId: Id.optional(), workerId: z.string().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/).optional(),
    coordinatorKey: Key.optional(), claimKey: Key.optional(), leaseSeconds: z.number().int().min(30).max(900).default(900),
    reads: z.array(z.object({ path: z.string().min(1).max(500), offset: z.number().int().min(0).default(0), length: z.number().int().min(1).max(400).default(120) }).strict()).max(16).optional(),
}).strict();
export const WorkerPatchSchema = z.object({ planId: z.string().uuid(), taskId: Id, claimKey: Key, submissionId: Id,
    summary: z.string().min(1).max(4000), changes: z.array(WorkspaceChangeSchema).max(16).default([]) }).strict();
export const WorkerIntegrateSchema = z.object({ action: z.enum(['preview', 'apply', 'verify', 'finish']).default('preview'),
    planId: z.string().uuid(), coordinatorKey: Key, taskIds: z.array(Id).min(1).max(32).optional(),
    review_sha256: z.string().regex(/^[a-f0-9]{64}$/).optional() }).strict();

export const WORKER_TOOL_HANDLERS: Record<string, (raw: Record<string, unknown>) => Promise<ServerResult>> = {
    worker_tasks: async (raw) => {
        const a = WorkerTasksSchema.parse(raw);
        if (a.action === 'create') {
            if (!a.path || !a.goal || !a.tasks) throw new AgentError('INVALID_ARGUMENT', 'create requires path, goal and tasks.');
            if (Buffer.byteLength(JSON.stringify(a)) > 512 * 1024) throw new AgentError('PLAN_TOO_LARGE', 'Plan metadata exceeds 512 KiB. Use fewer/smaller tasks.');
            return result(await workerCoordinator.create({ ...a, path: a.path, goal: a.goal, tasks: a.tasks })) as ServerResult;
        }
        if (!a.planId) throw new AgentError('INVALID_ARGUMENT', 'planId is required.');
        return result(await workerCoordinator.manage({ ...a, planId: a.planId })) as ServerResult;
    },
    worker_patch: async (raw) => result(await workerCoordinator.submit(WorkerPatchSchema.parse(raw))) as ServerResult,
    worker_integrate: async (raw) => (await workerCoordinator.integrate(WorkerIntegrateSchema.parse(raw))) as ServerResult,
};

export function buildWorkerToolDefinitions(): ToolDefinition[] {
    const defs: { name: string; schema: z.ZodTypeAny; description: string }[] = [
        { name: 'worker_tasks', schema: WorkerTasksSchema,
            description: 'Optional host-native parallel coding coordination. create(path,goal,tasks with owned scope/dependsOn), status, claim(workerId, optional reads), renew/release, coordinator reset/cancel. If the host truly supports spawning workers with these MCP tools, delegate ready independent tasks (prefer 2-4; max 10). Otherwise do the work yourself; this agent never spawns models or calls APIs. hostMode is caller-declared, not detected. Claims have a 15-minute lease (max); renew before expiry, reclaim and re-read hashes if expired. For scopes covering not-yet-created directories use a trailing slash (e.g. src/new-feature/). Dependencies wait for integration. Keep coordinatorKey with the parent. While a plan is live, write_file/edit_block/workspace_batch writes to paths owned by unapplied tasks are refused. RAM-only bounded state that expires and is cleared on agent shutdown; not an OS sandbox. Skip this for small single-worker edits.' },
        { name: 'worker_patch', schema: WorkerPatchSchema,
            description: 'A claimed worker submits a proposed UTF-8 patch using planId/taskId/claimKey/submissionId, summary and up to 16 changes (same shape as workspace_batch changes). Exact SHA-256 required; null means create-only. Validates owned canonical paths and current hashes but writes NO project files. Read-only tasks submit a summary and no changes. Same submissionId+payload replay is idempotent; expired/replaced claims cannot submit. 2 MiB per patch; staged patches stay in RAM.' },
        { name: 'worker_integrate', schema: WorkerIntegrateSchema,
            description: 'Parent-only, needs coordinatorKey. preview validates selected submitted tasks (dry run) and returns review_sha256; apply requires that digest and commits through workspace_batch (hash-checked, per-file atomic, best-effort rollback). Wait for active claims; dependents become ready after apply. verify runs an optional host verification hook if this agent has one (otherwise VERIFIER_UNAVAILABLE: run tests yourself); finish closes the plan after all tasks are applied (and verified, if a hook is installed). Worker summaries never prove success. No automatic merge, commit, model call or deployment.' },
    ];
    return defs.map(d => ({ name: d.name, description: d.description, inputSchema: zodToJsonSchema(d.schema) as ToolDefinition['inputSchema'],
        annotations: { title: d.name, readOnlyHint: false, destructiveHint: d.name === 'worker_integrate', openWorldHint: false } }));
}
export { WORKER_LIMITS };
