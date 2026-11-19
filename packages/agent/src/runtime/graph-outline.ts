/**
 * Reversible-by-reference graph context projection.
 *
 * This compresses the *wire representation* of existing RAM graph metadata; it
 * never compresses or overwrites source code, history, prompts, or a model
 * conversation. File hashes, exact declaration line ranges and edge confidence
 * stay available, and callers rehydrate source via read_code_ranges/read_file.
 */
import type { CodeGraph } from './code-graph.js';

export type GraphSnapshot = Awaited<ReturnType<CodeGraph['query']>>;

type FileEntry = [path: string, sha256: string, language: string];
type Declaration = [file: number, qualifiedName: string, kind: string, start: number, end: number];
type Dependency = [from: number, to: number, kind: string, confidence: string];
type Unresolved = [from: number, specifier: string, line: number];

export interface CompactGraph extends Record<string, unknown> {
  format: 'graph-outline-v1';
  root: string;
  legend: { files: string; declarations: string; relations: string; unresolved: string };
  files: FileEntry[];
  declarations: Declaration[];
  relations: Dependency[];
  unresolved: Unresolved[];
  coverage: { scannedFiles: number; returnedFiles: number; omittedFiles: number; omittedDeclarations: number; omittedRelations: number; omittedUnresolved: number };
  stale: boolean;
  partial: boolean;
  cache: { reused: number; reparsed: number; durationMs: number; persistent: false };
  note: string;
  charactersBefore: number;
}

/** Bound output bytes, rank relevant files first, keep every reference resolvable. */
export function compactGraph(
  graph: GraphSnapshot,
  options: { maxChars?: number; focus?: string; query?: string; maxSymbolsPerFile?: number } = {},
): CompactGraph {
  const budget = Math.min(48000, Math.max(2000, options.maxChars ?? 12000));
  const query = (options.query ?? '').trim().toLowerCase();
  const focused = (options.focus ?? '').replace(/\\/g, '/').toLowerCase();
  // Compute relevance once per node, not repeatedly inside sort comparisons.
  // This matters when many files have large symbol tables.
  const ranked = graph.nodes.map(node => ({
    node,
    score: (node.file.toLowerCase() === focused ? 1000 : 0)
      + (query && node.file.toLowerCase().includes(query) ? 60 : 0)
      + (query ? node.symbols.reduce((n, s) => n + Number(s.qualifiedName.toLowerCase().includes(query)), 0) * 20 : 0),
  })).sort((a, b) => b.score - a.score).map(v => v.node);
  const index = new Map<string, number>();
  const out: CompactGraph = {
    format: 'graph-outline-v1', root: graph.root,
    legend: {
      files: '[relativePath, sha256, language]; zero-based array index is the file ID',
      declarations: '[fileID, qualifiedName, kind, startLine, endLine] (inclusive 1-based source lines)',
      relations: '[fromFileID, toFileID, importKind, confidence] (candidate, not guaranteed semantic binding)',
      unresolved: '[fromFileID, specifier, line] (intentionally unresolved)',
    },
    files: [], declarations: [], relations: [], unresolved: [],
    coverage: { scannedFiles: graph.scannedFiles, returnedFiles: 0, omittedFiles: 0, omittedDeclarations: 0, omittedRelations: 0, omittedUnresolved: 0 },
    stale: graph.stale, partial: graph.truncated,
    cache: { reused: graph.cache.reused, reparsed: graph.cache.reparsed, durationMs: graph.cache.durationMs, persistent: false },
    note: 'Outline only; no source is stored or hidden in this response. Retrieve exact lines with read_code_ranges/read_file, validate current SHA-256 before edits. Source graph is RAM-only and may be stale. No LLM compression/proxy or graph database is used.',
    charactersBefore: JSON.stringify(graph).length,
  };
  const size = () => JSON.stringify(out).length;
  // Fixed metadata is serialized once. Each appended array element increases
  // JSON length by exactly its serialized length plus one optional comma.
  // Reserve 64 characters for growing omission counters and "partial".
  // The final exact size guard below still enforces the public hard budget.
  let projected = size();
  const addWithinBudget = <T>(items:T[], value:T): boolean => {
    const delta=JSON.stringify(value).length + (items.length ? 1 : 0);
    if(projected + delta > budget - 64)return false;
    items.push(value);
    projected += delta;
    return true;
  };
  // Allocate metadata by a hard character budget. Never emit an invalid index.
  for (const node of ranked) {
    const fileId = out.files.length;
    const file: FileEntry = [node.file, node.sha256, node.language];
    if (!addWithinBudget(out.files,file)) { out.coverage.omittedFiles++; out.partial = true; continue; }
    index.set(node.file, fileId);
    const relevant = query
      ? [...node.symbols].sort((a, b) => Number(b.qualifiedName.toLowerCase().includes(query)) - Number(a.qualifiedName.toLowerCase().includes(query)))
      : node.symbols;
    const count = Math.min(options.maxSymbolsPerFile ?? 8, relevant.length);
    for (let i = 0; i < relevant.length; i++) {
      if (i >= count) { out.coverage.omittedDeclarations++; continue; }
      const sym = relevant[i];
      if (!addWithinBudget(out.declarations,
        [fileId, sym.qualifiedName, sym.kind, sym.line, sym.endLine] as Declaration)) {
        out.coverage.omittedDeclarations++; out.partial = true;
      }
    }
  }
  for (const edge of graph.edges) {
    const from = index.get(edge.from), to = index.get(edge.to);
    if (from === undefined || to === undefined) { out.coverage.omittedRelations++; continue; }
    if (!addWithinBudget(out.relations,[from, to, edge.kind, edge.confidence] as Dependency)) {
      out.coverage.omittedRelations++; out.partial = true;
    }
  }
  for (const item of graph.unresolved) {
    const from = index.get(item.from);
    if (from === undefined) { out.coverage.omittedUnresolved++; continue; }
    if (!addWithinBudget(out.unresolved,[from, item.specifier, item.line] as Unresolved)) {
      out.coverage.omittedUnresolved++; out.partial = true;
    }
  }
  out.coverage.returnedFiles = out.files.length;
  out.coverage.omittedFiles += graph.nodes.length - out.files.length - out.coverage.omittedFiles;
  if (Object.values(out.coverage).some((v,i) => i > 1 && v > 0)) out.partial = true;
  // Final size guard includes counters changing digit lengths. Drop lower-priority
  // entries first; file IDs are stable because files are dropped only from the tail.
  while (size() > budget && out.unresolved.length) { out.unresolved.pop(); out.coverage.omittedUnresolved++; out.partial = true; }
  while (size() > budget && out.relations.length) { out.relations.pop(); out.coverage.omittedRelations++; out.partial = true; }
  while (size() > budget && out.declarations.length) { out.declarations.pop(); out.coverage.omittedDeclarations++; out.partial = true; }
  while (size() > budget && out.files.length) {
    const fileId = out.files.length - 1;
    out.files.pop();
    out.declarations = out.declarations.filter(d => d[0] !== fileId);
    out.relations = out.relations.filter(r => r[0] !== fileId && r[1] !== fileId);
    out.unresolved = out.unresolved.filter(r => r[0] !== fileId);
    out.coverage.omittedFiles++; out.partial = true;
  }
  out.coverage.returnedFiles = out.files.length;
  return out;
}
