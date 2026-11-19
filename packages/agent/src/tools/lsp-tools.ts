/** Opt-in-on-use language intelligence. No child process on BRC startup. */
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import type {ToolDefinition} from '../core/tool-definitions.js';
import type {ToolResult} from 'brc-shared';
import {lazyLanguageServer} from '../runtime/lazy-lsp.js';
import {AgentError,result} from '../runtime/errors.js';

export const LspQuerySchema=z.object({
 action:z.enum(['status','definition','references','hover','document_symbols','implementation']),
 path:z.string().min(1).optional().describe('Absolute project root. Required except for status.'),
 file:z.string().min(1).optional().describe('Saved file path under project root, e.g. src/main.rs. Required except for status.'),
 line:z.number().int().min(1).optional().describe('One-based line number; not needed for document_symbols/status.'),
 column:z.number().int().min(1).optional().describe('One-based column number; not needed for document_symbols/status.'),
 maxResults:z.number().int().min(1).max(100).optional().default(50)
}).strict();

export async function lspQuery(raw:unknown):Promise<ToolResult>{
 const a=LspQuerySchema.parse(raw);
 if(a.action==='status')return result(lazyLanguageServer.status());
 if(!a.path||!a.file)throw new AgentError('LSP_PATH_REQUIRED','Supply path (project root) and file (saved .cs/.rs/.py).');
 if(a.action!=='document_symbols'&&(!a.line||!a.column))
  throw new AgentError('LSP_POSITION_REQUIRED','Use one-based line and column for positional queries.');
 return result(await lazyLanguageServer.query({
  path:a.path,file:a.file,action:a.action,line:a.line,column:a.column,maxResults:a.maxResults
 }));
}
export const LSP_TOOL_HANDLERS:Record<string,(args:Record<string,unknown>)=>Promise<ToolResult>>={
 lsp_query:lspQuery
};
export function buildLspToolDefinitions():ToolDefinition[]{
 return [{name:'lsp_query',description:
  'Lazy read-only semantic navigation for C# (.cs, csharp-ls), Rust (.rs, rust-analyzer) and Python (.py, pylsp). Actions: status (server availability; does not start a server), definition, references, hover, implementation, document_symbols. Uses one trusted local language server at a time, starts only when a real semantic query is made, closes after 90s idle. No installations or edits. A missing language server is reported; never silently substitute lexical guesses. Supply path, file, and 1-based line/column for positional requests. Response is bounded and includes the saved-source SHA-256. For JS/TS use existing semantic find_references.',
  inputSchema:zodToJsonSchema(LspQuerySchema),
  annotations:{title:'Lazy language server',readOnlyHint:true,openWorldHint:false}}];
}
