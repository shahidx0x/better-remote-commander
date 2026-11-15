/** Two bounded, lazy parser workers. Timeouts/cancellation terminate computation, not only its promise. */
import { Worker } from 'node:worker_threads';
import { AgentError } from './errors.js';
import { getCallContext, checkCancelled } from '../context.js';
interface Job {
    id: number;
    grammar: string;
    language: string;
    text: string;
    resolve: (v: any) => void;
    reject: (e: unknown) => void;
    timer: NodeJS.Timeout;
    signal?: AbortSignal;
    abort: () => void;
    settled: boolean;
}
interface Slot {
    worker: Worker;
    job?: Job;
    idle?: NodeJS.Timeout;
    uses: number;
}
const slots = new Set<Slot>(), queue: Job[] = [];
const MAX_WORKERS=Math.min(2,Math.max(1,Number(process.env.BRC_PARSER_WORKERS)||1));
let seq = 0, completed = 0, restarts = 0;
function dispose(s: Slot) { clearTimeout(s.idle); slots.delete(s); s.worker.removeAllListeners(); void s.worker.terminate(); }
function finish(j: Job, error?: unknown, value?: unknown) { if (j.settled)
    return; j.settled = true; clearTimeout(j.timer); j.signal?.removeEventListener('abort', j.abort); error ? j.reject(error) : j.resolve(value); }
function makeSlot(): Slot {
    const worker = new Worker(new URL('./parser-worker.js', import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 64 }, stdout: true, stderr: true });
    // Worker diagnostics are not logs; ignore stdout/stderr rather than retaining source or stack dumps.
    worker.stdout?.resume();
    worker.stderr?.resume();
    const s: Slot = { worker, uses: 0 };
    slots.add(s);
    worker.on('message', (m: any) => {
        const j = s.job;
        if (!j || m.id !== j.id)
            return;
        s.job = undefined;
        completed++;
        s.uses++;
        finish(j, m.error ? new AgentError('PARSER_FAILED', String(m.error).slice(0, 500)) : undefined, m.result);
        if (m.recycle || s.uses >= 128) {
            restarts++;
            dispose(s);
        }
        else {
            worker.unref();
            s.idle = setTimeout(() => dispose(s), 30000);
            s.idle.unref();
        }
        pump();
    });
    worker.on('error', e => { const j = s.job; s.job = undefined; if (j)
        finish(j, new AgentError('PARSER_FAILED', e.message)); dispose(s); pump(); });
    worker.on('exit', code => { if (!slots.has(s))
        return; const j = s.job; s.job = undefined; if (j)
        finish(j, new AgentError('PARSER_EXIT', `Parser worker exited (${code}).`, true)); dispose(s); pump(); });
    return s;
}
function pump() {
    while (queue.length) {
        let slot = [...slots].find(s => !s.job);
        if (!slot && slots.size < MAX_WORKERS)
            slot = makeSlot();
        if (!slot)
            return;
        const j = queue.shift()!;
        if (j.settled)
            continue;
        clearTimeout(slot.idle);
        slot.job = j;
        slot.worker.ref();
        try {
            slot.worker.postMessage({ id: j.id, grammar: j.grammar, language: j.language, text: j.text });
        }
        catch (e) {
            slot.job = undefined;
            finish(j, e);
            dispose(slot);
        }
    }
}
export function parseInWorker(grammar: string, language: string, text: string): Promise<any> {
    checkCancelled();
    if (queue.length >= 16)
        return Promise.reject(new AgentError('PARSER_BUSY', 'Parser queue is full; retry a smaller batch.', true));
    if (Buffer.byteLength(text) > 1024 * 1024)
        return Promise.reject(new AgentError('FILE_TOO_LARGE', 'Syntax parsing is limited to 1 MiB per file; use ranged text reads.'));
    const signal = getCallContext()?.signal;
    return new Promise((resolve, reject) => {
        const abortWith = (j: Job, reason: unknown) => {
            const i = queue.indexOf(j);
            if (i >= 0)
                queue.splice(i, 1);
            const s = [...slots].find(s => s.job === j);
            if (s) {
                s.job = undefined;
                dispose(s);
            }
            finish(j, reason);
            pump();
        };
        const j: Job = { id: ++seq, grammar, language, text, resolve, reject, settled: false, signal, timer: setTimeout(() => abortWith(j, new AgentError('PARSER_TIMEOUT', 'Parser exceeded its 8-second budget.', true)), 8000), abort: () => abortWith(j, signal?.reason ?? new AgentError('CANCELLED', 'Parser cancelled.')) };
        signal?.addEventListener('abort', j.abort, { once: true });
        queue.push(j);
        if (signal?.aborted)
            j.abort();
        else
            pump();
    });
}
export function parserStatus() { return { workers: slots.size, queued: queue.length, completed, restarts, maxWorkers: MAX_WORKERS, maxQueue: 16, persistent: false }; }
export function releaseIdleParserWorkers(){for(const s of [...slots])if(!s.job)dispose(s);}
export function closeParserWorkers() { for (const j of queue.splice(0))
    finish(j, new AgentError('CANCELLED', 'Parser pool stopped.')); for (const s of [...slots]) {
    if (s.job)
        finish(s.job, new AgentError('CANCELLED', 'Parser pool stopped.'));
    dispose(s);
} }
