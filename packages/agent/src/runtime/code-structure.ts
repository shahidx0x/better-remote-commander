/** Syntax adapters: TypeScript compiler API for TS/JS/JSON, explicit lexical generic fallback (syntax not verified). */
import type ts from 'typescript';
import path from 'node:path';
import { textFile } from './workspace.js';
import { AgentError } from './errors.js';
import { checkCancelled } from '../context.js';
import { languageFor } from './languages.js';
import { genericStructure } from './generic-code.js';
export const CODE_EXT = /\.(?:[cm]?[jt]sx?)$/i;
export interface CodeSymbol {
    name: string;
    qualifiedName: string;
    kind: string;
    start: number;
    end: number;
    line: number;
    endLine: number;
    signature: string;
    exported: boolean;
    confidence?: string;
    canReplace?: boolean;
}
export interface SyntaxIssue {
    code: number;
    line: number;
    column: number;
    message: string;
    category: string;
}
export interface ParsedCode {
    language: string;
    provider: 'typescript' | 'json' | 'generic';
    syntaxSupported: boolean;
    /** False for the generic fallback: symbols are lexical candidates, syntax was NOT verified. */
    syntaxVerified: boolean;
    provides: string[];
    path: string;
    sha256: string;
    text: string;
    symbols: CodeSymbol[];
    imports: {
        specifier: string;
        line: number;
        kind?: string;
        confidence?: string;
    }[];
    diagnostics: SyntaxIssue[];
    truncated: boolean;
}
const cache = new Map<string, ParsedCode>();
const cacheAccess = new WeakMap<ParsedCode, number>();
const retainedBytes = (p: ParsedCode) => p.text.length * 2 + JSON.stringify([p.symbols,p.imports,p.diagnostics]).length * 2 + 1024;
let cachedBytes = 0;
let cacheHits = 0, cacheMisses = 0;
export async function parseCode(file: string): Promise<ParsedCode> {
    pruneCodeCache();
    const f = await textFile(file, 1024 * 1024);
    checkCancelled();
    const key = f.path + '\0' + f.sha256, hit = cache.get(key);
    if (hit) {
        cacheHits++;
        cacheAccess.set(hit, Date.now());
        cache.delete(key);
        cache.set(key, hit);
        return hit;
    }
    cacheMisses++;
    const parsed = await parseSource(f.path, f.text, f.sha256);
    for (const [k, v] of cache)
        if (v.path === f.path) {
            cachedBytes -= retainedBytes(v);
            cache.delete(k);
        }
    cache.set(key, parsed);
    cacheAccess.set(parsed, Date.now());
    cachedBytes += retainedBytes(parsed);
    while (cache.size > 32 || cachedBytes > 4 * 1024 * 1024) {
        const first = cache.entries().next().value!;
        cachedBytes -= retainedBytes(first[1]);
        cache.delete(first[0]);
    }
    return parsed;
}
export async function parseSource(file: string, text: string, hash = ''): Promise<ParsedCode> {
    const spec = languageFor(file);
    if (Buffer.byteLength(text) > 1024 * 1024)
        throw new AgentError('FILE_TOO_LARGE', 'Syntax tools accept at most 1 MiB. Use text range tools for larger files.');
    if (spec.engine !== 'typescript') {
        if (spec.engine === 'json')
            return parseJson(file, text, hash, spec.id);
        const data = genericStructure(text, spec.id);
        checkCancelled();
        return { path: file, sha256: hash, text, language: spec.id, provider: 'generic', syntaxSupported: false, syntaxVerified: false, ...data };
    }
    const ts = await import('typescript');
    const lower = file.toLowerCase();
    const kind = lower.endsWith('.tsx') ? ts.ScriptKind.TSX : lower.endsWith('.jsx') ? ts.ScriptKind.JSX : /\.[cm]?js$/.test(lower) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
    const symbols: CodeSymbol[] = [];
    let visited = 0, truncated = false;
    const walk = (node: ts.Node, parents: string[]) => {
        if (++visited > 40000 || symbols.length >= 500) {
            truncated = true;
            return;
        }
        let label: string | undefined, symbolKind: string | undefined, target: ts.Node = node;
        if (ts.isFunctionDeclaration(node)) {
            label = node.name?.text ?? 'default';
            symbolKind = 'function';
        }
        else if (ts.isClassDeclaration(node)) {
            label = node.name?.text ?? 'default';
            symbolKind = 'class';
        }
        else if (ts.isInterfaceDeclaration(node)) {
            label = node.name.text;
            symbolKind = 'interface';
        }
        else if (ts.isTypeAliasDeclaration(node)) {
            label = node.name.text;
            symbolKind = 'type';
        }
        else if (ts.isEnumDeclaration(node)) {
            label = node.name.text;
            symbolKind = 'enum';
        }
        else if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
            label = node.name.getText(sf);
            symbolKind = 'method';
        }
        else if (ts.isConstructorDeclaration(node)) {
            label = 'constructor';
            symbolKind = 'constructor';
        }
        else if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
            label = node.name.text;
            symbolKind = node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? 'function' : 'variable';
            const list = node.parent, statement = list.parent;
            if (ts.isVariableDeclarationList(list) && list.declarations.length === 1 && ts.isVariableStatement(statement))
                target = statement;
        }
        else if (ts.isPropertyDeclaration(node)) {
            label = node.name.getText(sf);
            symbolKind = 'property';
        }
        if (label && symbolKind) {
            const start = target.getStart(sf), end = target.getEnd();
            const startLine = sf.getLineAndCharacterOfPosition(start).line + 1, endLine = sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1;
            const modifiers = ts.canHaveModifiers(target) ? ts.getModifiers(target) : undefined;
            const body = (node as ts.FunctionDeclaration).body;
            const sigEnd = body && typeof body.pos === 'number' ? Math.min(body.getStart(sf), end) : Math.min(end, start + 240);
            symbols.push({ name: label.slice(0, 120), qualifiedName: [...parents, label].join('.').slice(0, 400), kind: symbolKind, start, end, line: startLine, endLine, signature: text.slice(start, sigEnd).replace(/\s+/g, ' ').slice(0, 240), exported: !!modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword || m.kind === ts.SyntaxKind.DefaultKeyword) });
        }
        const nextParents = label && ['class', 'interface', 'function'].includes(symbolKind ?? '') ? [...parents, label] : parents;
        ts.forEachChild(node, child => walk(child, nextParents));
    };
    walk(sf, []);
    const raw = (sf as ts.SourceFile & {
        parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
    }).parseDiagnostics ?? [];
    const diagnostics = raw.slice(0, 100).map(d => { const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0); return { code: d.code, line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 2000), category: ts.DiagnosticCategory[d.category] }; });
    const imports = ts.preProcessFile(text, true, true).importedFiles.slice(0, 200).map(i => ({ specifier: i.fileName, line: sf.getLineAndCharacterOfPosition(i.pos).line + 1 }));
    return { path: file, sha256: hash, text, symbols, imports, diagnostics, truncated: truncated || raw.length > 100, language: spec.id, provider: 'typescript', syntaxSupported: true, syntaxVerified: true, provides: [] };
}
async function parseJson(file: string, text: string, hash: string, language: string): Promise<ParsedCode> {
    const ts = await import('typescript');
    const sf = ts.parseJsonText(file.replace(/\\/g, '/'), text);
    const raw = (sf as ts.JsonSourceFile & { parseDiagnostics?: readonly ts.DiagnosticWithLocation[] }).parseDiagnostics ?? [];
    const diagnostics = raw.slice(0, 100).map(d => { const pos = sf.getLineAndCharacterOfPosition(d.start ?? 0); return { code: d.code, line: pos.line + 1, column: pos.character + 1, message: ts.flattenDiagnosticMessageText(d.messageText, ' ').slice(0, 2000), category: ts.DiagnosticCategory[d.category] }; });
    const symbols: CodeSymbol[] = [];
    const root = sf.statements[0]?.expression;
    if (root && ts.isObjectLiteralExpression(root))
        for (const p of root.properties.slice(0, 500)) {
            if (!ts.isPropertyAssignment(p) || !(ts.isStringLiteral(p.name) || ts.isIdentifier(p.name))) continue;
            const start = p.getStart(sf), end = p.getEnd(), name = p.name.text.slice(0, 120);
            symbols.push({ name, qualifiedName: name, kind: 'property', start, end, line: sf.getLineAndCharacterOfPosition(start).line + 1, endLine: sf.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1, signature: text.slice(start, Math.min(end, start + 120)).replace(/\s+/g, ' '), exported: false });
        }
    return { path: file, sha256: hash, text, language, provider: 'json', syntaxSupported: true, syntaxVerified: true, provides: [], symbols, imports: [], diagnostics, truncated: raw.length > 100 };
}
export function selectSymbol(parsed: ParsedCode, name: string, line?: number): CodeSymbol {
    const choices = parsed.symbols.filter(s => (s.name === name || s.qualifiedName === name) && (line === undefined || s.line === line));
    if (!choices.length)
        throw new AgentError('SYMBOL_NOT_FOUND', `No symbol named ${name}. Use code_outline first.`);
    if (choices.length !== 1)
        throw new AgentError('AMBIGUOUS_SYMBOL', `Found ${choices.length} matches. Supply the qualified name and start line from code_outline.`);
    return choices[0];
}
export function pruneCodeCache(now = Date.now(), all = false, ttl = 300000) { let n=0; for(const [key,value] of cache) if(all || now-(cacheAccess.get(value)??0)>ttl){cachedBytes-=retainedBytes(value);cache.delete(key);n++;}return n;}
export function clearCodeCache() { cache.clear(); cachedBytes = 0; }
export function codeCacheStatus() { return { entries: cache.size, bytes: cachedBytes, hits: cacheHits, misses: cacheMisses, persistent: false }; }

