import { activity } from '../../runtime/activity.js';
export interface FuzzySearchLogEntry {
    timestamp: Date;
    searchText: string;
    foundText: string;
    similarity: number;
    executionTime: number;
    exactMatchCount: number;
    expectedReplacements: number;
    fuzzyThreshold: number;
    belowThreshold: boolean;
    diff: string;
    searchLength: number;
    foundLength: number;
    fileExtension: string;
    characterCodes: string;
    uniqueCharacterCount: number;
    diffLength: number;
}


class FuzzySearchLogger {
  async log(entry: FuzzySearchLogEntry): Promise<void> { activity.log('debug', `Fuzzy search ${Math.round(entry.executionTime)}ms similarity=${entry.similarity.toFixed(3)}`); }
  async getLogPath(): Promise<string> { return activity.directory; }
  async getRecentLogs(count = 10): Promise<string[]> { return activity.recent().filter(e => e.message.startsWith('Fuzzy search')).slice(-Math.min(100, Math.max(1, count))).map(e => e.message); }
  async clearLog(): Promise<void> { /* No separate source-content logs are created. */ }
}
export const fuzzySearchLogger = new FuzzySearchLogger();
