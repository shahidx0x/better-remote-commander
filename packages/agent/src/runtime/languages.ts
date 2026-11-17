/** Language capabilities are explicit: syntax parsers are not semantic language servers. */
import path from 'node:path';
export interface LanguageSpec {
    id: string;
    extensions: string[];
    /** typescript = TS compiler API (syntax verified); json = TS JSON parser (syntax verified); generic = lexical candidates, syntax NOT verified. */
    engine: 'typescript' | 'json' | 'generic';
}
export const LANGUAGES: LanguageSpec[] = [
    { id: 'typescript', extensions: ['ts', 'mts', 'cts'], engine: 'typescript' },
    { id: 'tsx', extensions: ['tsx'], engine: 'typescript' },
    { id: 'javascript', extensions: ['js', 'mjs', 'cjs', 'jsx'], engine: 'typescript' },
    { id: 'json', extensions: ['json'], engine: 'json' },
    { id: 'jsonc', extensions: ['jsonc'], engine: 'json' },
    { id: 'python', extensions: ['py', 'pyi', 'pyw'], engine: 'generic' },
    { id: 'csharp', extensions: ['cs', 'csx'], engine: 'generic' },
    { id: 'rust', extensions: ['rs'], engine: 'generic' },
    { id: 'go', extensions: ['go'], engine: 'generic' },
    { id: 'java', extensions: ['java'], engine: 'generic' },
    { id: 'c', extensions: ['c', 'h'], engine: 'generic' },
    { id: 'cpp', extensions: ['cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx', 'ino'], engine: 'generic' },
    { id: 'ruby', extensions: ['rb', 'rake', 'gemspec'], engine: 'generic' },
    { id: 'php', extensions: ['php', 'phtml'], engine: 'generic' },
    { id: 'swift', extensions: ['swift'], engine: 'generic' },
    { id: 'dart', extensions: ['dart'], engine: 'generic' },
    { id: 'solidity', extensions: ['sol'], engine: 'generic' },
    { id: 'css', extensions: ['css'], engine: 'generic' },
    { id: 'vue', extensions: ['vue'], engine: 'generic' },
    { id: 'fsharp', extensions: ['fs', 'fsi', 'fsx'], engine: 'generic' },
    { id: 'visual-basic', extensions: ['vb', 'vbs'], engine: 'generic' },
    { id: 'kotlin', extensions: ['kt', 'kts'], engine: 'generic' },
    { id: 'scala', extensions: ['scala', 'sc'], engine: 'generic' },
    { id: 'shell', extensions: ['sh', 'bash', 'zsh', 'ps1', 'psm1', 'cmd', 'bat'], engine: 'generic' },
    { id: 'lua', extensions: ['lua'], engine: 'generic' },
    { id: 'julia', extensions: ['jl'], engine: 'generic' },
    { id: 'r', extensions: ['r', 'rmd'], engine: 'generic' },
    { id: 'elixir', extensions: ['ex', 'exs'], engine: 'generic' },
    { id: 'erlang', extensions: ['erl', 'hrl'], engine: 'generic' },
    { id: 'haskell', extensions: ['hs', 'lhs'], engine: 'generic' },
    { id: 'ocaml', extensions: ['ml', 'mli'], engine: 'generic' },
    { id: 'zig', extensions: ['zig'], engine: 'generic' },
    { id: 'sql', extensions: ['sql'], engine: 'generic' },
    { id: 'fortran', extensions: ['f', 'f90', 'f95', 'f03', 'f08'], engine: 'generic' },
    { id: 'cobol', extensions: ['cob', 'cbl'], engine: 'generic' },
    { id: 'html', extensions: ['html', 'htm'], engine: 'generic' },
    { id: 'config', extensions: ['yaml', 'yml', 'toml', 'xml', 'ini'], engine: 'generic' },
    { id: 'dotnet-project', extensions: ['csproj', 'fsproj', 'vbproj', 'props', 'targets', 'sln', 'slnx'], engine: 'generic' },
];
export function languageFor(file: string): LanguageSpec {
    const extension = path.extname(file).slice(1).toLowerCase();
    return LANGUAGES.find(l => l.extensions.includes(extension)) ?? { id: extension || 'text', extensions: [extension], engine: 'generic' };
}
// Binary exclusions only: unknown text languages are not excluded from graph/context tools.
export function sourceCandidate(file: string): boolean {
    return !/\.(?:png|jpe?g|gif|webp|avif|tiff?|heic|ico|pdf|zip|gz|7z|tar|exe|dll|so|dylib|node|wasm|woff2?|ttf|otf|mp[34]|mov|avi|db|sqlite(?:3)?|pdb|bin|class|jar|pyc|lock)$/i.test(file);
}
export function languageCapabilities() {
    return {
        languages: LANGUAGES.map(l => ({ ...l, syntaxDiagnostics: l.engine !== 'generic', syntaxVerified: l.engine !== 'generic' })),
        generic: { allTextLanguages: true, search: true, rangedReads: true, relationshipHints: true, syntaxDiagnostics: false, syntaxVerified: false },
        semanticLanguageServer: false, unsavedEditorBuffers: false,
        note: 'TypeScript/JavaScript (TS compiler API) and JSON/JSONC are parsed with verified syntax. Every other language uses lexical declaration/import candidates marked "syntax not verified" (confidence lexical-candidate); Python adds indentation-aware ranges. No compiler/type resolution or language server.',
    };
}
