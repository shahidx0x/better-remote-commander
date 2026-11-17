/**
 * Agent-only search errors. Vendored start_search historically returned isError
 * without structuredContent.error, so the dispatcher called it TOOL_FAILED.
 * Use specific model-facing codes without persisting query text or paths.
 */
import { AgentError, failure } from './errors.js';
import type { ToolResult } from 'brc-shared';

export function searchErrorCode(error:unknown):string {
  if(error instanceof AgentError)return error.code;
  const message=(error instanceof Error?error.message:String(error)).toLowerCase();
  if(/search_busy|too many.*search|search session.*limit/.test(message))return 'SEARCH_BUSY';
  if(/regex parse error|invalid regular expression|unclosed character class|invalid regex|error parsing regex/.test(message))return 'SEARCH_INVALID_PATTERN';
  if(/ripgrep binary not found|failed to locate ripgrep|rg executable not found/.test(message))return 'SEARCH_RIPGREP_UNAVAILABLE';
  if(/process error|failed to start ripgrep|spawn.*enoent|spawn.*eacces|spawn.*eperm/.test(message))return 'SEARCH_START_FAILED';
  if(/session .* not found|search session .* not found/.test(message))return 'SEARCH_SESSION_NOT_FOUND';
  if(/access is denied|permission denied|outside allowed|not allowed|eacces|eperm/.test(message))return 'SEARCH_ACCESS_DENIED';
  if(/timeout|timed out/.test(message))return 'SEARCH_TIMEOUT';
  return 'SEARCH_FAILED';
}
export function structuredSearchFailure(error:unknown,stage:'start'|'results'|'stop'|'validate'):ToolResult {
  const code=searchErrorCode(error);
  const message=error instanceof Error?error.message:String(error);
  const specific=new AgentError(code,'Search '+stage+' failed: '+message.slice(0,1400));
  const out=failure(specific);
  out.structuredContent={...out.structuredContent,
    commandExecuted:false,
    searchStage:stage,
    recovery:{automaticRetry:false,suggestion:
      code==='SEARCH_INVALID_PATTERN'?'The expression is invalid. Correct regex syntax or set literalSearch:true to search exact text.':
      code==='SEARCH_RIPGREP_UNAVAILABLE'?'Install ripgrep (rg), or configure BRC_RG_PATH to its executable and restart the agent.':
      code==='SEARCH_START_FAILED'?'Check local ripgrep binary permissions, architecture and executable path. Do not retry unchanged.':
      code==='SEARCH_ACCESS_DENIED'?'Choose an existing absolute directory inside the agent allowed directories; check permissions.':
      code==='SEARCH_BUSY'?'Use get_more_search_results or stop_search for existing sessions, or wait until search slots free.':
      code==='SEARCH_SESSION_NOT_FOUND'?'Start a new search and use its returned sessionId for pagination.':
      code==='SEARCH_TIMEOUT'?'Narrow the directory, regex or filePattern; reduce maxResults, or increase timeout_ms within allowed limits.':
      'Inspect the search failure details and adjust the path/pattern or local ripgrep environment before retrying.'}};
  return out;
}
