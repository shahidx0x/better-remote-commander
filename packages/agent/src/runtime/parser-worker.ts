/** WASM parsing stays off the agent's WebSocket/event loop. No project code is executed. */
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { Parser, Language, type Node } from 'web-tree-sitter';
const require = createRequire(import.meta.url);
const base = path.dirname(require.resolve('@repomix/tree-sitter-wasms/package.json'));
const loaded = new Map<string, Language>();
const ready = Parser.init();
const kinds: Record<string, string> = {
    function_item: 'function', function_definition: 'function', function_declaration: 'function', function_signature_item: 'function', method_declaration: 'method', method_definition: 'method', method: 'method', singleton_method: 'method', constructor_declaration: 'constructor', destructor_declaration: 'destructor', local_function_statement: 'function',
    class_declaration: 'class', class_definition: 'class', class: 'class', struct_item: 'struct', struct_specifier: 'struct', class_specifier: 'class', struct_declaration: 'struct', record_declaration: 'record', interface_declaration: 'interface', interface_type: 'interface', trait_item: 'trait', trait_declaration: 'trait',
    enum_item: 'enum', enum_declaration: 'enum', enum_specifier: 'enum', type_item: 'type', type_alias_declaration: 'type', type_spec: 'type', type_definition: 'type',
    mod_item: 'module', module: 'module', namespace_definition: 'namespace', namespace_declaration: 'namespace', file_scoped_namespace_declaration: 'namespace', impl_item: 'impl',
    const_item: 'constant', static_item: 'variable', constant_declaration: 'constant', property_declaration: 'property', field_declaration: 'field', variable_declaration: 'variable',
    mixin_declaration: 'mixin', extension_declaration: 'extension', contract_declaration: 'contract', event_definition: 'event', modifier_definition: 'modifier', rule_set: 'rule',
};
function nameOf(node: Node): string | undefined {
    let n = node.childForFieldName('name');
    if (n)
        return n.text;
    if (node.type === 'impl_item')
        return node.childForFieldName('type')?.text;
    if (node.type === 'rule_set')
        return node.namedChildren.find(c => c.type === 'selectors')?.text;
    let d = node.childForFieldName('declarator');
    for (let i = 0; d && i < 5; i++) {
        if (['identifier', 'field_identifier', 'operator_name', 'destructor_name', 'qualified_identifier'].includes(d.type))
            return d.text;
        const next = d.childForFieldName('declarator') ?? d.childForFieldName('name');
        if (!next)
            break;
        d = next;
    }
    return node.namedChildren.find(c => ['identifier', 'type_identifier', 'constant', 'simple_identifier', 'name'].includes(c.type))?.text;
}
function importsFrom(node: Node, language: string): {
    specifier: string;
    line: number;
    kind: string;
}[] {
    const t = node.text.trim(), line = node.startPosition.row + 1, out: {
        specifier: string;
        line: number;
        kind: string;
    }[] = [];
    const add = (specifier: string | undefined, kind: string) => { if (specifier && specifier.length <= 1000)
        out.push({ specifier: specifier.replace(/^["'`<]|["'`>]$/g, ''), line, kind }); };
    switch (language) {
        case 'csharp':
            if (node.type === 'using_directive') {
                let s = t.replace(/^(?:global\s+)?using\s+(?:static\s+)?/, '').replace(/;$/, '').trim();
                if (s.includes('='))
                    s = s.slice(s.indexOf('=') + 1).trim();
                add(s, 'namespace');
            }
            break;
        case 'rust':
            if (node.type === 'use_declaration') {
                let s = t.replace(/^(?:pub(?:\([^)]*\))?\s+)?use\s+/, '').replace(/;$/, '');
                const group = s.indexOf('::{');
                if (group >= 0) {
                    const prefix = s.slice(0, group), items = s.slice(group + 3).replace(/}\s*$/, '').split(',');
                    for (const item of items.slice(0, 30))
                        add(prefix + '::' + item.trim().replace(/\s+as\s+.*$/, ''), 'rust-use');
                }
                else
                    add(s.replace(/\s+as\s+.*$/, ''), 'rust-use');
            }
            if (node.type === 'mod_item' && !node.childForFieldName('body'))
                add(node.childForFieldName('name')?.text, 'rust-mod');
            break;
        case 'python':
            if (node.type === 'import_from_statement')
                add(node.childForFieldName('module_name')?.text ?? /^from\s+(\S+)/.exec(t)?.[1], 'python-from');
            if (node.type === 'import_statement')
                for (const n of node.namedChildren) {
                    if (n.type === 'dotted_name')
                        add(n.text, 'python-import');
                    else if (n.type === 'aliased_import')
                        add(n.childForFieldName('name')?.text, 'python-import');
                }
            break;
        case 'go':
            if (node.type === 'import_spec')
                add(node.childForFieldName('path')?.text, 'go-import');
            break;
        case 'java':
            if (node.type === 'import_declaration')
                add(t.replace(/^import\s+(?:static\s+)?/, '').replace(/;$/, ''), 'java-import');
            break;
        case 'c':
        case 'cpp':
            if (node.type === 'preproc_include') {
                const p = node.childForFieldName('path');
                add(p?.text, p?.type === 'system_lib_string' ? 'system-include' : 'include');
            }
            break;
        case 'ruby':
            if (node.type === 'call') {
                const method = node.childForFieldName('method')?.text;
                if (method === 'require' || method === 'require_relative')
                    add(/\(?(?:\s*)["']([^"']+)["']/.exec(t)?.[1], method === 'require_relative' ? 'relative' : 'module');
            }
            break;
        case 'php':
            if (node.type === 'namespace_use_declaration')
                add(t.replace(/^use\s+(?:(?:function|const)\s+)?/, '').replace(/;$/, ''), 'php-namespace');
            if (/^(?:require|include)(?:_once)?_expression$/.test(node.type))
                add(/["']([^"']+)["']/.exec(t)?.[1], 'include');
            break;
        case 'swift':
            if (node.type === 'import_declaration')
                add(t.replace(/^import\s+/, '').trim(), 'module');
            break;
        case 'dart':
            if (node.type === 'import_or_export' || node.type === 'import_specification')
                add(/["']([^"']+)["']/.exec(t)?.[1], 'dart-import');
            break;
        case 'solidity':
            if (node.type === 'import_directive')
                add(/["']([^"']+)["']/.exec(t)?.[1], 'relative');
            break;
        case 'css':
            if (node.type === 'import_statement')
                add(/["']([^"']+)["']/.exec(t)?.[1], 'relative');
            break;
    }
    return out;
}
parentPort!.on('message', async (job: {
    id: number;
    grammar: string;
    language: string;
    text: string;
}) => {
    let parser: Parser | undefined, tree: ReturnType<Parser['parse']> | undefined;
    try {
        await ready;
        let language = loaded.get(job.grammar);
        if (!language) {
            language = await Language.load(path.join(base, 'out', `tree-sitter-${job.grammar}.wasm`));
            loaded.set(job.grammar, language);
        }
        parser = new Parser();
        parser.setLanguage(language);
        tree = parser.parse(job.text);
        if (!tree)
            throw new Error('Parser returned no syntax tree');
        const symbols: any[] = [], imports: any[] = [], diagnostics: any[] = [], provides: string[] = [];
        let visited = 0, truncated = false;
        const todo: {
            node: Node;
            parents: string[];
        }[] = [{ node: tree.rootNode, parents: [] }];
        while (todo.length) {
            const { node, parents } = todo.pop()!;
            if (++visited > 60000) {
                truncated = true;
                break;
            }
            if (node.isError || node.isMissing) {
                if (diagnostics.length < 100)
                    diagnostics.push({ code: 0, line: node.startPosition.row + 1, column: node.startPosition.column + 1, message: node.isMissing ? `Missing ${node.type}` : `Unrecognized syntax near ${node.text.slice(0, 100)}`, category: 'Error' });
                else
                    truncated = true;
            }
            if (['namespace_declaration', 'file_scoped_namespace_declaration', 'namespace_definition'].includes(node.type)) {
                const n = node.childForFieldName('name')?.text;
                if (n)
                    provides.push(n.replace(/\\/g, '.'));
            }
            if (node.type === 'package_declaration' || node.type === 'package_clause') {
                const n = node.text.replace(/^package\s+/, '').replace(/;$/, '').trim();
                if (n)
                    provides.push(n);
            }
            if (imports.length < 200)
                imports.push(...importsFrom(node, job.language));
            else
                truncated = true;
            const kind = kinds[node.type], name = kind ? nameOf(node) : undefined;
            let nextParents = parents;
            if (name && kind) {
                if (symbols.length >= 500) {
                    truncated = true;
                    break;
                }
                const target = node.parent?.type === 'decorated_definition' ? node.parent : node;
                const start = target.startIndex, end = target.endIndex;
                // Verify binding offsets against the actual source before permitting edits.
                const exact = job.text.slice(start, end) === target.text;
                if (!exact)
                    throw new Error('Parser range encoding mismatch');
                const body = node.childForFieldName('body');
                symbols.push({ name: name.slice(0, 120), qualifiedName: [...parents, name].join('.').slice(0, 400), kind, start, end, line: target.startPosition.row + 1, endLine: Math.max(target.startPosition.row + 1, target.endPosition.row + (target.endPosition.column ? 1 : 0)), signature: job.text.slice(start, Math.min(body?.startIndex ?? end, start + 240)).replace(/\s+/g, ' '), exported: /^(?:pub\b|public\b|export\b)/.test(node.text.trim()), confidence: 'syntax', canReplace: true });
                if (['class', 'struct', 'namespace', 'interface', 'trait', 'module', 'impl', 'function', 'contract'].includes(kind))
                    nextParents = [...parents, name];
            }
            const children = node.children;
            for (let i = children.length - 1; i >= 0; i--)
                todo.push({ node: children[i], parents: nextParents });
        }
        if (tree.rootNode.hasError && !diagnostics.length)
            diagnostics.push({ code: 0, line: 1, column: 1, message: 'Syntax tree contains recovery or missing nodes.', category: 'Error' });
        parentPort!.postMessage({ id: job.id, result: { symbols, imports: imports.slice(0, 200), diagnostics, provides: [...new Set(provides)].slice(0, 100), truncated }, recycle: loaded.size >= 4 });
    }
    catch (e) {
        parentPort!.postMessage({ id: job.id, error: e instanceof Error ? e.message : String(e) });
    }
    finally {
        tree?.delete();
        parser?.delete();
    }
});
