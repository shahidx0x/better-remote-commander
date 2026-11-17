/**
 * Bounded range reading and hash-checked editing tools.
 * Every path is resolved against an explicit project root (symlink/junction escapes refused). All writes go through
 * workspaceBatch (single write engine: locks, expected hash, atomic replace, rollback), then are re-read from disk.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ToolResult } from 'brc-shared';
import type { ToolDefinition } from '../core/tool-definitions.js';
import type { ServerResult } from '../core/types.js';
import { searchManager } from '../core/search-manager.js';
import { rootPath, projectPath, textFile, inside, sensitive } from '../runtime/workspace.js';
import { readBounded, sha256, withFileLocks } from '../runtime/file-safety.js';
import { parseCode, parseSource, selectSymbol } from '../runtime/code-structure.js';
import { invalidateNavCaches } from '../runtime/nav-cache.js';
import { AgentError, result } from '../runtime/errors.js';
import { checkCancelled } from '../context.js';
import { workerCoordinator } from '../runtime/worker-coordination.js';
import { workspaceBatch } from './workspace-batch.js';

const Hash = z.string().regex(/^[a-fA-F0-9]{64}$/);
const Root = z.string().min(1);
const MAX_TEXT = 2 * 1024 * 1024; // workspaceBatch content limit; larger files must use other tools
const Line = z.number().int().min(1).max(10_000_000);
const RangesSchema = z.object({
    path: Root,
    files: z.array(z.object({ path: z.string().min(1), ranges: z.array(z.object({ startLine: Line, endLine: Line })).min(1).max(12) })).min(1).max(16),
    maxChars: z.number().int().min(1000).max(128000).default(32000),
});
const ContextSchema = z.object({
    path: Root, pattern: z.string().min(1).max(1000), literalSearch: z.boolean().default(true), filePattern: z.string().max(500).optional(),
    maxResults: z.number().int().min(1).max(50).default(10), contextLines: z.number().int().min(0).max(30).default(5),
    maxChars: z.number().int().min(1000).max(128000).default(64000),
});
const EditSchema = z.object({ old_string: z.string().min(1).max(1_000_000), new_string: z.string().max(1_000_000), expected_replacements: z.number().int().min(1).max(10000).default(1) });
const EditFilesSchema = z.object({
    path: Root,
    files: z.array(z.object({ path: z.string().min(1), expected_sha256: Hash, edits: z.array(EditSchema).min(1).max(100) })).min(1).max(16),
    dryRun: z.boolean().default(false),
});
const SymbolSchema = z.object({ path: Root, file: z.string().min(1), name: z.string().min(1).max(400), line: z.number().int().min(1).optional() });
const ReplaceSchema = SymbolSchema.extend({ expected_sha256: Hash, replacement: z.string().max(1_000_000), dryRun: z.boolean().default(true) });
const LineEditSchema = z.object({
    path: Root, file: z.string().min(1), expected_sha256: Hash,
    edits: z.array(z.object({ startLine: Line, endLine: Line, text: z.string().max(1_000_000) })).min(1).max(50),
    dryRun: z.boolean().default(true),
});

/** Resolve a file inside the project root and refuse any symlink/junction component (even ones staying inside the root). */
async function plainFile(root: string, raw: string): Promise<string> {
    const lexical = path.resolve(root, raw);
    if (!inside(root, lexical)) throw new AgentError('OUTSIDE_PROJECT', 'Path is outside the requested project.');
    const real = await projectPath(root, raw);
    const norm = (p: string) => process.platform === 'win32' ? path.normalize(p).toLowerCase() : path.normalize(p);
    if (norm(real) !== norm(lexical)) throw new AgentError('UNSAFE_TARGET', 'Path traverses a symlink or junction; edit tools require plain files.');
    const stat = await fs.lstat(real);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new AgentError('UNSAFE_TARGET', 'Edit tools require regular non-symlink files.');
    return real;
}
async function guardWorkers(root: string, files: string[]) {
    await workerCoordinator.guardFileMutation('workspace_batch', { path: root, dryRun: false, changes: files.map(f => ({ path: f })) });
}
/** Commit one validated content replacement through the shared batch engine, then verify the file on disk. */
async function commitContent(root: string, file: string, beforeHash: string, content: string, dryRun: boolean) {
    if (Buffer.byteLength(content) > MAX_TEXT) throw new AgentError('FILE_TOO_LARGE', 'Edited file would exceed 2 MiB; use smaller files or edit_files/edit_block.');
    const out = await workspaceBatch({ path: root, dryRun, changes: [{ path: file, expected_sha256: beforeHash, content }] });
    if (out.isError) throw Object.assign(new AgentError((out.structuredContent?.error as { code?: string })?.code ?? 'WRITE_FAILED', String((out.structuredContent?.error as { message?: string })?.message ?? 'Write failed.')), { toolResult: out });
    const change = (out.structuredContent!.changes as { beforeSha256: string; afterSha256: string }[])[0];
    return { afterSha256: change.afterSha256, verified: dryRun ? null : await verifyOnDisk(file, change.afterSha256) };
}
async function verifyOnDisk(file: string, expected: string): Promise<boolean> {
    return sha256(await readBounded(file, 32 * 1024 * 1024)) === expected;
}
const passFailure = (e: unknown): ToolResult | null => (e as { toolResult?: ToolResult })?.toolResult ?? null;

async function readRanges(raw: unknown) {
    const a = RangesSchema.parse(raw), root = await rootPath(a.path), files: Record<string, unknown>[] = [];
    let remaining = a.maxChars;
    for (const f of a.files) {
        checkCancelled();
        if (remaining <= 0) break;
        const data = await textFile(await projectPath(root, f.path), 4 * 1024 * 1024), lines = data.text.split('\n');
        const ranges = f.ranges.map(r => {
            if (r.endLine < r.startLine) throw new AgentError('INVALID_RANGE', 'endLine must be >= startLine.');
            // Build only as much text as the shared budget allows.
            let text = '', truncated = false;
            for (let i = r.startLine - 1; i < Math.min(r.endLine, lines.length); i++) {
                const piece = (i > r.startLine - 1 ? '\n' : '') + lines[i];
                if (text.length + piece.length > remaining) { text += piece.slice(0, Math.max(0, remaining - text.length)); truncated = true; break; }
                text += piece;
            }
            remaining -= text.length;
            return { ...r, text, truncated, beyondEnd: r.startLine > lines.length };
        });
        files.push({ path: data.path, sha256: data.sha256, totalLines: lines.length, ranges });
    }
    return result({ files, truncated: remaining <= 0 || files.length < a.files.length, lineNumbers: 'one-based, inclusive', note: 'Each file is read once per call. Hashes cover the full raw file; pass them as expected_sha256 to edit tools.' });
}
async function readContext(raw: unknown) {
    const a = ContextSchema.parse(raw), root = await rootPath(a.path);
    const started = await searchManager.startSearch({ rootPath: root, pattern: a.pattern, searchType: 'content', literalSearch: a.literalSearch, filePattern: a.filePattern, maxResults: a.maxResults, contextLines: 0, timeout: 15000, ignoreCase: false });
    try {
        const deadline = Date.now() + 15000;
        while (!searchManager.readSearchResults(started.sessionId, 0, 0).isComplete && Date.now() < deadline) { checkCancelled(); await new Promise(r => setTimeout(r, 20)); }
        const found = searchManager.readSearchResults(started.sessionId, 0, a.maxResults);
        if (found.isError && !found.results.length) throw new AgentError('SEARCH_FAILED', found.error ?? 'Search failed.');
        const grouped = new Map<string, number[]>();
        let fileCapReached = false;
        for (const hit of found.results) {
            if (hit.isContext || !hit.line) continue;
            const file = path.isAbsolute(hit.file) ? hit.file : path.resolve(root, hit.file);
            if (!grouped.has(file) && grouped.size >= 12) { fileCapReached = true; break; }
            const positions = grouped.get(file) ?? [];
            positions.push(hit.line);
            grouped.set(file, positions);
        }
        const files: Record<string, unknown>[] = [], skipped: { file: string; reason: string }[] = [];
        let budget = a.maxChars;
        for (const [file, positions] of grouped) {
            checkCancelled();
            if (budget <= 0) break;
            try {
                if (sensitive(file)) throw new AgentError('SENSITIVE_FILE', 'Likely secret file skipped.');
                const data = await textFile(await projectPath(root, file), 2 * 1024 * 1024), lines = data.text.split('\n');
                const ranges: { from: number; to: number }[] = [];
                for (const line of positions.sort((x, y) => x - y)) {
                    const from = Math.max(1, line - a.contextLines), to = Math.min(lines.length, line + a.contextLines), previous = ranges.at(-1);
                    if (previous && from <= previous.to + 1) previous.to = Math.max(previous.to, to); else ranges.push({ from, to });
                }
                const snippets = ranges.map(r => {
                    const text = lines.slice(r.from - 1, r.to).join('\n'), shown = text.slice(0, Math.max(0, budget));
                    budget -= shown.length;
                    return { ...r, text: shown, truncated: shown.length < text.length };
                });
                files.push({ path: data.path, sha256: data.sha256, matchLines: positions, snippets });
            } catch (e) { skipped.push({ file: path.relative(root, file).slice(0, 300), reason: (e as Error).message.slice(0, 200) }); }
        }
        return result({ files, skipped, matches: found.totalMatches, incomplete: !!found.wasIncomplete || !found.isComplete, truncated: fileCapReached || budget <= 0 || grouped.size > files.length + skipped.length, note: 'Line numbers are one-based. Files are read fresh after searching; hashes describe each returned file, not an atomic project snapshot.' });
    } finally { searchManager.terminateSearch(started.sessionId); }
}
async function editFiles(raw: unknown): Promise<ToolResult> {
    const a = EditFilesSchema.parse(raw), root = await rootPath(a.path);
    const paths = await Promise.all(a.files.map(f => plainFile(root, f.path)));
    if (!a.dryRun) await guardWorkers(root, paths);
    try {
        const out = await withFileLocks(paths, async () => {
            // Re-check plainness inside the locks; workspaceBatch then validates hashes/counts for ALL files before writing any.
            await Promise.all(a.files.map(f => plainFile(root, f.path)));
            return workspaceBatch({ path: root, dryRun: a.dryRun, writeConcurrency: 1, changes: a.files.map((f, i) => ({ path: paths[i], expected_sha256: f.expected_sha256, edits: f.edits })) });
        });
        if (out.isError) return out;
        const changes = out.structuredContent!.changes as { path: string; beforeSha256: string; afterSha256: string; changed: boolean }[];
        const files = await Promise.all(changes.map(async c => ({ path: c.path, beforeSha256: c.beforeSha256, afterSha256: c.afterSha256, changed: c.changed, verifiedOnDisk: a.dryRun ? null : await verifyOnDisk(c.path, c.afterSha256) })));
        const bad = files.some(f => f.verifiedOnDisk === false);
        return result({ dryRun: a.dryRun, files, atomicity: 'All files are validated first (hash, exact match counts); each replacement is atomic; multi-file rollback on failure is best-effort, not crash-atomic.', ...(bad ? { warning: 'A file changed after commit; re-read before further edits.' } : {}) }, bad);
    } finally { if (!a.dryRun) invalidateNavCaches(); }
}
async function replaceSymbol(raw: unknown): Promise<ToolResult> {
    const a = ReplaceSchema.parse(raw), root = await rootPath(a.path), file = await plainFile(root, a.file);
    if (!a.dryRun) await guardWorkers(root, [file]);
    try {
        return await withFileLocks([file], async () => {
            await plainFile(root, a.file);
            const p = await parseCode(file);
            if (p.sha256 !== a.expected_sha256.toLowerCase()) throw new AgentError('FILE_CONFLICT', 'Source changed. Read the symbol again.');
            if (!p.syntaxVerified || !p.syntaxSupported || p.provider === 'generic')
                throw new AgentError('SAFE_RANGE_UNAVAILABLE', `Symbol replacement needs verified syntax; ${p.language} only has lexical candidates. Use edit_code_ranges or edit_files with hashes instead.`);
            if (p.truncated || p.diagnostics.length)
                throw new AgentError('SAFE_RANGE_UNAVAILABLE', 'Symbol replacement requires a complete syntax tree without syntax errors.');
            const s = selectSymbol(p, a.name, a.line);
            if (s.canReplace === false || s.confidence === 'lexical-candidate')
                throw new AgentError('SAFE_RANGE_UNAVAILABLE', 'Lexical declaration candidates cannot authorise a symbol replacement.');
            const replacement = p.text.includes('\r\n') ? a.replacement.replace(/\r?\n/g, '\r\n') : a.replacement;
            const text = p.text.slice(0, s.start) + replacement + p.text.slice(s.end);
            const parsed = await parseSource(file, text);
            if (parsed.truncated) throw new AgentError('SAFE_RANGE_UNAVAILABLE', 'Replacement parse was incomplete.');
            if (parsed.diagnostics.length) throw new AgentError('SYNTAX_ERROR', 'Replacement would leave syntax errors: ' + parsed.diagnostics[0].message);
            const c = await commitContent(root, file, p.sha256, text, a.dryRun);
            return result({ path: file, symbol: s.qualifiedName, dryRun: a.dryRun, beforeSha256: p.sha256, afterSha256: c.afterSha256, verifiedOnDisk: c.verified, preview: { before: p.text.slice(s.start, Math.min(s.end, s.start + 2000)), after: replacement.slice(0, 2000) }, note: 'Replaces exactly this parsed declaration. Does not rename references or certify type correctness.' });
        });
    } catch (e) { const f = passFailure(e); if (f) return f; throw e; }
    finally { if (!a.dryRun) invalidateNavCaches(file); }
}
async function editRanges(raw: unknown): Promise<ToolResult> {
    const a = LineEditSchema.parse(raw), root = await rootPath(a.path), file = await plainFile(root, a.file);
    if (a.edits.reduce((n, e) => n + e.text.length, 0) > MAX_TEXT) throw new AgentError('FILE_TOO_LARGE', 'Combined replacement text exceeds 2 MiB.');
    if (!a.dryRun) await guardWorkers(root, [file]);
    try {
        return await withFileLocks([file], async () => {
            await plainFile(root, a.file);
            const f = await textFile(file, MAX_TEXT);
            // Line numbers are only meaningful for the exact bytes they were read from.
            if (f.sha256 !== a.expected_sha256.toLowerCase()) throw new AgentError('FILE_CONFLICT', 'File changed since it was read; line ranges may have drifted. Re-read it.');
            const offsets = [0];
            for (let i = 0; i < f.text.length; i++) if (f.text[i] === '\n') offsets.push(i + 1);
            const lineCount = offsets.length - (f.text.endsWith('\n') ? 1 : 0), sorted = [...a.edits].sort((x, y) => x.startLine - y.startLine);
            let last = 0;
            for (const e of sorted) {
                if (e.endLine < e.startLine || e.startLine <= last || e.endLine > lineCount) throw new AgentError('INVALID_RANGE', `Line edits must be non-overlapping, inclusive, existing one-based lines (file has ${lineCount}).`);
                last = e.endLine;
            }
            let next = f.text;
            const eol = f.text.includes('\r\n') ? '\r\n' : '\n';
            for (const e of [...sorted].reverse()) {
                const start = offsets[e.startLine - 1], end = offsets[e.endLine] ?? f.text.length;
                let replacement = e.text.replace(/\r?\n/g, eol);
                if (f.text.slice(start, end).endsWith('\n') && replacement && !replacement.endsWith('\n')) replacement += eol;
                next = next.slice(0, start) + replacement + next.slice(end);
            }
            if (f.text.startsWith('\ufeff') && !next.startsWith('\ufeff')) next = '\ufeff' + next;
            const c = await commitContent(root, file, f.sha256, next, a.dryRun);
            return result({ path: file, dryRun: a.dryRun, edits: sorted.length, beforeSha256: f.sha256, afterSha256: c.afterSha256, verifiedOnDisk: c.verified, lineEndings: eol === '\r\n' ? 'CRLF' : 'LF' });
        });
    } catch (e) { const f = passFailure(e); if (f) return f; throw e; }
    finally { if (!a.dryRun) invalidateNavCaches(file); }
}

export const EDIT_TOOL_HANDLERS: Record<string, (args: Record<string, unknown>) => Promise<ServerResult>> = {
    read_code_ranges: readRanges as never, read_code_context: readContext as never,
    edit_files: editFiles as never, replace_symbol: replaceSymbol as never, edit_code_ranges: editRanges as never,
};

export function buildEditToolDefinitions(): ToolDefinition[] {
    const defs: [string, z.ZodTypeAny, boolean, string][] = [
        ['read_code_ranges', RangesSchema, true, 'Read several one-based inclusive line ranges from up to 16 files under a project root (path), reading each file once and returning its full-file SHA-256 for later edits. Shared maxChars budget (max 128000) with explicit truncated flags.'],
        ['read_code_context', ContextSchema, true, 'Search a project with ripgrep (literal by default), then return fresh surrounding snippets and file hashes in one call. Max 12 files, bounded characters; likely secret files are skipped.'],
        ['edit_files', EditFilesSchema, false, 'Apply exact old_string/new_string edits to up to 16 existing UTF-8 files under the project root (path). Every file needs expected_sha256 from a prior read. All hashes and exact match counts are validated before any write; each replacement is atomic, CRLF is preserved, files are re-read after writing and rolled back on failure. Symlinks and paths outside the root are refused. dryRun previews hashes (default false).'],
        ['replace_symbol', ReplaceSchema, false, 'Replace one declaration by name in a file with VERIFIED syntax (TypeScript, JavaScript, JSON). Needs expected_sha256; refuses languages that only have lexical candidates and replacements that introduce syntax errors. Previews by default (dryRun true); set dryRun:false to write. Does not rename references.'],
        ['edit_code_ranges', LineEditSchema, false, 'Replace non-overlapping one-based inclusive line ranges in one file, using line numbers from a read of the same hash (expected_sha256 required, so drifted line numbers are rejected). Preserves CRLF/LF and BOM, atomic, previews by default (dryRun true).'],
    ];
    return defs.map(([name, schema, readOnlyHint, description]) => ({ name, description, inputSchema: zodToJsonSchema(schema) as ToolDefinition['inputSchema'], annotations: { title: name, readOnlyHint, ...(readOnlyHint ? {} : { destructiveHint: true }), openWorldHint: false } }));
}
