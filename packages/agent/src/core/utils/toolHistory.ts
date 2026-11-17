import { activity } from '../../runtime/activity.js';
import type { ServerResult } from '../types.js';
export interface ToolCallRecord { timestamp: string; toolName: string; arguments: unknown; output: ServerResult; duration?: number }
class ToolHistory {
  addCall(toolName: string, _args: unknown, output: ServerResult, duration?: number): void {
    activity.tool(output.isError ? 'ERROR' : 'OK', toolName, 'history', duration);
  }
  getRecentCalls(options: { maxResults?: number; toolName?: string; since?: string }): ToolCallRecord[] {
    return activity.recent().filter(e => e.tool && e.phase && e.phase !== 'START' && (!options.toolName || e.tool === options.toolName) && (!options.since || Date.parse(e.timestamp) >= Date.parse(options.since)))
      .slice(-Math.min(1000, Math.max(1, options.maxResults ?? 50)))
      .map(e => ({ timestamp: e.timestamp, toolName: e.tool!, arguments: {}, duration: e.ms,
        output: { isError: e.phase === 'ERROR', content: [{ type: 'text', text: e.code ?? e.phase! }] } }));
  }
  getRecentCallsFormatted(options: { maxResults?: number; toolName?: string; since?: string }) { return this.getRecentCalls(options); }
  getStats() { const es = this.getRecentCalls({maxResults:1000}); return { totalEntries: es.length, oldestEntry: es[0]?.timestamp, newestEntry: es.at(-1)?.timestamp, historyFile: activity.directory, queuedWrites: 0 }; }
  async cleanup(): Promise<void> { await activity.flush(); }
}
export const toolHistory = new ToolHistory();
