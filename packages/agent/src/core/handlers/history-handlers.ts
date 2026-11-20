import { toolHistory } from '../utils/toolHistory.js';
import { GetRecentToolCallsArgsSchema, TrackUiEventArgsSchema } from '../tools/schemas.js';
import { ServerResult } from '../types.js';
import { capture_ui_event } from '../utils/capture.js';

type TrackUiEventParams = Record<string, string | number | boolean | null>;

export function buildTrackUiEventCapturePayload(event: string, component: string, params: TrackUiEventParams): Record<string, string | number | boolean | null> {
  return {
    ...params,
    component,
    event
  };
}

/**
 * Handle get_recent_tool_calls command
 */
export async function handleGetRecentToolCalls(args: unknown): Promise<ServerResult> {
  try {
    const parsed = GetRecentToolCallsArgsSchema.parse(args);
    
    // Return the newest entries first. Paging avoids sending a full
    // 1,000 x 4KiB history dump through a single MCP response.
    const calls = (await toolHistory.getRecentCallsFormatted({
      maxResults: Math.min(1000,parsed.maxResults+1),
      offset: parsed.offset,
      toolName: parsed.toolName,
      since: parsed.since
    })).reverse();
    const stats = toolHistory.getStats();
    const budgetBytes = 96*1024;
    let used = 0;
    const returned:typeof calls = [];
    for(const entry of calls.slice(0,parsed.maxResults)){
      const bytes=Buffer.byteLength(JSON.stringify(entry),'utf8')+2;
      if(returned.length && used+bytes>budgetBytes)break;
      returned.push(entry);
      used+=bytes;
    }
    const more=calls.length>returned.length;
    const nextOffset=more?parsed.offset+returned.length:null;
    const summary='Tool Call History ('+returned.length+' shown; '+
      stats.totalEntries+' retained; '+stats.maxEntries+' max; '+
      (stats.persisted?'disk-backed':'live only')+')';
    const paging=more?'MORE HISTORY: get_recent_tool_calls({offset:'+
      nextOffset+',maxResults:'+parsed.maxResults+
      (parsed.toolName?',toolName:'+JSON.stringify(parsed.toolName):'')+'})':'No additional history in this page.';
    return {
      content:[{type:'text',text:summary+'\n'+paging+'\n\n'+JSON.stringify(returned,null,2)}],
      structuredContent:{returned:returned.length,totalRetained:stats.totalEntries,
        persisted:stats.persisted,hasMore:more,nextOffset,maxFileBytes:stats.maxFileBytes,
        maxOutputBytes:stats.maxOutputBytes}
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error getting tool history: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Handle track_ui_event command
 */
export async function handleTrackUiEvent(args: unknown): Promise<ServerResult> {
  try {
    const parsed = TrackUiEventArgsSchema.parse(args);

    await capture_ui_event('mcp_ui_event', buildTrackUiEventCapturePayload(parsed.event, parsed.component, parsed.params));

    return {
      content: [{
        type: "text",
        text: `Tracked UI event: ${parsed.event}`
      }]
    };
  } catch (error) {
    return {
      content: [{
        type: "text",
        text: `Error tracking UI event: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}
