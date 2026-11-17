/** RAM-only coding sessions: goal/scope/required checks plus fresh-verification evidence. Nothing is persisted, logged or sent anywhere. */
import { randomUUID, createHash } from 'node:crypto';
import path from 'node:path';
import { rootPath, projectPath, listProjectFiles, slash, sensitive } from './workspace.js';
import { readBounded, sha256 } from './file-safety.js';
import { AgentError } from './errors.js';
import { checkCancelled } from '../context.js';
import { sourceCandidate } from './languages.js';
import { discoverChecks, runProjectChecks } from './harness.js';

interface Verification { fingerprint: string; passed: boolean; checks: string[]; steps: { name: string; passed: boolean; exitCode?: unknown }[]; at: number }
interface Session {
    id: string; root: string; goal: string; scope: string[]; requiredChecks: string[];
    baseline: Map<string, string>; state: 'active' | 'verified' | 'finished';
    verification?: Verification; touchedAt: number; busy: boolean;
}
const MAX_SESSIONS = 8, IDLE_MS = 2 * 3600000, MAX_FILES = 2500, MAX_BYTES = 32 * 1024 * 1024;
const sessions = new Map<string, Session>();

/** Same file set and digest algorithm as harness.sourceFingerprint, but keeps per-file hashes so changes can be listed. */
async function snapshot(root: string) {
    const listed = await listProjectFiles(root, 15000);
    if (listed.truncated) throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Too many paths for reliable session tracking. Use a narrower project root.');
    const files = listed.files.filter(sourceCandidate);
    if (files.length > MAX_FILES) throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', `Session tracking is limited to ${MAX_FILES} source/config files. Narrow the root.`);
    const hashes = new Map<string, string>();
    let bytes = 0;
    for (const name of files) {
        checkCancelled();
        let data: Buffer;
        try { data = await readBounded(await projectPath(root, name), 8 * 1024 * 1024); }
        catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new AgentError('VERIFICATION_CHANGED', 'A source file disappeared while tracking. Retry when file changes finish.');
            throw e;
        }
        bytes += data.length;
        if (bytes > MAX_BYTES) throw new AgentError('VERIFICATION_SCOPE_TOO_LARGE', 'Session snapshots exceed 32 MiB. Narrow the root.');
        hashes.set(name, sha256(data));
    }
    const h = createHash('sha256');
    for (const [f, s] of hashes) h.update(f + '\0' + s + '\n');
    return { hashes, fingerprint: h.digest('hex') };
}
function prune(now = Date.now()) { for (const [id, s] of sessions) if (!s.busy && now - s.touchedAt > IDLE_MS) sessions.delete(id); }
function get(id: string) {
    const s = sessions.get(id);
    if (!s) throw new AgentError('SESSION_NOT_FOUND', 'Session expired or the agent restarted. Start a new coding_session.');
    s.touchedAt = Date.now();
    return s;
}
function changesOf(s: Session, now: Map<string, string>) {
    const all = new Set([...s.baseline.keys(), ...now.keys()]);
    return [...all].filter(f => s.baseline.get(f) !== now.get(f)).sort().map(file => ({
        file, kind: !s.baseline.has(file) ? 'added' : !now.has(file) ? 'deleted' : 'modified',
        inScope: s.scope.some(p => p === '.' || file === p || file.startsWith(p + '/')),
    }));
}
async function view(s: Session, finish = false) {
    const cur = await snapshot(s.root), changed = changesOf(s, cur.hashes);
    const v = s.verification;
    const verified = !!v?.passed && v.fingerprint === cur.fingerprint && s.requiredChecks.every(c => v.checks.includes(c));
    if (!verified && s.state === 'verified') s.state = 'active';
    if (finish) {
        if (s.busy) throw new AgentError('SESSION_BUSY', 'Verification is still running.');
        if (!verified) throw new AgentError('VERIFICATION_REQUIRED', 'Run every required check against the current source. Old, missing or failed results cannot finish a session.');
        if (changed.some(c => !c.inScope)) throw new AgentError('SCOPE_VIOLATION', 'Changes outside the agreed scope were detected. Review them; nothing was reverted.');
        s.state = 'finished';
    }
    return { sessionId: s.id, root: s.root, goal: s.goal, state: s.state, scope: s.scope, requiredChecks: s.requiredChecks, verifiedCurrentSource: verified, verification: s.verification, changes: changed, persistent: false as const };
}
export interface SessionArgs { action: 'start' | 'status' | 'verify' | 'finish' | 'abandon'; path?: string; sessionId?: string; goal?: string; scope?: string[]; requiredChecks?: string[] }
export async function codingSession(a: SessionArgs) {
    prune();
    if (a.action === 'start') {
        if (!a.path || !a.goal) throw new AgentError('INVALID_ARGUMENT', 'Starting a session requires path and goal.');
        if (sessions.size >= MAX_SESSIONS) throw new AgentError('SESSION_LIMIT', `At most ${MAX_SESSIONS} sessions. Abandon an unused session.`);
        const root = await rootPath(a.path), checks = await discoverChecks(root);
        const required = a.requiredChecks ?? checks.defaultChecks;
        if (!required.length) throw new AgentError('NO_VERIFICATION_DEFINED', 'No default project checks found. Pass discovered check IDs as requiredChecks.');
        for (const name of required)
            if (!checks.candidates.some(c => c.name === name)) throw new AgentError('UNKNOWN_CHECK', `Required check ${name} is not a discovered project check.`);
        const scope = (a.scope ?? ['.']).map(p => {
            const rel = slash(path.relative(root, path.resolve(root, p)));
            if (rel === '..' || rel.startsWith('../') || path.isAbsolute(rel) || sensitive(rel)) throw new AgentError('INVALID_SCOPE', 'Scope must be relative source paths inside the project.');
            return rel || '.';
        });
        const snap = await snapshot(root);
        if (sessions.size >= MAX_SESSIONS) throw new AgentError('SESSION_LIMIT', `At most ${MAX_SESSIONS} sessions. Abandon an unused session.`);
        const s: Session = { id: randomUUID(), root, goal: a.goal, scope, requiredChecks: required, baseline: snap.hashes, state: 'active', touchedAt: Date.now(), busy: false };
        sessions.set(s.id, s);
        return { sessionId: s.id, state: s.state, goal: s.goal, scope, requiredChecks: required, persistent: false, note: 'Scope is checked at finish. This is workflow bookkeeping, not an OS sandbox; other tools keep their normal authority.' };
    }
    if (!a.sessionId) throw new AgentError('INVALID_ARGUMENT', 'sessionId is required.');
    const s = get(a.sessionId);
    if (a.action === 'abandon') {
        if (s.busy) throw new AgentError('SESSION_BUSY', 'Cancel the running verification first.');
        sessions.delete(s.id);
        return { sessionId: s.id, abandoned: true, persistent: false };
    }
    if (a.action === 'verify') {
        if (s.busy) throw new AgentError('SESSION_BUSY', 'This session already has a verification running.');
        s.busy = true;
        try {
            const r = await runProjectChecks(s.root, s.requiredChecks, true) as Record<string, any>;
            const after = await snapshot(s.root);
            const steps = (Array.isArray(r.steps) ? r.steps : []).map((x: any) => ({ name: String(x.name), passed: x.passed === true, exitCode: x.exitCode }));
            // Evidence only counts if the tree still matches the fingerprint the checks ran against.
            const passed = r.passed === true && r.sourceStableDuringChecks === true && r.fingerprint === after.fingerprint;
            s.verification = { fingerprint: after.fingerprint, passed, checks: s.requiredChecks.slice(), steps, at: Date.now() };
            s.state = passed ? 'verified' : 'active';
            return { passed, steps, error: passed ? undefined : r.error, ...(await view(s)) };
        } finally { s.busy = false; s.touchedAt = Date.now(); }
    }
    return view(s, a.action === 'finish');
}
export function sessionHandoff(sessionId: string, maxChanges: number) {
    return codingSession({ action: 'status', sessionId }).then(s => {
        const v = s as Awaited<ReturnType<typeof view>>;
        return { ...v, changes: v.changes.slice(0, maxChanges), changesTruncated: v.changes.length > maxChanges,
            resume: 'Re-read hashes before editing and re-run required checks when verification is stale. This handoff is computed now, not saved; it does not survive an agent restart.' };
    });
}
export function clearCodingSessions() { sessions.clear(); }
