/** Live-only metadata diagnostics. No append/write API, disk buffer or log timer. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const RETENTION_MS = 0;
let stdoutAvailable = true;
process.stdout.on('error', () => { stdoutAvailable = false; });
export interface ActivityEvent {
    timestamp: string;
    level: string;
    message: string;
    tool?: string;
    id?: string;
    phase?: 'START' | 'OK' | 'ERROR';
    ms?: number;
    code?: string;
}
export function compactLine(s: string, limit = 180): string {
    return s.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')
        .replace(/brc_(?:dev|ak)_[A-Za-z0-9_-]+/g, '[REDACTED]')
        .replace(/(bearer\s+)[^\s]+/gi, '$1[REDACTED]')
        .replace(/((?:password|secret|token|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[REDACTED]')
        .slice(0, limit);
}
const safeId = (v: string) => v.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80);
export class ActivityLog {
    private events: ActivityEvent[] = [];
    private consoleQueue: string[] = [];
    private blocked = false;
    private started = false;
    dropped = 0;
    ioErrors = 0;
    // The legacy third argument is deliberately ignored: disk logging cannot be enabled.
    constructor(readonly home = process.env.BRC_HOME ?? path.join(os.homedir(), '.brc'), private quiet = process.env.BRC_LOG_LEVEL === 'silent', _legacyDisk?: boolean) { }
    get directory(): string { return path.join(this.home, 'logs'); }
    async start(): Promise<void> { if (this.started)
        return; this.started = true; await this.prune(); }
    log(level: string, message: string): void {
        if (level === 'debug' && process.env.BRC_DEBUG !== '1')
            return;
        this.record({ timestamp: new Date().toISOString(), level, message: compactLine(message) });
    }
    tool(phase: 'START' | 'OK' | 'ERROR', tool: string, id: string, ms?: number, code?: string): void {
        tool = safeId(tool);
        id = safeId(id);
        code = code ? safeId(code) : undefined;
        this.record({ timestamp: new Date().toISOString(), level: phase === 'ERROR' ? 'error' : 'info', phase, tool, id, ms, code,
            message: `${phase.padEnd(5)} ${tool} [${id.slice(0, 8)}]${ms === undefined ? '' : ` ${Math.round(ms)}ms`}${code ? ` ${code}` : ''}` });
    }
    private record(event: ActivityEvent): void {
        this.events.push(event);
        if (this.events.length > 1000)
            this.events.shift();
        if (this.quiet)
            return;
        if (this.consoleQueue.length >= 200) {
            this.consoleQueue.shift();
            this.dropped++;
        }
        const width = Math.min(160, Math.max(40, (process.stdout.columns || 120) - 1));
        this.consoleQueue.push(compactLine(`[${new Date(event.timestamp).toTimeString().slice(0, 8)}] ${event.message}`, width) + '\n');
        this.drainConsole();
    }
    private drainConsole(): void {
        if (!stdoutAvailable || process.stdout.destroyed) {
            this.consoleQueue.length = 0;
            return;
        }
        if (this.blocked)
            return;
        while (this.consoleQueue.length) {
            try {
                if (!process.stdout.write(this.consoleQueue.shift()!)) {
                    this.blocked = true;
                    process.stdout.once('drain', () => { this.blocked = false; this.drainConsole(); });
                    return;
                }
            }
            catch {
                this.consoleQueue.length = 0;
                return;
            }
        }
    }
    recent(): ActivityEvent[] { return this.events.map(e => ({ ...e })); }
    metrics() {
        const groups = new Map<string, ActivityEvent[]>();
        for (const e of this.events)
            if (e.tool && e.phase && e.phase !== 'START') {
                const g = groups.get(e.tool) ?? [];
                g.push(e);
                groups.set(e.tool, g);
            }
        return [...groups].map(([tool, es]) => { const d = es.map(e => e.ms ?? 0).sort((a, b) => a - b); return { tool, calls: es.length, errors: es.filter(e => e.phase === 'ERROR').length, meanMs: Math.round(d.reduce((a, b) => a + b, 0) / d.length), p95Ms: Math.round(d[Math.max(0, Math.ceil(d.length * .95) - 1)]), maxMs: Math.round(d.at(-1) ?? 0) }; });
    }
    async flush(): Promise<void> { }
    async prune(_now = Date.now()): Promise<void> {
        // Migration only. Never walk symlinks or delete configuration/user project files.
        for (const dir of [this.home, this.directory]) {
            const stat = await fs.lstat(dir).catch(() => null);
            if (!stat?.isDirectory() || stat.isSymbolicLink())
                continue;
            for (const name of await fs.readdir(dir).catch(() => [] as string[])) {
                if (!/^(agent\.log(?:\..*)?|tool-history\.jsonl|claude_tool_call(?:_[\w-]+)?\.log|fuzzy-search\.log|activity-\d{4}-\d{2}-\d{2}-\d{2}-\d+-\d+\.jsonl)$/.test(name))
                    continue;
                const file = path.join(dir, name);
                if ((await fs.lstat(file).catch(() => null))?.isFile())
                    await fs.unlink(file).catch(() => { this.ioErrors++; });
            }
        }
    }
    async close(): Promise<void> { this.drainConsole(); this.events = []; }
}
export const activity = new ActivityLog();
