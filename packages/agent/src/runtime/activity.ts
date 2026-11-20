/** Live-only activity diagnostics: bounded rolling text, no disk transcript. */
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
export const RETENTION_MS = 0;
/** At most 500 KiB of RETAINED diagnostic UTF-8 payload across history and stdout queue.
 * JS objects, buffers and the Node runtime consume additional physical RAM.
 * Native terminal scrollback needs no duplicate in-agent 500-KiB ring.
 */
export const MAX_ACTIVITY_LOG_BYTES = 500 * 1024;
export const MAX_ACTIVITY_QUEUE_BYTES = 40 * 1024;
/** Additional fixed reservation for the disk history writer (pending + in-flight). */
export const MAX_HISTORY_WRITER_QUEUE_BYTES = 32 * 1024;
export const MAX_ACTIVITY_EVENT_BYTES = MAX_ACTIVITY_LOG_BYTES - MAX_ACTIVITY_QUEUE_BYTES - MAX_HISTORY_WRITER_QUEUE_BYTES;
/** On-demand L/history rendering cap: not a separate retained allocation. */
export const MAX_ACTIVITY_CONSOLE_BYTES = MAX_ACTIVITY_EVENT_BYTES;
let stdoutAvailable = true;
process.stdout.on('error', () => { stdoutAvailable = false; });
export type ConsoleMode = 'mymcp' | 'compact' | 'detailed' | 'verbose';
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
    const command=val('command') || val('program');
    const dirFlag=/(?:^|\s)(?:--dir|--cwd|-C)\s+(?:'([^']{1,260})'|"([^"]{1,260})"|([^\s]{1,260}))/i.exec(command);
    const hintedDir=dirFlag?.[1]||dirFlag?.[2]||dirFlag?.[3]||'';
    const where=shortPath(val('file_path')||val('path')||val('cwd')||
        val('root')||val('directory')||val('source')||hintedDir);
    const at=where?' @ '+where:'';
    if (tool==='run_command'||tool==='start_process'){
        // Only approved executable and task names; never echo raw arguments.
        const first=val('program')||command.match(/^\s*("[^"]+"|[^\s]+)/)?.[1]||'';
        const exe=first.replace(/^"|"$/g,'').split(/[\\/]/).at(-1)?.toLowerCase().replace(/\.(exe|cmd|bat|ps1)$/,'')??'';
        const approved=['pnpm','npm','node','python','python3','git','rg','cargo','go','dotnet','tsc','bun','npx','cmd','powershell'].includes(exe)?exe:'shell';
        const task=/(?:^|\s)(eslint|tsc|vitest|jest|pytest|build|test|lint|typecheck)(?=\s|$)/i.exec(command)?.[1].toLowerCase();
        const rel=/(?:^|\s)([a-zA-Z0-9_./\\-]+\.(?:tsx?|jsx?|py|go|rs))(?=\s|$)/i.exec(command)?.[1]??'';
        const file=rel ? shortPath(rel).replace(/^\.\//,'') : '';
        return approved+(task?' '+task:'')+(where?' in '+where:'')+
            (file?' / '+file:'');
    }
    if (tool==='code_mode')return 'sandboxed workflow';
    if (tool==='read_multiple_files') {
        const files = Array.isArray(args.files) ? args.files :
            Array.isArray(args.paths) ? args.paths : null;
        return files ? files.length+' files' : 'multiple files';
    }
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
/** Format local time for MyMCP remote-device-style terminal output.
 * Safe JSON previews are supplied separately by the dispatcher. */
function localToolStamp(timestamp:string):string {
    const date=new Date(timestamp);
    const pad=(n:number)=>String(n).padStart(2,'0');
    return date.getFullYear()+'-'+pad(date.getMonth()+1)+'-'+pad(date.getDate())+
        ' '+pad(date.getHours())+':'+pad(date.getMinutes())+':'+pad(date.getSeconds());
}
/** Parse only allowlisted, short console fields. Never render raw MCP JSON. */
function minimalPreview(raw:string|undefined):{
    summary?:string;detail?:string;target?:string;hint?:string
} {
    if(!raw)return {};
    try {
        const value=JSON.parse(raw) as Record<string,unknown>;
        if(!value||typeof value!=='object'||Array.isArray(value))return {};
        const field=(name:string,limit:number):string|undefined=>{
            const item=value[name];
            return typeof item==='string'&&item.length>0?compactLine(item,limit):undefined;
        };
        return {
            summary:field('summary',130),
            detail:field('detail',100),
            target:field('target',115),
            hint:field('hint',125),
        };
    } catch { return {}; }
}
/** Render human-readable live events. Verbose mode preserves bounded multi-line details. */
export function formatActivityEvent(event: ActivityEvent, mode: ConsoleMode, width=120): string {
    const time = new Date(event.timestamp).toLocaleTimeString('en-GB',{hour12:false});
    const max = Math.min(160,Math.max(40,width));
    if (!event.phase) {
        if (mode==='mymcp') {
            const heartbeat=event.message.startsWith('Heartbeat | ');
            const label=(heartbeat?'status':event.level).slice(0,20).padEnd(20,' ');
            const message=heartbeat?event.message.slice('Heartbeat | '.length):event.message;
            return compactLine(localToolStamp(event.timestamp)+' | '+label+' | '+message,max);
        }
        return compactLine('['+time+'] '+event.message,max);
    }
    const state = event.phase === 'PENDING' ? 'RUN'
        : event.phase === 'ERROR' ? 'FAIL'
        : event.phase === 'OK' ? 'OK' : 'START';
    const duration = event.ms === undefined ? '' : '  '+(event.ms >= 1000
        ? (event.ms / 1000).toFixed(1)+'s' : Math.round(event.ms)+'ms');
    const legacyTool = /^\s*(?:START|OK|ERROR|PENDING)\s+([a-z][a-z0-9_]*)\b/i.exec(event.message)?.[1];
    const label = '['+time+'] ['+state+'] '+(event.tool??legacyTool??'operation')+duration;
    if (mode === 'mymcp') {
        // A few readable lines like a tool receipt: no JSON, code or full output.
        const stamp='['+time+']';
        const name=event.tool??legacyTool??'operation';
        const preview=minimalPreview(event.trace);
        const id='#'+(event.id?.slice(0,8)??'unknown');
        const took=event.ms===undefined?'':' • '+(event.ms>=1000
            ?(event.ms/1000).toFixed(1)+'s':Math.round(event.ms)+'ms');
        const target=preview.target??(event.action?compactLine(event.action,105):undefined);
        const context=target&&target!==preview.detail
            ?'\n    Target: '+compactLine(target,Math.max(40,max-12)):'';
        if(event.phase==='START')
            return stamp+' 🔧 Tool call '+name+' started  '+id;
        const receipt='\n    Call '+id+took;
        const heading='\n    Result preview\n    ';
        const detail=preview.detail?' • '+preview.detail:'';
        if(event.phase==='OK')return stamp+' ✅ Tool call '+name+' completed'+receipt+
            heading+(preview.summary??'Tool completed successfully')+detail+context;
        if(event.phase==='PENDING')return stamp+' ⏳ Tool call '+name+' running'+receipt+
            heading+(preview.summary??'Operation is still running')+detail+context;
        const code=preview.detail??event.code??'TOOL_FAILED';
        const generic=/tool failed; inspect its structured error and recovery guidance/i;
        const hint=preview.hint??(event.note&&!generic.test(event.note)
            ?compactLine(event.note,105):undefined);
        return stamp+' ❌ Tool call '+name+' failed'+receipt+heading+
            'Operation failed • '+compactLine(code,100)+
            (hint?'\n    Next: '+compactLine(hint,125):'')+context;
    }
    if (mode === 'detailed') {
        // Desktop Commander-style timestamps, call IDs, action and outcome,
        // without copying raw arguments, command output or source into logs.
        const summary = compactLine(label+(event.id?' #'+event.id.slice(0,12):'')+
            (event.action?' | '+event.action:''),max);
        const diagnostic = event.note || event.code;
        return diagnostic ? summary+'\n'+compactLine('    '+diagnostic,max) : summary;
    }
    if (mode === 'compact') {
        // One line per successful operation; a second line for a failure or a
        // still-running command. This maximizes actual visible history.
        const summary=compactLine(label+(event.action?' | '+event.action:''),max);
        const diagnostic=event.phase === 'ERROR' || event.phase === 'PENDING'
            ? (event.note||event.code) : undefined;
        return diagnostic ? summary+'\n'+compactLine('    '+diagnostic,max) : summary;
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
    private rollingTimer: NodeJS.Timeout | null = null;
    private rollingConsole = false;
    private blocked = false;
    private started = false;
    private consolePauses = 0;
    private startedCalls = 0;
    private finishedCalls = 0;
    private failedCalls = 0;
    private pendingCalls = 0;
    private lastTool: string | null = null;
    // Match Desktop Commander's remote-device tool-call console by default.
    // Legacy compact/detailed/verbose displays remain available as overrides.
    private consoleMode: ConsoleMode = process.env.BRC_CONSOLE_MODE === 'verbose' ? 'verbose'
        : process.env.BRC_CONSOLE_MODE === 'compact' ? 'compact'
        : process.env.BRC_CONSOLE_MODE === 'detailed' ? 'detailed' : 'mymcp';
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
        trace = trace ? trace.slice(0,this.consoleMode==='mymcp'?6_500:12_000) : undefined;
        if (phase==='START') this.startedCalls++;
        else if (phase==='OK') this.finishedCalls++;
        else if (phase==='ERROR') {this.finishedCalls++;this.failedCalls++;}
        else if (phase==='PENDING') this.pendingCalls++;
        this.lastTool=tool;
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
        if ((this.consoleMode === 'compact' || this.consoleMode === 'mymcp') && event.level === 'info' && !event.phase
            && !/^(Connecting to |Ready: |Disconnected|Relay refused|Device authorization|Heartbeat \|)/.test(event.message)) return;
        const width = Math.min(160, Math.max(40, (process.stdout.columns || 120) - 1));
        let line = formatActivityEvent(event,this.consoleMode,width);
        // Colors are attached only AFTER sanitizing untrusted log text.
        if (this.consoleMode !== 'mymcp' && process.stdout.isTTY && !('NO_COLOR' in process.env) && process.env.BRC_COLOR !== '0') {
            const code = event.phase === 'ERROR' || event.level === 'error' ? '31'
                : event.phase === 'OK' ? '32' : event.phase === 'PENDING' ? '33' : event.level === 'warn' ? '33' : '36';
            line = line.split('\n').map(part => '\x1b['+code+'m'+part+'\x1b[0m').join('\n');
        }
        // Native terminal scrollback already owns visible history. Holding
        // another full ring here duplicated 500 KiB with no rendering benefit.
        const queuedLine=line+'\n';
        this.consoleQueue.push(queuedLine);
        this.queuedBytes += Buffer.byteLength(queuedLine, 'utf8');
        // A separate 64-KiB pending-output queue avoids memory growth if
        // stdout is slow or settings temporarily pause log output.
        while (this.queuedBytes > MAX_ACTIVITY_QUEUE_BYTES && this.consoleQueue.length > 1) {
            const old=this.consoleQueue.shift()!;
            this.queuedBytes-=Buffer.byteLength(old,'utf8');
            this.dropped++;
        }
        if (this.rollingConsole) this.scheduleRolling();
        else this.drainConsole();
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
        // Coalesce short bursts. Never clear the terminal screen: native
        // scrollback keeps older activity accessible without redrawing 500 KiB.
        this.rollingTimer=setTimeout(() => {
            this.rollingTimer=null;
            if (!this.rollingConsole || this.blocked || this.consolePauses ||
                process.stdout.destroyed) return;
            this.drainConsole();
        },60);
        this.rollingTimer.unref();
    }
    private drainConsole(): void {
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
    /** O(1) safe diagnostic counters for the 30-second local heartbeat. */
    status() {
        return {mode:this.consoleMode,started:this.startedCalls,finished:this.finishedCalls,
            failed:this.failedCalls,pending:this.pendingCalls,lastTool:this.lastTool,
            retainedBytes:this.eventsBytes+this.queuedBytes,
            historyBytes:this.eventsBytes,queueBytes:this.queuedBytes,
            maxRetainedBytes:MAX_ACTIVITY_LOG_BYTES,dropped:this.dropped,
            persistentHistory:false};
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
                if (!/^(agent\.log(?:\..*)?|claude_tool_call(?:_[\w-]+)?\.log|fuzzy-search\.log|activity-\d{4}-\d{2}-\d{2}-\d{2}-\d+-\d+\.jsonl)$/.test(name))
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
        this.consoleQueue = [];
        this.queuedBytes = 0;
        this.startedCalls=0;
        this.finishedCalls=0;
        this.failedCalls=0;
        this.pendingCalls=0;
        this.lastTool=null;
    }
}
export const activity = new ActivityLog();
