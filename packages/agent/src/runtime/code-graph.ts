/** Agent-local, bounded dependency metadata graph. No database, source transcript or disk cache. */
import fs from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import path from 'node:path';
import { rootPath, projectPath, textFile, inside } from './workspace.js';
import { listProjectFiles, slash, sensitive, IGNORED_DIRS } from './project-files.js';
import { parseCode, type ParsedCode } from './code-structure.js';
import { sourceCandidate, languageFor } from './languages.js';
import { AgentError } from './errors.js';
import { checkCancelled } from '../context.js';
type Import = ParsedCode['imports'][number];
export interface GraphNode {
    file: string;
    sha256: string;
    stamp: string;
    language: string;
    provider: string;
    symbols: {
        name: string;
        qualifiedName: string;
        kind: string;
        line: number;
        endLine: number;
        signature: string;
    }[];
    imports: Import[];
    provides: string[];
    truncated: boolean;
    bytes: number;
}
export interface GraphEdge {
    from: string;
    to: string;
    specifier: string;
    line: number;
    kind: string;
    confidence: 'path' | 'module-candidate' | 'namespace-candidate' | 'lexical-candidate';
}
interface Graph {
    root: string;
    accessedAt: number;
    nodes: Map<string, GraphNode>;
    edges: GraphEdge[];
    unresolved: {
        from: string;
        specifier: string;
        line: number;
        reason: string;
    }[];
    files: string[];
    listedAt: number;
    dirty: boolean;
    watcher?: FSWatcher;
    version: number;
    building?: Promise<void>;
    errors: {
        file: string;
        code: string;
    }[];
    partial: boolean;
    enumerationTruncated: boolean;
    scanned: number;
    hits: number;
    misses: number;
    durationMs: number;
    metadataBytes: number;
    goModule?: string;
}
const stamp = (s: import('node:fs').Stats) => `${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`;
const graphKey = (root: string) => process.platform === 'win32' ? root.toLowerCase() : root;
export class CodeGraph {
    private projects = new Map<string, Graph>();
    invalidate(file?: string) { for (const g of this.projects.values())
        if (!file || inside(g.root, file)) {
            g.dirty = true;
            g.version++;
        } }
    status() { return [...this.projects.values()].map(g => ({ root: g.root, nodes: g.nodes.size, edges: g.edges.length, metadataBytes: g.metadataBytes, watching: !!g.watcher, partial: g.partial, lastBuildMs: g.durationMs, reused: g.hits, reparsed: g.misses, persistent: false })); }
    clear(root?: string) { for (const [k, g] of this.projects)
        if (!root || graphKey(root) === k) {
            g.watcher?.close();
            this.projects.delete(k);
        } }
    pruneIdle(now=Date.now(),all=false,ttl=300000){let n=0;for(const g of [...this.projects.values()])if(!g.building&&(all||now-g.accessedAt>ttl)){this.clear(g.root);n++;}return n;}
    async get(raw: string, maxFiles = 300, focus?: string, force = false): Promise<Graph> {
        const root = await rootPath(raw), key = graphKey(root);
        let g = this.projects.get(key);
        if (!g) {
            this.pruneIdle();
            if(this.projects.size >= 4){const oldest=[...this.projects.values()].filter(p=>!p.building).sort((a,b)=>a.accessedAt-b.accessedAt)[0];if(oldest)this.clear(oldest.root);}
            if(this.projects.size >= 4) throw new AgentError('GRAPH_BUSY','All graph slots are active; retry later.');
            g = { root, accessedAt: Date.now(), nodes: new Map(), edges: [], unresolved: [], files: [], listedAt: 0, dirty: true, version: 0, errors: [], partial: false, enumerationTruncated: false, scanned: 0, hits: 0, misses: 0, durationMs: 0, metadataBytes: 0 };
            this.projects.set(key, g);
            const target = g;
            try {
                g.watcher = watch(root, { recursive: true, persistent: false }, (_event, name) => { if (name && slash(String(name)).split('/').some(p => IGNORED_DIRS.includes(p)))
                    return; target.dirty = true; target.version++; });
                g.watcher.on('error', () => { g!.watcher?.close(); g!.watcher = undefined; g!.dirty = true; });
            }
            catch { /* Enumerate on each query when watching is unavailable. */ }
        }
        g.accessedAt = Date.now();
        if (g.building)
            await g.building;
        const entry = g;
        entry.building = this.build(entry, Math.min(1500, Math.max(1, maxFiles)), focus, force).finally(() => { entry.building = undefined; });
        await entry.building;
        return entry;
    }
    private async build(g: Graph, maxFiles: number, focus: string | undefined, force: boolean) {
        const started = Date.now(), version = g.version;
        if (force || g.dirty || !g.watcher || Date.now() - g.listedAt > 5000) {
            const list = await listProjectFiles(g.root, 15000);
            g.files = list.files.filter(sourceCandidate);
            g.enumerationTruncated = list.truncated;
            g.listedAt = Date.now();
        }
        let selected = g.files;
        if (focus) {
            const f = slash(path.relative(g.root, await projectPath(g.root, focus)));
            if (sensitive(f))
                throw new AgentError('SENSITIVE_PATH', 'Secret files are not graph inputs.');
            selected = [f, ...selected.filter(n => n !== f)];
        }
        selected = selected.slice(0, maxFiles);
        const nodes = new Map<string, GraphNode>(), errors: {
            file: string;
            code: string;
        }[] = [];
        let bytes = 0, metadata = 0, hits = 0, misses = 0, next = 0, partial = g.enumerationTruncated || g.files.length > maxFiles, changed = force;
        const worker = async () => {
            while (next < selected.length) {
                checkCancelled();
                const file = selected[next++];
                if (Date.now() - started > 20000 || bytes > 16 * 1024 * 1024 || metadata > 4 * 1024 * 1024) {
                    partial = true;
                    break;
                }
                try {
                    const absolute = await projectPath(g.root, file), s = await fs.stat(absolute);
                    if (!s.isFile())
                        continue;
                    if (s.size > 1024 * 1024) {
                        errors.push({ file, code: 'FILE_TOO_LARGE' });
                        partial = true;
                        continue;
                    }
                    const signature = stamp(s), old = g.nodes.get(file);
                    if (!force && old?.stamp === signature) {
                        nodes.set(file, old);
                        metadata += old.bytes;
                        hits++;
                        continue;
                    }
                    if (bytes + s.size > 16 * 1024 * 1024) {
                        partial = true;
                        break;
                    }
                    bytes += s.size;
                    const p = await parseCode(absolute);
                    checkCancelled();
                    if (stamp(await fs.stat(absolute)) !== signature)
                        throw new AgentError('FILE_CHANGED', 'Source changed during indexing.');
                    const data: GraphNode = { file, stamp: signature, sha256: p.sha256, language: p.language, provider: p.provider, symbols: p.symbols.slice(0, 80).map(({ name, qualifiedName, kind, line, endLine, signature }) => ({ name, qualifiedName, kind, line, endLine, signature })), imports: p.imports.slice(0, 80), provides: p.provides ?? [], truncated: p.truncated || p.symbols.length > 80 || p.imports.length > 80, bytes: 0 };
                    data.bytes = Buffer.byteLength(JSON.stringify(data));
                    metadata += data.bytes;
                    nodes.set(file, data);
                    changed = true;
                    misses++;
                    if (data.truncated)
                        partial = true;
                }
                catch (e) {
                    checkCancelled();
                    errors.push({ file, code: (e as {
                            code?: string;
                        }).code ?? 'UNREADABLE' });
                    partial = true;
                    changed = true;
                }
            }
        };
        await Promise.all([worker(), worker()]);
        if (nodes.size !== g.nodes.size || [...nodes.keys()].some(k => !g.nodes.has(k)))
            changed = true;
        // Enforce the final metadata budget even when two parsing tasks finish concurrently.
        while (metadata > 4 * 1024 * 1024 && nodes.size) {
            const last = [...nodes.entries()].at(-1)!;
            metadata -= last[1].bytes;
            nodes.delete(last[0]);
            partial = true;
            changed = true;
        }
        g.nodes = nodes;
        g.errors = errors.slice(0, 30);
        g.partial = partial || nodes.size < selected.length;
        g.scanned = nodes.size;
        g.hits = hits;
        g.misses = misses;
        g.metadataBytes = metadata;
        g.dirty = g.version !== version;
        // Module path matters for Go imports even if the changed file itself has no declarations.
        try {
            const f = await textFile(await projectPath(g.root, 'go.mod'), 65536);
            const module = /^\s*module\s+([^\s]+)/m.exec(f.text)?.[1];
            if (module !== g.goModule)
                changed = true;
            g.goModule = module;
        }
        catch {
            if (g.goModule)
                changed = true;
            g.goModule = undefined;
        }
        if (changed)
            this.connect(g);
        g.durationMs = Date.now() - started;
    }
    private connect(g: Graph) {
        const edges: GraphEdge[] = [], unresolved: Graph['unresolved'] = [], seen = new Set<string>();
        const namespace = new Map<string, string[]>();
        const addNs = (n: string, f: string) => { const a = namespace.get(n) ?? []; if (a.length < 100 && !a.includes(f))
            a.push(f); namespace.set(n, a); };
        for (const n of g.nodes.values())
            for (const provided of n.provides) {
                addNs(provided, n.file);
                for (const s of n.symbols)
                    addNs(provided + '.' + s.name, n.file);
            }
        const exact = (p: string) => { const rel = slash(path.normalize(p)); return !rel.startsWith('../') && !path.isAbsolute(rel) && g.nodes.has(rel) ? rel : undefined; };
        const findPaths = (base: string, exts: string[]) => {
            const attempts = [base, ...exts.map(e => base + '.' + e), ...exts.map(e => base + '/index.' + e)];
            if (/\.[cm]?js$/.test(base))
                attempts.push(base.replace(/\.[cm]?js$/, '.ts'), base.replace(/\.[cm]?js$/, '.tsx'));
            const matches = [...new Set(attempts.map(exact).filter((f): f is string => !!f))];
            return matches.slice(0, 40);
        };
        for (const node of g.nodes.values())
            for (const imp of node.imports) {
                if (edges.length >= 12000) {
                    g.partial = true;
                    break;
                }
                const spec = imp.specifier.replace(/\\/g, '/');
                let targets: string[] = [], confidence: GraphEdge['confidence'] = 'path';
                const dir = slash(path.posix.dirname(node.file));
                if (imp.kind === 'namespace' || imp.kind === 'java-import' || imp.kind === 'php-namespace' || imp.kind === 'generic-module') {
                    const ns = spec.replace(/::/g, '.').replace(/\//g, '.').replace(/\.\*$/, '');
                    targets = namespace.get(ns) ?? [];
                    confidence = imp.kind === 'generic-module' ? 'lexical-candidate' : 'namespace-candidate';
                }
                else if (node.language === 'python') {
                    const dots = /^\.+/.exec(spec)?.[0].length ?? 0, parts = spec.slice(dots).replace(/\./g, '/');
                    let base = dots ? dir : '.';
                    for (let i = 1; i < dots; i++)
                        base = path.posix.dirname(base);
                    const bases = dots ? [path.posix.join(base, parts)] : [parts, 'src/' + parts];
                    for (const b of bases)
                        targets.push(...findPaths(b, ['py', 'pyi']), ...findPaths(b + '/__init__', ['py', 'pyi']));
                    confidence = 'module-candidate';
                }
                else if (node.language === 'rust') {
                    const rootDir = node.file.startsWith('src/') ? 'src' : '.';
                    let pieces = spec.split('::').filter(Boolean), base = rootDir;
                    const selfBase = /\/(?:lib|main|mod)\.rs$/.test('/' + node.file) ? dir : node.file.replace(/\.rs$/, '');
                    if (imp.kind === 'rust-mod') {
                        base = selfBase;
                        pieces = [spec];
                    }
                    else if (pieces[0] === 'crate')
                        pieces.shift();
                    else if (pieces[0] === 'self') {
                        base = selfBase;
                        pieces.shift();
                    }
                    else if (pieces[0] === 'super') {
                        base = selfBase;
                        while (pieces[0] === 'super') {
                            base = path.posix.dirname(base);
                            pieces.shift();
                        }
                    }
                    else {
                        pieces = [];
                    }
                    while (pieces.length) {
                        const b = path.posix.join(base, ...pieces);
                        targets.push(...findPaths(b, ['rs']), ...findPaths(b + '/mod', ['rs']));
                        if (targets.length)
                            break;
                        pieces.pop();
                    }
                    confidence = 'module-candidate';
                }
                else if (node.language === 'go') {
                    let d: string | undefined;
                    if (spec.startsWith('.'))
                        d = path.posix.normalize(path.posix.join(dir, spec));
                    else if (g.goModule && spec.startsWith(g.goModule + '/'))
                        d = spec.slice(g.goModule.length + 1);
                    if (d)
                        targets = [...g.nodes.values()].filter(n => n.language === 'go' && path.posix.dirname(n.file) === d && !n.file.endsWith('_test.go')).map(n => n.file).slice(0, 40);
                    confidence = 'module-candidate';
                }
                else if (imp.kind !== 'system-include') {
                    if (spec.startsWith('.') || ['include', 'project-reference', 'generic-path', 'relative'].includes(imp.kind ?? '') || node.language === 'dart' && !spec.includes(':')) {
                        const b = path.posix.normalize(path.posix.join(dir, spec));
                        targets = findPaths(b, ['javascript', 'typescript', 'tsx'].includes(node.language) ? ['ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs'] : languageFor(node.file).extensions);
                        if (!targets.length && !path.posix.extname(b))
                            targets = [...g.nodes.keys()].filter(f => f.startsWith(b + '.')).slice(0, 10);
                    }
                    if (imp.kind?.startsWith('generic'))
                        confidence = 'lexical-candidate';
                }
                targets = [...new Set(targets)].filter(f => f !== node.file);
                if (!targets.length) {
                    if (unresolved.length < 4000)
                        unresolved.push({ from: node.file, specifier: imp.specifier, line: imp.line, reason: 'external, dynamic, alias, unsupported resolution, or outside scanned subset' });
                    else
                        g.partial = true;
                }
                for (const to of targets) {
                    const key = node.file + '\0' + to + '\0' + imp.line;
                    if (seen.has(key))
                        continue;
                    seen.add(key);
                    edges.push({ from: node.file, to, specifier: imp.specifier, line: imp.line, kind: imp.kind ?? 'import', confidence });
                }
            }
        g.edges = edges;
        g.unresolved = unresolved;
    }
    async related(root: string, file: string, maxFiles = 300) {
        const absolute = await projectPath(await rootPath(root), file), g = await this.get(root, maxFiles, file), rel = slash(path.relative(g.root, absolute)), node = g.nodes.get(rel);
        if (!node)
            throw new AgentError('GRAPH_INPUT_UNAVAILABLE', 'File could not be indexed. Use direct ranged reads and inspect graph limits.');
        const outgoing = g.edges.filter(e => e.from === rel), incoming = g.edges.filter(e => e.to === rel);
        return { root: g.root, file: absolute, sha256: node.sha256, language: node.language, provider: node.provider, imports: node.imports.map(i => { const targets = outgoing.filter(e => e.specifier === i.specifier && e.line === i.line); return { ...i, resolved: targets.length === 1 ? targets[0].to : null, candidates: targets.map(e => ({ path: e.to, confidence: e.confidence })) }; }), importers: [...new Set(incoming.map(e => e.from))].slice(0, 100), edges: [...outgoing, ...incoming].slice(0, 200), scannedFiles: g.scanned, stale: g.dirty, truncated: g.partial || incoming.length + outgoing.length > 200, unreadable: g.errors, cache: { reused: g.hits, reparsed: g.misses, durationMs: g.durationMs, persistent: false }, note: 'Syntax/path relationships and explicitly labeled namespace/module/text candidates, not compiler-resolved dependencies. Unresolved imports are not silently guessed. Graph freshness uses file metadata; read source/hash again before edits.' };
    }
    async query(root: string, file: string | undefined, direction = 'both', depth = 1, limit = 100, maxFiles = 300, force = false) {
        const g = await this.get(root, maxFiles, file, force);
        let nodes = [...g.nodes.values()], edges = g.edges;
        if (file) {
            const name = slash(path.relative(g.root, await projectPath(g.root, file))), visited = new Set([name]);
            let frontier = [name];
            for (let d = 0; d < depth; d++) {
                const next: string[] = [];
                for (const edge of g.edges) {
                    let n: string | undefined;
                    if (direction !== 'importers' && frontier.includes(edge.from))
                        n = edge.to;
                    if (direction !== 'dependencies' && frontier.includes(edge.to))
                        n = edge.from;
                    if (n && !visited.has(n) && visited.size < limit) {
                        visited.add(n);
                        next.push(n);
                    }
                }
                frontier = next;
                if (!frontier.length)
                    break;
            }
            nodes = nodes.filter(n => visited.has(n.file));
            edges = edges.filter(e => visited.has(e.from) && visited.has(e.to));
        }
        const selected = nodes.slice(0, limit), selectedPaths = new Set(selected.map(n => n.file));
        edges = edges.filter(e => selectedPaths.has(e.from) && selectedPaths.has(e.to));
        return { root: g.root, nodes: selected.map(({ file, sha256, language, provider, symbols, truncated }) => ({ file, sha256, language, provider, symbols: symbols.slice(0, 20).map(({ name, qualifiedName, kind, line, endLine }) => ({ name, qualifiedName, kind, line, endLine })), truncated: truncated || symbols.length > 20 })), edges: edges.slice(0, 500), unresolved: g.unresolved.filter(i => selectedPaths.has(i.from)).slice(0, 100), scannedFiles: g.scanned, stale: g.dirty, truncated: g.partial || nodes.length > limit || edges.length > 500, errors: g.errors, cache: { reused: g.hits, reparsed: g.misses, durationMs: g.durationMs, metadataBytes: g.metadataBytes, persistent: false }, semantics: 'A bounded file/import candidate graph, not a runtime call graph, type system or test coverage graph.' };
    }
}
export const codeGraph = new CodeGraph();
