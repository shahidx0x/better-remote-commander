import { checkCancelled } from '../../context.js';
import { searchManager } from '../search-manager.js';
import {
  StartSearchArgsSchema,
  GetMoreSearchResultsArgsSchema,
  StopSearchArgsSchema
} from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture } from '../utils/capture.js';
import { structuredSearchFailure, searchErrorCode } from '../../runtime/search-diagnostics.js';
import { AgentError } from '../../runtime/errors.js';

/**
 * Handle start_search command
 */
export async function handleStartSearch(args: unknown): Promise<ServerResult> {
  const parsed = StartSearchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return structuredSearchFailure(new AgentError('INVALID_ARGUMENT',
      'Invalid start_search arguments: '+parsed.error.message.slice(0,1000)),'validate') as ServerResult;
  }

  if (parsed.data.wait) {
    return runBlockingSearch(parsed.data);
  }

  try {
    const result = await searchManager.startSearch({
      rootPath: parsed.data.path,
      pattern: parsed.data.pattern,
      searchType: parsed.data.searchType,
      filePattern: parsed.data.filePattern,
      ignoreCase: parsed.data.ignoreCase,
      maxResults: parsed.data.maxResults,
      includeHidden: parsed.data.includeHidden,
      contextLines: parsed.data.contextLines,
      timeout: parsed.data.timeout_ms,
      earlyTermination: parsed.data.earlyTermination,
      literalSearch: parsed.data.literalSearch,
    });

    if(result.isError){
      const state=searchManager.readSearchResults(result.sessionId,0,0);
      return structuredSearchFailure(new AgentError(
        searchErrorCode(state.error??'SEARCH_FAILED'),state.error??'ripgrep search failed'),'start') as ServerResult;
    }
    const searchTypeText = parsed.data.searchType === 'content' ? 'content search' : 'file search';
    
    let output = `Started ${searchTypeText} session: ${result.sessionId}\n`;
    output += `Pattern: "${parsed.data.pattern}"\n`;
    output += `Path: ${parsed.data.path}\n`;
    output += `Status: ${result.isComplete ? 'COMPLETED' : 'RUNNING'}\n`;
    output += `Runtime: ${Math.round(result.runtime)}ms\n`;
    output += `Total results: ${result.totalResults}\n\n`;

    if (result.results.length > 0) {
      output += "Initial results:\n";
      
      for (const searchResult of result.results.slice(0, 10)) {
        if (searchResult.type === 'content') {
          output += `📄 ${searchResult.file}:${searchResult.line} - ${searchResult.match?.substring(0, 100)}${searchResult.match && searchResult.match.length > 100 ? '...' : ''}\n`;
        } else {
          output += `📁 ${searchResult.file}\n`;
        }
      }
      
      if (result.results.length > 10) {
        output += `... and ${result.results.length - 10} more results\n`;
      }
    }

    if (result.isComplete) {
      output += `\n✅ Search completed.`;
    } else {
      output += `\n🔄 Search in progress. Use get_more_search_results to get more results.`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('search_session_start_error', { error: errorMessage });
    
    return structuredSearchFailure(error,'start') as ServerResult;
  }
}

// BRC: blocking search mode (start_search with wait=true).
// Must stay below the relay's per-call timeout (120s).
const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
// Includes queue admission and result formatting. Leave margin below the
// relay's normal 120-second request deadline even when workers are busy.
const WAIT_MAX_TIMEOUT_MS = 105_000;
const WAIT_DEFAULT_MAX_RESULTS = 200;
const WAIT_POLL_MS = 250; // upper bound; waitForActivity wakes earlier on output or exit

type StartSearchArgs = ReturnType<typeof StartSearchArgsSchema.parse>;

async function runBlockingSearch(args: StartSearchArgs): Promise<ServerResult> {
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? WAIT_DEFAULT_TIMEOUT_MS, 1_000), WAIT_MAX_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs; // includes time waiting for a free worker
  const cap = Math.max(1, args.maxResults ?? WAIT_DEFAULT_MAX_RESULTS);
  const isContent = args.searchType === 'content';

  let sessionId: string;
  try {
    const started = await searchManager.startSearch({
      rootPath: args.path,
      pattern: args.pattern,
      searchType: args.searchType,
      filePattern: args.filePattern,
      ignoreCase: args.ignoreCase,
      maxResults: cap,
      includeHidden: args.includeHidden,
      contextLines: args.contextLines,
      timeout: timeoutMs,
      earlyTermination: args.earlyTermination,
      literalSearch: args.literalSearch,
      skipInitialWait: true,
    });
    sessionId = started.sessionId;
    // An immediate ripgrep failure must not be reported as a successful empty search.
    if (started.isError) {
      const state = searchManager.readSearchResults(sessionId, 0, 0);
      return structuredSearchFailure(new AgentError(
        searchErrorCode(state.error ?? 'SEARCH_FAILED'),
        state.error ?? 'ripgrep search failed during startup'), 'start') as ServerResult;
    }
  } catch (error) {
    return structuredSearchFailure(error,'start') as ServerResult;
  }

  let stoppedReason: 'complete' | 'cap' | 'timeout' = 'complete';
  try {
    for (;;) {
      checkCancelled();
      const s = searchManager.readSearchResults(sessionId, 0, 0);
      if (s.isComplete) { stoppedReason = 'complete'; break; }
      if (s.totalMatches >= cap) { stoppedReason = 'cap'; break; }
      if (Date.now() >= deadline) { stoppedReason = 'timeout'; break; }
      await searchManager.waitForActivity(sessionId, Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
    }
  } catch (error) {
    // A cancelled/failed blocking request must release its ripgrep process.
    // Previously this path bypassed terminateSearch and could hold a worker.
    searchManager.terminateSearch(sessionId);
    throw error;
  }
  if (stoppedReason !== 'complete') searchManager.terminateSearch(sessionId);

  const all = searchManager.readSearchResults(sessionId, 0, Number.MAX_SAFE_INTEGER);
  if (all.stopReason === 'limit') stoppedReason = 'cap';
  if (all.stopReason === 'timeout') stoppedReason = 'timeout';
  if (all.isError && all.totalResults === 0 && all.error?.trim()) {
    return structuredSearchFailure(new AgentError(searchErrorCode(all.error),all.error),'results') as ServerResult;
  }

  // A large match set must not be forwarded as one huge MCP/ChatGPT
  // response. Retain the search session for explicit offset-based retrieval.
  const MAX_SEARCH_RESULT_CHARS = 48_000;
  const lines: string[] = [];
  let matches = 0;
  let truncated = false;
  let lastFile = '';
  let outputChars = 0;
  let returnedCount = 0;
  for (const r of all.results) {
    const isMatch = r.type === 'file' || !r.isContext;
    if (isMatch && matches >= cap) {truncated=true;break;}
    const nextFile = r.type === 'content' && r.file !== lastFile;
    const snippet = r.type === 'file' ? r.file :
      (nextFile ? (lastFile ? '\n' : '') + r.file + '\n' : '') +
      `${r.line}${r.isContext ? '-' : ':'} ${r.lineText ?? r.match ?? ''}`;
    if (outputChars + snippet.length + 1 > MAX_SEARCH_RESULT_CHARS) {truncated=true;break;}
    if (isMatch) matches++;
    if (r.type === 'content') lastFile=r.file;
    lines.push(snippet);
    outputChars += snippet.length + 1;
    returnedCount++;
  }

  const kind = isContent ? 'match(es)' : 'file(s)';
  let header = `${matches} ${kind} for "${args.pattern}" in ${args.path} (${Math.round(all.runtime)}ms)`;
  if (stoppedReason === 'cap' || truncated) header += ` — stopped at maxResults=${cap}; narrow the pattern/filePattern or raise maxResults`;
  if (stoppedReason === 'timeout') header += ` — timed out after ${timeoutMs}ms, results may be incomplete`;
  if (all.stopReason === 'output_limit') header += ' [output limit reached; narrow the query]';
  if (all.wasIncomplete && !all.stopReason) header += ` — some paths were inaccessible`;

  const hasMoreResults=truncated || returnedCount<all.results.length;
  if(hasMoreResults)header += '\nMORE SEARCH RESULTS: use get_more_search_results with sessionId='+sessionId+
    ' offset='+returnedCount+' length=80; no new search is necessary.';
  const body = lines.length ? lines.join('\n') : 'No matches found.';
  return { content: [{ type: "text", text: `${header.slice(0,2000)}\n\n${body}` }],
    structuredContent:{sessionId,totalMatches:all.totalMatches,returnedCount,
      isComplete:all.isComplete,hasMoreResults,outputTruncated:truncated,
      stopReason:all.stopReason,wasIncomplete:all.wasIncomplete,
      ...(hasMoreResults?{next:{tool:'get_more_search_results',
        args:{sessionId,offset:returnedCount,length:80}}}:{})}
  };
}

/**
 * Handle get_more_search_results command
 */
export async function handleGetMoreSearchResults(args: unknown): Promise<ServerResult> {
  const parsed = GetMoreSearchResultsArgsSchema.safeParse(args);
  if (!parsed.success) return structuredSearchFailure(new AgentError('INVALID_ARGUMENT',
    'Invalid get_more_search_results args: '+parsed.error.message.slice(0,1000)),'validate') as ServerResult;

  try {
    const results = searchManager.readSearchResults(
      parsed.data.sessionId,
      parsed.data.offset<0?Math.max(-80,parsed.data.offset):parsed.data.offset,
      Math.max(1,Math.min(80,parsed.data.length))
    );
    
    // Only return error if we have no results AND there's an actual error
    // Permission errors should not block returning found results
    if (results.isError && results.totalResults === 0 && results.error?.trim()) {
      return structuredSearchFailure(new AgentError(searchErrorCode(results.error),results.error),'results') as ServerResult;
    }

    // Format results for display
    let output = `Search session: ${parsed.data.sessionId}\n`;
    output += `Status: ${results.isComplete ? 'COMPLETED' : 'IN PROGRESS'}\n`;
    output += `Runtime: ${Math.round(results.runtime / 1000)}s\n`;
    output += `Total results found: ${results.totalResults} (${results.totalMatches} matches)\n`;
    
    const offset = parsed.data.offset<0?Math.max(-80,parsed.data.offset):parsed.data.offset;
    
    if (offset < 0) {
      // Negative offset - tail behavior
      output += `Showing last ${results.returnedCount} results\n\n`;
    } else {
      // Positive offset - range behavior
      const startPos = offset;
      const endPos = startPos + results.returnedCount - 1;
      output += `Showing results ${startPos}-${endPos}\n\n`;
    }

    if (results.results.length === 0) {
      if (results.isComplete) {
        output += results.totalResults === 0 ? "No matches found." : "No results in this range.";
      } else {
        output += "No results yet, search is still running...";
      }
    } else {
      output += "Results:\n";
      
      for (const result of results.results) {
        if (result.type === 'content') {
          output += `📄 ${result.file}:${result.line} - ${result.match?.substring(0, 100)}${result.match && result.match.length > 100 ? '...' : ''}\n`;
        } else {
          output += `📁 ${result.file}\n`;
        }
      }
    }

    // Add pagination hints
    if (offset >= 0 && results.hasMoreResults) {
      const nextOffset = offset + results.returnedCount;
      output += `\n📖 More results available. Use get_more_search_results with offset: ${nextOffset}`;
    }

    if (results.isComplete) {
      output += `\n✅ Search completed.`;
      
      // Warn users if search was incomplete due to permission issues
      if (results.stopReason) output += `\nSearch stopped: ${results.stopReason}; results are partial.`;
      if (results.wasIncomplete && !results.stopReason) {
        output += `\n⚠️  Warning: Some files were inaccessible due to permissions. Results may be incomplete.`;
      }
    }

    return {
      content: [{ type: "text", text: output }],
      structuredContent:{sessionId:parsed.data.sessionId,returnedCount:results.returnedCount,
        totalMatches:results.totalMatches,isComplete:results.isComplete,
        hasMoreResults:results.hasMoreResults,
        ...(offset>=0&&results.hasMoreResults?{next:{tool:'get_more_search_results',
          args:{sessionId:parsed.data.sessionId,offset:offset+results.returnedCount,length:80}}}:{})}
    };
  } catch (error) {
    return structuredSearchFailure(error,'results') as ServerResult;
  }
}

/**
 * Handle stop_search command
 */
export async function handleStopSearch(args: unknown): Promise<ServerResult> {
  const parsed = StopSearchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Invalid arguments for stop_search: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    const success = searchManager.terminateSearch(parsed.data.sessionId);
    
    if (success) {
      return {
        content: [{
          type: "text",
          text: `Search session ${parsed.data.sessionId} terminated successfully.`
        }],
      };
    } else {
      return {
        content: [{
          type: "text",
          text: `Search session ${parsed.data.sessionId} not found or already completed.`
        }],
      };
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return {
      content: [{ type: "text", text: `Error terminating search session: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * Handle list_searches command
 */
export async function handleListSearches(): Promise<ServerResult> {
  try {
    const sessions = searchManager.listSearchSessions();
    
    if (sessions.length === 0) {
      return {
        content: [{ type: "text", text: "No active searches." }],
      };
    }

    let output = `Active Searches (${sessions.length}):\n\n`;
    
    for (const session of sessions) {
      const status = session.isComplete 
        ? (session.isError ? '❌ ERROR' : '✅ COMPLETED')
        : '🔄 RUNNING';
      
      output += `Session: ${session.id}\n`;
      output += `  Type: ${session.searchType}\n`;
      output += `  Pattern: "${session.pattern}"\n`;
      output += `  Status: ${status}\n`;
      output += `  Runtime: ${Math.round(session.runtime / 1000)}s\n`;
      output += `  Results: ${session.totalResults}\n\n`;
    }

    return {
      content: [{ type: "text", text: output }],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return {
      content: [{ type: "text", text: `Error listing search sessions: ${errorMessage}` }],
      isError: true,
    };
  }
}
