/** Live-only activity diagnostics: bounded rolling text, no disk transcript. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const RETENTION_MS = 0;
/** Combined live-log text budget: structured history plus one console ring/queue. */
export const MAX_ACTIVITY_LOG_BYTES = 100 * 1024;
export const MAX_ACTIVITY_EVENT_BYTES = 60 * 1024;
export const MAX_ACTIVITY_CONSOLE_BYTES = MAX_ACTIVITY_LOG_BYTES - MAX_ACTIVITY_EVENT_BYTES;
const MAX_QUEUED_ACTIVITY_LINES = 200;
let stdoutAvailable = true;
process.stdout.on('error', () => { stdoutAvailable = false; });
export type ConsoleMode = 'compact' | 'verbose';
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
    private eventsBytes = 0;
    private consoleQueue: string[] = [];
    private queuedBytes = 0;
    private rollingLines: string[] = [];
    private rollingBytes = 0;
    private rollingTimer: NodeJS.Timeout | null = null;
    private rollingConsole = false;
    private blocked = false;
    private started = false;
    private consolePauses = 0;
    private consoleMode: ConsoleMode = process.env.BRC_CONSOLE_MODE === 'verbose' || !process.stdout.isTTY ? 'verbose' : 'compact';
    dropped = 0;
    ioErrors = 0;
    // The legacy third argument is deliberately ignored: disk logging cannot be enabled.
    constructor(readonly home = process.env.BRC_HOME ?? path.join(os.homedir(), '.brc'), private quiet = process.env.BRC_LOG_LEVEL === 'silent', _legacyDisk?: boolean) { }
    get directory(): string { return path.join(this.home, 'logs'); }
    getConsoleMode(): ConsoleMode { return this.consoleMode; }
    setConsoleMode(mode: ConsoleMode): void { this.consoleMode = mode; }
    /** Enabled only after pairing, in an interactive TTY. Never redraw prompts. */
    setRollingConsole(enabled:boolean):void {
        this.rollingConsole = !!enabled && !!process.stdout.isTTY && process.env.TERM !== 'dumb';
        if (this.rollingConsole) {
            this.consoleQueue.length = 0;
            this.queuedBytes = 0;
            this.scheduleRolling();
        } else {
            if (this.rollingTimer) clearTimeout(this.rollingTimer);
            this.rollingTimer = null;
            this.rollingLines.length = 0;
            this.rollingBytes = 0;
        }
    }
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
        // Cap by UTF-8 text size instead of 20 entries; no log is persisted.
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        this.events.push(event);
        this.eventsBytes += bytes;
        while (this.eventsBytes > MAX_ACTIVITY_EVENT_BYTES || this.events.length > 1000) {
            const old = this.events.shift();
            if (!old) break;
            this.eventsBytes -= Buffer.byteLength(JSON.stringify(old), 'utf8');
            this.dropped++;
        }
        if (this.quiet)
            return;
        // Compact mode halves successful tool chatter by displaying the
        // completion, not the START and completion. History remains complete.
        if (this.consoleMode === 'compact' && event.phase === 'START') return;
        if (this.consoleMode === 'compact' && event.level === 'info' && !event.phase
            && !/^(Connecting to |Ready: |Disconnected|Relay refused|Device authorization)/.test(event.message)) return;
        const width = Math.min(160, Math.max(40, (process.stdout.columns || 120) - 1));
        const hhmmss = event.timestamp.slice(11, 19);
        let line = this.consoleMode === 'compact'
            ? '[' + hhmmss + ']  ' + (event.phase === 'OK' ? '[OK]  ' : event.phase === 'ERROR' ? '[FAIL]  ' : event.level === 'warn' ? '[WARN]  ' : event.level === 'error' ? '[ERROR]  ' : '       ')
                + (event.phase ? event.tool + (event.ms === undefined ? '' : '  ' + Math.round(event.ms) + 'ms')
                    + (event.code ? '  ' + event.code : '') : event.message)
            : '[' + hhmmss + '] ' + event.message;
        line = compactLine(line, width);
        // Colors are attached only AFTER sanitizing untrusted log text.
        if (process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.BRC_COLOR !== '0') {
            const code = event.phase === 'ERROR' || event.level === 'error' ? '31'
                : event.phase === 'OK' ? '32' : event.level === 'warn' ? '33' : '36';
            line = '\x1b[' + code + 'm' + line + '\x1b[0m';
        }
        if (this.rollingConsole) {
            this.rollingLines.push(line);
            this.rollingBytes += Buffer.byteLength(line + '\n', 'utf8');
            while (this.rollingBytes > MAX_ACTIVITY_CONSOLE_BYTES && this.rollingLines.length > 1) {
                const old = this.rollingLines.shift()!;
                this.rollingBytes -= Buffer.byteLength(old + '\n', 'utf8');
                this.dropped++;
            }
            this.scheduleRolling();
            return;
        }
        const queuedLine = line + '\n';
        this.consoleQueue.push(queuedLine);
        this.queuedBytes += Buffer.byteLength(queuedLine, 'utf8');
        while (this.consoleQueue.length > MAX_QUEUED_ACTIVITY_LINES || this.queuedBytes > MAX_ACTIVITY_CONSOLE_BYTES) {
            const old = this.consoleQueue.shift();
            if (!old) break;
            this.queuedBytes -= Buffer.byteLength(old, 'utf8');
            this.dropped++;
        }
        this.drainConsole();
    }
    /** Keep a settings prompt readable; queued live lines remain bounded and are never written to disk. */
    pauseConsole(): () => void {
        this.consolePauses++;
        let resumed = false;
        return () => {
            if (resumed) return;
            resumed = true;
            this.consolePauses = Math.max(0, this.consolePauses - 1);
            this.drainConsole();
        };
    }
    private scheduleRolling(): void {
        if (!this.rollingConsole || this.rollingTimer || this.blocked || this.consolePauses ||
            !stdoutAvailable || process.stdout.destroyed) return;
        // Coalesce bursts: rendering up to 100 KiB after EVERY log line would
        // waste CPU. Repaint only on new data, at most about three times/sec.
        this.rollingTimer = setTimeout(() => {
            this.rollingTimer = null;
            if (!this.rollingConsole || this.consolePauses || this.blocked || process.stdout.destroyed) return;
            // ANSI erase-screen is limited to the BRC agent's own TTY window.
            // No interaction with user shell commands, relay or other consoles.
            const frame = '\x1b[H\x1b[2J\x1b[3J'
                + '  BRC LIVE ACTIVITY  |  latest ' + Math.ceil(this.rollingBytes / 1024)
                + ' / ' + Math.round(MAX_ACTIVITY_CONSOLE_BYTES / 1024) + ' KiB  |  100 KiB total budget\n'
                + '  [M] settings  [S] status  [L] activity  [V] verbose  [?] help  [Ctrl+C] stop\n'
                + '-'.repeat(68) + '\n'
                + this.rollingLines.join('\n') + '\n';
            try {
                if (!process.stdout.write(frame)) {
                    this.blocked = true;
                    process.stdout.once('drain', () => { this.blocked = false; this.scheduleRolling(); });
                }
            } catch { this.rollingConsole = false; }
        }, 350);
        this.rollingTimer.unref();
    }
    private drainConsole(): void {
        if (this.rollingConsole) { this.scheduleRolling(); return; }
        if (!stdoutAvailable || process.stdout.destroyed) {
            this.consoleQueue.length = 0;
            this.queuedBytes = 0;
            return;
        }
        if (this.blocked || this.consolePauses > 0)
            return;
        while (this.consoleQueue.length) {
            try {
                const next = this.consoleQueue.shift()!;
                this.queuedBytes = Math.max(0, this.queuedBytes - Buffer.byteLength(next, 'utf8'));
                if (!process.stdout.write(next)) {
                    this.blocked = true;
                    process.stdout.once('drain', () => { this.blocked = false; this.drainConsole(); });
                    return;
                }
            }
            catch {
                this.consoleQueue.length = 0;
                this.queuedBytes = 0;
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
    async close(): Promise<void> {
        if (this.rollingTimer) clearTimeout(this.rollingTimer);
        this.rollingTimer = null;
        this.rollingConsole = false;
        this.drainConsole();
        this.events = [];
        this.eventsBytes = 0;
        this.rollingLines = [];
        this.rollingBytes = 0;
        this.consoleQueue = [];
        this.queuedBytes = 0;
    }
}
export const activity = new ActivityLog();
