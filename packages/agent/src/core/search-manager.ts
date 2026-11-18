import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import fs from 'fs/promises';
import os from 'node:os';
import { validatePath } from './tools/filesystem.js';
import { capture } from './utils/capture.js';
import { getRipgrepPath } from './utils/ripgrep-resolver.js';
import { isExcelFile } from './utils/files/index.js';
import { getCallContext, checkCancelled } from '../context.js';

export interface SearchResult {
  file: string;
  line?: number;
  match?: string;
  type: 'file' | 'content';
  /** BRC: full text of the matched/context line (trimmed, capped) for grep-style output */
  lineText?: string;
  /** BRC: true for ripgrep context lines (not actual matches) */
  isContext?: boolean;
}

const MAX_LINE_TEXT = 400;
// Keep search fan-out and retained results bounded in the Normal profile.
const MAX_ACTIVE_SEARCHES = 2;
const MAX_QUEUED_SEARCHES = 16;
const MAX_SEARCH_SLOT_WAIT_MS = 10_000;
type SearchSlotWaiter = {
  resolve: () => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  signal?: AbortSignal;
  abort?: () => void;
};
const SEARCH_RESULT_BYTE_BUDGET = 1 * 1024 * 1024;
const capLine = (s: string | undefined): string | undefined => {
  if (s === undefined) return undefined;
  const t = s.replace(/\r?\n$/, '');
  return t.length > MAX_LINE_TEXT ? t.slice(0, MAX_LINE_TEXT) + '…' : t;
};

export interface SearchSession {
  id: string;
  process: ChildProcess;
  results: SearchResult[];
  isComplete: boolean;
  isError: boolean;
  error?: string;
  startTime: number;
  lastReadTime: number;
  options: SearchSessionOptions;
  buffer: string;  // For processing incomplete JSON lines
  totalMatches: number;
  bytesStored: number;
  stopReason?: 'limit' | 'output_limit' | 'timeout' | 'cancelled';
  totalContextLines: number;  // Track context lines separately
  wasIncomplete?: boolean;  // NEW: Track if search was incomplete due to permissions/access issues
}

export interface SearchSessionOptions {
  rootPath: string;
  pattern: string;
  searchType: 'files' | 'content';
  filePattern?: string;
  ignoreCase?: boolean;
  maxResults?: number;
  includeHidden?: boolean;
  contextLines?: number;
  timeout?: number;
  earlyTermination?: boolean;  // Stop search early when exact filename match is found
  literalSearch?: boolean;     // Force literal string matching (-F flag) instead of regex
  skipInitialWait?: boolean;   // BRC: blocking callers wait on events themselves (no 40ms first-chunk wait)
}

/**
 * Search Session Manager - handles ripgrep processes like terminal sessions
 * Supports both file search and content search with progressive results
 */export class SearchManager {
  private sessions = new Map<string, SearchSession>();
  private sessionCounter = 0;
  // Reserve capacity before validation/spawn so concurrent starts cannot
  // race past the two-worker cap. Queued calls don't start any processes.
  private pendingStarts = 0;
  private slotWaiters: SearchSlotWaiter[] = [];

  private grantSearchSlots(): void {
    while (this.slotWaiters.length &&
        this.getActiveSessionCount() + this.pendingStarts < MAX_ACTIVE_SEARCHES) {
      const next = this.slotWaiters.shift()!;
      if (next.timer) clearTimeout(next.timer);
      if (next.signal && next.abort) next.signal.removeEventListener('abort', next.abort);
      this.pendingStarts++;
      next.resolve();
    }
  }

  private releaseStartSlot(): void {
    this.pendingStarts = Math.max(0, this.pendingStarts - 1);
    this.grantSearchSlots();
  }

  private async reserveStartSlot(): Promise<() => void> {
    const signal = getCallContext()?.signal;
    checkCancelled();
    if (!this.slotWaiters.length &&
        this.getActiveSessionCount() + this.pendingStarts < MAX_ACTIVE_SEARCHES) {
      this.pendingStarts++;
      return () => this.releaseStartSlot();
    }
    if (this.slotWaiters.length >= MAX_QUEUED_SEARCHES) {
      throw new Error('SEARCH_BUSY: bounded pending search queue is full; retry after an active search completes.');
    }
    await new Promise<void>((resolve,reject) => {
      const pending: SearchSlotWaiter = { resolve, reject, signal };
      const forget = (): boolean => {
        const idx = this.slotWaiters.indexOf(pending);
        if (idx < 0) return false; // already granted the capacity
        this.slotWaiters.splice(idx,1);
        if (pending.timer) clearTimeout(pending.timer);
        if (signal && pending.abort) signal.removeEventListener('abort',pending.abort);
        return true;
      };
      pending.abort = () => {
        if (forget()) reject(new Error('SEARCH_CANCELLED: cancelled while waiting for a free search worker.'));
      };
      pending.timer = setTimeout(() => {
        if (forget()) reject(new Error('SEARCH_BUSY: no search worker became available within 10 seconds.'));
      }, MAX_SEARCH_SLOT_WAIT_MS);
      pending.timer.unref?.();
      this.slotWaiters.push(pending);
      signal?.addEventListener('abort',pending.abort,{once:true});
      if (signal?.aborted) pending.abort();
      else this.grantSearchSlots();
    });
    return () => this.releaseStartSlot();
  }

  /**
   * Start a new search session (like start_process)
   * Returns immediately with initial state and results
   */

  async startSearch(options: SearchSessionOptions): Promise<{
    sessionId: string;
    isComplete: boolean;
    isError: boolean;
    results: SearchResult[];
    totalResults: number;
    runtime: number;
  }> {
    checkCancelled();
    options = {...options, maxResults: Math.min(10000, Math.max(1, options.maxResults ?? 1000))};
    const releaseSlot = await this.reserveStartSlot();
    try {
    checkCancelled();
    if (this.sessions.size >= 32) {
      for (const [id, old] of this.sessions) { if (old.isComplete) this.sessions.delete(id); if (this.sessions.size < 32) break; }
      if (this.sessions.size >= 32) throw new Error('SEARCH_BUSY: stop an active search before starting another.');
    }
    const sessionId = `search_${++this.sessionCounter}_${Date.now()}`;
    
    // Validate path first
    const validPath = await validatePath(options.rootPath);

    // Build ripgrep arguments
    const args = this.buildRipgrepArgs({ ...options, rootPath: validPath });
    
    // Get ripgrep path with fallback resolution
    let rgPath: string;
    try {
      rgPath = await getRipgrepPath();
    } catch (err) {
      throw new Error(`Failed to locate ripgrep binary: ${err instanceof Error ? err.message : String(err)}`);
    }
    
    // Start ripgrep. A platform-specific spawn() failure must return a
    // classified SEARCH_START_FAILED, not kill the agent or leak worker slots.
    let rgProcess: ChildProcess;
    try {
      rgProcess = spawn(rgPath, args, { windowsHide: true });
    } catch (error) {
      throw new Error('Failed to start ripgrep process: '+
        (error instanceof Error ? error.message : String(error)));
    }

    if (!rgProcess.pid) {
      // Node emits the spawn error on a subsequent tick. Without this listener,
      // throwing here can leave an unhandled ChildProcess 'error' that crashes
      // the entire agent instead of returning SEARCH_START_FAILED.
      rgProcess.once('error', () => {});
      throw new Error('Failed to start ripgrep process');
    }
    if (process.platform === 'win32') {
      try { os.setPriority(rgProcess.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { /* running without permissions is okay: executable still starts */ }
    }

    // Create session
    const session: SearchSession = {
      id: sessionId,
      process: rgProcess,
      results: [],
      isComplete: false,
      isError: false,
      startTime: Date.now(),
      lastReadTime: Date.now(),
      options,
      buffer: '',
      totalMatches: 0,
      bytesStored: 0,
      totalContextLines: 0
    };

    this.sessions.set(sessionId, session);

    // Set up process event handlers
    this.setupProcessHandlers(session);
    // The manager's close/error handlers update isComplete first, so waiting
    // callers are released only after a worker actually exits.
    rgProcess.once('close', () => this.grantSearchSlots());
    rgProcess.once('error', () => this.grantSearchSlots());
    const signal = getCallContext()?.signal;
    const abort = () => this.stopLimited(session, 'cancelled');
    signal?.addEventListener('abort', abort, {once:true});
    if (signal?.aborted) abort();
    rgProcess.once('close', () => signal?.removeEventListener('abort', abort));
    rgProcess.once('error', () => signal?.removeEventListener('abort', abort));

    // Start cleanup interval now that we have a session
    startCleanupIfNeeded();

    // Set up timeout if specified and auto-terminate
    // For exact filename searches, use a shorter default timeout
    const timeoutMs = options.timeout ?? (this.isExactFilename(options.pattern) ? 1500 : undefined);
    
    let killTimer: NodeJS.Timeout | null = null;
    if (timeoutMs) {
      killTimer = setTimeout(() => {
        if (!session.isComplete && !session.process.killed) {
          this.stopLimited(session, 'timeout');
        }
      }, timeoutMs);
    }

    // Clear timer on process completion
    session.process.once('close', () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    session.process.once('error', () => {
      if (killTimer) {
        clearTimeout(killTimer);
        killTimer = null;
      }
    });

    capture('search_session_started', {
      sessionId,
      searchType: options.searchType,
      hasTimeout: !!timeoutMs,
      timeoutMs,
      requestedPath: options.rootPath,
      validatedPath: validPath
    });

    // For content searches, only search Excel files when contextually relevant:
    // - filePattern explicitly targets Excel files (*.xlsx, *.xls, etc.)
    // - or rootPath is an Excel file itself
    const shouldSearchExcel = options.searchType === 'content' &&
      this.shouldIncludeExcelSearch(options.filePattern, validPath);

    if (shouldSearchExcel) {
      this.searchExcelFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,  // Pass filePattern to filter Excel files too
        options.literalSearch  // Respect literalSearch flag for Office files
      ).then(excelResults => {
        // Add Excel results to session (merged after initial response)
        for (const result of excelResults) {
          if (!this.addResult(session, result)) break;
        }
      }).catch((err) => {
        // Log Excel search errors but don't fail the whole search
        capture('excel_search_error', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // For content searches, also search DOCX files
    const shouldSearchDocx = options.searchType === 'content' &&
      this.shouldIncludeDocxSearch(options.filePattern, validPath);

    if (shouldSearchDocx) {
      this.searchDocxFiles(
        validPath,
        options.pattern,
        options.ignoreCase !== false,
        options.maxResults,
        options.filePattern,
        options.literalSearch  // Respect literalSearch flag for Office files
      ).then(docxResults => {
        for (const result of docxResults) {
          if (!this.addResult(session, result)) break;
        }
      }).catch((err) => {
        capture('docx_search_error', { error: err instanceof Error ? err.message : String(err) });
      });
    }

    // Wait for first chunk of data or early completion instead of fixed delay
    // Excel search runs in background and results are merged via readSearchResults
    const firstChunk = new Promise<void>(resolve => {
      const onData = () => {
        session.process.stdout?.off('data', onData);
        resolve();
      };
      session.process.stdout?.once('data', onData);
      setTimeout(resolve, 40); // cap at 40ms instead of 50-100ms
    });

    // Only wait for ripgrep first chunk - Excel results merge asynchronously
    if (!options.skipInitialWait) await firstChunk;

    return {
      sessionId,
      isComplete: session.isComplete,
      isError: session.isError,
      results: [...session.results],
      totalResults: session.totalMatches,
      runtime: Date.now() - session.startTime
    };
    } finally {
      // A failed path/regex check or failed spawn must never leak a slot.
      releaseSlot();
    }
  }

  /**
   * Read search results with offset-based pagination (like read_file)
   * Supports both range reading and tail behavior
   */
  /**
   * BRC: resolve on the next sign of progress (new ripgrep output or process exit) or after ms.
   * Lets blocking callers react immediately instead of polling on a fixed interval.
   */
  waitForActivity(sessionId: string, ms: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session || session.isComplete) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const proc = session.process;
      const done = () => {
        clearTimeout(timer);
        proc.stdout?.off('data', done);
        proc.off('close', done);
        // let the manager's own data/close handlers run first
        setImmediate(resolve);
      };
      const timer = setTimeout(done, Math.max(1, ms));
      proc.stdout?.once('data', done);
      proc.once('close', done);
    });
  }

  readSearchResults(
    sessionId: string, 
    offset: number = 0, 
    length: number = 100
  ): {
    results: SearchResult[];
    returnedCount: number;        // Renamed from newResultsCount
    totalResults: number;
    totalMatches: number;         // Actual matches (excluding context)
    isComplete: boolean;
    isError: boolean;
    error?: string;
    hasMoreResults: boolean;      // New field
    runtime: number;
    stopReason?: SearchSession['stopReason'];
    wasIncomplete?: boolean;      // Includes explicit output/match/time limits
  } {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      throw new Error(`Search session ${sessionId} not found`);
    }

    // Get all results (excluding internal markers)
    const allResults = session.results.filter(r => r.file !== '__LAST_READ_MARKER__');
    
    // Handle negative offsets (tail behavior) - like file reading
    if (offset < 0) {
      const tailCount = Math.abs(offset);
      const tailResults = allResults.slice(-tailCount);
      return {
        results: tailResults,
        returnedCount: tailResults.length,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches, // Actual matches only
        isComplete: session.isComplete,
        isError: session.isError && !!session.error?.trim(), // Only error if we have actual errors
        error: session.error?.trim() || undefined,
        hasMoreResults: false, // Tail always returns what's available
        runtime: Date.now() - session.startTime,
        stopReason: session.stopReason,
        wasIncomplete: session.wasIncomplete
      };
    }

    // Handle positive offsets (range behavior) - like file reading
    const slicedResults = allResults.slice(offset, offset + length);
    const hasMoreResults = offset + length < allResults.length || !session.isComplete;

    session.lastReadTime = Date.now();

    return {
      results: slicedResults,
      returnedCount: slicedResults.length,
      totalResults: session.totalMatches + session.totalContextLines,
      totalMatches: session.totalMatches, // Actual matches only
      isComplete: session.isComplete,
      isError: session.isError && !!session.error?.trim(), // Only error if we have actual errors
      error: session.error?.trim() || undefined,
      hasMoreResults,
      runtime: Date.now() - session.startTime,
      stopReason: session.stopReason,
      wasIncomplete: session.wasIncomplete
    };
  }

  /**
   * Terminate a search session (like force_terminate)
   */
  terminateSearch(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    
    if (!session) {
      return false;
    }

    if (!session.process.killed) {
      session.process.kill('SIGTERM');
    }

    // Don't delete session immediately - let user read final results
    // It will be cleaned up by cleanup process
    
    return true;
  }

  /**
   * Get list of active search sessions (like list_sessions)
   */
  listSearchSessions(): Array<{
    id: string;
    searchType: string;
    pattern: string;
    isComplete: boolean;
    isError: boolean;
    runtime: number;
    totalResults: number;
  }> {
    return Array.from(this.sessions.values()).map(session => ({
      id: session.id,
      searchType: session.options.searchType,
      pattern: session.options.pattern,
      isComplete: session.isComplete,
      isError: session.isError,
      runtime: Date.now() - session.startTime,
      totalResults: session.totalMatches + session.totalContextLines
    }));
  }

  /**
   * Search Excel files for content matches
   * Called during content search to include Excel files alongside text files
   * Searches ALL sheets in each Excel file (row-wise for cross-column matching)
   *
   * TODO: Refactor - Extract Excel search logic to separate module (src/utils/search/excel-search.ts)
   * and inject into SearchManager, similar to how file handlers are structured in src/utils/files/
   * This would allow adding other file type searches (PDF, etc.) without bloating search-manager.ts
   */
  private async searchExcelFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    // Find Excel files recursively
    let excelFiles = await this.findExcelFiles(rootPath);

    // Filter by filePattern if provided
    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      excelFiles = excelFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          // Support glob-like patterns
          if (pat.includes('*')) {
            // Escape all regex metacharacters first (preserving * for glob expansion),
            // then convert the remaining * wildcards to .* for glob matching.
            // Without this, patterns like report(2024).xlsx or [draft].xlsx would be
            // misinterpreted as regex groups/character-classes.
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metacharacters except *
              .replace(/\*/g, '.*');                  // glob * → regex .*
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          // Exact match (case-insensitive)
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    // Dynamically import ExcelJS to search all sheets
    const ExcelJS = await import('exceljs');

    for (const filePath of excelFiles) {
      if (maxResults && results.length >= maxResults) break;

      try {
        const workbook = new ExcelJS.default.Workbook();
        await workbook.xlsx.readFile(filePath);

        // Search ALL sheets in the workbook (row-wise for speed and cross-column matching)
        for (const worksheet of workbook.worksheets) {
          if (maxResults && results.length >= maxResults) break;

          const sheetName = worksheet.name;

          // Iterate through rows (faster than cell-by-cell)
          worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            if (maxResults && results.length >= maxResults) return;

            // Build a concatenated string of all cell values in the row
            const rowValues: string[] = [];
            row.eachCell({ includeEmpty: false }, (cell) => {
              if (cell.value === null || cell.value === undefined) return;

              let cellStr: string;
              if (typeof cell.value === 'object') {
                if ('result' in cell.value) {
                  cellStr = String(cell.value.result ?? '');
                } else if ('richText' in cell.value) {
                  cellStr = (cell.value as any).richText.map((rt: any) => rt.text).join('');
                } else if ('text' in cell.value) {
                  cellStr = String((cell.value as any).text);
                } else {
                  cellStr = String(cell.value);
                }
              } else {
                cellStr = String(cell.value);
              }

              if (cellStr.trim()) {
                rowValues.push(cellStr);
              }
            });

            // Join all cell values with space for cross-column matching
            const rowText = rowValues.join(' ');

            const textToSearch = ignoreCase ? rowText.toLowerCase() : rowText;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(rowText, matchIndex, searchTerm.length);

              results.push({
                file: `${filePath}:${sheetName}!Row${rowNumber}`,
                line: rowNumber,
                match: matchContext,
                type: 'content'
              });
            }
          });
        }
      } catch (error) {
        // Skip files that can't be read (permission issues, corrupted, etc.)
        continue;
      }
    }

    return results;
  }

  /**
   * Find all Excel files in a directory recursively
   */
  private async findExcelFiles(rootPath: string): Promise<string[]> {
    const excelFiles: string[] = [];

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });

        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);

          if (entry.isDirectory()) {
            // Skip node_modules, .git, etc.
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isExcelFile(entry.name)) {
            excelFiles.push(fullPath);
          }
        }
      } catch {
        // Skip directories we can't read
      }
    }

    // Check if rootPath is a file or directory
    try {
      const stats = await fs.stat(rootPath);
      if (stats.isFile() && isExcelFile(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch {
      // Path doesn't exist or can't be accessed
    }

    return excelFiles;
  }

  /**
   * Determine if DOCX search should be included based on context
   */
  private shouldIncludeDocxSearch(filePattern?: string, rootPath?: string): boolean {
    const docxExtensions = ['.docx'];

    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (docxExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      if (docxExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) || lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  /**
   * Search DOCX files for content matches
   * Extracts <w:t> text from document.xml and searches it
   */
  private async searchDocxFiles(
    rootPath: string,
    pattern: string,
    ignoreCase: boolean,
    maxResults?: number,
    filePattern?: string,
    _literalSearch?: boolean
  ): Promise<SearchResult[]> {
    const results: SearchResult[] = [];

    // Office file search always uses literal matching to prevent ReDoS.
    // Regex patterns are treated as literal strings — this is intentional.
    const searchTerm = ignoreCase ? pattern.toLowerCase() : pattern;

    let docxFiles = await this.findDocxFiles(rootPath);

    if (filePattern) {
      const patterns = filePattern.split('|').map(p => p.trim()).filter(Boolean);
      docxFiles = docxFiles.filter(filePath => {
        const fileName = path.basename(filePath);
        return patterns.some(pat => {
          if (pat.includes('*')) {
            const regexPat = pat
              .replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape metacharacters except *
              .replace(/\*/g, '.*');                  // glob * → regex .*
            return new RegExp(`^${regexPat}$`, 'i').test(fileName);
          }
          return fileName.toLowerCase() === pat.toLowerCase();
        });
      });
    }

    const PizZip = docxFiles.length ? (await import('pizzip')).default : null;
    for (const filePath of docxFiles) {
      if (maxResults && results.length >= maxResults) break;
      if (!PizZip) break;

      try {
        const buf = await fs.readFile(filePath);
        const zip = new PizZip(buf);

        // Search all XML parts that can contain text
        const xmlParts = ['word/document.xml', 'word/header1.xml', 'word/header2.xml',
          'word/header3.xml', 'word/footer1.xml', 'word/footer2.xml', 'word/footer3.xml'];

        for (const xmlPath of xmlParts) {
          if (maxResults && results.length >= maxResults) break;

          const file = zip.file(xmlPath);
          if (!file) continue;

          const xml = file.asText();
          // Extract all <w:t> text with position tracking
          const wtRe = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g;
          let m;
          let lineNum = 0;

          while ((m = wtRe.exec(xml)) !== null) {
            if (maxResults && results.length >= maxResults) break;
            const text = m[1];
            if (!text || !text.trim()) continue;
            lineNum++;

            const textToSearch = ignoreCase ? text.toLowerCase() : text;
            const matchIndex = textToSearch.indexOf(searchTerm);
            if (matchIndex !== -1) {
              const matchContext = this.getMatchContext(text, matchIndex, searchTerm.length);

              const partName = xmlPath === 'word/document.xml' ? '' : `:${xmlPath.replace('word/', '')}`;
              results.push({
                file: `${filePath}${partName}`,
                line: lineNum,
                match: matchContext,
                type: 'content'
              });
            }
          }
        }
      } catch {
        continue;
      }
    }

    return results;
  }

  /**
   * Find all DOCX files in a directory recursively
   */
  private async findDocxFiles(rootPath: string): Promise<string[]> {
    const docxFiles: string[] = [];
    const isDocx = (name: string) => name.toLowerCase().endsWith('.docx');

    async function walk(dir: string): Promise<void> {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          const fullPath = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (!entry.name.startsWith('.') && entry.name !== 'node_modules') {
              await walk(fullPath);
            }
          } else if (entry.isFile() && isDocx(entry.name)) {
            docxFiles.push(fullPath);
          }
        }
      } catch { /* skip */ }
    }

    try {
      const stats = await fs.stat(rootPath);
      if (stats.isFile() && isDocx(rootPath)) {
        return [rootPath];
      } else if (stats.isDirectory()) {
        await walk(rootPath);
      }
    } catch { /* skip */ }

    return docxFiles;
  }

  /**
   * Extract context around a match for display (show surrounding text)
   */
  private getMatchContext(text: string, matchStart: number, matchLength: number): string {
    const contextChars = 50; // chars before and after match
    const start = Math.max(0, matchStart - contextChars);
    const end = Math.min(text.length, matchStart + matchLength + contextChars);

    let context = text.substring(start, end);

    // Add ellipsis if truncated
    if (start > 0) context = '...' + context;
    if (end < text.length) context = context + '...';

    return context;
  }

  /**
   * Clean up completed sessions older than specified time
   * Called automatically by cleanup interval
   */
  cleanupSessions(maxAge: number = 5 * 60 * 1000): void {
    const cutoffTime = Date.now() - maxAge;
    
    for (const [sessionId, session] of this.sessions) {
      if (session.isComplete && session.lastReadTime < cutoffTime) {
        this.sessions.delete(sessionId);
      }
    }
  }

  /**
   * Get total number of active sessions (excluding completed ones)
   */
  getActiveSessionCount(): number {
    return Array.from(this.sessions.values()).filter(session => !session.isComplete).length;
  }

  /**
   * Detect if pattern looks like an exact filename
   * (has file extension and no glob wildcards)
   */
  private isExactFilename(pattern: string): boolean {
    return /\.[a-zA-Z0-9]+$/.test(pattern) &&
           !this.isGlobPattern(pattern);
  }

  /**
   * Detect if pattern contains glob wildcards
   */
  private isGlobPattern(pattern: string): boolean {
    return pattern.includes('*') ||
           pattern.includes('?') ||
           pattern.includes('[') ||
           pattern.includes('{') ||
           pattern.includes(']') ||
           pattern.includes('}');
  }

  /**
   * Determine if Excel search should be included based on context
   * Only searches Excel files when:
   * - filePattern explicitly targets Excel files (*.xlsx, *.xls, *.xlsm, *.xlsb)
   * - or the rootPath itself is an Excel file
   */
  private shouldIncludeExcelSearch(filePattern?: string, rootPath?: string): boolean {
    const excelExtensions = ['.xlsx', '.xls', '.xlsm', '.xlsb'];

    // Check if rootPath is an Excel file
    if (rootPath) {
      const lowerPath = rootPath.toLowerCase();
      if (excelExtensions.some(ext => lowerPath.endsWith(ext))) {
        return true;
      }
    }

    // Check if filePattern targets Excel files
    if (filePattern) {
      const lowerPattern = filePattern.toLowerCase();
      // Check for patterns like *.xlsx, *.xls, or explicit Excel extensions
      if (excelExtensions.some(ext =>
        lowerPattern.includes(`*${ext}`) ||
        lowerPattern.endsWith(ext)
      )) {
        return true;
      }
    }

    return false;
  }

  private buildRipgrepArgs(options: SearchSessionOptions): string[] {
    // Even on a machine with many cores, one ripgrep worker keeps CPU usage
    // predictable. Lower scheduling priority is handled by the local launcher.
    const args: string[] = ['--threads', '1'];
    
    if (options.searchType === 'content') {
      // Content search mode
      args.push('--json', '--line-number', '--max-columns', '2048', '--max-columns-preview');
      
      // Add literal search support for content searches
      if (options.literalSearch) {
        args.push('-F'); // Fixed string matching (literal)
      }

      if (options.contextLines && options.contextLines > 0) {
        args.push('-C', options.contextLines.toString());
      }
    } else {
      // File search mode
      args.push('--files');
    }
    
    // Case-insensitive: content searches use -i flag, file searches use --iglob
    if (options.searchType === 'content' && options.ignoreCase !== false) {
      args.push('-i');
    }
    
    if (options.includeHidden) {
      args.push('--hidden');
    }
    
    if (options.maxResults && options.maxResults > 0) {
      args.push('-m', options.maxResults.toString());
    }

    // File pattern filtering (for file type restrictions like *.js, *.d.ts)
    if (options.filePattern) {
      const patterns = options.filePattern
        .split('|')
        .map(p => p.trim())
        .filter(Boolean);
      
      for (const p of patterns) {
        if (options.searchType === 'content') {
          args.push('-g', p);
        } else {
          // For file search: use --iglob for case-insensitive or --glob for case-sensitive
          if (options.ignoreCase !== false) {
            args.push('--iglob', p);
          } else {
            args.push('--glob', p);
          }
        }
      }
    }
    
    // Handle the main search pattern
    if (options.searchType === 'files') {
      // For file search: determine how to treat the pattern
      const globFlag = options.ignoreCase !== false ? '--iglob' : '--glob';
      
      if (this.isExactFilename(options.pattern)) {
        // Exact filename: use appropriate glob flag with the exact pattern
        args.push(globFlag, options.pattern);
      } else if (this.isGlobPattern(options.pattern)) {
        // Already a glob pattern: use appropriate glob flag as-is
        args.push(globFlag, options.pattern);
      } else {
        // Substring/fuzzy search: wrap with wildcards
        args.push(globFlag, `*${options.pattern}*`);
      }
      // Add the root path for file mode
      args.push(options.rootPath);
    } else {
      // Content search: terminate options before the pattern to prevent 
      // patterns starting with '-' being interpreted as flags
      args.push('--', options.pattern, options.rootPath);
    }
    
    return args;
  }

  private setupProcessHandlers(session: SearchSession): void {
    const { process } = session;

    process.stdout?.setEncoding('utf8');
    process.stdout?.on('data', (data: string) => {
      if (session.stopReason) return;
      session.buffer += data;
      this.processBufferedOutput(session);
      if (session.buffer.length > 262144) this.stopLimited(session, 'output_limit');
    });

    process.stderr?.on('data', (data: Buffer) => {
      const errorText = data.toString();

      // Store error text for potential user display, but don't capture individual errors
      // We'll capture incomplete search status in the completion event instead
      session.error = ((session.error || '') + errorText).slice(0,8192);

      // Filter meaningful errors
      const filteredErrors = errorText
        .split('\n')
        .filter(line => {
          const trimmed = line.trim();

          // Skip empty lines and lines with just symbols/numbers/colons
          if (!trimmed || trimmed.match(/^[\)\(\s\d:]*$/)) return false;

          // Skip all ripgrep system errors that start with "rg:"
          if (trimmed.startsWith('rg:')) return false;

          return true;
        });

      // Only add to session.error if there are actual meaningful errors after filtering
      if (filteredErrors.length > 0) {
        const meaningfulErrors = filteredErrors.join('\n').trim();
        if (meaningfulErrors) {
          session.error = ((session.error || '') + meaningfulErrors + '\n').slice(0,8192);
          capture('search_session_error', {
            sessionId: session.id,
            error: meaningfulErrors.substring(0, 200)
          });
        }
      }
    });

    process.on('close', (code: number) => {
      // Process any remaining buffer content
      if (session.buffer.trim()) {
        this.processBufferedOutput(session, true);
      }

      session.isComplete = true;

      // Track if search was incomplete due to access issues
      // Ripgrep exit code 2 means "some files couldn't be searched"
      if (code === 2) {
        session.wasIncomplete = true;
        if (session.totalMatches === 0) { session.isError = true; session.error ||= 'ripgrep search failed'; }
      }

      // Only treat as error if:
      // 1. Unexpected exit code (not 0, 1, or 2) AND
      // 2. We have meaningful errors after filtering AND
      // 3. We found no results at all
      if (code !== 0 && code !== 1 && code !== 2) {
        // Codes 0=success, 1=no matches, 2=some files couldn't be searched
        if (session.error?.trim() && session.totalMatches === 0) {
          session.isError = true;
          session.error = session.error || `ripgrep exited with code ${code}`;
        }
      }

      // If we have results, don't mark as error even if there were permission issues
      if (session.totalMatches > 0) {
        session.isError = false;
      }

      capture('search_session_completed', {
        sessionId: session.id,
        exitCode: code,
        totalResults: session.totalMatches + session.totalContextLines,
        totalMatches: session.totalMatches,
        runtime: Date.now() - session.startTime,
        stopReason: session.stopReason,
        wasIncomplete: session.wasIncomplete || false  // NEW: Track incomplete searches
      });

      // Rely on cleanupSessions(maxAge) only; no per-session timer
    });

    process.on('error', (error: Error) => {
      session.isComplete = true;
      session.isError = true;
      session.error = `Process error: ${error.message}`;

      // Rely on cleanupSessions(maxAge) only; no per-session timer
    });
  }


  private stopLimited(session: SearchSession, reason: NonNullable<SearchSession['stopReason']>): void {
    if (!session.stopReason) session.stopReason = reason;
    session.wasIncomplete = true;
    session.buffer = '';
    if (!session.process.killed) session.process.kill('SIGTERM');
  }
  private addResult(session: SearchSession, result: SearchResult): boolean {
    if (session.stopReason) return false;
    const match = !(result.type === 'content' && result.isContext);
    if (match && session.totalMatches >= (session.options.maxResults ?? 1000)) { this.stopLimited(session, 'limit'); return false; }
    if (result.match) result.match = result.match.slice(0,2000);
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (session.bytesStored + bytes > SEARCH_RESULT_BYTE_BUDGET || session.results.length >= 10000) { this.stopLimited(session, 'output_limit'); return false; }
    session.bytesStored += bytes;
    session.results.push(result);
    if (match) session.totalMatches++; else session.totalContextLines++;
    if (match && session.totalMatches >= (session.options.maxResults ?? 1000)) this.stopLimited(session, 'limit');
    return true;
  }
  private processBufferedOutput(session: SearchSession, isFinal: boolean = false): void {
    const lines = session.buffer.split('\n');
    
    // Keep the last incomplete line in the buffer unless this is final processing
    if (!isFinal) {
      session.buffer = lines.pop() || '';
    } else {
      session.buffer = '';
    }
    
    for (const line of lines) {
      if (session.stopReason) break;
      if (line.length > 262144) { this.stopLimited(session, 'output_limit'); break; }
      if (!line.trim()) continue;
      
      const result = this.parseLine(line, session.options.searchType);
      if (result) {
        if (!this.addResult(session, result)) break;

        // Early termination for exact filename matches (if enabled)
        if (session.options.earlyTermination !== false && // Default to true
            session.options.searchType === 'files' &&
            this.isExactFilename(session.options.pattern)) {
          const pat = path.normalize(session.options.pattern);
          const filePath = path.normalize(result.file);
          const ignoreCase = session.options.ignoreCase !== false;
          const ends = ignoreCase
            ? filePath.toLowerCase().endsWith(pat.toLowerCase())
            : filePath.endsWith(pat);
          if (ends) {
            // Found exact match, terminate search early
            setTimeout(() => {
              if (!session.process.killed) {
                session.process.kill('SIGTERM');
              }
            }, 100); // Small delay to allow any remaining results
            break;
          }
        }
      }
    }
  }

  private parseLine(line: string, searchType: 'files' | 'content'): SearchResult | null {
    if (searchType === 'content') {
      // Parse JSON output from content search
      try {
        const parsed = JSON.parse(line);
        
        if (parsed.type === 'match') {
          // Handle multiple submatches per line - return first submatch
          const submatch = parsed.data?.submatches?.[0];
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: submatch?.match?.text || parsed.data.lines.text,
            type: 'content',
            lineText: capLine(parsed.data.lines?.text),
          };
        }
        
        if (parsed.type === 'context') {
          return {
            file: parsed.data.path.text,
            line: parsed.data.line_number,
            match: parsed.data.lines.text.trim(),
            type: 'content',
            lineText: capLine(parsed.data.lines?.text),
            isContext: true,
          };
        }
        
        // Handle summary to reconcile totals
        if (parsed.type === 'summary') {
          // Optional: could reconcile totalMatches with parsed.data.stats?.matchedLines
          return null;
        }
        
        return null;
      } catch (error) {
        // Skip invalid JSON lines
        return null;
      }
    } else {
      // File search - each line is a file path
      return {
        file: line.trim(),
        type: 'file'
      };
    }
  }
}

// Global search manager instance
export const searchManager = new SearchManager();

// Cleanup management - run on fixed schedule
let cleanupInterval: NodeJS.Timeout | null = null;

/**
 * Start cleanup interval - now runs on fixed schedule
 */
function startCleanupIfNeeded(): void {
  if (!cleanupInterval) {
    cleanupInterval = setInterval(() => {
      searchManager.cleanupSessions();
    }, 5 * 60 * 1000);
    cleanupInterval.unref();
    
    // Also check immediately after a short delay (let search process finish)
    setTimeout(() => {
      searchManager.cleanupSessions();
    }, 1000).unref();
  }
}