import { capture } from '../utils/capture.js';
import { Worker } from 'worker_threads';
import type { FuzzyMatch, FuzzySearchMetrics } from './fuzzySearchCore.js';

// Re-export so existing callers keep importing from this module.
export { recursiveFuzzyIndexOf, getSimilarityRatio } from './fuzzySearchCore.js';
import { runFuzzySearch } from './fuzzySearchCore.js';

/** Abort fuzzy search in the worker after this many ms to avoid unbounded CPU burn. */
export const FUZZY_SEARCH_TIMEOUT_MS = 30000;

/**
 * Inline worker entry: imports the dependency-free core module (passed as
 * moduleUrl) and serves searches off the main thread. The core module is
 * deliberately a leaf: importing this module (or anything app-level) from the
 * worker would boot the whole server in the worker. Kept as an eval'd snippet so
 * the worker needs no separate file to ship alongside the compiled output.
 *
 * BRC: the worker is long-lived and handles one request at a time
 * ({id, text, query} -> {id, ok, ...}); starting a worker costs ~50 ms, far more
 * than a typical search.
 */
const WORKER_CODE = `
const { workerData, parentPort } = require('worker_threads');
const core = import(workerData.moduleUrl);
parentPort.on('message', (req) => {
    core.then((m) => {
        parentPort.postMessage({ id: req.id, ok: true, ...m.runFuzzySearch(req.text, req.query) });
    }).catch((err) => {
        parentPort.postMessage({ id: req.id, ok: false, error: String(err && err.stack || err) });
    });
});
`;

const CORE_MODULE_URL = new URL('./fuzzySearchCore.js', import.meta.url).href;

/** BRC: below this size the search runs inline (a few ms), cheaper than any worker round trip. */
export const INLINE_FUZZY_MAX_CHARS = 100_000;
/** BRC: idle workers kept for reuse, and how long an idle worker lives. */
const MAX_IDLE_WORKERS = 2;
const IDLE_WORKER_TTL_MS = 60_000;

type WorkerReply = { id: number; ok: true; result: FuzzyMatch; metrics: FuzzySearchMetrics } | { id: number; ok: false; error: string };

const idleWorkers: { worker: Worker; timer: NodeJS.Timeout }[] = [];
let nextRequestId = 1;

function newWorker(): Worker {
    const worker = new Worker(WORKER_CODE, { eval: true, workerData: { moduleUrl: CORE_MODULE_URL } });
    // Never let a worker keep the server process alive during shutdown.
    worker.unref();
    return worker;
}

function takeWorker(): Worker {
    const idle = idleWorkers.pop();
    if (idle) { clearTimeout(idle.timer); return idle.worker; }
    return newWorker();
}

function releaseWorker(worker: Worker): void {
    if (idleWorkers.length >= MAX_IDLE_WORKERS) { void worker.terminate(); return; }
    const timer = setTimeout(() => {
        const i = idleWorkers.findIndex((w) => w.worker === worker);
        if (i !== -1) idleWorkers.splice(i, 1);
        void worker.terminate();
    }, IDLE_WORKER_TTL_MS);
    timer.unref();
    idleWorkers.push({ worker, timer });
}

/**
 * Fuzzy search that keeps the main MCP event loop responsive. Small texts are
 * searched inline (a few ms); larger ones go to a reused worker thread. Rejects
 * if the scan exceeds timeoutMs, terminating that worker so it doesn't linger.
 * Search metrics are captured here, on the main thread, where the client
 * identity is initialized.
 */
export function runFuzzySearchInWorker(
    text: string,
    query: string,
    timeoutMs: number = FUZZY_SEARCH_TIMEOUT_MS
): Promise<FuzzyMatch> {
    if (text.length <= INLINE_FUZZY_MAX_CHARS) {
        try {
            const { result, metrics } = runFuzzySearch(text, query);
            captureFuzzySearchMetrics(metrics);
            return Promise.resolve(result);
        } catch (err) {
            return Promise.reject(err);
        }
    }
    return new Promise((resolve, reject) => {
        const worker = takeWorker();
        const id = nextRequestId++;
        let settled = false;
        const cleanup = () => {
            settled = true;
            clearTimeout(timer);
            worker.off('message', onMessage);
            worker.off('error', onError);
            worker.off('exit', onExit);
        };

        const timer = setTimeout(() => {
            if (settled) return;
            cleanup();
            void worker.terminate();
            reject(new Error(`Fuzzy search timed out after ${timeoutMs}ms`));
        }, timeoutMs);
        timer.unref();

        const onMessage = (msg: WorkerReply) => {
            if (msg.id !== id || settled) return;
            cleanup();
            releaseWorker(worker);
            if (msg.ok) {
                captureFuzzySearchMetrics(msg.metrics);
                resolve(msg.result);
            } else {
                reject(new Error(`Fuzzy search worker failed: ${msg.error}`));
            }
        };
        const onError = (err: Error) => {
            if (settled) return;
            cleanup();
            reject(err);
        };
        const onExit = (code: number) => {
            if (settled) return;
            cleanup();
            reject(new Error(`Fuzzy search worker exited with code ${code}`));
        };

        worker.on('message', onMessage);
        worker.on('error', onError);
        worker.on('exit', onExit);
        worker.postMessage({ id, text, query });
    });
}

/** Same telemetry events the search used to emit inline, now sent from the main thread. */
function captureFuzzySearchMetrics(metrics: FuzzySearchMetrics): void {
    capture('fuzzy_search_recursive_metrics', metrics.recursive);
    if (metrics.iterative) {
        capture('fuzzy_search_iterative_metrics', metrics.iterative);
    }
}
