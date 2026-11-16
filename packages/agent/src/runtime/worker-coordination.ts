/** Cooperative task ownership and staged patches. No model execution, database, or background workers. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { ToolResult } from 'brc-shared';
import type { z } from 'zod';
import type { WorkspaceChangeSchema } from '../tools/workspace-batch.js';
import { rootPath, projectPath, slash, sensitive, inside, IGNORED_DIRS } from './workspace.js';
import { lockKey, sha256, readBounded } from './file-safety.js';
import { AgentError, result, failure } from './errors.js';
import { checkCancelled } from '../context.js';
import { sourceCandidate } from './languages.js';
export const WORKER_LIMITS = Object.freeze({ plans: 4, tasks: 32, maxWorkers: 10, defaultWorkers: 3, receipts: 64, appliedPaths: 512,
    patchBytes: 2 * 1024 * 1024, planPatchBytes: 8 * 1024 * 1024, totalPatchBytes: 16 * 1024 * 1024,
    idleMs: 2 * 3600000, terminalMs: 5 * 60000, leaseMs: 15 * 60000 });
export type WorkerMode = 'native_workers' | 'parallel_tools' | 'single';
type Change = z.infer<typeof WorkspaceChangeSchema>;
type TaskState = 'queued' | 'claimed' | 'submitted' | 'applied';
type PlanState = 'active' | 'needs_review' | 'finished' | 'cancelled';
interface Scope {
    relative: string;
    canonical: string;
    key: string;
    directory: boolean;
}
export interface TaskInput {
    id: string;
    goal: string;
    scope: string[];
    dependsOn?: string[];
    readOnly?: boolean;
}
export interface PlanInput {
    path: string;
    goal: string;
    tasks: TaskInput[];
    hostMode?: WorkerMode;
    maxWorkers?: number;
    requiredChecks?: string[];
}
interface Submission {
    id: string;
    digest: string;
    summary: string;
    changes: Change[];
    bytes: number;
}
interface Task {
    id: string;
    goal: string;
    scope: Scope[];
    dependsOn: string[];
    readOnly: boolean;
    state: TaskState;
    worker?: string;
    claimHash?: string;
    expiresAt?: number;
    generation: number;
    submitting: boolean;
    submission?: Submission;
    note?: string;
}
interface Verification {
    passed: boolean;
    fingerprint?: string;
    at: number;
    checks: string[];
    steps: unknown[];
}
interface Plan {
    id: string;
    root: string;
    goal: string;
    mode: WorkerMode;
    maxWorkers: number;
    coordinatorHash: string;
    tasks: Map<string, Task>;
    state: PlanState;
    touchedAt: number;
    createdAt: number;
    busy: boolean;
    requiredChecks: string[];
    baseline: Map<string, string>;
    appliedHashes: Map<string, string>;
    receipts: Map<string, Record<string, unknown>>;
    receiptBytes: number;
    verification?: Verification;
    revision: number;
}
const canonicalCase = (s: string) => process.platform === 'win32' ? s.toLowerCase() : s;
const fileId = (s: string) => canonicalCase(slash(s));
const secret = () => randomBytes(24).toString('base64url');
function authorize(provided: string, expected: string | undefined): void {
    if (!expected || !provided || !timingSafeEqual(Buffer.from(sha256(provided)), Buffer.from(expected)))
        throw new AgentError('WORKER_ACCESS_DENIED', 'Invalid coordinator or claim key. Keys are not recovered from labels or status.');
}
function safeRelative(raw: string): string {
    const name = slash(raw);
    if (!name || path.isAbsolute(raw) || path.posix.isAbsolute(name) || path.win32.isAbsolute(raw) || /[\x00-\x1f\x7f:*?<>|]/.test(name)
        || name.split('/').some(p => p === '..') || name.length > 500)
        throw new AgentError('INVALID_SCOPE', 'Use literal project-relative file/directory paths, not wildcards, drive paths or parent traversal.');
    const normal = path.posix.normalize(name).replace(/\/$/, '') || '.';
    if (normal.split('/').some(p => IGNORED_DIRS.includes(p.toLowerCase()) || sensitive(p)))
        throw new AgentError('INVALID_SCOPE', 'Generated, dependency, secret and Git directories are not worker scopes.');
    return normal;
}
function overlaps(a: Scope, b: Scope): boolean {
    return a.key === b.key || (a.directory && b.key.startsWith(a.key + path.sep)) || (b.directory && a.key.startsWith(b.key + path.sep));
}
function owns(task: Task, canonical: string): boolean {
    const key = canonicalCase(path.normalize(canonical));
    return task.scope.some(s => key === s.key || (s.directory && key.startsWith(s.key + path.sep)));
}
function normalizedHashes(hashes: Map<string, string>) { return new Map([...hashes].map(([name, hash]) => [fileId(name), hash])); }
const delegatedInstructions = [
    'Use host-native subagents only if this host can actually spawn them AND expose these BRC tools to them. Do not invent a worker or call another model/API.',
    'Prefer 2-4 workers for independent tasks. Send planId, taskId, project root and scope; keep coordinatorKey with the parent only.',
    'Claim a task before work. Read shared source with batch_tools/context_pack; return proposed changes through worker_patch, not direct writes or host shell commands.',
    'Use fresh SHA-256 values, respect dependencies and renew the claim before expiry. A dependent task becomes ready only after its prerequisite is applied.',
    'The parent previews/integrates submitted patches and runs the real combined checks. No worker-written success claim substitutes for verification.',
    'Without native workers, process tasks with the same AI and existing batches. Parallel tool calls are not extra reasoning agents.',
];
export class WorkerCoordinator {
    private plans = new Map<string, Plan>();
    private creating = new Set<string>();
    constructor(private readonly now: () => number = Date.now) { }
    private expireClaims(p: Plan) {
        for (const t of p.tasks.values())
            if (t.state === 'claimed' && !t.submitting && (t.expiresAt ?? 0) <= this.now()) {
                t.state = 'queued';
                t.worker = undefined;
                t.claimHash = undefined;
                t.expiresAt = undefined;
                t.generation++;
                t.note = 'Previous claim expired; old keys cannot submit.';
                p.revision++;
            }
    }
    prune(now = this.now()): number {
        let removed = 0;
        for (const [id, p] of this.plans) {
            this.expireClaims(p);
            if (p.busy || [...p.tasks.values()].some(t => t.submitting))
                continue;
            const terminal = p.state === 'finished' || p.state === 'cancelled';
            if (now - p.touchedAt > (terminal ? WORKER_LIMITS.terminalMs : WORKER_LIMITS.idleMs)) {
                this.plans.delete(id);
                removed++;
            }
        }
        return removed;
    }
    stats() {
        let tasks = 0, patches = 0, patchBytes = 0, metadataBytes = 0, receipts = 0;
        for (const p of this.plans.values()) {
            tasks += p.tasks.size;
            receipts += p.receipts.size;
            metadataBytes += p.receiptBytes * 2;
            metadataBytes += p.baseline.size * 280 + p.appliedHashes.size * 280 + p.tasks.size * 8000 + 16000;
            for (const t of p.tasks.values())
                if (t.submission) {
                    patchBytes += t.submission.bytes;
                    patches++;
                }
        }
        return { plans: this.plans.size, tasks, patches, receipts, patchBytes, estimatedRetainedBytes: patchBytes * 2 + metadataBytes,
            limits: WORKER_LIMITS, persistent: false, spawnedModels: 0, note: 'Payload budgets are not an OS-enforced RSS limit.' };
    }
    clear() { this.plans.clear(); this.creating.clear(); this.pendingBytes.clear(); }
    private async get(id: string): Promise<Plan> {
        this.prune();
        checkCancelled();
        const p = this.plans.get(id);
        if (!p)
            throw new AgentError('WORKER_PLAN_NOT_FOUND', 'Plan expired, was evicted, or the agent restarted. No files were deleted.');
        if (await rootPath(p.root) !== p.root)
            throw new AgentError('PROJECT_CHANGED', 'Project root moved; create a new plan.');
        if (this.plans.get(id) !== p)
            throw new AgentError('WORKER_PLAN_NOT_FOUND', 'Plan no longer exists.');
        this.expireClaims(p);
        p.touchedAt = this.now();
        return p;
    }
    private editable(p: Plan) {
        if (p.state !== 'active')
            throw new AgentError('WORKER_PLAN_CLOSED', `Plan is ${p.state}; inspect it before creating new work.`);
        if (p.busy)
            throw new AgentError('WORKER_PLAN_BUSY', 'Integration or verification is already running. Retry after it finishes.', true);
    }
    private task(p: Plan, id: string): Task {
        const t = p.tasks.get(id);
        if (!t)
            throw new AgentError('UNKNOWN_TASK', 'Unknown task ID.');
        return t;
    }
    private ready(p: Plan, t: Task) { return t.dependsOn.every(id => p.tasks.get(id)?.state === 'applied'); }
    private view(p: Plan) {
        const tasks = [...p.tasks.values()].map(t => ({ id: t.id, goal: t.goal, scope: t.scope.map(s => s.relative), readOnly: t.readOnly,
            dependsOn: t.dependsOn, ready: t.state === 'queued' && this.ready(p, t), state: t.state, worker: t.worker, expiresAt: t.expiresAt,
            generation: t.generation, submissionId: t.submission?.id, patchFiles: t.submission?.changes.length ?? 0,
            summary: t.submission?.summary, note: t.note }));
        return { planId: p.id, root: p.root, goal: p.goal, state: p.state, revision: p.revision, hostMode: p.mode,
            hostModeSource: 'caller-declared, not verified by MCP', maxWorkers: p.maxWorkers, tasks,
            readyTaskIds: tasks.filter(t => t.ready).map(t => t.id), requiredChecks: p.requiredChecks,
            verification: p.verification, verificationFreshness: 'Use worker_integrate finish to recheck current files; status alone does not validate fresh source.',
            persistent: false, spawnedModels: 0, busy: p.busy };
    }
    async create(a: PlanInput) {
        this.prune();
        const root = await rootPath(a.path), rootKey = canonicalCase(root);
        const occupied = [...this.plans.values()].filter(p => p.state === 'active' || p.state === 'needs_review').map(p => canonicalCase(p.root));
        if ([...occupied, ...this.creating].some(r => inside(r, rootKey) || inside(rootKey, r)))
            throw new AgentError('WORKER_ROOT_BUSY', 'An overlapping project already has a worker plan. Reuse its plan or cancel it first.');
        for (const [id, p] of this.plans)
            if (this.plans.size + this.creating.size >= WORKER_LIMITS.plans && (p.state === 'finished' || p.state === 'cancelled'))
                this.plans.delete(id);
        if (this.plans.size + this.creating.size >= WORKER_LIMITS.plans)
            throw new AgentError('WORKER_PLAN_LIMIT', 'At most four retained worker plans. Cancel an unused plan.');
        this.creating.add(rootKey);
        try {
            if (!a.tasks.length || a.tasks.length > WORKER_LIMITS.tasks)
                throw new AgentError('TASK_LIMIT', 'Use 1-32 tasks.');
            const tasks = new Map<string, Task>();
            for (const input of a.tasks) {
                if (tasks.has(input.id))
                    throw new AgentError('DUPLICATE_TASK', 'Task IDs must be unique.');
                const scope: Scope[] = [];
                for (const raw of input.scope) {
                    const relative = safeRelative(raw), canonical = await projectPath(root, relative);
                    const stat = await fs.stat(canonical).catch((e: NodeJS.ErrnoException) => { if (e.code === 'ENOENT')
                        return null; throw e; });
                    if (stat && !stat.isDirectory() && !stat.isFile())
                        throw new AgentError('INVALID_SCOPE', 'Scopes must be directories or regular files.');
                    const canonicalRelative = slash(path.relative(root, canonical));
                    safeRelative(canonicalRelative || '.');
                    // A planned directory must be explicitly marked with a trailing slash.
                    // Never infer that an extensionless NEW file grants directory-wide writes.
                    const plannedDirectory = !stat && /[\\/]$/.test(raw);
                    scope.push({ relative, canonical, key: await lockKey(canonical), directory: !!stat?.isDirectory() || plannedDirectory });
                }
                tasks.set(input.id, { id: input.id, goal: input.goal, scope, dependsOn: [...new Set(input.dependsOn ?? [])], readOnly: !!input.readOnly,
                    state: 'queued', generation: 0, submitting: false });
            }
            const ancestors = new Map<string, Set<string>>();
            const visit = (id: string, trail = new Set<string>()): Set<string> => {
                if (trail.has(id))
                    throw new AgentError('TASK_CYCLE', 'Task dependencies must not form a cycle.');
                const prior = ancestors.get(id);
                if (prior)
                    return prior;
                const task = tasks.get(id);
                if (!task)
                    throw new AgentError('UNKNOWN_DEPENDENCY', `Unknown dependency ${id}.`);
                const next = new Set(trail).add(id), all = new Set<string>();
                for (const dep of task.dependsOn) {
                    all.add(dep);
                    for (const parent of visit(dep, next))
                        all.add(parent);
                }
                ancestors.set(id, all);
                return all;
            };
            for (const id of tasks.keys())
                visit(id);
            const writers = [...tasks.values()].filter(t => !t.readOnly);
            for (let i = 0; i < writers.length; i++)
                for (const other of writers.slice(i + 1)) {
                    const first = writers[i];
                    if (first.scope.some(s => other.scope.some(v => overlaps(s, v))) && !ancestors.get(first.id)!.has(other.id) && !ancestors.get(other.id)!.has(first.id))
                        throw new AgentError('OVERLAPPING_SCOPE', `Tasks ${first.id} and ${other.id} share writable paths. Assign one owner or add a dependency.`);
                }
            const { discoverChecks, sourceFingerprint } = await import('./harness.js');
            const catalog = await discoverChecks(root), requiredChecks = [...new Set(a.requiredChecks ?? catalog.defaultChecks)].slice(0, 5);
            for (const name of requiredChecks)
                if (!catalog.candidates.some(c => c.name === name))
                    throw new AgentError('UNKNOWN_CHECK', `No discovered check named ${name}.`);
            const baseline = await sourceFingerprint(root);
            checkCancelled();
            const coordinatorKey = secret();
            const p: Plan = { id: randomUUID(), root, goal: a.goal, mode: a.hostMode ?? 'single', maxWorkers: Math.min(10, Math.max(1, a.maxWorkers ?? 3)),
                coordinatorHash: sha256(coordinatorKey), tasks, state: 'active', createdAt: this.now(), touchedAt: this.now(), busy: false,
                requiredChecks, baseline: normalizedHashes(baseline.hashes), appliedHashes: new Map(), receipts: new Map(), receiptBytes: 0, revision: 1 };
            this.plans.set(p.id, p);
            return { ...this.view(p), coordinatorKey, instructions: delegatedInstructions, coverage: baseline.coverage,
                next: p.mode === 'native_workers' ? 'Use this host\'s real spawn/delegate feature for ready tasks; give workers read tools plus worker_tasks/worker_patch, not direct writes or host shell. Keep coordinatorKey private to the parent.' : 'Use ordinary batches or process ready tasks with the same AI. This plan does not create reasoning agents.',
                security: 'Workflow coordination for authorized clients, not an OS sandbox. Raw terminal access retains its existing authority.' };
        }
        finally {
            this.creating.delete(rootKey);
        }
    }
    async manage(a: {
        action: string;
        planId: string;
        taskId?: string;
        workerId?: string;
        claimKey?: string;
        coordinatorKey?: string;
        leaseSeconds?: number;
        requiredChecks?: string[];
        reads?: {
            path: string;
            offset?: number;
            length?: number;
        }[];
    }) {
        const p = await this.get(a.planId);
        if (a.action === 'status')
            return this.view(p);
        if (a.action === 'cancel') {
            authorize(a.coordinatorKey ?? '', p.coordinatorHash);
            if (p.busy || [...p.tasks.values()].some(t => t.submitting))
                throw new AgentError('WORKER_PLAN_BUSY', 'Wait for in-flight submission/integration before cancelling.', true);
            p.state = 'cancelled';
            p.verification = undefined;
            p.baseline.clear();
            p.appliedHashes.clear();
            p.receipts.clear();
            p.receiptBytes = 0;
            for (const t of p.tasks.values()) {
                t.claimHash = undefined;
                t.submission = undefined;
                t.expiresAt = undefined;
            }
            p.revision++;
            return { ...this.view(p), note: 'Coordination cancelled; keys invalidated and staged patches discarded. Applied files are not reverted and host-native model sessions must be stopped by their host.' };
        }
        this.editable(p);
        if (a.action === 'set_checks') {
            authorize(a.coordinatorKey ?? '', p.coordinatorHash);
            if (!a.requiredChecks?.length)
                throw new AgentError('NO_CHECKS', 'Select actual discovered check IDs.');
            p.busy = true;
            try {
                const { runProjectChecks } = await import('./harness.js');
                await runProjectChecks(p.root, a.requiredChecks, false);
                checkCancelled();
                p.requiredChecks = [...new Set(a.requiredChecks)];
                p.verification = undefined;
                p.revision++;
                return this.view(p);
            }
            finally {
                p.busy = false;
            }
        }
        if (a.action === 'claim') {
            if (!a.workerId?.trim())
                throw new AgentError('WORKER_ID_REQUIRED', 'Provide a worker label (not an authentication identity).');
            const active = [...p.tasks.values()].filter(t => t.state === 'claimed');
            if (active.length >= p.maxWorkers)
                throw new AgentError('WORKER_CAPACITY', 'All worker slots are claimed. Submit, release, or wait for expiry; do not create a duplicate plan.', true);
            const t = a.taskId ? this.task(p, a.taskId) : [...p.tasks.values()].find(t => t.state === 'queued' && this.ready(p, t));
            if (!t)
                return { planId: p.id, task: null, reason: 'No ready task. Integrate prerequisite submissions or wait for existing workers.', spawnedModels: 0 };
            if (t.state !== 'queued')
                throw new AgentError('TASK_ALREADY_CLAIMED', 'Task is already claimed, submitted or applied.');
            if (!this.ready(p, t))
                throw new AgentError('TASK_BLOCKED', 'Dependencies must be integrated before this task can be claimed.');
            const claimKey = secret();
            t.claimHash = sha256(claimKey);
            t.generation++;
            t.worker = a.workerId;
            t.state = 'claimed';
            t.expiresAt = this.now() + Math.min(900, Math.max(30, a.leaseSeconds ?? 300)) * 1000;
            t.note = undefined;
            t.submitting = true;
            p.revision++;
            try {
                const reads = a.reads ?? [];
                for (const r of reads)
                    safeRelative(r.path);
                let snapshot: Record<string, unknown> | undefined;
                if (reads.length) {
                    const { workspaceBatch } = await import('../tools/workspace-batch.js');
                    snapshot = (await workspaceBatch({ path: p.root, reads, maxChars: 32000 })).structuredContent;
                }
                checkCancelled();
                return { planId: p.id, root: p.root, task: { id: t.id, goal: t.goal, scope: t.scope.map(s => s.relative), readOnly: t.readOnly, dependsOn: t.dependsOn },
                    workerId: t.worker, claimKey, expiresAt: t.expiresAt, generation: t.generation, snapshot,
                    instructions: 'Read/context tools may run in parallel. Do not edit shared source or run host-shell commands as a delegated worker. Submit a proposed patch with this claimKey; renew before expiresAt (default 15 minutes; max 60). If a claim expired, re-claim and re-read fresh hashes; never blindly resubmit. Parent integrates and verifies.',
                    persistent: false, spawnedModels: 0 };
            }
            catch (error) {
                t.state = 'queued';
                t.claimHash = undefined;
                t.worker = undefined;
                t.expiresAt = undefined;
                p.revision++;
                throw error;
            }
            finally {
                t.submitting = false;
            }
        }
        if (!a.taskId)
            throw new AgentError('TASK_ID_REQUIRED', 'taskId is required for this action.');
        const t = this.task(p, a.taskId);
        if (t.submitting)
            throw new AgentError('TASK_BUSY', 'Task submission/snapshot is still being processed.', true);
        if (a.action === 'reset') {
            authorize(a.coordinatorKey ?? '', p.coordinatorHash);
            const depends = (id: string): boolean => this.task(p, id).dependsOn.some(d => d === t.id || depends(d));
            if ([...p.tasks.values()].some(other => other.id !== t.id && other.state !== 'queued' && depends(other.id)))
                throw new AgentError('DEPENDENTS_ACTIVE', 'Reset downstream tasks first. Their work may depend on this task.');
        }
        else {
            authorize(a.claimKey ?? '', t.claimHash);
            if (t.state !== 'claimed' && t.state !== 'submitted')
                throw new AgentError('INVALID_TASK_STATE', 'Task has no live claim to renew/release.');
        }
        if (a.action === 'renew') {
            if (t.state !== 'claimed')
                throw new AgentError('INVALID_TASK_STATE', 'Submitted work no longer needs a lease.');
            t.expiresAt = this.now() + Math.min(900, Math.max(30, a.leaseSeconds ?? 300)) * 1000;
            return { planId: p.id, taskId: t.id, expiresAt: t.expiresAt };
        }
        if (!['release', 'reset'].includes(a.action))
            throw new AgentError('INVALID_ACTION', 'Unknown task action.');
        t.state = 'queued';
        t.claimHash = undefined;
        t.worker = undefined;
        t.expiresAt = undefined;
        t.submission = undefined;
        t.generation++;
        t.note = 'Claim released; previously applied files were not reverted.';
        p.verification = undefined;
        p.revision++;
        return this.view(p);
    }
    private pendingBytes = new Map<string, number>();
    private async checkScope(p: Plan, t: Task, changes: Change[]): Promise<Change[]> {
        for (const s of t.scope)
            if (await lockKey(await projectPath(p.root, s.relative)) !== s.key)
                throw new AgentError('SCOPE_CHANGED', 'A scoped path now resolves elsewhere. Review and recreate the plan.');
        const normalized: Change[] = [], keys = new Set<string>();
        for (const c of changes) {
            const relative = safeRelative(c.path), file = await projectPath(p.root, relative), key = await lockKey(file);
            if (!owns(t, file))
                throw new AgentError('TASK_SCOPE_VIOLATION', 'A proposed change is outside this task\'s owned paths.');
            safeRelative(slash(path.relative(p.root, file)));
            if (!sourceCandidate(file))
                throw new AgentError('BINARY_PATCH_DENIED', 'Worker patches support UTF-8 source, not binary files.');
            if (keys.has(key))
                throw new AgentError('DUPLICATE_TARGET', 'Only one change per canonical target.');
            keys.add(key);
            normalized.push({ ...c, path: slash(path.relative(p.root, file)), expected_sha256: c.expected_sha256?.toLowerCase() ?? null });
        }
        return normalized;
    }
    async submit(a: {
        planId: string;
        taskId: string;
        claimKey: string;
        submissionId: string;
        summary: string;
        changes: Change[];
    }) {
        const p = await this.get(a.planId);
        this.editable(p);
        const t = this.task(p, a.taskId);
        authorize(a.claimKey, t.claimHash);
        if (t.submitting)
            throw new AgentError('TASK_BUSY', 'Another submission for this task is being validated.', true);
        if (!['claimed', 'submitted'].includes(t.state))
            throw new AgentError('INVALID_TASK_STATE', 'Claim the task before submitting.');
        if (t.readOnly && a.changes.length)
            throw new AgentError('READ_ONLY_TASK', 'Read-only tasks can submit findings, not edits.');
        if (!t.readOnly && !a.changes.length)
            throw new AgentError('EMPTY_PATCH', 'Editing tasks must submit changes. Use readOnly tasks for findings.');
        const inputBytes = Buffer.byteLength(JSON.stringify(a.changes)) + Buffer.byteLength(a.summary);
        if (inputBytes > WORKER_LIMITS.patchBytes)
            throw new AgentError('PATCH_TOO_LARGE', 'A submission is limited to 2 MiB. Split the task.');
        t.submitting = true;
        let reserved = 0;
        try {
            const changes = await this.checkScope(p, t, a.changes);
            const digest = sha256(JSON.stringify({ changes, summary: a.summary }));
            if (t.state === 'submitted') {
                if (t.submission?.id === a.submissionId && t.submission.digest === digest)
                    return { planId: p.id, taskId: t.id, submitted: true, replay: true, submissionId: a.submissionId, digest, filesWritten: 0 };
                throw new AgentError('TASK_ALREADY_SUBMITTED', 'A different patch already exists. The coordinator must reset the task before revising it.');
            }
            const bytes = Buffer.byteLength(JSON.stringify(changes)) + Buffer.byteLength(a.summary);
            const planBytes = [...p.tasks.values()].reduce((n, task) => n + (task.submission?.bytes ?? 0), 0);
            const pendingTotal = [...this.pendingBytes.values()].reduce((n, x) => n + x, 0);
            if (planBytes + (this.pendingBytes.get(p.id) ?? 0) + bytes > WORKER_LIMITS.planPatchBytes || this.stats().patchBytes + pendingTotal + bytes > WORKER_LIMITS.totalPatchBytes)
                throw new AgentError('WORKER_MEMORY_LIMIT', 'Staged-patch budget reached. Integrate or discard older submitted work first.');
            this.pendingBytes.set(p.id, (this.pendingBytes.get(p.id) ?? 0) + bytes);
            reserved = bytes;
            if (changes.length) {
                const { workspaceBatch } = await import('../tools/workspace-batch.js');
                const validation = await workspaceBatch({ path: p.root, changes, dryRun: true });
                if (validation.isError)
                    throw new AgentError('PATCH_INVALID', 'Patch validation failed; re-read its input files.');
            }
            checkCancelled();
            if ((t.expiresAt ?? 0) <= this.now())
                throw new AgentError('CLAIM_EXPIRED', 'Claim expired during patch validation. Call worker_tasks status, reclaim the task, reread fresh hashes and submit once using its new claimKey. No files were written.');
            t.submission = { id: a.submissionId, digest, summary: a.summary, changes, bytes };
            t.state = 'submitted';
            t.expiresAt = undefined;
            p.revision++;
            p.touchedAt = this.now();
            return { planId: p.id, taskId: t.id, submitted: true, replay: false, submissionId: a.submissionId, digest,
                changedPaths: changes.map(c => c.path), filesWritten: 0, persistent: false,
                next: 'Parent: preview/apply ready submissions with worker_integrate. Submitted is not applied, tested or finished.' };
        }
        finally {
            if (reserved) {
                const left = (this.pendingBytes.get(p.id) ?? 0) - reserved;
                if (left > 0)
                    this.pendingBytes.set(p.id, left);
                else
                    this.pendingBytes.delete(p.id);
            }
            t.submitting = false;
        }
    }
    private async expectedTree(p: Plan) {
        const { sourceFingerprint } = await import('./harness.js');
        const snapshot = await sourceFingerprint(p.root), now = normalizedHashes(snapshot.hashes);
        const unexpected: string[] = [];
        for (const name of new Set([...p.baseline.keys(), ...now.keys()])) {
            if (p.baseline.get(name) !== now.get(name) && p.appliedHashes.get(name) !== now.get(name))
                unexpected.push(name);
            // Deletions are not supported by staged patches; an undefined expected value is not approval.
            if (p.baseline.has(name) && !now.has(name) && !unexpected.includes(name))
                unexpected.push(name);
        }
        for (const [name, expected] of p.appliedHashes) {
            let actual = now.get(name);
            if (!actual) {
                try {
                    actual = sha256(await readBounded(await projectPath(p.root, name), 4 * 1024 * 1024));
                }
                catch (e) {
                    if ((e as NodeJS.ErrnoException).code !== 'ENOENT')
                        throw e;
                }
            }
            if (actual !== expected && !unexpected.includes(name))
                unexpected.push(name);
        }
        if (unexpected.length)
            throw new AgentError('UNAPPROVED_CHANGES', `Files differ from accepted patches: ${unexpected.slice(0, 8).join(', ')}. Review external edits; they were not overwritten.`);
        return snapshot;
    }
    private async verify(p: Plan) {
        if ([...p.tasks.values()].some(t => t.state !== 'applied'))
            throw new AgentError('TASKS_INCOMPLETE', 'Apply all tasks before combined verification.');
        if (!p.requiredChecks.length)
            throw new AgentError('NO_VERIFICATION_DEFINED', 'Set actual discovered checks with worker_tasks set_checks before verification/finish.');
        await this.expectedTree(p);
        const { runProjectChecks } = await import('./harness.js');
        p.verification = undefined;
        const check = await runProjectChecks(p.root, p.requiredChecks, true);
        const after = await this.expectedTree(p);
        const data = check as unknown as Record<string, unknown>;
        const passed = data.passed === true && data.fingerprint === after.fingerprint;
        const steps = (Array.isArray(data.steps) ? data.steps : []).map(s => ({ name: String(s.name), passed: s.passed === true, exitCode: s.exitCode }));
        p.verification = { passed, fingerprint: after.fingerprint, at: this.now(), checks: [...p.requiredChecks], steps };
        return { ...data, passed, coverage: after.coverage };
    }
    async integrate(a: {
        action: 'preview' | 'apply' | 'verify' | 'finish';
        planId: string;
        coordinatorKey: string;
        taskIds?: string[];
        review_sha256?: string;
        runChecks?: boolean;
    }): Promise<ToolResult> {
        const p = await this.get(a.planId);
        authorize(a.coordinatorKey, p.coordinatorHash);
        if (a.action === 'apply' && a.review_sha256 && p.receipts.has(a.review_sha256))
            return result({ ...p.receipts.get(a.review_sha256), replay: true, note: 'This integration already committed; no file or command was executed again. Use verify/finish for current evidence.' });
        if (!(a.action === 'finish' && p.state === 'finished'))
            this.editable(p);
        if (p.busy)
            throw new AgentError('WORKER_PLAN_BUSY', 'Another integration is running.', true);
        if (a.action !== 'preview' && [...p.tasks.values()].some(t => t.state === 'claimed' || t.submitting))
            throw new AgentError('WORKERS_ACTIVE', 'Wait for or release active claims before modifying/verifying shared source.');
        p.busy = true;
        let committed = false, mutationStarted = false;
        try {
            if (a.action === 'finish') {
                if ([...p.tasks.values()].some(t => t.state !== 'applied'))
                    throw new AgentError('TASKS_INCOMPLETE', 'Some tasks are not applied.');
                if (!p.verification?.passed || !p.requiredChecks.every(c => p.verification!.checks.includes(c)))
                    throw new AgentError('VERIFICATION_REQUIRED', 'Run actual combined project checks; worker summaries cannot prove success.');
                const current = await this.expectedTree(p);
                if (p.verification.fingerprint !== current.fingerprint) {
                    p.verification = undefined;
                    throw new AgentError('VERIFICATION_STALE', 'Source changed after verification. Run checks again.');
                }
                p.state = 'finished';
                p.revision++;
                return result({ ...this.view(p), busy: false, verifiedCurrentSource: true, coverage: current.coverage,
                    note: 'Only selected checks and the covered source snapshot are verified. No automatic commit, deployment or guarantee of full correctness.' });
            }
            if (a.action === 'verify') {
                const checks = await this.verify(p);
                return result({ planId: p.id, checks, verification: p.verification, persistent: false }, !checks.passed);
            }
            const selected = (a.taskIds ?? [...p.tasks.values()].filter(t => t.state === 'submitted').map(t => t.id)).map(id => this.task(p, id));
            if (!selected.length)
                throw new AgentError('NO_SUBMISSIONS', 'No submitted tasks were selected.');
            if (new Set(selected.map(t => t.id)).size !== selected.length)
                throw new AgentError('DUPLICATE_TASK', 'Select each task once.');
            selected.sort((x, y) => x.id.localeCompare(y.id));
            if (selected.some(t => t.state !== 'submitted' || !t.submission))
                throw new AgentError('TASK_NOT_SUBMITTED', 'Every selected task must have a submitted patch/result.');
            const digest = sha256(JSON.stringify({ planId: p.id, tasks: selected.map(t => [t.id, t.generation, t.submission!.id, t.submission!.digest]), checks: p.requiredChecks }));
            if (a.action === 'apply' && (!a.review_sha256 || a.review_sha256 !== digest))
                throw new AgentError('STALE_REVIEW', 'Preview current submissions and use its review_sha256.');
            const changes: Change[] = [];
            for (const t of selected)
                changes.push(...await this.checkScope(p, t, t.submission!.changes));
            if (changes.length > 64)
                throw new AgentError('INTEGRATION_TOO_LARGE', 'Select fewer tasks; one integration accepts at most 64 file changes.');
            if (new Set(changes.map(c => fileId(c.path))).size !== changes.length)
                throw new AgentError('OVERLAPPING_PATCH', 'Selected patches target the same file. Integrate dependent changes in separate waves.');
            if (new Set([...p.appliedHashes.keys(), ...changes.map(c => fileId(c.path))]).size > WORKER_LIMITS.appliedPaths)
                throw new AgentError('APPLIED_PATH_LIMIT', 'One worker plan is limited to 512 changed paths. Finish or cancel it before creating another.');
            if (a.runChecks) {
                if ([...p.tasks.values()].some(t => t.state !== 'applied' && !selected.includes(t)))
                    throw new AgentError('TASKS_INCOMPLETE', 'Combined checks require the final integration wave.');
                if (!p.requiredChecks.length)
                    throw new AgentError('NO_VERIFICATION_DEFINED', 'Configure discovered project checks first.');
                const { runProjectChecks } = await import('./harness.js');
                await runProjectChecks(p.root, p.requiredChecks, false);
            }
            const { workspaceBatch } = await import('../tools/workspace-batch.js');
            if (a.action === 'preview') {
                const validation = changes.length ? await workspaceBatch({ path: p.root, changes, dryRun: true }) : result({ changes: [] });
                if (validation.isError)
                    return validation;
                let budget = 24000;
                const previews = selected.map(t => ({ taskId: t.id, summary: t.submission!.summary, changes: t.submission!.changes.map(c => {
                        const serialized = JSON.stringify(c), take = Math.min(budget, 3000, serialized.length);
                        budget -= take;
                        return { path: c.path, proposedChange: serialized.slice(0, take), truncated: take < serialized.length };
                    }) }));
                return result({ planId: p.id, review_sha256: digest, taskIds: selected.map(t => t.id), dryRun: true, validation: validation.structuredContent,
                    previews, previewsTruncated: budget <= 0, writesPerformed: 0, note: 'Review these proposals. apply revalidates every hash and commits this exact selected set; no automatic merge or execution.' });
            }
            checkCancelled();
            mutationStarted = true;
            const outcome = changes.length ? await workspaceBatch({ path: p.root, changes, dryRun: false, writeConcurrency: 4 }) : result({ changes: [] });
            if (outcome.isError) {
                if (outcome.structuredContent?.requiresReview)
                    p.state = 'needs_review';
                return { ...outcome, structuredContent: { ...outcome.structuredContent, planId: p.id, committed: false, planState: p.state } };
            }
            committed = true;
            const written = (outcome.structuredContent?.changes ?? []) as {
                path: string;
                afterSha256: string;
                beforeSha256: string | null;
                changed: boolean;
            }[];
            for (const entry of written)
                p.appliedHashes.set(fileId(path.relative(p.root, entry.path)), entry.afterSha256);
            for (const t of selected) {
                t.state = 'applied';
                t.claimHash = undefined;
                t.worker = undefined;
                if (t.submission) {
                    t.submission.changes = [];
                    t.submission.bytes = 0;
                }
            }
            p.verification = undefined;
            p.revision++;
            const receipt: Record<string, unknown> = { planId: p.id, review_sha256: digest, appliedTaskIds: selected.map(t => t.id), committed: true,
                changes: written, replay: false, persistent: false, note: 'Patches applied. A failing check does not undo code; never blindly resubmit an already committed integration.' };
            p.receipts.set(digest, receipt);
            p.receiptBytes += Buffer.byteLength(JSON.stringify(receipt));
            while (p.receipts.size > WORKER_LIMITS.receipts) {
                const first = p.receipts.entries().next().value!;
                p.receiptBytes -= Buffer.byteLength(JSON.stringify(first[1]));
                p.receipts.delete(first[0]);
            }
            if (a.runChecks) {
                const checks = await this.verify(p);
                return result({ ...receipt, checks, verification: p.verification }, !checks.passed);
            }
            return result(receipt);
        }
        catch (error) {
            if (mutationStarted && !committed && !(error instanceof AgentError && ['FILE_CONFLICT', 'EDIT_MISMATCH', 'FILE_TOO_LARGE', 'BATCH_TOO_LARGE', 'DUPLICATE_TARGET', 'UNSAFE_TARGET', 'OUTSIDE_PROJECT'].includes(error.code)))
                p.state = 'needs_review';
            const out = failure(error);
            out.structuredContent = { ...out.structuredContent, planId: p.id, committed, planState: p.state,
                note: committed ? 'Code was already applied. Inspect status and rerun verification; do not replay mutations.' : 'Inspect current state before retrying. No automatic replay or merge.' };
            return out;
        }
        finally {
            p.busy = false;
            p.touchedAt = this.now();
        }
    }
    /** Narrow defense against accidental use of ordinary file mutation tools during a plan.
     * This is not a sandbox: generic shells/external editors retain their own authority. */
    async guardFileMutation(tool: string, args: Record<string, unknown>) {
        const live = [...this.plans.values()].filter(p => p.state === 'active' || p.state === 'needs_review');
        if (!live.length)
            return;
        let targets: string[] = [];
        const strings = (...values: unknown[]) => values.filter((v): v is string => typeof v === 'string' && !!v);
        if (['write_file', 'edit_block', 'create_directory', 'delete_file', 'move_file', 'write_pdf'].includes(tool))
            targets = strings(args.path, args.file_path, args.source, args.destination, args.outputPath);
        if (['replace_symbol', 'edit_code_ranges'].includes(tool) && args.dryRun === false)
            targets = strings(args.path);
        if (tool === 'edit_files' && args.dryRun !== true && Array.isArray(args.files))
            targets = args.files.flatMap(f => strings(f.path));
        if (tool === 'workspace_batch' && args.dryRun === false && Array.isArray(args.changes) && args.changes.length && typeof args.path === 'string')
            targets = args.changes.flatMap(c => typeof c.path === 'string' ? [path.resolve(args.path as string, c.path)] : []);
        if (tool === 'project_preferences' && args.action === 'set' && args.persist === true)
            targets = strings(args.path);
        for (const target of targets) {
            const key = await lockKey(path.resolve(target));
            if (live.some(p => inside(canonicalCase(p.root), key) || inside(key, canonicalCase(p.root))))
                throw new AgentError('COORDINATED_WRITE_REQUIRED', 'This project has a live worker plan. Submit a worker_patch and let its coordinator use worker_integrate, or cancel the plan first.');
        }
    }
}
export const workerCoordinator = new WorkerCoordinator();
