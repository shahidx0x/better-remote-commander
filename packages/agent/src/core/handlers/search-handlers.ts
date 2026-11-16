import { checkCancelled } from '../../context.js';
import { searchManager } from '../search-manager.js';
import {
  StartSearchArgsSchema,
  GetMoreSearchResultsArgsSchema,
  StopSearchArgsSchema
} from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture } from '../utils/capture.js';

/**
 * Handle start_search command
 */
export async function handleStartSearch(args: unknown): Promise<ServerResult> {
  const parsed = StartSearchArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Invalid arguments for start_search: ${parsed.error}` }],
      isError: true,
    };
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
    
    return {
      content: [{ type: "text", text: `Error starting search session: ${errorMessage}` }],
      isError: true,
    };
  }
}

// BRC: blocking search mode (start_search with wait=true).
// Must stay below the relay's per-call timeout (120s).
const WAIT_DEFAULT_TIMEOUT_MS = 30_000;
const WAIT_MAX_TIMEOUT_MS = 110_000;
const WAIT_DEFAULT_MAX_RESULTS = 200;
const WAIT_POLL_MS = 250; // upper bound; waitForActivity wakes earlier on output or exit

type StartSearchArgs = ReturnType<typeof StartSearchArgsSchema.parse>;

async function runBlockingSearch(args: StartSearchArgs): Promise<ServerResult> {
  const timeoutMs = Math.min(Math.max(args.timeout_ms ?? WAIT_DEFAULT_TIMEOUT_MS, 1_000), WAIT_MAX_TIMEOUT_MS);
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
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    return { content: [{ type: "text", text: `Error starting search: ${errorMessage}` }], isError: true };
  }

  const deadline = Date.now() + timeoutMs;
  let stoppedReason: 'complete' | 'cap' | 'timeout' = 'complete';
  for (;;) {
    checkCancelled();
    const s = searchManager.readSearchResults(sessionId, 0, 0);
    if (s.isComplete) { stoppedReason = 'complete'; break; }
    if (s.totalMatches >= cap) { stoppedReason = 'cap'; break; }
    if (Date.now() >= deadline) { stoppedReason = 'timeout'; break; }
    await searchManager.waitForActivity(sessionId, Math.min(WAIT_POLL_MS, Math.max(1, deadline - Date.now())));
  }
  if (stoppedReason !== 'complete') searchManager.terminateSearch(sessionId);

  const all = searchManager.readSearchResults(sessionId, 0, Number.MAX_SAFE_INTEGER);
  if (all.stopReason === 'limit') stoppedReason = 'cap';
  if (all.stopReason === 'timeout') stoppedReason = 'timeout';
  if (all.isError && all.totalResults === 0 && all.error?.trim()) {
    return { content: [{ type: "text", text: `Search failed: ${all.error}` }], isError: true };
  }

  // Keep results up to `cap` matches (context lines ride along with their match).
  const lines: string[] = [];
  let matches = 0;
  let truncated = false;
  let lastFile = '';
  for (const r of all.results) {
    if (r.type === 'file') {
      if (matches >= cap) { truncated = true; break; }
      matches++;
      lines.push(r.file);
      continue;
    }
    if (!r.isContext) {
      if (matches >= cap) { truncated = true; break; }
      matches++;
    }
    if (r.file !== lastFile) {
      if (lastFile) lines.push('');
      lines.push(r.file);
      lastFile = r.file;
    }
    const text = r.lineText ?? r.match ?? '';
    lines.push(`${r.line}${r.isContext ? '-' : ':'} ${text}`);
  }

  const kind = isContent ? 'match(es)' : 'file(s)';
  let header = `${matches} ${kind} for "${args.pattern}" in ${args.path} (${Math.round(all.runtime)}ms)`;
  if (stoppedReason === 'cap' || truncated) header += ` — stopped at maxResults=${cap}; narrow the pattern/filePattern or raise maxResults`;
  if (stoppedReason === 'timeout') header += ` — timed out after ${timeoutMs}ms, results may be incomplete`;
  if (all.stopReason === 'output_limit') header += ' [output limit reached; narrow the query]';
  if (all.wasIncomplete && !all.stopReason) header += ` — some paths were inaccessible`;

  const body = lines.length ? lines.join('\n') : 'No matches found.';
  return { content: [{ type: "text", text: `${header}\n\n${body}` }] };
}

/**
 * Handle get_more_search_results command
 */
export async function handleGetMoreSearchResults(args: unknown): Promise<ServerResult> {
  const parsed = GetMoreSearchResultsArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Invalid arguments for get_more_search_results: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    const results = searchManager.readSearchResults(
      parsed.data.sessionId,
      parsed.data.offset,
      parsed.data.length
    );
    
    // Only return error if we have no results AND there's an actual error
    // Permission errors should not block returning found results
    if (results.isError && results.totalResults === 0 && results.error?.trim()) {
      return {
        content: [{
          type: "text",
          text: `Search session ${parsed.data.sessionId} encountered an error: ${results.error}`
        }],
        isError: true,
      };
    }

    // Format results for display
    let output = `Search session: ${parsed.data.sessionId}\n`;
    output += `Status: ${results.isComplete ? 'COMPLETED' : 'IN PROGRESS'}\n`;
    output += `Runtime: ${Math.round(results.runtime / 1000)}s\n`;
    output += `Total results found: ${results.totalResults} (${results.totalMatches} matches)\n`;
    
    const offset = parsed.data.offset;
    
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
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    return {
      content: [{ type: "text", text: `Error reading search results: ${errorMessage}` }],
      isError: true,
    };
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
