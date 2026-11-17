/** Conservative fallback for arbitrary UTF-8 languages. Never claims syntax validity: results are lexical candidates, "syntax not verified". */
export interface GenericStructure { symbols: any[]; imports: any[]; provides: string[]; diagnostics: any[]; truncated: boolean }
function lexicalStructure(text: string) {
    const symbols: any[] = [], imports: any[] = [], provides: string[] = [];
    let offset = 0, line = 0, truncated = false;
    for (const row of text.split('\n')) {
        line++;
        if (line > 30000 || symbols.length >= 500 || imports.length >= 200) {
            truncated = true;
            break;
        }
        const s = row.trim();
        if (!/^(?:\/\/|#(?!include)|\/\*|\*|--|;)/.test(s)) {
            const m = /^(?:(?:public|private|protected|internal|static|abstract|final|open|export|pub|async|sealed|partial|override|local)\s+)*(class|struct|interface|enum|trait|module|namespace|fn|fun|func|function|def|sub|let|type)\s+([\p{L}_$][\p{L}\p{N}_$:.]*)/iu.exec(s);
            const extra = !m && (/^(?:CREATE\s+(?:OR\s+REPLACE\s+)?)(?:FUNCTION|PROCEDURE|TABLE|VIEW|TRIGGER)\s+([\p{L}_][\p{L}\p{N}_.]*)/iu.exec(s) || /^([\p{L}_][\p{L}\p{N}_.]*)\s*(?:<-|=)\s*function\b/u.exec(s) || /^([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*\)\s*\{/.exec(s));
            if(extra){const start=offset+row.indexOf(s);symbols.push({name:extra[1],qualifiedName:extra[1],kind:'declaration-candidate',start,end:offset+row.length,line,endLine:line,signature:s.slice(0,240),exported:false,confidence:'lexical-candidate',canReplace:false});}
            if (m) {
                const start = offset + row.indexOf(s);
                symbols.push({ name: m[2], qualifiedName: m[2], kind: m[1].toLowerCase(), start, end: offset + row.length, line, endLine: line, signature: s.slice(0, 240), exported: false, confidence: 'lexical-candidate', canReplace: false });
            }
            const ns = /^(?:namespace|package|module)\s+([\w.\\]+)/i.exec(s);
            if (ns)
                provides.push(ns[1].replace(/\\/g, '.'));
            const sln = /^Project\([^)]*\)\s*=\s*"[^"]*",\s*"([^"]+)"/.exec(s);
            if (sln)
                imports.push({ specifier: sln[1], line, kind: 'project-reference', confidence: 'lexical-candidate' });
            const slnx = /<Project\b[^>]*\bPath\s*=\s*["']([^"']+)["']/i.exec(s);
            if (slnx)
                imports.push({ specifier: slnx[1], line, kind: 'project-reference', confidence: 'lexical-candidate' });
            const refs = [...s.matchAll(/<(?:ProjectReference|Import)\b[^>]*\b(?:Include|Project)\s*=\s*["']([^"']+)["']/gi)];
            for (const m of refs)
                imports.push({ specifier: m[1], line, kind: 'project-reference', confidence: 'lexical-candidate' });
            const statement = /^(?:import|from|using|imports|require(?:_relative)?|include|source|load|#include)\b\s*(.*)/i.exec(s);
            if (statement) {
                const quoted = [...statement[1].matchAll(/["'<]([^"'>\r\n]{1,400})["'>]/g)];
                if (quoted.length)
                    for (const m of quoted.slice(0, 10))
                        imports.push({ specifier: m[1], line, kind: 'generic-path', confidence: 'lexical-candidate' });
                else {
                    const m = /^(?:static\s+)?([\w.$:*/\\-]+)/.exec(statement[1]);
                    if (m)
                        imports.push({ specifier: m[1], line, kind: 'generic-module', confidence: 'lexical-candidate' });
                }
            }
        }
        offset += row.length + 1;
    }
    return { symbols, imports: imports.slice(0, 200), provides: [...new Set(provides)].slice(0, 100), diagnostics: [], truncated };
}

/** Indentation-aware Python declarations and imports. Still lexical: no syntax verification. */
function pythonStructure(text: string): GenericStructure {
    const rows = text.split('\n'), offsets: number[] = [];
    let at = 0;
    for (const r of rows) { offsets.push(at); at += r.length + 1; }
    const symbols: any[] = [], imports: any[] = [], stack: { indent: number; name: string; index: number }[] = [];
    let truncated = rows.length > 30000, fence: string | undefined;
    const limit = Math.min(rows.length, 30000);
    const lastCode = (from: number, to: number) => { for (let i = to; i > from; i--) if (rows[i].trim()) return i; return from; };
    const closeBlocks = (indent: number, row: number) => {
        while (stack.length && stack.at(-1)!.indent >= indent) {
            const top = stack.pop()!, last = lastCode(symbols[top.index].line - 1, row - 1);
            symbols[top.index].endLine = last + 1;
            symbols[top.index].end = offsets[last] + rows[last].replace(/\r$/, '').length;
        }
    };
    for (let i = 0; i < limit; i++) {
        const raw = rows[i].replace(/\r$/, ''), s = raw.trim();
        if (fence) { if (s.includes(fence)) fence = undefined; continue; }
        const q = /^[rbuf]{0,2}("""|''')/i.exec(s);
        if (q && !s.slice(q[0].length).includes(q[1])) { fence = q[1]; continue; }
        if (!s || s.startsWith('#')) continue;
        const indent = raw.length - raw.trimStart().length;
        const d = /^(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(s);
        if (d) {
            closeBlocks(indent, i);
            if (symbols.length >= 500) { truncated = true; break; }
            const parents = stack.map(x => x.name), inClass = stack.length && symbols[stack.at(-1)!.index].kind === 'class';
            symbols.push({ name: d[2], qualifiedName: [...parents, d[2]].join('.'), kind: d[1] === 'class' ? 'class' : inClass ? 'method' : 'function', start: offsets[i] + indent, end: offsets[i] + raw.length, line: i + 1, endLine: i + 1, signature: s.replace(/:\s*(?:#.*)?$/, '').slice(0, 240), exported: !d[2].startsWith('_'), confidence: 'lexical-candidate', canReplace: false });
            stack.push({ indent, name: d[2], index: symbols.length - 1 });
            continue;
        }
        closeBlocks(indent, i);
        if (imports.length >= 200) { truncated = true; continue; }
        const from = /^from\s+(\.*[\w.]*)\s+import\b/.exec(s);
        if (from) { imports.push({ specifier: from[1], line: i + 1, kind: 'python-from', confidence: 'lexical-candidate' }); continue; }
        const imp = /^import\s+(.+)$/.exec(s);
        if (imp) for (const part of imp[1].split(',').slice(0, 20)) { const m = /^\s*([\w.]+)/.exec(part); if (m) imports.push({ specifier: m[1], line: i + 1, kind: 'python-import', confidence: 'lexical-candidate' }); }
    }
    closeBlocks(0, limit);
    return { symbols, imports: imports.slice(0, 200), provides: [], diagnostics: [], truncated };
}
export function genericStructure(text: string, language?: string): GenericStructure {
    return language === 'python' ? pythonStructure(text) : lexicalStructure(text);
}


