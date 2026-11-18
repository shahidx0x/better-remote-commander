import { spawn } from 'child_process';
import path from 'path';
import { TerminalSession, CommandExecutionResult, ActiveSession, TimingInfo, OutputEvent } from './types.js';
import { DEFAULT_COMMAND_TIMEOUT } from './config.js';
import { planFastExec } from '../tools/fast-exec.js';
import os from 'node:os';
import { configManager } from './config-manager.js';
import {capture} from "./utils/capture.js";
import { analyzeProcessState } from './utils/process-detection.js';

/**
 * Standard Windows PATHEXT value, used to repair a corrupted PATHEXT before
 * spawning child shells.
 *
 * On some Windows Claude Desktop / DXT launches the server process inherits a
 * broken PATHEXT (observed as ".CPL" only). Because we build the child env from
 * { ...process.env }, that broken value would propagate into every spawned
 * shell, stripping ".EXE" and breaking resolution of git / node / python / rg /
 * etc. (and even full-path .exe invocations under PowerShell). See issue #481.
 */
const STANDARD_PATHEXT = '.COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC';

/**
 * Return a healthy PATHEXT for spawned Windows shells.
 * - Unset           -> use the standard list.
 * - Missing ".EXE"  -> corrupted; merge the standard list with whatever was
 *                      present (preserves any extra extensions, order-stable).
 * - Otherwise       -> leave the inherited value untouched.
 */
export function getRepairedPathExt(): string {
  const current = process.env.PATHEXT;
  if (!current) return STANDARD_PATHEXT;
  const exts = current.split(';').map(e => e.trim().toUpperCase()).filter(Boolean);
  if (!exts.includes('.EXE')) {
    return [...new Set([...STANDARD_PATHEXT.split(';'), ...exts])].join(';');
  }
  return current;
}

interface CompletedSession {
  pid: number;
  outputLines: string[];       // Line-based buffer (consistent with active sessions)
  exitCode: number | null;
  startTime: Date;
  endTime: Date;
  evictedLines: number;        // Carried over from the active session (see TerminalSession)
  evictedChars: number;
  retainedChars: number;
}

/** Slice the tail of a joined line buffer without joining/copying the full buffer. */
export function sliceJoinedOutputTail(lines: readonly string[], maxChars: number): string {
  let remaining = Math.max(0, Math.floor(maxChars));
  if (!remaining || !lines.length) return '';
  const reversed: string[] = [];
  for (let i = lines.length - 1; i >= 0 && remaining > 0; i--) {
    const line = lines[i] ?? '';
    const take = Math.min(line.length, remaining);
    if (take) reversed.push(line.slice(line.length - take));
    remaining -= take;
    if (remaining > 0 && i > 0) {
      reversed.push('\n');
      remaining--;
    }
  }
  return reversed.reverse().join('');
}

/** Return only text written after a snapshot, bounded by the retained tail. */
export function outputSinceSnapshot(
  lines: readonly string[], evictedChars: number, retainedChars: number, snapshotTotalChars: number
): string {
  const newChars = evictedChars + retainedChars - snapshotTotalChars;
  if (newChars <= 0) return '';
  return sliceJoinedOutputTail(lines, Math.min(newChars, retainedChars));
}

/**
 * Output buffering caps. Without a cap, a process emitting enough output makes
 * string concatenation throw "RangeError: Invalid string length" at V8's max
 * string size (~536M chars) inside a stdout 'data' handler — an uncaught
 * exception that kills the whole server (index.ts exits on uncaughtException).
 * The cap also bounds the join() cost in snapshot reads and the periodic
 * process-state scan, both of which are O(total output).
 */
// Keep a small rolling terminal-output buffer in every profile. Large builds
// can run for a long time, but only the newest 500 KiB of text is retained.
export const MAX_BUFFERED_OUTPUT_CHARS = 500 * 1024;
const MAX_LINE_CHARS = 8 * 1024;
// No line-count truncation: lots of short build lines can fit inside 500 KiB.
// Agent's interactive activity console retains a bounded share of 500 KiB of UTF-8 activity text.
export const MAX_VISIBLE_TERMINAL_LINES = Number.POSITIVE_INFINITY;
/** Keep the latest bounded text for the initial start_process response. */
export function keepRecentTerminalOutput(previous:string, chunk:string):string {
  // Slice first, then append: avoid allocating an oversized intermediate
  // string whenever a busy command exceeds the rolling output budget.
  const budget = MAX_WAIT_OUTPUT_CHARS;
  if (chunk.length >= budget) return chunk.slice(-budget);
  const keep = budget - chunk.length;
  return previous.length > keep ? previous.slice(-keep) + chunk : previous + chunk;
}
const MAX_WAIT_OUTPUT_CHARS = 500 * 1024;
// Only one interactive terminal process is allowed at a time. It can keep
// running while read_process_output and other lightweight agent tools proceed.
const MAX_ACTIVE_TERMINALS = 1;
// Retain only a few completed sessions; each session is individually capped at 500 KiB.
const MAX_COMPLETED_TERMINALS = 4;
const MAX_COMPLETED_CHARS = 2 * 1024 * 1024;

// Result type for paginated output reading
export interface PaginatedOutputResult {
  lines: string[];
  totalLines: number;
  readFrom: number;            // Starting line of this read
  readCount: number;           // Number of lines returned
  remaining: number;           // Lines remaining after this read
  isComplete: boolean;         // Whether process has finished
  exitCode?: number | null;    // Exit code if completed
  runtimeMs?: number;          // Runtime in milliseconds (for completed processes)
  evictedLines?: number;       // Lines dropped by the buffer cap; when > 0, line numbers are relative to the retained buffer
}

/**
 * Configuration for spawning a shell with appropriate flags
 */
export interface ShellSpawnConfig {
  executable: string;
  args: string[];
  useShellOption: string | boolean;
  // When true, pass args verbatim on Windows (see executeCommand). Only cmd.exe
  // needs this; its quote parsing conflicts with libuv's default \" escaping.
  windowsVerbatim?: boolean;
}

/**
 * Get the appropriate spawn configuration for a given shell
 * This handles login shell flags for different shell types
 */
export function getShellSpawnArgs(shellPath: string, command: string): ShellSpawnConfig {
  const shellName = path.basename(shellPath).toLowerCase();
  
  // Unix shells with login flag support
  if (shellName.includes('bash') || shellName.includes('zsh')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // PowerShell Core (cross-platform, supports -Login)
  if (shellName === 'pwsh' || shellName === 'pwsh.exe') {
    return { 
      executable: shellPath, 
      args: ['-Login', '-Command', command],
      useShellOption: false 
    };
  }
  
  // Windows PowerShell 5.1 (no login flag support)
  if (shellName === 'powershell' || shellName === 'powershell.exe') {
    return { 
      executable: shellPath, 
      args: ['-Command', command],
      useShellOption: false 
    };
  }
  
  // CMD
  if (shellName === 'cmd' || shellName === 'cmd.exe') {
    return { 
      executable: shellPath, 
      args: ['/c', command],
      windowsVerbatim: true,
      useShellOption: false 
    };
  }
  
  // Fish shell (uses -l for login, -c for command)
  if (shellName.includes('fish')) {
    return { 
      executable: shellPath, 
      args: ['-l', '-c', command],
      useShellOption: false 
    };
  }
  
  // Unknown/other shells - use shell option for safety
  // This provides a fallback for shells we don't explicitly handle
  return { 
    executable: command,
    args: [],
    useShellOption: shellPath 
  };
}

export class TerminalManager {
  private sessions: Map<number, TerminalSession> = new Map();
  private completedSessions: Map<number, CompletedSession> = new Map();
  private completedBufferedChars = 0;
  
  /**
   * Send input to a running process
   * @param pid Process ID
   * @param input Text to send to the process
   * @returns Whether input was successfully sent
   */
  sendInputToProcess(pid: number, input: string): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }
    
    try {
      if (session.process.stdin && !session.process.stdin.destroyed) {
        // Ensure input ends with a newline for most REPLs
        const inputWithNewline = input.endsWith('\n') ? input : input + '\n';
        session.process.stdin.write(inputWithNewline);
        return true;
      }
      return false;
    } catch (error) {
      console.error(`Error sending input to process ${pid}:`, error);
      return false;
    }
  }
  
  async executeCommand(command: string, timeoutMs: number = DEFAULT_COMMAND_TIMEOUT, shell?: string, collectTiming: boolean = false): Promise<CommandExecutionResult> {
    // start_process returns before long-running builds finish. Without a live
    // session cap, repeated calls bypass the scheduler and oversubscribe CPU/RAM.
    if (this.sessions.size >= MAX_ACTIVE_TERMINALS) return {
      pid:-1, output:'TERMINAL_BUSY: Too many active BRC terminal sessions; wait for an existing process or close it before launching another.',
      isBlocked:false
    };
    // Get the shell from config if not specified
    let shellToUse: string | boolean | undefined = shell;
    if (!shellToUse) {
      try {
        const config = await configManager.getConfig();
        shellToUse = config.defaultShell || true;
      } catch (error) {
        // If there's an error getting the config, fall back to default
        shellToUse = true;
      }
    }

    // For REPL interactions, we need to ensure stdin, stdout, and stderr are properly configured
    // Note: No special stdio options needed here, Node.js handles pipes by default

    // Enhance SSH commands automatically
    let enhancedCommand = command;
    if (command.trim().startsWith('ssh ') && !command.includes(' -t')) {
      enhancedCommand = command.replace(/^ssh /, 'ssh -t ');
      // Do not print the command: SSH arguments can contain credentials.
    }

    // Get the appropriate spawn configuration for the shell
    let spawnConfig: ShellSpawnConfig;
    let spawnOptions: any;
    
    if (typeof shellToUse === 'string') {
      // Use shell-specific configuration with login flags where appropriate
      spawnConfig = getShellSpawnArgs(shellToUse, enhancedCommand);
      spawnOptions = {
        env: {
          ...process.env,
          TERM: 'xterm-256color'  // Better terminal compatibility
        },
        windowsHide: true  // Prevent visible console windows on Windows
      };

      // Add shell option if needed (for unknown shells)
      if (spawnConfig.useShellOption) {
        spawnOptions.shell = spawnConfig.useShellOption;
      }
    } else {
      // Boolean or undefined shell - use default shell option behavior
      spawnConfig = {
        executable: enhancedCommand,
        args: [],
        useShellOption: shellToUse
      };
      spawnOptions = {
        shell: shellToUse,
        env: {
          ...process.env,
          TERM: 'xterm-256color'
        },
        windowsHide: true  // Prevent visible console windows on Windows
      };
    }

    // Repair PATHEXT on Windows before spawning. On some Windows DXT launches
    // the server process inherits a corrupted PATHEXT (e.g. ".CPL"), which we
    // would otherwise propagate via { ...process.env } and break command
    // resolution (git, node, python, rg, ...) in the spawned shell. See #481.
    if (process.platform === 'win32' && spawnOptions.env) {
      spawnOptions.env.PATHEXT = getRepairedPathExt();
    }

    // Skip shell startup for literal native .exe commands. Quoting, pipelines,
    // shell built-ins and scripts retain the configured shell unchanged.
    if (typeof shellToUse === 'string') {
      const fast = await planFastExec(shellToUse, enhancedCommand, spawnOptions.env);
      if (fast) {
        spawnConfig = { executable:fast.executable, args:fast.args, useShellOption:false,
          windowsVerbatim:fast.windowsVerbatim };
        spawnOptions.env = fast.env ?? spawnOptions.env;
      }
    }

    // On Windows, when we invoke cmd.exe directly and pass the user's command as a
    // single argument, Node/libuv applies MSVCRT-style quoting that escapes embedded
    // double quotes as \" . cmd.exe does not understand that escaping, so any command
    // containing quotes (e.g. a quoted path with spaces like "C:\Program Files\app.exe")
    // is corrupted before the shell ever parses it. Passing arguments verbatim lets
    // cmd handle its own quoting. Scoped to shells that set windowsVerbatim (cmd only)
    // because PowerShell/pwsh have different quote rules and must NOT use verbatim.
    if (process.platform === 'win32' && spawnConfig.windowsVerbatim) {
      spawnOptions.windowsVerbatimArguments = true;
    }

    // Spawn the process with appropriate arguments
    const childProcess = spawn(spawnConfig.executable, spawnConfig.args, spawnOptions);
    if (process.platform === 'win32' && childProcess.pid) {
      try { os.setPriority(childProcess.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); }
      catch { /* best effort; never change unrelated processes */ }
    }
    let output = '';

    // spawn() reports failure asynchronously via an 'error' event; it does not
    // throw. Node rethrows an 'error' that has no listener as an uncaught
    // exception, and our process-level handler (src/index.ts) turns that into
    // process.exit(1). So an unresolvable executable — e.g. shell: "/usr/bin/bash"
    // on Windows — used to kill the entire MCP server one tick AFTER this
    // function had already returned "Failed to get process ID", making the crash
    // look unrelated to the command that caused it. Under `remote` the parent
    // then kept accepting tool calls over a dead stdio pipe ("Not connected").
    //
    // Attach before any return path below, and keep it for the session lifetime
    // so a later runtime error (EPIPE on a closed stdin, ...) can't crash us either.
    let forwardProcessError: ((err: Error) => void) | null = null;
    let pendingProcessError: Error | null = null;
    childProcess.on('error', (err: Error) => {
      if (forwardProcessError) {
        forwardProcessError(err);
      } else {
        pendingProcessError = err;
        console.error(`Process error for "${command}": ${err.message}`);
      }
    });

    // Ensure childProcess.pid is defined before proceeding
    if (!childProcess.pid) {
      // Return a consistent error object instead of throwing
      return {
        pid: -1,  // Use -1 to indicate an error state
        output: 'Error: Failed to get process ID. The command could not be executed.',
        isBlocked: false
      };
    }

    const session: TerminalSession = {
      pid: childProcess.pid,
      process: childProcess,
      outputLines: [],           // Line-based buffer
      lastReadIndex: 0,          // Track where "new" output starts
      isBlocked: false,
      startTime: new Date(),
      bufferedChars: 0,
      evictedLines: 0,
      evictedChars: 0
    };

    this.sessions.set(childProcess.pid, session);

    // Timing telemetry
    const startTime = Date.now();
    let firstOutputTime: number | undefined;
    let lastOutputTime: number | undefined;
    const outputEvents: OutputEvent[] = [];
    let exitReason: TimingInfo['exitReason'] = 'timeout';

    return new Promise((resolve) => {
      let resolved = false;
      let periodicCheck: NodeJS.Timeout | null = null;
      let waitTimer: NodeJS.Timeout | null = null;

      // Quick prompt patterns for immediate detection
      const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;

      const resolveOnce = (result: CommandExecutionResult) => {
        if (resolved) return;
        resolved = true;
        if (periodicCheck) clearInterval(periodicCheck);
        if (waitTimer) clearTimeout(waitTimer);

        // Add timing info if requested
        if (collectTiming) {
          const endTime = Date.now();
          result.timingInfo = {
            startTime,
            endTime,
            totalDurationMs: endTime - startTime,
            exitReason,
            firstOutputTime,
            lastOutputTime,
            timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
            outputEvents: outputEvents.length > 0 ? outputEvents : undefined
          };
        }

        resolve(result);
      };

      // Now that resolveOnce exists, route process errors into it: an error after
      // a successful spawn means the process is gone, so the caller must not sit
      // waiting for output that will never arrive.
      forwardProcessError = (err: Error) => {
        this.sessions.delete(childProcess.pid!);
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output: output + `\nProcess error: ${err.message}`,
          isBlocked: false
        });
      };
      // An error emitted between spawn and here (the common case — spawn errors
      // land on the next tick) is replayed rather than dropped.
      if (pendingProcessError) {
        forwardProcessError(pendingProcessError);
        return; // do not arm timers on an already-failed child
      }

      childProcess.stdout.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        // `output` only feeds the wait-phase result and prompt/state detection,
        // so stop growing it once resolved and keep only a bounded tail.
        if (!resolved) output = keepRecentTerminalOutput(output, text);
        // Append to line-based buffer
        this.appendToLineBuffer(session, text);

        // Record output event if collecting timing
        if (collectTiming && outputEvents.length < 128) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stdout',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }

        // Immediate check for obvious prompts
        if (quickPromptPatterns.test(text)) {
          session.isBlocked = true;
          exitReason = 'early_exit_quick_pattern';

          if (collectTiming && outputEvents.length > 0) {
            outputEvents[outputEvents.length - 1].matchedPattern = 'quick_pattern';
          }

          resolveOnce({
            pid: childProcess.pid!,
            output,
            isBlocked: true
          });
        }
      });

      childProcess.stderr.on('data', (data: any) => {
        const text = data.toString();
        const now = Date.now();

        if (!firstOutputTime) firstOutputTime = now;
        lastOutputTime = now;

        if (!resolved) output = keepRecentTerminalOutput(output, text);
        // Append to line-based buffer
        this.appendToLineBuffer(session, text);

        // Record output event if collecting timing
        if (collectTiming && outputEvents.length < 128) {
          outputEvents.push({
            timestamp: now,
            deltaMs: now - startTime,
            source: 'stderr',
            length: text.length,
            snippet: text.slice(0, 50).replace(/\n/g, '\\n')
          });
        }
      });

      // Periodic comprehensive check every 100ms
      periodicCheck = setInterval(() => {
        if (output.length > 0) {
          const processState = analyzeProcessState(output, childProcess.pid);
          if (processState.isWaitingForInput) {
            session.isBlocked = true;
            exitReason = 'early_exit_periodic_check';
            resolveOnce({
              pid: childProcess.pid!,
              output,
              isBlocked: true
            });
          }
        }
      }, 100);

      // Timeout only controls how long the initial request waits, not how
      // long the child may run. Clear it on every early resolution.
      waitTimer = setTimeout(() => {
        session.isBlocked = true;
        exitReason = 'timeout';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: true
        });
      }, timeoutMs);

      // 'close' means the process has exited AND stdout/stderr pipes have been
      // drained. Recording on 'exit' could retain a buffer that is still growing.
      childProcess.on('close', (code: any) => {
        if (childProcess.pid) {
          const previous = this.completedSessions.get(childProcess.pid);
          if (previous) this.completedBufferedChars = Math.max(0,this.completedBufferedChars-previous.retainedChars);
          // Store the bounded, final buffer before removing active session
          this.completedSessions.set(childProcess.pid, {
            pid: childProcess.pid,
            outputLines: session.outputLines, // transfer ownership without copying the retained command text
            exitCode: code,
            startTime: session.startTime,
            endTime: new Date(),
            evictedLines: session.evictedLines,
            evictedChars: session.evictedChars,
            retainedChars: session.bufferedChars
          });
          this.completedBufferedChars += session.bufferedChars;
          // Cap both total completed-session count and aggregate retained output.
          // Do not keep old terminal logs in RAM indefinitely.
          while (this.completedSessions.size > MAX_COMPLETED_TERMINALS ||
                 this.completedBufferedChars > MAX_COMPLETED_CHARS) {
            const oldestKey = this.completedSessions.keys().next().value;
            if (oldestKey === undefined) break;
            const oldest = this.completedSessions.get(oldestKey)!;
            this.completedBufferedChars = Math.max(0,this.completedBufferedChars-oldest.retainedChars);
            this.completedSessions.delete(oldestKey);
          }

          this.sessions.delete(childProcess.pid);
        }
        exitReason = 'process_exit';
        resolveOnce({
          pid: childProcess.pid!,
          output,
          isBlocked: false
        });
      });
    });
  }

  /**
   * Append text to a session's line buffer
   * Handles partial lines and newline splitting
   */
  private appendToLineBuffer(session: TerminalSession, text: string): void {
    if (!text) return;

    // Split text into lines, keeping track of whether text ends with newline
    const lines = text.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLastFragment = i === lines.length - 1;
      const endsWithNewline = text.endsWith('\n');

      if (session.outputLines.length === 0) {
        // First line ever
        session.outputLines.push(line);
      } else if (i === 0) {
        // First fragment - append to last line (might be partial)
        session.outputLines[session.outputLines.length - 1] += line;
      } else {
        // Subsequent lines - add as new lines
        session.outputLines.push(line);
      }
    }
    // Appended text contributes exactly its length to the joined buffer
    // (its newlines become the join separators).
    session.bufferedChars += text.length;

    // A process printing without newlines grows a single line forever, which
    // eviction can't bound — force-split so no line exceeds MAX_LINE_CHARS.
    // Each inserted break adds one separator to the joined length.
    let lastIndex = session.outputLines.length - 1;
    while (session.outputLines[lastIndex].length > MAX_LINE_CHARS) {
      const overlong = session.outputLines[lastIndex];
      session.outputLines[lastIndex] = overlong.slice(0, MAX_LINE_CHARS);
      session.outputLines.push(overlong.slice(MAX_LINE_CHARS));
      session.bufferedChars += 1;
      lastIndex++;
    }

    // Retain as many lines as fit within the 500-KiB responsive text budget;
    // do not silently discard useful compiler/build lines just to show 20.
    // Evict old lines in one batch, avoiding O(n^2) shifts on chatty output.
    let droppedLines = 0, droppedChars = 0;
    while (session.bufferedChars - droppedChars > MAX_BUFFERED_OUTPUT_CHARS &&
           droppedLines < session.outputLines.length - 1) {
      droppedChars += session.outputLines[droppedLines].length + 1;
      droppedLines++;
    }
    if (droppedLines) {
      session.outputLines.splice(0,droppedLines);
      session.bufferedChars -= droppedChars;
      session.evictedChars += droppedChars;
      session.evictedLines += droppedLines;
      session.lastReadIndex = Math.max(0,session.lastReadIndex-droppedLines);
    }
  }

  /**
   * Read process output with pagination (like file reading)
   * @param pid Process ID
   * @param offset Line offset: 0=from lastReadIndex, positive=absolute, negative=tail
   * @param length Max lines to return
   * @param updateReadIndex Whether to update lastReadIndex (default: true for offset=0)
   */
  readOutputPaginated(pid: number, offset: number = 0, length: number = 1000): PaginatedOutputResult | null {
    // First check active sessions
    const session = this.sessions.get(pid);
    if (session) {
      const result = this.readFromLineBuffer(
        session.outputLines,
        offset,
        length,
        session.lastReadIndex,
        (newIndex) => { session.lastReadIndex = newIndex; },
        false,
        undefined
      );
      result.evictedLines = session.evictedLines;
      return result;
    }

    // Then check completed sessions
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      const runtimeMs = completedSession.endTime.getTime() - completedSession.startTime.getTime();
      const result = this.readFromLineBuffer(
        completedSession.outputLines,
        offset,
        length,
        0,  // Completed sessions don't track read position
        () => {},  // No-op for completed sessions
        true,
        completedSession.exitCode,
        runtimeMs
      );
      result.evictedLines = completedSession.evictedLines;
      return result;
    }

    return null;
  }

  /**
   * Internal helper to read from a line buffer with offset/length
   */
  private readFromLineBuffer(
    lines: string[],
    offset: number,
    length: number,
    lastReadIndex: number,
    updateLastRead: (index: number) => void,
    isComplete: boolean,
    exitCode?: number | null,
    runtimeMs?: number
  ): PaginatedOutputResult {
    const totalLines = lines.length;
    let startIndex: number;
    let linesToRead: string[];

    if (offset < 0) {
      // Negative offset = start position from end, then read 'length' lines forward
      // e.g., offset=-50, length=10 means: start 50 lines from end, read 10 lines
      const fromEnd = Math.abs(offset);
      startIndex = Math.max(0, totalLines - fromEnd);
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for tail reads
    } else if (offset === 0) {
      // offset=0 means "from where I last read" (like getNewOutput)
      startIndex = lastReadIndex;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Update lastReadIndex for "new output" behavior
      updateLastRead(Math.min(startIndex + linesToRead.length, totalLines));
    } else {
      // Positive offset = absolute position
      startIndex = offset;
      linesToRead = lines.slice(startIndex, startIndex + length);
      // Don't update lastReadIndex for absolute position reads
    }

    const readCount = linesToRead.length;
    const endIndex = startIndex + readCount;
    const remaining = Math.max(0, totalLines - endIndex);

    return {
      lines: linesToRead,
      totalLines,
      readFrom: startIndex,
      readCount,
      remaining,
      isComplete,
      exitCode,
      runtimeMs
    };
  }

  /**
   * Get total line count for a process
   */
  getOutputLineCount(pid: number): number | null {
    const session = this.sessions.get(pid);
    if (session) {
      return session.outputLines.length;
    }

    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return completedSession.outputLines.length;
    }

    return null;
  }

  /**
   * Legacy method for backward compatibility
   * Returns all new output since last read
   * @param maxLines Maximum lines to return (default: 1000 for context protection)
   * @deprecated Use readOutputPaginated instead
   */
  getNewOutput(pid: number, maxLines: number = 1000): string | null {
    const result = this.readOutputPaginated(pid, 0, maxLines);
    if (!result) return null;

    const output = result.lines.join('\n').trim();

    // For completed sessions, append completion info with runtime
    if (result.isComplete) {
      const runtimeStr = result.runtimeMs !== undefined 
        ? `\nRuntime: ${(result.runtimeMs / 1000).toFixed(2)}s` 
        : '';
      if (output) {
        return `${output}\n\nProcess completed with exit code ${result.exitCode}${runtimeStr}`;
      } else {
        return `Process completed with exit code ${result.exitCode}${runtimeStr}\n(No output produced)`;
      }
    }

    // Add truncation warning if there's more output
    if (result.remaining > 0) {
      return `${output}\n\n[Output truncated: ${result.remaining} more lines available. Use read_process_output with offset/length for full output.]`;
    }

    return output || null;
  }

  /**
   * Capture a snapshot of current output state for interaction tracking.
   * Used by interactWithProcess to know what output existed before sending input.
   */
  captureOutputSnapshot(pid: number): { totalChars: number; lineCount: number } | null {
    const session = this.sessions.get(pid);
    if (session) {
      return {
        // bufferedChars is maintained with each append/eviction and avoids a full-buffer join.
        totalChars: session.evictedChars + session.bufferedChars,
        lineCount: session.evictedLines + session.outputLines.length
      };
    }
    return null;
  }

  /**
   * Get output that appeared since a snapshot was taken.
   * This handles the case where output is appended to the last line (REPL prompts).
   * Also checks completed sessions in case process finished between snapshot and poll.
   */
  getOutputSinceSnapshot(pid: number, snapshot: { totalChars: number; lineCount: number }): string | null {
    // Check active session first; only copy the new suffix, not the whole retained buffer.
    const session = this.sessions.get(pid);
    if (session) {
      return outputSinceSnapshot(session.outputLines, session.evictedChars, session.bufferedChars, snapshot.totalChars);
    }

    // Fallback to completed sessions - process may have finished between snapshot and poll
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) {
      return outputSinceSnapshot(completedSession.outputLines, completedSession.evictedChars, completedSession.retainedChars, snapshot.totalChars);
    }

    return null;
  }

  /** Return a bounded tail for prompt/state detection without joining all retained output. */
  getRecentOutput(pid: number, maxChars = 8192): string | null {
    const session = this.sessions.get(pid);
    if (session) return sliceJoinedOutputTail(session.outputLines, maxChars);
    const completedSession = this.completedSessions.get(pid);
    if (completedSession) return sliceJoinedOutputTail(completedSession.outputLines, maxChars);
    return null;
  }

    /**
   * Get a session by PID
   * @param pid Process ID
   * @returns The session or undefined if not found
   */
  getSession(pid: number): TerminalSession | undefined {
    return this.sessions.get(pid);
  }

  forceTerminate(pid: number): boolean {
    const session = this.sessions.get(pid);
    if (!session) {
      return false;
    }

    try {
        session.process.kill('SIGINT');
        setTimeout(() => {
          if (this.sessions.has(pid)) {
            session.process.kill('SIGKILL');
          }
        }, 1000);
        return true;
      } catch (error) {
        // Convert error to string, handling both Error objects and other types
        const errorMessage = error instanceof Error ? error.message : String(error);
        capture('server_request_error', {error: errorMessage, message: `Failed to terminate process ${pid}:`});
        return false;
      }
  }

  listActiveSessions(): ActiveSession[] {
    const now = new Date();
    return Array.from(this.sessions.values()).map(session => ({
      pid: session.pid,
      isBlocked: session.isBlocked,
      runtime: now.getTime() - session.startTime.getTime()
    }));
  }

  listCompletedSessions(): CompletedSession[] {
    return Array.from(this.completedSessions.values());
  }
}

export const terminalManager = new TerminalManager();