/** Language capabilities are explicit: syntax parsers are not semantic language servers. */
import path from 'node:path';
export interface LanguageSpec {
    id: string;
    extensions: string[];
    grammar?: string;
    engine: 'typescript' | 'tree-sitter' | 'generic';
}
export const LANGUAGES: LanguageSpec[] = [
    { id: 'typescript', extensions: ['ts', 'mts', 'cts'], engine: 'typescript' },
    { id: 'tsx', extensions: ['tsx'], engine: 'typescript' },
    { id: 'javascript', extensions: ['js', 'mjs', 'cjs', 'jsx'], engine: 'typescript' },
    { id: 'csharp', extensions: ['cs', 'csx'], grammar: 'c_sharp', engine: 'tree-sitter' },
    { id: 'rust', extensions: ['rs'], grammar: 'rust', engine: 'tree-sitter' },
    { id: 'python', extensions: ['py', 'pyi', 'pyw'], grammar: 'python', engine: 'tree-sitter' },
    { id: 'go', extensions: ['go'], grammar: 'go', engine: 'tree-sitter' },
    { id: 'java', extensions: ['java'], grammar: 'java', engine: 'tree-sitter' },
    { id: 'c', extensions: ['c', 'h'], grammar: 'c', engine: 'tree-sitter' },
    { id: 'cpp', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'], grammar: 'cpp', engine: 'tree-sitter' },
    { id: 'ruby', extensions: ['rb', 'rake', 'gemspec'], grammar: 'ruby', engine: 'tree-sitter' },
    { id: 'php', extensions: ['php', 'phtml'], grammar: 'php', engine: 'tree-sitter' },
    { id: 'swift', extensions: ['swift'], grammar: 'swift', engine: 'tree-sitter' },
    { id: 'dart', extensions: ['dart'], grammar: 'dart', engine: 'tree-sitter' },
    { id: 'solidity', extensions: ['sol'], grammar: 'solidity', engine: 'tree-sitter' },
    { id: 'css', extensions: ['css'], grammar: 'css', engine: 'tree-sitter' },
    { id: 'vue', extensions: ['vue'], grammar: 'vue', engine: 'tree-sitter' },
    { id: 'fsharp', extensions: ['fs', 'fsi', 'fsx'], engine: 'generic' },
    { id: 'visual-basic', extensions: ['vb', 'vbs'], engine: 'generic' },
    { id: 'kotlin', extensions: ['kt', 'kts'], engine: 'generic' },
    { id: 'scala', extensions: ['scala', 'sc'], engine: 'generic' },
    { id: 'shell', extensions: ['sh', 'bash', 'zsh', 'ps1', 'psm1', 'cmd', 'bat'], engine: 'generic' },
    { id:'lua', extensions:['lua'], engine:'generic' },
    { id:'julia', extensions:['jl'], engine:'generic' },
    { id:'r', extensions:['r','rmd'], engine:'generic' },
    { id:'elixir', extensions:['ex','exs'], engine:'generic' },
    { id:'erlang', extensions:['erl','hrl'], engine:'generic' },
    { id:'haskell', extensions:['hs','lhs'], engine:'generic' },
    { id:'ocaml', extensions:['ml','mli'], engine:'generic' },
    { id:'zig', extensions:['zig'], engine:'generic' },
    { id:'sql', extensions:['sql'], engine:'generic' },
    { id:'fortran', extensions:['f','f90','f95','f03','f08'], engine:'generic' },
    { id:'cobol', extensions:['cob','cbl'], engine:'generic' },
    { id:'html', extensions:['html','htm'], engine:'generic' },
    { id:'config', extensions:['json','jsonc','yaml','yml','toml','xml','ini'], engine:'generic' },
    { id: 'dotnet-project', extensions: ['csproj', 'fsproj', 'vbproj', 'props', 'targets', 'sln', 'slnx'], engine: 'generic' },
];
export function languageFor(file: string): LanguageSpec {
    const extension = path.extname(file).slice(1).toLowerCase();
    return LANGUAGES.find(l => l.extensions.includes(extension)) ?? { id: extension || 'text', extensions: [extension], engine: 'generic' };
}
// Binary exclusions only: unknown text languages are not excluded from graph/context tools.
export function sourceCandidate(file: string): boolean {
    return !/\.(?:png|jpe?g|gif|webp|avif|tiff?|heic|ico|pdf|zip|gz|7z|tar|exe|dll|so|dylib|node|wasm|woff2?|ttf|otf|mp[34]|mov|avi|db|sqlite(?:3)?|pdb|bin|class|jar|pyc)$/i.test(file);
}
export function languageCapabilities() {
    return { languages: LANGUAGES.map(l => ({ ...l, syntaxDiagnostics: l.engine !== 'generic', safeSymbolReplacement: l.engine !== 'generic' })),
        generic: { allTextLanguages: true, search: true, rangedReads: true, hashCheckedEdits: true, relationshipHints: true, syntaxDiagnostics: false, safeSymbolReplacement: false },
        semanticLanguageServer: false, unsavedEditorBuffers: false,
        note: 'Registered grammars provide syntax, not full compiler/type resolution. Unknown languages retain text operations and clearly labeled declaration/import candidates. .NET is an ecosystem: C# has a parser; F#/VB have text support and dotnet checks.' };
}
