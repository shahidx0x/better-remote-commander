/** Explicit coding sessions and verification evidence. All task state is RAM-only. */
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { rootPath, projectPath, listProjectFiles, packageInfo, gatherContext, slash, sensitive } from './workspace.js';
import { readBounded, sha256 } from './file-safety.js';
import { AgentError } from './errors.js';
import { CODING_TOOL_HANDLERS } from '../tools/coding-tools.js';
import { checkCancelled } from '../context.js';
import { sourceCandidate } from './languages.js';
import { checkCatalog } from './toolchains.js';
import { loadTaskCheckpoints,saveTaskCheckpoint,deleteTaskCheckpoint,type TaskCheckpointEvent } from './task-checkpoints.js';
interface Verification {
    fingerprint: string;
    passed: boolean;
    checks: string[];
    steps: {
        name: string;
        passed: boolean;
        exitCode?: unknown;
    }[];
    at: number;
}
interface Session {
    id: string;
    root: string;
    goal: string;
    scope: string[];
    requiredChecks: string[];
    baseline: Map<string, string>;
    state: 'active' | 'verified' | 'finished';
    verification?: Verification;
    touchedAt: number;
    busy: boolean;
    restored?: boolean;
    persistent?: boolean;
    events?: {at:number;type:TaskCheckpointEvent}[];
}
const sessions = new Map<string, Session>();
let historyLoaded=false;
async function loadSavedSessions():Promise<void>{
    if(historyLoaded)return;
    historyLoaded=true;
    for(const c of await loadTaskCheckpoints()){
        if(sessions.size>=8)break;
        // Previous verification is not trusted after a restart. The source,
        // toolchain and project state must be revalidated on the current PC.
        sessions.set(c.id,{
            id:c.id,root:c.root,goal:c.goal,scope:c.scope,
            requiredChecks:c.requiredChecks,baseline:new Map(c.baseline),
            state:c.state==='finished'?'finished':'active',verification:undefined,
            touchedAt:Date.now(),busy:false,restored:true,persistent:true,
            events:[...c.events.slice(-31),{at:Date.now(),type:'resumed'}]
        });
    }
}
async function checkpointSession(s:Session,event?:TaskCheckpointEvent):Promise<boolean>{
    if(event)s.events=[...(s.events??[]).slice(-31),{at:Date.now(),type:event}];
    const ok=await saveTaskCheckpoint({
        version:1,id:s.id,root:s.root,goal:s.goal.slice(0,2048),scope:s.scope,
        requiredChecks:s.requiredChecks,baseline:[...s.baseline.entries()],
        state:s.state,touchedAt:Date.now(),events:s.events??[]
    });
    s.persistent=ok;
    return ok;
}
const SOURCE = /\.(?:[cm]?[jt]sx?|jsonc?|mdx?|ya?ml|toml|css|s[ac]ss|html|vue|svelte|py|rs|go|java|cs|c|cc|cpp|h|hpp|php|rb|sql|graphql|sh|ps1|cmd|bat|xml|ini|conf|lock)$/i;
export async function sourceFingerprint(root: string) {
    const listed = await listProjectFiles(root, 15000, {fresh:true});
    if (listed.truncated)
        throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Too many paths for reliable verification. Use a narrower project root.');
    const files = listed.files.filter(sourceCandidate);
    if (files.length > 2500)
        throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Verification is limited to 2500 source/config files. Narrow the root.');
    const hashes = new Map<string, string>();
    let bytes = 0;
    for (const name of files) {
        checkCancelled();
        const p = await projectPath(root, name);
        let data: Buffer;
        try { data = await readBounded(p, 8 * 1024 * 1024); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT')
                throw new AgentError('VERIFICATION_CHANGED', 'A source file disappeared during verification. Re-run checks after file changes finish.');
            throw e;
        }
        bytes += data.length;
        if (bytes > 32 * 1024 * 1024)
            throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Verification source snapshots exceed 32 MiB. Narrow the root.');
        hashes.set(name, sha256(data));
    }
    const h = createHash('sha256');
    for (const [f, s] of hashes)
        h.update(f + '\0' + s + '\n');
    return { fingerprint: h.digest('hex'), hashes, files: files.length, bytes, coverage: 'Non-ignored source/config/documentation files. Excludes secrets, binary assets and generated/dependency directories; not a full filesystem snapshot.' };
}
export async function discoverChecks(root: string) { return checkCatalog(root); }
function getSession(id: string) {
    const session = sessions.get(id);
    if (!session)
        throw new AgentError('SESSION_NOT_FOUND', 'Session expired or agent restarted. Start a new coding_session.');
    session.touchedAt = Date.now();
    return session;
}
function changes(s: Session, now: Map<string, string>) {
    const all = new Set([...s.baseline.keys(), ...now.keys()]);
    return [...all].filter(f => s.baseline.get(f) !== now.get(f)).map(file => ({ file, kind: !s.baseline.has(file) ? 'added' : !now.has(file) ? 'deleted' : 'modified', inScope: s.scope.some(p => p === '.' || file === p || file.startsWith(p + '/')) }));
}
export async function runProjectChecks(root: string, names: string[], execute: boolean, sessionId?: string) {
    root = await rootPath(root);
    if(sessionId)await loadSavedSessions();
    const session = sessionId ? getSession(sessionId) : undefined;
    if (session && session.root !== root)
        throw new AgentError('SESSION_ROOT_MISMATCH', 'Verification must use the same project root as the session.');
    if (session?.busy)
        throw new AgentError('SESSION_BUSY', 'This coding session already has a verification running.');
    const catalog = await checkCatalog(root);
    if (!names.length)
        throw new AgentError('NO_CHECKS', 'Select at least one actual project check.');
    const commands = names.map(name => { const recipe = catalog.candidates.find(r => r.name === name); if (!recipe)
        throw new AgentError('UNKNOWN_CHECK', `No discovered check named ${name}. Discover checks first.`); return { name, ...(recipe.program ? { program: recipe.program, args: recipe.args ?? [] } : { command: recipe.command }) }; });
    if (!execute)
        return { root, execute: false, commands, packageManager: catalog.packageManager, note: 'Preview only. No verification evidence has been created.' };
    if (session)
        session.busy = true;
    try {
        const before = await sourceFingerprint(root);
        const out = await CODING_TOOL_HANDLERS.verify_project({ cwd: root, commands, timeout_ms: 110000, stopOnFailure: true });
        const after = await sourceFingerprint(root);
        const data = out.structuredContent ?? {};
        const stable = before.fingerprint === after.fingerprint;
        // Keep failure evidence, but never return multiple unbounded build logs
        // through MCP (which can exhaust the host's message stream).
        const steps = (Array.isArray(data.steps) ? data.steps as Record<string, unknown>[] : []).map(s => {
            const chunks = Array.isArray(s.output) ? s.output as {type?:string;text?:string}[] : [];
            const full = chunks.filter(c => c?.type === 'text').map(c => String(c.text ?? '')).join('\n');
            return { name: String(s.name), passed: s.passed === true, exitCode: s.exitCode,
                output: full.slice(-8000), outputTruncated: full.length > 8000 };
        });
        const passed = !out.isError && data.passed === true && steps.length === names.length && steps.every(s => s.passed) && stable;
        if (session) {
            session.verification = { fingerprint: after.fingerprint, passed, checks: names, steps, at: Date.now() };
            session.state = passed ? 'verified' : 'active';
            await checkpointSession(session,passed?'verification_passed':'verification_failed');
        }
        const firstFailure = steps.find(s => !s.passed);
        const checkError = passed ? undefined : {
            code: stable ? 'CHECK_FAILED' : 'VERIFICATION_CHANGED',
            message: stable
                ? ('Project check ' + (firstFailure?.name ?? '(unknown)') + ' failed (exit code ' +
                    String(firstFailure?.exitCode ?? 'unknown') + '). Inspect steps[].output; this is a real check failure, not an agent transport failure.')
                : 'Project files changed during verification; rerun on a stable tree.'
        };
        return { ...data, steps, root, passed, ...(checkError ? { error: checkError } : {}),
            sourceStableDuringChecks: stable, fingerprint: after.fingerprint, coverage: after.coverage,
            sessionId, executed: true, note: stable ? 'Checks returned real exit codes. Passing only establishes the selected checks, not full correctness.' : 'Source changed while checks ran; verification cannot be accepted. Re-run on a stable tree.' };
    }
    finally {
        if (session)
            session.busy = false;
    }
}
export async function codingSession(a: {
    action: string;
    path?: string;
    sessionId?: string;
    goal?: string;
    scope?: string[];
    requiredChecks?: string[];
}) {
    // Restore only metadata and file hashes; no model transcript is saved.
    await loadSavedSessions();
    for (const [id, s] of sessions)
        if (!s.busy && Date.now() - s.touchedAt > 2 * 3600000)
            sessions.delete(id);
    if (a.action === 'start') {
        if (!a.path || !a.goal)
            throw new AgentError('INVALID_ARGUMENT', 'Starting a session requires path and goal.');
        if (sessions.size >= 8)
            throw new AgentError('SESSION_LIMIT', 'At most eight sessions. Abandon an unused session.');
        const root = await rootPath(a.path), checks = await discoverChecks(root);
        const required = a.requiredChecks ?? checks.defaultChecks;
        if (!required.length)
            throw new AgentError('NO_VERIFICATION_DEFINED', 'No default project checks found. Select discovered manifest-backed check IDs as requiredChecks or configure project preferences.');
        for (const name of required)
            if (!checks.candidates.some(c => c.name === name))
                throw new AgentError('UNKNOWN_CHECK', `Required check ${name} is not a discovered project check.`);
        const scope = (a.scope ?? ['.']).map(p => {
            const absolute = path.resolve(root, p);
            const relative = slash(path.relative(root, absolute));
            if (relative === '..' || relative.startsWith('../') || path.isAbsolute(relative) || sensitive(relative))
                throw new AgentError('INVALID_SCOPE', 'Scope must be relative source paths inside the project.');
            return relative || '.';
        });
        const snap = await sourceFingerprint(root);
        const session: Session = { id: randomUUID(), root, goal: a.goal, scope, requiredChecks: required, baseline: snap.hashes, state: 'active', touchedAt: Date.now(), busy: false };
        sessions.set(session.id, session);
        const persisted=await checkpointSession(session,'started');
        return { sessionId: session.id, state: session.state, goal: session.goal, scope, requiredChecks: required, context: await gatherContext(root), coverage: snap.coverage, persistent: persisted, note: 'Metadata-only restart checkpoint (when enabled). Scope is checked at finish; this is workflow enforcement, not an OS sandbox. No model conversation or source contents are stored.' };
    }
    if (!a.sessionId)
        throw new AgentError('INVALID_ARGUMENT', 'sessionId is required.');
    const s = getSession(a.sessionId);
    if (a.action === 'abandon') {
        if (s.busy)
            throw new AgentError('SESSION_BUSY', 'Cancel the running verification first.');
        sessions.delete(s.id);
        await deleteTaskCheckpoint(s.id);
        return { sessionId: s.id, abandoned: true, persistent: false };
    }
    if (a.action === 'verify')
        return runProjectChecks(s.root, s.requiredChecks, true, s.id);
    const current = await sourceFingerprint(s.root), changed = changes(s, current.hashes);
    const verified = !!s.verification?.passed && s.verification.fingerprint === current.fingerprint && s.requiredChecks.every(c => s.verification!.checks.includes(c));
    if (!verified && s.state === 'verified')
        s.state = 'active';
    if (a.action === 'finish') {
        if (s.busy)
            throw new AgentError('SESSION_BUSY', 'Verification is still running.');
        if (!verified)
            throw new AgentError('VERIFICATION_REQUIRED', 'Run every required check against the current source. Old, missing or failed results cannot finish a session.');
        if (changed.some(c => !c.inScope))
            throw new AgentError('SCOPE_VIOLATION', 'Changes outside the agreed scope were detected. Review them before starting a correctly scoped session; nothing was reverted.');
        s.state = 'finished';
        await checkpointSession(s,'finished');
    }
    return { sessionId: s.id, root: s.root, goal: s.goal, state: s.state, scope: s.scope, requiredChecks: s.requiredChecks, restoredUnverified:!!s.restored && !s.verification, verifiedCurrentSource: verified, verification: s.verification, changes: changed.slice(0, 200), changesTruncated: changed.length > 200, persistent:!!s.persistent, coverage: current.coverage };
}
export function pruneHarnessSessions(now=Date.now()){for(const [id,s]of sessions)if(!s.busy&&now-s.touchedAt>2*3600000)sessions.delete(id);}
export function clearHarnessSessions() { sessions.clear(); }
