/** Small, periodic cache maintenance. Does not scan/delete projects or operational credentials. */
import { codeGraph } from './code-graph.js';
import { workerCoordinator } from './worker-coordination.js';
import { projectIndex } from './project-index.js';
import { codeCacheStatus, pruneCodeCache } from './code-structure.js';
import { releaseIdleParserWorkers } from './parser-pool.js';
import { pruneHarnessSessions } from './harness.js';
import { pruneScratch, SCRATCH_BUDGET } from './scratch-budget.js';
export const CONTEXT_CACHE_BUDGET = 256 * 1024 * 1024;
let timer: NodeJS.Timeout | undefined, idleTimer: NodeJS.Timeout | undefined;
let lastCheck = 0, evictions = 0, cleanupErrors = 0, activeCalls = 0;
const RESPONSIVE_PROFILE = process.env.BRC_RESOURCE_PROFILE === 'responsive' || process.env.BRC_LOW_RESOURCE_MODE === '1';
// Keep a short-lived working set for fast repeated edits/navigation. Release
// idle worker/cache references after a minute; under memory pressure prune sooner.
const IDLE_RELEASE_MS = 60_000;

/** Release agent-owned caches shortly after the LAST tool finishes, never during work.
 * V8 manages garbage collection; forcing full GC would cause new CPU spikes. */
export function markToolStarted(): void {
    activeCalls++;
    clearTimeout(idleTimer);
    idleTimer = undefined;
}
export function markToolFinished(): void {
    activeCalls = Math.max(0, activeCalls - 1);
    if (!RESPONSIVE_PROFILE || activeCalls || idleTimer) return;
    idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (activeCalls) return;
        const now = Date.now();
        evictions += codeGraph.pruneIdle(now, false, IDLE_RELEASE_MS)
            + projectIndex.pruneIdle(now, false, IDLE_RELEASE_MS)
            + pruneCodeCache(now, false, IDLE_RELEASE_MS);
        releaseIdleParserWorkers();
        pruneHarnessSessions(now);
        workerCoordinator.prune(now);
    }, IDLE_RELEASE_MS);
    idleTimer.unref();
}
export function cacheStatus() {
    const graphs = codeGraph.status(), files = projectIndex.status(), parser = codeCacheStatus();
    const workers = workerCoordinator.stats();
    const estimated = workers.estimatedRetainedBytes + parser.bytes + graphs.reduce((n, g) => n + g.metadataBytes * 2 + g.nodes * 512, 0) + files.reduce((n, f) => n + f.memoryBytes, 0);
    return { workerCoordination: workers, estimatedRetainedContextBytes: estimated, retainedContextBudgetBytes: CONTEXT_CACHE_BUDGET,
        diskContextCacheBytes: 0, scratchBudgetBytes: SCRATCH_BUDGET, idleCacheTtlMs: RESPONSIVE_PROFILE ? IDLE_RELEASE_MS : 5 * 60000,
        resourceProfile: RESPONSIVE_PROFILE ? 'responsive' : 'normal', lowResourceMode: process.env.BRC_LOW_RESOURCE_MODE === '1', activeToolCalls: activeCalls,
        evictions, cleanupErrors, rssBytes: process.memoryUsage().rss,
        note: 'Budgets cover managed cache payloads and BRC scratch, not installed packages, user projects, Docker images, operational authentication databases or an OS-enforced total RSS limit. Native decoding/parser allocations and JS object overhead are reported separately through process memory.' };
}
export function reclaimCaches(now = Date.now(), force = false) {
    if (!force && now - lastCheck < (RESPONSIVE_PROFILE ? 5000 : 1000))
        return;
    lastCheck = now;
    evictions += codeGraph.pruneIdle(now) + projectIndex.pruneIdle(now) + pruneCodeCache(now);
    pruneHarnessSessions(now);
    workerCoordinator.prune(now);
    if (cacheStatus().estimatedRetainedContextBytes > CONTEXT_CACHE_BUDGET) {
        evictions += codeGraph.pruneIdle(now, true) + projectIndex.pruneIdle(now, true) + pruneCodeCache(now, true);
        releaseIdleParserWorkers();
    }
    // Soft pressure response is not a promise that RSS equals the sum of cache sizes.
    if (process.memoryUsage().rss > 256 * 1024 * 1024) {
        evictions += codeGraph.pruneIdle(now, false, 60000) + projectIndex.pruneIdle(now, false, 60000) + pruneCodeCache(now, false, 60000);
        releaseIdleParserWorkers();
    }
}
export async function startResourceMaintenance() {
    // Responsive mode has no polling loop: per-tool cleanup and on-demand
    // scratch allocation handle maintenance, leaving CPU idle between calls.
    if (RESPONSIVE_PROFILE || timer)
        return;
    await pruneScratch().catch(() => { cleanupErrors++; });
    // Cache checks are cheap; scratch traversal can be expensive and is done
    // separately only every five minutes when the agent is idle.
    let lastScratch = Date.now();
    timer = setInterval(() => {
        if (activeCalls) return;
        reclaimCaches();
        if (Date.now() - lastScratch >= 5 * 60000) {
            lastScratch = Date.now();
            void pruneScratch().catch(() => { cleanupErrors++; });
        }
    }, 30000);
    timer.unref();
}
export function stopResourceMaintenance() {
    clearInterval(timer);
    clearTimeout(idleTimer);
    timer = undefined;
    idleTimer = undefined;
}
