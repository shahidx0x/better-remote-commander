/** Small, periodic cache maintenance. Does not scan/delete projects or operational credentials. */
import { codeGraph } from './code-graph.js';
import { projectIndex } from './project-index.js';
import { codeCacheStatus, pruneCodeCache } from './code-structure.js';
import { releaseIdleParserWorkers } from './parser-pool.js';
import { pruneHarnessSessions } from './harness.js';
import { pruneScratch, SCRATCH_BUDGET } from './scratch-budget.js';
export const CONTEXT_CACHE_BUDGET = 256 * 1024 * 1024;
let timer: NodeJS.Timeout | undefined, lastCheck = 0, evictions = 0, cleanupErrors = 0;
export function cacheStatus() {
    const graphs = codeGraph.status(), files = projectIndex.status(), parser = codeCacheStatus();
    const estimated = parser.bytes + graphs.reduce((n, g) => n + g.metadataBytes * 2 + g.nodes * 512, 0) + files.reduce((n, f) => n + f.memoryBytes, 0);
    return { estimatedRetainedContextBytes: estimated, retainedContextBudgetBytes: CONTEXT_CACHE_BUDGET,
        diskContextCacheBytes: 0, scratchBudgetBytes: SCRATCH_BUDGET, idleCacheTtlMs: 5 * 60000,
        evictions, cleanupErrors, rssBytes: process.memoryUsage().rss,
        note: 'Budgets cover managed cache payloads and BRC scratch, not installed packages, user projects, Docker images, operational authentication databases or an OS-enforced total RSS limit. Native decoding/parser allocations and JS object overhead are reported separately through process memory.' };
}
export function reclaimCaches(now = Date.now(), force = false) {
    if (!force && now - lastCheck < 1000)
        return;
    lastCheck = now;
    evictions += codeGraph.pruneIdle(now) + projectIndex.pruneIdle(now) + pruneCodeCache(now);
    pruneHarnessSessions(now);
    if (cacheStatus().estimatedRetainedContextBytes > CONTEXT_CACHE_BUDGET) {
        evictions += codeGraph.pruneIdle(now, true) + projectIndex.pruneIdle(now, true) + pruneCodeCache(now, true);
        releaseIdleParserWorkers();
    }
    // Soft pressure response is not a promise that RSS equals the sum of cache sizes.
    if (process.memoryUsage().rss > 300 * 1024 * 1024) {
        evictions += codeGraph.pruneIdle(now, false, 60000) + projectIndex.pruneIdle(now, false, 60000) + pruneCodeCache(now, false, 60000);
        releaseIdleParserWorkers();
    }
}
export async function startResourceMaintenance() {
    if (timer)
        return;
    await pruneScratch().catch(() => { cleanupErrors++; });
    timer = setInterval(() => { reclaimCaches(); void pruneScratch().catch(() => { cleanupErrors++; }); }, 60000);
    timer.unref();
}
export function stopResourceMaintenance() { clearInterval(timer); timer = undefined; }
