/** Developer extras: session handoff, syntax diagnostics, change review, test impact, VS Code tasks (read-only), coding sessions, Docker observation. */
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolResult } from 'brc-shared';
import type { ToolDefinition } from '../core/tool-definitions.js';
import type { ServerResult } from '../core/types.js';
import { rootPath, projectPath, jsoncFile, slash } from '../runtime/workspace.js';
import { parseCode } from '../runtime/code-structure.js';
import { discoverChecks } from '../runtime/harness.js';
import { codingSession, sessionHandoff } from '../runtime/coding-session.js';
import { DockerTarget, dockerQuery, inspectDocker } from '../runtime/docker-client.js';
import { result } from '../runtime/errors.js';
import { checkCancelled } from '../context.js';
import { handleGitStatus, handleGitDiff } from './brc-tools.js';

const PathSchema = z.object({ path: z.string().min(1) });
const CheckId = z.string().regex(/^[A-Za-z0-9_.:-]+$/);
const DiagnosticsSchema = z.object({ paths: z.array(z.string().min(1)).min(1).max(20) });
const ImpactSchema = PathSchema.extend({ files: z.array(z.string().min(1)).min(1).max(50) });
const SessionSchema = z.object({
    action: z.enum(['start', 'status', 'verify', 'finish', 'abandon']), path: z.string().optional(), sessionId: z.string().optional(),
    goal: z.string().min(1).max(2000).optional(), scope: z.array(z.string().min(1).max(500)).min(1).max(20).optional(), requiredChecks: z.array(CheckId).min(1).max(5).optional(),
});
const HandoffSchema = z.object({ sessionId: z.string().min(1), maxChanges: z.number().int().min(1).max(100).default(30) });
export const DockerInventorySchema = z.object({ path: z.string().min(1), includeStopped: z.boolean().default(true), includeImages: z.boolean().default(true), limit: z.number().int().min(1).max(200).default(80) });
export const DockerInspectSchema = z.object({ path: z.string().min(1), kind: z.enum(['container', 'image']), targets: z.array(DockerTarget).min(1).max(12) });

const clip = (v: unknown, n: number) => typeof v === 'string' ? v.slice(0, n) : v;
const text = (r: ServerResult) => (r.content ?? []).map(c => (c as { text?: string }).text ?? '').join('\n').slice(0, 60000);

export async function codeDiagnostics(raw: unknown) {
    const a = DiagnosticsSchema.parse(raw), files = [];
    for (const f of a.paths) {
        checkCancelled();
        const p = await parseCode(f);
        // Only a verified syntax tree counts as checked; generic line scans never produce a passing result.
        files.push({ path: p.path, sha256: p.sha256, language: p.language, provider: p.provider, checked: p.syntaxSupported && p.syntaxVerified, diagnostics: p.diagnostics.slice(0, 50), diagnosticCount: p.diagnostics.length, truncated: p.truncated });
    }
    const complete = files.every(f => f.checked && !f.truncated), errors = files.some(f => f.diagnosticCount > 0);
    return result({ files, passed: complete && !errors, complete, level: 'syntax-only', note: 'Unsupported languages return checked=false, never a passing syntax check. Not compiler/typecheck/editor diagnostics and not unsaved-editor state; run the discovered project checks.' }, errors);
}
export async function reviewChanges(raw: unknown) {
    const a = PathSchema.parse(raw), root = await rootPath(a.path);
    const status = await handleGitStatus({ path: root }), diff = await handleGitDiff({ path: root, stat: true });
    const failed = !!status.isError || !!diff.isError;
    return result({ root, status: text(status), diffStat: text(diff), note: 'Read-only working-tree review (staged/unstaged/untracked + unstaged diffstat). No staging, reset, checkout or commit is performed.' }, failed);
}
const stemOf = (f: string) => path.basename(f).replace(/\.[^.]+$/, '').replace(/[._-](?:test|spec)$/i, '').replace(/^(?:test|spec)[._-]/i, '').toLowerCase();
export async function testImpact(raw: unknown) {
    const a = ImpactSchema.parse(raw), root = await rootPath(a.path), checks = await discoverChecks(root), recommendations = [];
    for (const f of a.files) {
        const file = await projectPath(root, f), stem = stemOf(file);
        const exact: string[] = [], related: string[] = [];
        for (const t of checks.testFiles) {
            const ts = stemOf(t);
            if (ts === stem) exact.push(t);
            else if (stem.length >= 4 && ts.includes(stem)) related.push(t);
        }
        recommendations.push({ file: slash(path.relative(root, file)), candidateTests: [...exact, ...related].slice(0, 20), exactNameMatches: exact.length });
    }
    return result({ recommendations, projectChecks: checks.defaultChecks, testFilesTruncated: checks.truncated, heuristic: true, note: 'Filename-based candidates, not a proven coverage graph. No match does not mean no tests are needed; run the agreed project checks.' });
}
const arg = (v: unknown) => typeof v === 'string' ? v.slice(0, 500) : v && typeof v === 'object' && typeof (v as any).value === 'string' ? (v as any).value.slice(0, 500) : null;
const small = (v: unknown, max = 500) => { if (v === undefined) return null; const s = JSON.stringify(v) ?? ''; return s.length <= max ? v : s.slice(0, max); };
export async function vscodeTasks(raw: unknown) {
    const a = PathSchema.parse(raw), root = await rootPath(a.path);
    let value: any = null, found = true;
    try { value = (await jsoncFile(await projectPath(root, '.vscode/tasks.json'))).value; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; found = false; }
    const all: any[] = value && typeof value === 'object' && Array.isArray(value.tasks) ? value.tasks : [];
    const tasks = all.slice(0, 50).filter(t => t && typeof t === 'object').map(t => ({
        label: String(t.label ?? t.taskName ?? '').slice(0, 200), type: String(t.type ?? '').slice(0, 40),
        command: typeof t.command === 'string' ? t.command.slice(0, 1500) : null,
        args: Array.isArray(t.args) ? t.args.map(arg).filter((s: unknown) => s !== null).slice(0, 30) : [],
        cwd: clip(t.options?.cwd, 500) ?? null, group: small(t.group), dependsOn: small(t.dependsOn), isBackground: t.isBackground === true, problemMatcher: small(t.problemMatcher),
    }));
    return result({ root, found, tasks, total: all.length, truncated: all.length > 50, execution: false, note: 'Saved .vscode/tasks.json definitions only (JSONC). env/inputs and platform overrides are omitted, variables are not expanded and tasks are never executed.' });
}
export async function dockerInventory(raw: unknown, query: typeof dockerQuery = dockerQuery) {
    const a = DockerInventorySchema.parse(raw), cwd = await rootPath(a.path);
    const [c, i] = await Promise.all([
        query(['container', 'ls', ...(a.includeStopped ? ['--all'] : []), '--no-trunc', '--format', '{{json .}}'], cwd),
        a.includeImages ? query(['image', 'ls', '--no-trunc', '--digests', '--format', '{{json .}}'], cwd) : Promise.resolve(null),
    ]);
    const cs = c.rows.map(r => ({ id: r.ID, names: clip(r.Names, 300), image: clip(r.Image, 300), state: r.State, status: clip(r.Status, 300), ports: clip(r.Ports, 1500) }));
    const ims = (i?.rows ?? []).map(r => ({ id: r.ID, repository: clip(r.Repository, 300), tag: clip(r.Tag, 300), digest: r.Digest, size: r.Size, created: r.CreatedAt }));
    const available = c.ok && (i?.ok ?? true);
    return result({
        observedAt: new Date().toISOString(), available,
        complete: available && cs.length <= a.limit && ims.length <= a.limit,
        containers: c.ok ? cs.slice(0, a.limit) : null, images: i === null ? null : i.ok ? ims.slice(0, a.limit) : null,
        errors: [c.error, i?.error].filter(Boolean),
        counts: { containers: c.ok ? cs.length : null, images: i?.ok ? ims.length : null },
        note: 'null means unavailable or not requested, never empty. If available=false Docker could not be queried, so do not infer that an image/container is absent. No builds, pulls or changes were performed.',
    }, !available);
}
export async function dockerInspect(raw: unknown, query: typeof dockerQuery = dockerQuery) {
    const a = DockerInspectSchema.parse(raw), cwd = await rootPath(a.path);
    return result({ observedAt: new Date().toISOString(), kind: a.kind, items: await inspectDocker(a.kind, a.targets, cwd, query), environmentValuesOmitted: true });
}

const wrap = (fn: (raw: unknown) => Promise<ToolResult>) => async (raw: Record<string, unknown>) => (await fn(raw)) as unknown as ServerResult;
export const DEV_EXTRA_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
    code_diagnostics: wrap(codeDiagnostics),
    review_changes: wrap(reviewChanges),
    test_impact: wrap(testImpact),
    vscode_tasks: wrap(vscodeTasks),
    docker_inventory: wrap(r => dockerInventory(r)),
    docker_inspect: wrap(r => dockerInspect(r)),
    coding_session: wrap(async raw => {
        const a = SessionSchema.parse(raw), r = await codingSession(a);
        return result(r as unknown as Record<string, unknown>, a.action === 'verify' && (r as { passed?: boolean }).passed === false);
    }),
    session_handoff: wrap(async raw => { const a = HandoffSchema.parse(raw); return result(await sessionHandoff(a.sessionId, a.maxChanges) as unknown as Record<string, unknown>); }),
};

export function buildDevExtraToolDefinitions(): ToolDefinition[] {
    const defs: [string, z.ZodTypeAny, boolean, string][] = [
        ['code_diagnostics', DiagnosticsSchema, true, 'Syntax diagnostics for up to 20 saved files with registered grammars. Unsupported languages return checked=false, never a passing syntax check. Not compiler/typecheck/editor diagnostics.'],
        ['review_changes', PathSchema, true, 'Review git status and unstaged diff statistics of a project without staging or committing. Use before finishing, then verify with run_project_checks.'],
        ['test_impact', ImpactSchema, true, 'Suggest filename-related test candidates for changed files plus default project checks. Explicit heuristic, not proven coverage.'],
        ['vscode_tasks', PathSchema, true, 'Inspect saved .vscode/tasks.json (JSONC supported). Read-only: env values are omitted, variables are not expanded and tasks are never executed.'],
        ['coding_session', SessionSchema, false, 'Bounded RAM-only session: start(goal,scope,requiredChecks), status, verify (runs the required checks for real), finish, abandon. Finish needs passing checks on unchanged current source and no out-of-scope edits. Max 8 sessions, idle expiry 2h; no auto-commit, progress file or logs.'],
        ['session_handoff', HandoffSchema, true, 'Compact current coding_session handoff: goal, scope, changed files, required checks and whether verification is fresh. RAM-only, computed now, not saved; lost on agent restart.'],
        ['docker_inventory', DockerInventorySchema, true, 'Observe existing Docker containers/images (stopped included by default) before proposing a build/pull/container. A failed daemon query reports available=false with null lists, never an empty inventory. Read-only.'],
        ['docker_inspect', DockerInspectSchema, true, 'Inspect up to 12 existing container/image IDs or tags: actual image IDs, state, health, ports, mounts. Omits environment values and startup commands; no logs, builds, pulls, exec or restart.'],
    ];
    return defs.map(([name, schema, readOnly, description]) => ({
        name, description, inputSchema: zodToJsonSchema(schema) as ToolDefinition['inputSchema'],
        annotations: { title: name, readOnlyHint: readOnly, ...(readOnly ? {} : { destructiveHint: true }), openWorldHint: false },
    }));
}
