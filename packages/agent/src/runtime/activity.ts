/** Live-only activity diagnostics: bounded rolling text, no disk transcript. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const RETENTION_MS = 0;
/** Combined live-log text budget: structured history plus one console ring/queue. */
export const MAX_ACTIVITY_LOG_BYTES = 500 * 1024;
export const MAX_ACTIVITY_EVENT_BYTES = 244 * 1024; // retained searchable events
export const MAX_ACTIVITY_CONSOLE_BYTES = MAX_ACTIVITY_LOG_BYTES - MAX_ACTIVITY_EVENT_BYTES;
let stdoutAvailable = true;
process.stdout.on('error', () => { stdoutAvailable = false; });
export type ConsoleMode = 'compact' | 'verbose';
export interface ActivityEvent {
    timestamp: string;
    level: string;
    message: string;
    tool?: string;
    id?: string;
    phase?: 'START' | 'OK' | 'ERROR' | 'PENDING';
    action?: string;
    note?: string;
    trace?: string;
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
/** Safe human-readable summary: no raw command, source text, credentials or arguments. */
export function activityAction(tool: string, args: Record<string,unknown> | undefined | null): string {
    if (!args || typeof args !== 'object') return '';
    const val=(key:string):string=>typeof args[key]==='string'?args[key] as string:'';
    const shortPath=(s:string):string=>{
        if (!s)return '';
        const chunks=s.replace(/\\/g,'/').split('/').filter(Boolean);
        const text=chunks.length>3
            ?chunks[0]+'/.../'+chunks.slice(-3).join('/')
            :chunks.join('/');
        return compactLine(text,100);
    };
    // Recognize common package-manager cwd flags, without showing the command text.
    const command=val('command');
    const dirFlag=/(?:^|\s)(?:--dir|--cwd|-C)\s+(?:'([^']{1,260})'|"([^"]{1,260})"|([^\s]{1,260}))/i.exec(command);
    const hintedDir=dirFlag?.[1]||dirFlag?.[2]||dirFlag?.[3]||'';
    const where=shortPath(val('file_path')||val('path')||val('cwd')||
        val('root')||val('directory')||val('source')||hintedDir);
    const at=where?' @ '+where:'';
    if (tool==='run_command'||tool==='start_process'){
        // Only approved executable and task names; never echo raw arguments.
        const first=command.match(/^\s*("[^"]+"|[^\s]+)/)?.[1]??'';
        const exe=first.replace(/^"|"$/g,'').split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/,'')??'';
        const approved=['pnpm','npm','node','python','python3','git','rg','cargo','go','dotnet','tsc','bun','npx','cmd','powershell'].includes(exe)?exe:'shell';
        const task=/(?:^|\s)(eslint|tsc|vitest|jest|pytest|build|test|lint|typecheck)(?=\s|$)/i.exec(command)?.[1].toLowerCase();
        const rel=/(?:^|\s)([a-zA-Z0-9_./\\-]+\.(?:tsx?|jsx?|py|go|rs))(?=\s|$)/i.exec(command)?.[1]??'';
        const file=rel ? shortPath(rel).replace(/^\.\//,'') : '';
        return approved+(task?' '+task:'')+(where?' in '+where:'')+
            (file?' / '+file:'');
    }
    if (tool==='read_multiple_files')
        return (Array.isArray(args.paths)?args.paths.length:0)+' files';
    if (tool==='edit_block')return 'edit'+at;
    if (tool==='write_file')return 'write'+at;
    if (tool==='read_file')return 'read'+at;
    if (tool==='start_search')return 'search'+at;
    if (tool==='get_job'||tool==='wait_jobs'||tool==='cancel_job'){
        const ids=Array.isArray(args.ids)?args.ids:[];
        const id=val('id')||(typeof ids[0]==='string'?ids[0]:'');
        return id?'job '+safeId(id).slice(0,16):'jobs';
    }
    if (tool==='read_process_output'||tool==='interact_with_process'||tool==='force_terminate')
        return typeof args.pid==='number'&&Number.isSafeInteger(args.pid)?'PID '+args.pid:'';
    return at.trim();
}
/** Render human-readable live events. Verbose mode preserves bounded multi-line details. */
export function formatActivityEvent(event: ActivityEvent, mode: ConsoleMode, width=120): string {
    const time = new Date(event.timestamp).toLocaleTimeString('en-GB',{hour12:false});
    const max = Math.min(160,Math.max(40,width));
    if (!event.phase) return compactLine('['+time+'] '+event.message,max);
    const state = event.phase === 'PENDING' ? 'RUN'
        : event.phase === 'ERROR' ? 'FAIL'
        : event.phase === 'OK' ? 'OK' : 'START';
    const duration = event.ms === undefined ? '' : '  '+(event.ms >= 1000
        ? (event.ms / 1000).toFixed(1)+'s' : Math.round(event.ms)+'ms');
    const legacyTool = /^\s*(?:START|OK|ERROR|PENDING)\s+([a-z][a-z0-9_]*)\b/i.exec(event.message)?.[1];
    const label = '['+time+'] ['+state+'] '+(event.tool??legacyTool??'operation')+duration;
    if (mode === 'compact') {
        const lines=[label];
        if(event.action) lines.push('           Task: '+event.action);
        if(event.note) lines.push('           '+event.note);
        else if(event.code) lines.push('           '+event.code);
        return lines.slice(0,3).map(line=>compactLine(line,max)).join('\n');
    }
    const parts=[label+(event.id?'  (call '+event.id.slice(0,16)+')':'')];
    if(event.action)parts.push('  Task: '+event.action);
    if(event.trace)parts.push(event.trace);
    if(event.note)parts.push('  Note: '+event.note);
    else if(event.code)parts.push('  Code: '+event.code);
    // Wrap instead of discarding text after column 160. Every input trace was
    // already clipped and redacted before being retained in activity history.
    const lines: string[]=[];
    for(const piece of parts.join('\n').split('\n')){
        if(!piece){lines.push('');continue;}
        for(let pos=0;pos<piece.length;pos+=max){
            const fragment=piece.slice(pos,pos+max);
            lines.push(compactLine(fragment,max));
        }
    }
    return lines.join('\n');
}
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
    private consoleMode: ConsoleMode = process.env.BRC_CONSOLE_MODE === 'compact' ? 'compact' : 'verbose';
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
    tool(phase: 'START' | 'OK' | 'ERROR' | 'PENDING', tool: string, id: string, ms?: number, code?: string, action?: string, note?: string, trace?: string): void {
        tool = safeId(tool);
        id = safeId(id);
        code = code ? safeId(code) : undefined;
        note = note ? compactLine(note,155) : undefined;
        trace = trace ? trace.slice(0,12_000) : undefined;
        this.record({ timestamp: new Date().toISOString(), level: phase === 'ERROR' ? 'error' : 'info', phase, tool, id, ms, code, action, note, trace,
            message: `${phase.padEnd(5)} ${tool} [${id.slice(0, 8)}]${ms === undefined ? '' : ` ${Math.round(ms)}ms`}${code ? ` ${code}` : ''}` });
    }
    private record(event: ActivityEvent): void {
        if(event.phase && event.action) event.message += ' | ' + compactLine(event.action,108);
        if(event.phase && event.note) event.message += ' | ' + event.note;
        // Cap by UTF-8 text size instead of 20 entries; no log is persisted.
        const bytes = Buffer.byteLength(JSON.stringify(event), 'utf8');
        this.events.push(event);
        this.eventsBytes += bytes;
        while (this.eventsBytes > MAX_ACTIVITY_EVENT_BYTES) {
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
        // Polling is not a separate user task and must not look like
        // another successful build. Final command status is logged by the job.
        if (this.consoleMode === 'compact' && event.phase === 'OK' &&
            (event.tool === 'wait_jobs' || event.tool === 'get_job' ||
             event.tool === 'list_jobs')) return;
        if (this.consoleMode === 'compact' && event.level === 'info' && !event.phase
            && !/^(Connecting to |Ready: |Disconnected|Relay refused|Device authorization)/.test(event.message)) return;
        const width = Math.min(160, Math.max(40, (process.stdout.columns || 120) - 1));
        let line = formatActivityEvent(event,this.consoleMode,width);
        // Colors are attached only AFTER sanitizing untrusted log text.
        if (process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.BRC_COLOR !== '0') {
            const code = event.phase === 'ERROR' || event.level === 'error' ? '31'
                : event.phase === 'OK' ? '32' : event.phase === 'PENDING' ? '33' : event.level === 'warn' ? '33' : '36';
            line = line.split('\n').map(part => '\x1b['+code+'m'+part+'\x1b[0m').join('\n');
        }
        if (this.rollingConsole) {
            for (const row of line.split('\n')) {
                this.rollingLines.push(row);
                this.rollingBytes += Buffer.byteLength(row+'\n','utf8');
            }
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
        while (this.queuedBytes > MAX_ACTIVITY_CONSOLE_BYTES) {
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
        // Keep the budgeted ring in RAM but paint only visible rows to avoid expensive redraws.
        this.rollingTimer = setTimeout(() => {
            this.rollingTimer = null;
            if (!this.rollingConsole || this.consolePauses || this.blocked || process.stdout.destroyed) return;
            // ANSI erase-screen is limited to the BRC agent's own TTY window.
            // No interaction with user shell commands, relay or other consoles.
            const visibleLines=this.rollingLines.slice(-Math.min(65,Math.max(15,(process.stdout.rows||38)-6)));
            const frame = '\x1b[H\x1b[2J\x1b[3J'
                + '  BRC LIVE ACTIVITY  |  latest ' + Math.ceil(this.rollingBytes / 1024)
                + ' / ' + Math.round(MAX_ACTIVITY_CONSOLE_BYTES / 1024) + ' KiB  |  500 KiB total budget\n'
                + '  [M] settings  [S] status  [L] activity  [V] verbose  [?] help  [Ctrl+C] stop\n'
                + '-'.repeat(68) + '\n'
                + visibleLines.join('\n') + '\n';
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
