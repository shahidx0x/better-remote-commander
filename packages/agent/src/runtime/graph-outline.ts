/**
 * Reversible-by-reference graph context projection.
 *
 * This compresses the *wire representation* of existing RAM graph metadata; it
 * never compresses or overwrites source code, history, prompts, or a model
 * conversation. File hashes, exact declaration line ranges and edge confidence
 * stay available, and callers rehydrate source via read_file/read_symbol.
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
  const ranked = [...graph.nodes].sort((a, b) => {
    const score = (n: typeof a) =>
      (n.file.toLowerCase() === focused ? 1000 : 0)
      + (query && n.file.toLowerCase().includes(query) ? 60 : 0)
      + (query ? n.symbols.filter(s => s.qualifiedName.toLowerCase().includes(query)).length * 20 : 0);
    return score(b) - score(a);
  });
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
    note: 'Outline only; no source is stored or hidden in this response. Retrieve exact lines with read_file/read_symbol, validate current SHA-256 before edits. Source graph is RAM-only and may be stale. No LLM compression/proxy or graph database is used.',
    charactersBefore: JSON.stringify(graph).length,
  };
  const size = () => JSON.stringify(out).length;
  // Allocate metadata by a hard character budget. Never emit an invalid index.
  for (const node of ranked) {
    const fileId = out.files.length;
    const file: FileEntry = [node.file, node.sha256, node.language];
    out.files.push(file);
    if (size() > budget) { out.files.pop(); out.coverage.omittedFiles++; out.partial = true; continue; }
    index.set(node.file, fileId);
    const relevant = query
      ? [...node.symbols].sort((a, b) => Number(b.qualifiedName.toLowerCase().includes(query)) - Number(a.qualifiedName.toLowerCase().includes(query)))
      : node.symbols;
    const count = Math.min(options.maxSymbolsPerFile ?? 8, relevant.length);
    for (let i = 0; i < relevant.length; i++) {
      if (i >= count) { out.coverage.omittedDeclarations++; continue; }
      const sym = relevant[i];
      out.declarations.push([fileId, sym.qualifiedName, sym.kind, sym.line, sym.endLine]);
      if (size() > budget) { out.declarations.pop(); out.coverage.omittedDeclarations++; out.partial = true; }
    }
  }
  for (const edge of graph.edges) {
    const from = index.get(edge.from), to = index.get(edge.to);
    if (from === undefined || to === undefined) { out.coverage.omittedRelations++; continue; }
    out.relations.push([from, to, edge.kind, edge.confidence]);
    if (size() > budget) { out.relations.pop(); out.coverage.omittedRelations++; out.partial = true; }
  }
  for (const item of graph.unresolved) {
    const from = index.get(item.from);
    if (from === undefined) { out.coverage.omittedUnresolved++; continue; }
    out.unresolved.push([from, item.specifier, item.line]);
    if (size() > budget) { out.unresolved.pop(); out.coverage.omittedUnresolved++; out.partial = true; }
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
