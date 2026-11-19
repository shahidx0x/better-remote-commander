/** Idle cache and bounded owned-state maintenance. Never scans/deletes user projects, plugin installs, pairing credentials or relay data. */
import { codeGraph } from './code-graph.js';
import { workerCoordinator } from './worker-coordination.js';
import { projectIndex } from './project-index.js';
import { codeCacheStatus, pruneCodeCache } from './code-structure.js';
import { releaseIdleParserWorkers } from './parser-pool.js';
import { pruneHarnessSessions } from './harness.js';
import { pruneScratch, SCRATCH_BUDGET } from './scratch-budget.js';
import { getResourceProfileStatus } from './resource-profile.js';
import {semanticTsManager} from './semantic-ts-host.js';
import {sharedProjectManifest} from './project-manifest.js';
import {sweepOperationalRetention,operationalRetentionStatus} from './operational-retention.js';
export const CONTEXT_CACHE_BUDGET = 128 * 1024 * 1024;
let timer: NodeJS.Timeout | undefined, idleTimer: NodeJS.Timeout | undefined;
let lastCheck = 0, evictions = 0, cleanupErrors = 0, activeCalls = 0;
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
    if (activeCalls || idleTimer) return;
    idleTimer = setTimeout(() => {
        idleTimer = undefined;
        if (activeCalls) return;
        const now = Date.now();
        evictions += codeGraph.pruneIdle(now, false, IDLE_RELEASE_MS)
            + projectIndex.pruneIdle(now, false, IDLE_RELEASE_MS)
            + pruneCodeCache(now, false, IDLE_RELEASE_MS);
        releaseIdleParserWorkers();
        sharedProjectManifest.pruneIdle(now);
        semanticTsManager.releaseIdle(now);
        pruneHarnessSessions(now);
        workerCoordinator.prune(now);
    }, IDLE_RELEASE_MS);
    idleTimer.unref();
}
export function cacheStatus() {
    const graphs = codeGraph.status(), files = projectIndex.status(), parser = codeCacheStatus();
    const workers = workerCoordinator.stats();
    const estimated = workers.estimatedRetainedBytes + parser.bytes + graphs.reduce((n, g) => n + g.metadataBytes * 2 + g.nodes * 512, 0) + files.reduce((n, f) => n + f.memoryBytes, 0) + sharedProjectManifest.status().retainedBytes;
    const hardware = getResourceProfileStatus();
    return { workerCoordination: workers, estimatedRetainedContextBytes: estimated, retainedContextBudgetBytes: CONTEXT_CACHE_BUDGET,
        diskContextCacheBytes: 0, scratchBudgetBytes: SCRATCH_BUDGET, idleCacheTtlMs: IDLE_RELEASE_MS,
        resourceProfile: hardware.profile, resourceProfileSelection: hardware.selection, resourceProfileReason: hardware.reason,
        hardware: { cpuParallelism: hardware.cpuParallelism, totalMemoryBytes: hardware.totalMemoryBytes, freeMemoryBytesAtStartup: hardware.freeMemoryBytes,
            maxConcurrentJobs: hardware.maxConcurrentJobs, maxToolConcurrency: hardware.maxToolConcurrency, parserWorkers: hardware.parserWorkers },
        lowResourceMode: false, activeToolCalls: activeCalls,
        semanticNavigation:semanticTsManager.status(),
        sharedProjectManifest:sharedProjectManifest.status(),
        operationalRetention:operationalRetentionStatus(),
        evictions, cleanupErrors, rssBytes: process.memoryUsage().rss,
        note: 'Budgets cover managed cache payloads and BRC scratch, not installed packages, user projects, Docker images, operational authentication databases or an OS-enforced total RSS limit. Native decoding/parser allocations and JS object overhead are reported separately through process memory.' };
}
export function reclaimCaches(now = Date.now(), force = false) {
    if (!force && now - lastCheck < 1000)
        return;
    lastCheck = now;
    evictions += codeGraph.pruneIdle(now) + projectIndex.pruneIdle(now) + pruneCodeCache(now) + sharedProjectManifest.pruneIdle(now);
    pruneHarnessSessions(now);
    workerCoordinator.prune(now);
    semanticTsManager.releaseIdle(now);
    if (cacheStatus().estimatedRetainedContextBytes > CONTEXT_CACHE_BUDGET) {
        evictions += codeGraph.pruneIdle(now, true) + projectIndex.pruneIdle(now, true) + pruneCodeCache(now, true) + sharedProjectManifest.pruneIdle(now,true);
        releaseIdleParserWorkers();
    }
    // Soft pressure response is not a promise that RSS equals the sum of cache sizes.
    if (process.memoryUsage().rss > 192 * 1024 * 1024) {
        evictions += codeGraph.pruneIdle(now, false, 60000) + projectIndex.pruneIdle(now, false, 60000) + pruneCodeCache(now, false, 60000);
        releaseIdleParserWorkers();
    }
}
export async function startResourceMaintenance() {
    if (timer) return;
    // Do not traverse scratch folders during startup. Defer that disk work until
    // the agent has been idle and the five-minute maintenance interval has elapsed.
    let lastScratch = Date.now();
    let maintenanceInFlight:Promise<void>|undefined;
    timer = setInterval(() => {
        if (activeCalls) return;
        reclaimCaches();
        if (Date.now() - lastScratch >= 5 * 60000 && !maintenanceInFlight) {
            lastScratch = Date.now();
            // Idle-time cleanup of explicitly owned operational state only.
            maintenanceInFlight=Promise.allSettled([pruneScratch(),sweepOperationalRetention()]).then(results=>{
                cleanupErrors+=results.filter(x=>x.status==='rejected').length;
            }).finally(()=>{maintenanceInFlight=undefined;});
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
