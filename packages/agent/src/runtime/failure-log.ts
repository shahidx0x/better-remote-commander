/**
 * OPT-IN local failure log (BRC_ERROR_LOG=1). Disabled by default; nothing is written otherwise.
 *
 * Stores ONLY: timestamp, tool name (registered tools only), error code, duration, short call id and a fixed
 * explanation string. Never arguments, paths, file names, content, results, credentials or network telemetry.
 * Bounded: the newest MAX_FAILURE_LOG_ENTRIES entries in one agent-owned file (0600), rewritten atomically-ish
 * through a single serialized writer; symlinked directories/files are refused.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

export const MAX_FAILURE_LOG_ENTRIES = 100;
const MAX_EXISTING_FILE_BYTES = 512 * 1024;

export interface FailureEvent { tool: string; code: string; durationMs: number; callId: string }
export interface FailureEntry { timestamp: string; tool: string; code: string; durationMs: number; callId: string; reason: string }

const EXPLANATIONS: Record<string, string> = {
    INVALID_ARGUMENT: 'tool argument validation failed; check required fields and types',
    FILE_CONFLICT: 'expected_sha256 is stale or the file changed during publication; re-read the current hash',
    PATH_NOT_ALLOWED: 'agent denied the requested file path',
    OUTSIDE_ALLOWED_DIRECTORY: 'agent denied access outside allowed directories',
    UNKNOWN_TOOL: 'the requested tool is not registered on this agent',
    TOOL_FAILED: 'tool returned an unclassified failure; inspect its response',
    TIMEOUT: 'tool or command exceeded its execution timeout',
    BUSY: 'agent concurrency queue is full',
    CANCELLED: 'operation was cancelled before completion',
    RESULT_TOO_LARGE: 'tool output exceeded the bounded transport response limit',
    NESTED_BATCH: 'batch_tools cannot be nested',
    BATCH_TOOL_DENIED: 'tool is not allowed inside batch_tools',
    SETTINGS_OPEN: 'local connection settings were open; call not executed',
    DUPLICATE_CALL: 'duplicate call id; not executed twice',
};
export function failureReason(tool: string, code: string): string {
    return EXPLANATIONS[code] ?? (tool === 'edit_block' ? 'edit failed; check exact text, occurrence count and current SHA-256' : 'tool failed; inspect its structured error and recovery guidance');
}
export const failureLogEnabled = (): boolean => process.env.BRC_ERROR_LOG === '1';
export function failureLogPath(home = process.env.BRC_HOME ?? path.join(os.homedir(), '.brc')): string {
    return path.join(home, 'logs', 'agent-failures.jsonl');
}

const clean = (v: unknown, limit = 80): string => String(v ?? '').replace(/[^\w.:-]/g, '_').slice(0, limit);
function newEntry(e: FailureEvent): FailureEntry {
    return { timestamp: new Date().toISOString(), tool: clean(e.tool), code: clean(e.code), durationMs: Math.max(0, Math.round(Number(e.durationMs) || 0)), callId: clean(e.callId, 16), reason: failureReason(e.tool, e.code) };
}
function parseEntry(line: string): FailureEntry | null {
    try {
        const v = JSON.parse(line) as Partial<FailureEntry>;
        if (typeof v.tool !== 'string' || typeof v.code !== 'string') return null;
        // Re-derive every field from a whitelist so a tampered file cannot smuggle extra data through agent_status.
        return { timestamp: typeof v.timestamp === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(v.timestamp) ? v.timestamp.slice(0, 30) : new Date().toISOString(),
            tool: clean(v.tool), code: clean(v.code), durationMs: Number.isFinite(v.durationMs) ? Math.max(0, Math.round(v.durationMs!)) : 0,
            callId: clean(v.callId, 16), reason: failureReason(v.tool, v.code) };
    } catch { return null; }
}

async function safeFile(create: boolean): Promise<string | null> {
    const file = failureLogPath(), folder = path.dirname(file);
    if (create) await fs.mkdir(folder, { recursive: true, mode: 0o700 });
    const dir = await fs.lstat(folder).catch(() => null);
    if (!dir?.isDirectory() || dir.isSymbolicLink()) return null;
    const stat = await fs.lstat(file).catch(() => null);
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) return null;
    return file;
}
async function readEntries(file: string): Promise<FailureEntry[]> {
    const stat = await fs.lstat(file).catch(() => null);
    if (!stat || stat.size > MAX_EXISTING_FILE_BYTES) return [];
    const text = await fs.readFile(file, 'utf8').catch(() => '');
    return text.split(/\r?\n/).filter(Boolean).slice(-MAX_FAILURE_LOG_ENTRIES).map(parseEntry).filter((x): x is FailureEntry => x !== null);
}

let queued: FailureEvent[] = [];
let pending: Promise<void> = Promise.resolve();
let scheduled = false;
function schedule(): void {
    if (scheduled) return;
    scheduled = true;
    pending = pending.then(async () => {
        const batch = queued.splice(0);
        const file = batch.length ? await safeFile(true) : null;
        if (!file) return;
        const entries = [...await readEntries(file), ...batch.map(newEntry)].slice(-MAX_FAILURE_LOG_ENTRIES);
        await fs.writeFile(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n', { mode: 0o600 });
    }).catch(() => { /* failure logging must never interrupt tool execution */ })
        .finally(() => { scheduled = false; if (queued.length) schedule(); });
}
export function recordToolFailure(event: FailureEvent): void {
    if (!failureLogEnabled()) return;
    queued.push(event);
    if (queued.length > MAX_FAILURE_LOG_ENTRIES) queued = queued.slice(-MAX_FAILURE_LOG_ENTRIES);
    schedule();
}
export async function flushToolFailureLogs(): Promise<void> {
    while (scheduled || queued.length) await pending;
}
/** Newest-last failure metadata for agent_status; empty (and no disk access) unless the log is enabled. */
export async function recentFailures(limit = 20): Promise<FailureEntry[]> {
    if (!failureLogEnabled()) return [];
    await flushToolFailureLogs();
    const file = await safeFile(false);
    return file ? (await readEntries(file)).slice(-Math.max(1, Math.min(limit, MAX_FAILURE_LOG_ENTRIES))) : [];
}
