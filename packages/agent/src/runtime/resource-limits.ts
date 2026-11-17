/**
 * Small periodic cache maintenance for RAM-only caches. Never scans or deletes projects or credentials.
 * Timers are unref'd; start/stop hooks are used by cli.ts. Only modules that exist in this build are touched.
 */
import { codeGraph } from './code-graph.js';
import { projectIndex } from './project-index.js';
import { codeCacheStatus, pruneCodeCache } from './code-structure.js';
import { workerCoordinator } from './worker-coordination.js';
import { pruneScratch, SCRATCH_BUDGET } from './scratch-budget.js';

export const CONTEXT_CACHE_BUDGET = 256 * 1024 * 1024;
const SOFT_RSS_BYTES = 300 * 1024 * 1024;
const INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | undefined, lastCheck = 0, evictions = 0, cleanupErrors = 0;

export function cacheStatus() {
    const graphs = codeGraph.status(), files = projectIndex.status(), parser = codeCacheStatus(), workers = workerCoordinator.stats();
    const estimated = workers.patchBytes + parser.bytes
        + graphs.reduce((n, g) => n + g.metadataBytes * 2 + g.nodes * 512, 0) + files.reduce((n, f) => n + f.memoryBytes, 0);
    return { workerCoordination: workers, estimatedRetainedContextBytes: estimated, retainedContextBudgetBytes: CONTEXT_CACHE_BUDGET,
        scratchBudgetBytes: SCRATCH_BUDGET, idleCacheTtlMs: 5 * 60_000, evictions, cleanupErrors, rssBytes: process.memoryUsage().rss,
        note: 'Budgets cover managed RAM cache payloads and BRC scratch, not user projects, installed packages, Docker images or an OS-enforced RSS limit.' };
}

/** Evict idle entries; escalates only when estimated retained bytes or RSS exceed their soft budgets. Throttled to 1/s unless forced. */
export function reclaimCaches(now = Date.now(), force = false): void {
    if (!force && now - lastCheck < 1000) return;
    lastCheck = now;
    try {
        evictions += codeGraph.pruneIdle(now) + projectIndex.pruneIdle(now) + pruneCodeCache(now);
        workerCoordinator.prune(now);
        if (cacheStatus().estimatedRetainedContextBytes > CONTEXT_CACHE_BUDGET)
            evictions += codeGraph.pruneIdle(now, true) + projectIndex.pruneIdle(now, true) + pruneCodeCache(now, true);
        else if (process.memoryUsage().rss > SOFT_RSS_BYTES)
            // Soft pressure response only; RSS is not the sum of cache sizes.
            evictions += codeGraph.pruneIdle(now, false, 60_000) + projectIndex.pruneIdle(now, false, 60_000) + pruneCodeCache(now, false, 60_000);
    } catch { cleanupErrors++; }
}

export async function startResourceMaintenance(intervalMs = INTERVAL_MS): Promise<void> {
    if (timer) return;
    timer = setInterval(() => { reclaimCaches(); void pruneScratch().catch(() => { cleanupErrors++; }); }, intervalMs);
    timer.unref();
    await pruneScratch().catch(() => { cleanupErrors++; });
}
export function stopResourceMaintenance(): void { if (timer) clearInterval(timer); timer = undefined; }
export const resourceMaintenanceRunning = (): boolean => !!timer;
