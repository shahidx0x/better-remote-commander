/** Single invalidation point for RAM-only navigation caches (project index, code graph). */
import { projectIndex } from './project-index.js';
import { codeGraph } from './code-graph.js';

export function invalidateNavCaches(file?: string): void {
    projectIndex.invalidate(file);
    codeGraph.invalidate(file);
}
export function pruneNavCaches(all = false): void {
    projectIndex.pruneIdle(Date.now(), all);
    codeGraph.pruneIdle(Date.now(), all);
}
