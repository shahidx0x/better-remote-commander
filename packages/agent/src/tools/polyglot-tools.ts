/** Language-neutral context assembly, graph navigation and same-process session handoff. */
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolResult } from 'brc-shared';
import type { ToolDefinition } from '../core/tool-definitions.js';
import { languageCapabilities } from '../runtime/languages.js';
import { codeCacheStatus } from '../runtime/code-structure.js';
import { codeGraph } from '../runtime/code-graph.js';
import { compactGraph } from '../runtime/graph-outline.js';
import { rootPath, projectPath, gatherContext, textFile, slash } from '../runtime/workspace.js';
import { codingSession } from '../runtime/harness.js';
import { checkCancelled } from '../context.js';
import { result, AgentError } from '../runtime/errors.js';
const GraphSchema = z.object({ path: z.string().min(1), action: z.enum(['query', 'refresh', 'status', 'clear']).default('query'), format: z.enum(['full', 'compact']).default('full'), maxChars: z.number().int().min(2000).max(48000).default(12000), file: z.string().optional(), direction: z.enum(['both', 'dependencies', 'importers']).default('both'), depth: z.number().int().min(1).max(3).default(1), limit: z.number().int().min(1).max(100).default(30), maxFiles: z.number().int().min(1).max(1500).default(300) });
const PackSchema = z.object({ path: z.string().min(1), focus: z.string().optional(), mode: z.enum(['balanced', 'outline']).default('balanced'), query: z.string().max(200).default(''), maxChars: z.number().int().min(4000).max(48000).default(20000), maxFiles: z.number().int().min(1).max(1000).default(200) });
const HandoffSchema = z.object({ sessionId: z.string().min(1), maxChanges: z.number().int().min(1).max(100).default(30) });
async function contextPack(raw: unknown): Promise<ToolResult> {
    const a = PackSchema.parse(raw), root = await rootPath(a.path), context = await gatherContext(root, a.focus, Math.floor(a.maxChars * .35));
    const graph = await codeGraph.query(root, a.focus, 'both', 1, 30, a.maxFiles);
    if (a.mode === 'outline') {
        // Model-neutral hierarchical context: the first tier retains file IDs,
        // symbols, line ranges and relationships, but sends NO raw source snippets.
        // The model expands only relevant ranges with existing exact read tools.
        const instructions = context.instructions.slice(0, 6).map(i => ({ ...i }));
        const project = { packageManager: context.package.packageManager, frameworks: context.package.frameworks };
        const output: Record<string, unknown> = {
            root, focus: a.focus, query: a.query, mode: 'outline', project, instructions,
            graph: compactGraph(graph, { maxChars: Math.min(12000, Math.floor(a.maxChars * .7)), focus: a.focus, query: a.query }),
            warnings: context.warnings.slice(0, 4), persistent: false,
            note: 'Retrieval-first context: choose references from graph.files/declarations, then call read_code_ranges or read_symbol for exact source. File hashes here reflect graph-index time, NOT fresh reads. No model call, conversation proxy or graph database.',
        };
        // Scoped instructions are never compressed into guessed paraphrases; if
        // needed omit them with an explicit partial marker, not silent truncation.
        while (JSON.stringify(output).length > a.maxChars - 80 && instructions.length) {
            instructions.pop();
            output.partial = true;
        }
        while (JSON.stringify(output).length > a.maxChars - 80) {
            const g = output.graph as ReturnType<typeof compactGraph>;
            if (g.unresolved.length) { g.unresolved.pop(); g.coverage.omittedUnresolved++; }
            else if (g.relations.length) { g.relations.pop(); g.coverage.omittedRelations++; }
            else if (g.declarations.length) { g.declarations.pop(); g.coverage.omittedDeclarations++; }
            else if (g.files.length) { g.files.pop(); g.coverage.omittedFiles++; g.coverage.returnedFiles--; }
            else break;
            g.partial = true; output.partial = true;
        }
        const out = result(output);
        out.content = [{ type: 'text', text: JSON.stringify(output) }];
        return out;
    }
    const q = a.query.toLowerCase();
    const focused = a.focus ? slash(path.relative(root, path.resolve(root, a.focus))) : undefined;
    const ranked = [...graph.nodes].sort((a, b) => { const score = (n: typeof a) => (n.file === focused ? 10000 : 0) + (n.file.toLowerCase().includes(q) ? 2 : 0) + n.symbols.filter(s => s.qualifiedName.toLowerCase().includes(q)).length; return score(b) - score(a); });
    const instructions = context.instructions.slice(0, 12);
    const data: Record<string, any> = { root, focus: a.focus, query: a.query, instructions, project: { packageManager: context.package.packageManager, frameworks: context.package.frameworks }, files: [], relations: graph.edges.slice(0, 50), warnings: context.warnings.slice(0, 5), partial: graph.truncated, persistent: false,
        note: 'Budgeted just-in-time source context. Graph edges are candidates; returned snippets/hashes are read fresh. No extra model calls, embeddings, database or saved transcript.' };
    // Bound metadata too, not just source text. Instructions are scoped data, never auto-executed.
    while (JSON.stringify(data).length > a.maxChars * .6 && instructions.length) {
        const item = instructions[instructions.length - 1];
        if (typeof item.text === 'string' && item.text.length > 500) {
            item.text = item.text.slice(0, 500);
            item.truncated = true;
        }
        else
            instructions.pop();
        data.partial = true;
    }
    for (const node of ranked.slice(0, 12)) {
        checkCancelled();
        const remaining = a.maxChars - JSON.stringify(data).length - 1000;
        if (remaining < 500) {
            data.partial = true;
            break;
        }
        try {
            const fresh = await textFile(await projectPath(root, node.file), 1024 * 1024), lines = fresh.text.split('\n');
            const selected = (q ? node.symbols.filter(s => s.qualifiedName.toLowerCase().includes(q)) : node.symbols).slice(0, 4);
            const startLine = selected[0]?.line ?? 1, endLine = Math.min(lines.length, startLine + 50), text = lines.slice(Math.max(0, startLine - 2), endLine).join('\n');
            const entry = { file: node.file, language: node.language, provider: node.provider, sha256: fresh.sha256, startLine: Math.max(1, startLine - 1), endLine, symbols: selected, text: text.slice(0, Math.min(remaining - 500, 5000)), truncated: text.length > Math.min(remaining - 500, 5000), graphChangedSinceRead: fresh.sha256 !== node.sha256 };
            if (JSON.stringify(data).length + JSON.stringify(entry).length > a.maxChars) {
                data.partial = true;
                break;
            }
            data.files.push(entry);
        }
        catch (e) {
            data.warnings.push({ file: node.file, error: (e as Error).message.slice(0, 150) });
            data.partial = true;
        }
    }
    // The budget covers compact metadata + snippets, including unexpectedly long paths/signatures.
    while (JSON.stringify(data).length > a.maxChars - 60) {
        data.partial = true;
        if (data.relations.length)
            data.relations.pop();
        else if (data.warnings.length)
            data.warnings.pop();
        else if (data.files.length)
            data.files.pop();
        else if (data.instructions.length)
            data.instructions.pop();
        else
            break;
    }
    data.characters = JSON.stringify(data).length;
    const out = result(data);
    out.content = [{ type: 'text', text: JSON.stringify(data) }];
    return out;
}
export const POLYGLOT_TOOL_HANDLERS: Record<string, (a: Record<string, unknown>) => Promise<ToolResult>> = {
    language_capabilities: async () => result({ ...languageCapabilities(), cache: codeCacheStatus(), graphs: codeGraph.status() }),
    code_graph: async (raw) => { const a = GraphSchema.parse(raw), root = await rootPath(a.path); if (a.action === 'clear') {
        codeGraph.clear(root);
        return result({ root, cleared: true, persistent: false });
    } if (a.action === 'status')
        return result({ graphs: codeGraph.status().filter(g => g.root === root), persistent: false }); const graph = await codeGraph.query(root, a.file, a.direction, a.depth, a.limit, a.maxFiles, a.action === 'refresh'); return result(a.format === 'compact' ? compactGraph(graph, { maxChars: a.maxChars, focus: a.file }) : graph); },
    context_pack: contextPack,
    session_handoff: async (raw) => { const a = HandoffSchema.parse(raw), s = await codingSession({ action: 'status', sessionId: a.sessionId }); if (!('changes' in s) || !s.changes)
        throw new AgentError('SESSION_NOT_FOUND', 'Session is unavailable.'); return result({ sessionId: s.sessionId, root: s.root, goal: s.goal, scope: s.scope, state: s.state, requiredChecks: s.requiredChecks, verifiedCurrentSource: s.verifiedCurrentSource, verification: s.verification, changes: s.changes.slice(0, a.maxChanges), changesTruncated: s.changesTruncated || s.changes.length > a.maxChanges, persistent: false, resume: 'Read the relevant project_context/context_pack. Re-read hashes before edits. Re-run required checks when verification is stale. This handoff is computed now, not saved; it does not survive an agent restart.' }); },
};
export function buildPolyglotToolDefinitions(): ToolDefinition[] {
    return [
        { name: 'language_capabilities', schema: z.object({}), description: 'Show exact multilingual parser/text capabilities and bounded RAM cache status. Distinguishes syntax parsing from compiler/LSP semantics. No install or execution.' },
        { name: 'code_graph', schema: GraphSchema, description: 'Agent-local multilingual file/import graph: query, refresh, status or clear; navigate dependencies/importers. Use format=compact for dictionary-coded source references and low token usage, or full for expanded graph details. Incremental RAM-only metadata; no graph database, model proxy or saved source/logs. Edges are candidates with confidence.' },
        { name: 'context_pack', schema: PackSchema, description: 'Budgeted coding context. mode=outline returns compressed graph/file/symbol IDs, scoped instructions and exact line references with no raw source snippets; expand through read_code_ranges/read_symbol. Default mode=balanced reads fresh source snippets/hashes. Context-aware across languages, no extra LLM calls, saved transcripts or database.' },
        { name: 'session_handoff', schema: HandoffSchema, description: 'Generate a compact current coding-session handoff: goal, scope, changed files, required checks and fresh verification status. RAM-only, not a saved progress log or claim of independent review.' },
    ].map(d => ({ name: d.name, description: d.description, inputSchema: zodToJsonSchema(d.schema), annotations: { title: d.name, readOnlyHint: true } }));
}
