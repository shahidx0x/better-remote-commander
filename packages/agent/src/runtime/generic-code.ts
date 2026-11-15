/** Conservative fallback for arbitrary UTF-8 languages. Never claims syntax validity or safe AST edits. */
export function genericStructure(text: string) {
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
