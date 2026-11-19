import { terminalManager, MAX_BUFFERED_OUTPUT_CHARS } from '../terminal-manager.js';
import {loadTerminalSnapshot,terminalJournalStatus} from '../../runtime/terminal-journal.js';
import { commandManager } from '../command-manager.js';
import { StartProcessArgsSchema, ReadProcessOutputArgsSchema, InteractWithProcessArgsSchema, ForceTerminateArgsSchema, ListSessionsArgsSchema } from './schemas.js';
import { capture } from "../utils/capture.js";
import { ServerResult } from '../types.js';
import { analyzeProcessState, cleanProcessOutput, formatProcessStateMessage, ProcessState } from '../utils/process-detection.js';
import * as os from 'os';
import { configManager } from '../config-manager.js';
import { selectRunCommandShell } from '../../tools/command-shell.js';
import { spawn } from 'child_process';
import {spawnManaged} from '../../runtime/managed-spawn.js';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory where the MCP is installed (for ES module imports)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const mcpRoot = path.resolve(__dirname, '..', '..');

// Track virtual Node sessions (PIDs that are actually Node fallback sessions)
const virtualNodeSessions = new Map<number, { timeout_ms: number }>();
let virtualPidCounter = -1000; // Use negative PIDs for virtual sessions

/**
 * Execute Node.js code via temp file (fallback when Python unavailable)
 * Creates temp .mjs file in MCP directory for ES module import access
 */
async function executeNodeCode(code: string, timeout_ms: number = 30000): Promise<ServerResult> {
  const tempFile = path.join(mcpRoot, `.mcp-exec-${Date.now()}-${Math.random().toString(36).slice(2)}.mjs`);

  try {
    await fs.writeFile(tempFile, code, 'utf8');

    const result = await new Promise<{ stdout: string; stderr: string; exitCode: number }>((resolve) => {
      const proc = spawnManaged(process.execPath, [tempFile], {
        cwd: mcpRoot,
        timeout: timeout_ms,
        windowsHide: true  // Prevent visible console windows on Windows
      });
      if (os.platform() === 'win32' && proc.pid) {
        try { os.setPriority(proc.pid, os.constants.priority.PRIORITY_BELOW_NORMAL); } catch {}
      }

      let stdout = '', stderr = '', omitted = 0;
      const cap = 128 * 1024;
      const collect = (prior: string, next: string): string => {
        const take = Math.min(next.length,Math.max(0,cap-prior.length));
        omitted += next.length-take;
        return take ? prior+next.slice(0,take) : prior;
      };
      proc.stdout!.on('data', data => { stdout = collect(stdout,data.toString()); });
      proc.stderr!.on('data', data => { stderr = collect(stderr,data.toString()); });

      proc.on('close', (exitCode) => {
        const trunc = omitted ? '\n[OUTPUT TRUNCATED: '+omitted+' characters omitted; redirect full output to a file when needed.]' : '';
        resolve({ stdout:stdout+trunc, stderr, exitCode: exitCode ?? 1 });
      });

      proc.on('error', (err) => {
        resolve({ stdout, stderr: stderr + '\n' + err.message, exitCode: 1 });
      });
    });

    // Clean up temp file
    await fs.unlink(tempFile).catch(() => {});

    if (result.exitCode !== 0) {
      return {
        content: [{
          type: "text",
          text: `Execution failed (exit code ${result.exitCode}):\n${result.stderr}\n${result.stdout}`
        }],
        isError: true
      };
    }

    return {
      content: [{
        type: "text",
        text: result.stdout || '(no output)'
      }]
    };

  } catch (error) {
    // Clean up temp file on error
    await fs.unlink(tempFile).catch(() => {});

    return {
      content: [{
        type: "text",
        text: `Failed to execute Node.js code: ${error instanceof Error ? error.message : String(error)}`
      }],
      isError: true
    };
  }
}

/**
 * Start a new process (renamed from execute_command)
 * Includes early detection of process waiting for input
 */
export async function startProcess(args: unknown): Promise<ServerResult> {
  const parsed = StartProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_start_process_failed');
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for start_process: ${parsed.error}` }],
      isError: true,
    };
  }

  try {
    const commands = commandManager.extractCommands(parsed.data.command).join(', ');
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command),
      commands: commands
    });
  } catch (error) {
    capture('server_start_process', {
      command: commandManager.getBaseCommand(parsed.data.command)
    });
  }

  const isAllowed = await commandManager.validateCommand(parsed.data.command);
  if (!isAllowed) {
    return {
      content: [{ type: "text", text: `Error: Command not allowed: ${parsed.data.command}` }],
      isError: true,
    };
  }

  const commandToRun = parsed.data.command;

  // Handle node:local - runs Node.js code directly on MCP server
  if (commandToRun.trim() === 'node:local') {
    const virtualPid = virtualPidCounter--;
    virtualNodeSessions.set(virtualPid, { timeout_ms: parsed.data.timeout_ms || 30000 });

    return {
      content: [{
        type: "text",
        text: `Node.js session started with PID ${virtualPid} (MCP server execution)

   IMPORTANT: Each interact_with_process call runs as a FRESH script.
   State is NOT preserved between calls. Include ALL code in ONE call:
   - imports, file reading, processing, and output together.

   Available libraries:
   - ExcelJS for Excel files: import ExcelJS from 'exceljs'
   - All Node.js built-ins: fs, path, http, crypto, etc.

🔄 Ready for code - send complete self-contained script via interact_with_process.`
      }],
    };
  }

  let shellUsed: string | undefined = parsed.data.shell;

  if (!shellUsed) {
    const config = await configManager.getConfig();
    if (config.defaultShell) {
      shellUsed = config.defaultShell;
    } else {
      const isWindows = os.platform() === 'win32';
      if (isWindows && process.env.COMSPEC) {
        shellUsed = process.env.COMSPEC;
      } else if (!isWindows && process.env.SHELL) {
        shellUsed = process.env.SHELL;
      } else {
        shellUsed = isWindows ? 'cmd.exe' : '/bin/sh';
      }
    }
  }

  const configuredShell=shellUsed;
  const shellChoice=selectRunCommandShell(commandToRun,configuredShell,parsed.data.shell!==undefined);
  if(shellChoice.error){
    const suggested=shellChoice.suggestedShell
      ? {command:commandToRun,shell:shellChoice.suggestedShell,timeout_ms:parsed.data.timeout_ms}
      : null;
    return {
      isError:true,
      content:[{type:'text',text:'SHELL_SYNTAX: '+shellChoice.error+
        (suggested?'\nSUGGESTED CALL (not executed): start_process('+JSON.stringify(suggested)+')':'')}],
      structuredContent:{error:{code:'SHELL_SYNTAX',message:shellChoice.error,retryable:false},
        commandExecuted:false,shell:configuredShell,platform:process.platform,
        recovery:{automaticRetry:false,suggestion:shellChoice.error,
          ...(suggested?{next:{tool:'start_process',args:suggested}}:{})}}
    };
  }
  shellUsed=shellChoice.shell;
  const result = await terminalManager.executeCommand(
    commandToRun,
    parsed.data.timeout_ms,
    shellUsed,
    parsed.data.verbose_timing || false
  );

  if (result.pid === -1) {
    const busy = result.output.startsWith('TERMINAL_BUSY:');
    return {
      content: [{type:'text',text:(busy ? result.output+'\nNEXT ACTION: Wait for a current session or terminate it using force_terminate; no new process started.' :
        'SHELL_START_FAILED: '+result.output+'\nNEXT ACTION: Check shell executable, command permissions and PATH. No process started.')}],
      isError:true,
      structuredContent:{error:{code:busy?'TERMINAL_BUSY':'SHELL_START_FAILED',message:result.output.slice(0,1200),retryable:busy},
        commandExecuted:false,shell:shellUsed,platform:process.platform,
        recovery:{automaticRetry:false,suggestion:busy?'Wait for an existing terminal session or close it; do not launch more heavy processes.':
          'Check shell, PATH and command permissions; correct the failure before retrying.'}},
    };
  }

  // Analyze the process state to detect if it's waiting for input
  const processState = analyzeProcessState(result.output, result.pid);

  let statusMessage = '';
  if (processState.isWaitingForInput) {
    statusMessage = `\n🔄 ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (processState.isFinished) {
    statusMessage = `\n✅ ${formatProcessStateMessage(processState, result.pid)}`;
  } else if (result.isBlocked) {
    statusMessage = '\n⏳ Process is running. Use read_process_output to get more output.';
  }

  // Add timing information if requested
  let timingMessage = '';
  if (result.timingInfo) {
    timingMessage = formatTimingInfo(result.timingInfo);
  }

  const latestSession = terminalManager.getSession(result.pid);
  const stableSessionId=terminalManager.getSessionId(result.pid);
  const dropped = latestSession?.evictedLines ??
    terminalManager.listCompletedSessions().find(s => s.pid === result.pid)?.evictedLines ?? 0;
  return {
    content: [{
      type: "text",
      text: `Process started with PID ${result.pid} (session: ${stableSessionId??'unavailable'}, shell: ${shellUsed})\n${shellChoice.reason?'Shell selection: '+shellChoice.reason+'\n':''}Initial output:\n${result.output}${dropped>0?'\n[EARLIER OUTPUT DISCARDED: '+dropped+' lines; redirect the command to a file if full logs are needed.]':''}${statusMessage}${timingMessage}`
    }],
    structuredContent:{pid:result.pid,sessionId:stableSessionId,
      outputBufferBytes:500*1024,terminalJournal:terminalJournalStatus(),
      processStarted:true,processMayStillBeRunning:result.isBlocked}
  };
}

function formatTimingInfo(timing: any): string {
  let msg = '\n\n📊 Timing Information:\n';
  msg += `  Exit Reason: ${timing.exitReason}\n`;
  msg += `  Total Duration: ${timing.totalDurationMs}ms\n`;

  if (timing.timeToFirstOutputMs !== undefined) {
    msg += `  Time to First Output: ${timing.timeToFirstOutputMs}ms\n`;
  }

  if (timing.firstOutputTime && timing.lastOutputTime) {
    msg += `  Output Window: ${timing.lastOutputTime - timing.firstOutputTime}ms\n`;
  }

  if (timing.outputEvents && timing.outputEvents.length > 0) {
    msg += `\n  Output Events (${timing.outputEvents.length} total):\n`;
    timing.outputEvents.forEach((event: any, idx: number) => {
      msg += `    [${idx + 1}] +${event.deltaMs}ms | ${event.source} | ${event.length}b`;
      if (event.matchedPattern) {
        msg += ` | 🎯 ${event.matchedPattern}`;
      }
      msg += `\n       "${event.snippet}"\n`;
    });
  }

  return msg;
}

/**
 * Read output from a running process with file-like pagination
 * Supports offset/length parameters for controlled reading
 */
/** Restart-aware terminal output. Encrypted snapshots carry no command or
 * arguments, never reattach by reused PID and never replay a process.
 */
async function recoveredTerminalOutput(sessionId:string,cursor:number|undefined,length:number):Promise<ServerResult>{
 const saved=await loadTerminalSnapshot(sessionId);
 if(!saved)return {isError:true,content:[{type:'text',text:'PROCESS_SESSION_NOT_FOUND: no readable encrypted session snapshot. The process may have expired, been unpaired, or journaling was disabled. Do not replay commands automatically.'}],
  structuredContent:{error:{code:'PROCESS_SESSION_NOT_FOUND',retryable:false},sessionId,recoveredFromDisk:false}};
 const oldest=saved.evictedLines,requested=cursor??oldest;
 const start=Math.max(requested,oldest),index=start-oldest;
 const selected=saved.lines.slice(index,index+Math.max(1,Math.min(length,2000)));
 const nextCursor=start+selected.length,hasMore=nextCursor<oldest+saved.lines.length;
 const state=saved.state==='completed'?'completed':'outcome_uncertain';
 const warning=state==='completed'?'[RESTORED SESSION: historical command output; the process is no longer active in this agent.]':
  '[OUTCOME UNCERTAIN: the previous agent recorded a running/failed process, but no clean completion was confirmed. Inspect actual side effects; never automatically re-execute.]';
 return {content:[{type:'text',text:warning+'\n'+selected.join('\n')+
   (hasMore?'\n[MORE RESTORED OUTPUT: read_process_output({session_id:'+JSON.stringify(sessionId)+',cursor:'+nextCursor+',length:'+length+'})]':'')}],
  structuredContent:{sessionId,pid:saved.pid,recoveredFromDisk:true,processRunning:false,
   processState:state,exitConfirmed:state==='completed',exitCode:saved.exitCode,
   requestedCursor:requested,oldestAvailableCursor:oldest,nextCursor,hasMore,
   lostOutput:requested<oldest,evictedLines:oldest,
   readCount:selected.length,bufferCapBytes:500*1024,automaticProcessRetry:false}};
}
export async function readProcessOutput(args: unknown): Promise<ServerResult> {
  const parsed = ReadProcessOutputArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for read_process_output: ${parsed.error}` }],
      isError: true,
    };
  }

  // Get default line limit from config
  const config = await configManager.getConfig();
  const defaultLength = config.fileReadLineLimit ?? 1000;

  const { 
    pid:requestedPid,session_id,cursor,
    timeout_ms = 5000, 
    offset = 0,                    // 0 = from last read, positive = absolute, negative = tail
    length = defaultLength,        // Default from config, same as file reading
    verbose_timing = false 
  } = parsed.data;
  const resolvedPid=session_id?terminalManager.resolvePidBySessionId(session_id):null;
  if(session_id && resolvedPid===null)return recoveredTerminalOutput(session_id,cursor,length);
  if(requestedPid!==undefined&&resolvedPid!==null&&requestedPid!==resolvedPid)
    return {isError:true,content:[{type:'text',text:'PROCESS_SESSION_MISMATCH: PID does not match the stable session ID. No output from another process was returned.'}],
      structuredContent:{error:{code:'PROCESS_SESSION_MISMATCH',retryable:false},sessionId:session_id}};
  const pid=resolvedPid??requestedPid??-1;

  // This is only the wait window for new output. It never terminates the process;
  // long builds remain alive and can be read repeatedly with offset=0 or tail reads.
  const waitTimeoutMs = timeout_ms;

  // Timing telemetry
  const startTime = Date.now();

  // For active sessions with no new output yet, optionally wait for output
  const session = terminalManager.getSession(pid);
  if (session && (cursor!==undefined?
      cursor>=session.evictedLines+session.outputLines.length:offset===0)) {
    // Wait for new output to arrive (only for "new output" reads, not absolute/tail)
    const waitForOutput = (): Promise<void> => {
      return new Promise((resolve) => {
        // Check if there's already new output
        const currentLines = terminalManager.getOutputLineCount(pid) || 0;
        if (currentLines > (cursor===undefined?session.lastReadIndex:
            cursor-session.evictedLines)) {
          resolve();
          return;
        }

        let resolved = false;
        let interval: NodeJS.Timeout | null = null;
        let timeout: NodeJS.Timeout | null = null;

        const cleanup = () => {
          if (interval) clearInterval(interval);
          if (timeout) clearTimeout(timeout);
        };

        const resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          cleanup();
          resolve();
        };

        // Poll at a modest cadence; process output is already buffered by the terminal manager.
        interval = setInterval(() => {
          const newLineCount = terminalManager.getOutputLineCount(pid) || 0;
          if (newLineCount > (cursor===undefined?session.lastReadIndex:
              cursor-session.evictedLines)) {
            resolveOnce();
          }
        }, 100);

        // Timeout
        timeout = setTimeout(resolveOnce, waitTimeoutMs);
      });
    };

    await waitForOutput();
  }

  // Read output with pagination
  const result = cursor===undefined?
    terminalManager.readOutputPaginated(pid, offset, length):
    terminalManager.readOutputByCursor(pid,cursor,length);
  
  if (!result) {
    return {
      content: [{ type: "text", text: `No session found for PID ${pid}` }],
      isError: true,
    };
  }

  // Join lines back into string. New cursor reads never move another reader's
  // legacy offset=0 pointer, even after in-memory output eviction.
  const output = result.lines.join('\n');
  const currentSessionId=terminalManager.getSessionId(pid);
  const nextCursor=(result.evictedLines??0)+result.readFrom+result.readCount;
  const oldestAvailableCursor=result.evictedLines??0;
  const lostOutput=cursor!==undefined&&cursor<oldestAvailableCursor;

  // Generate status message similar to file reading
  let statusMessage = '';
  if (offset < 0) {
    // Tail read - match file reading format for consistency
    statusMessage = `[Reading last ${result.readCount} lines (total: ${result.totalLines} lines)]`;
  } else if (offset === 0) {
    // "New output" read
    if (result.remaining > 0) {
      statusMessage = `[Reading ${result.readCount} new lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
    } else {
      statusMessage = `[Reading ${result.readCount} new lines (total: ${result.totalLines} lines)]`;
    }
  } else {
    // Absolute position read
    statusMessage = `[Reading ${result.readCount} lines from line ${result.readFrom} (total: ${result.totalLines} lines, ${result.remaining} remaining)]`;
  }

  // Surface buffer-cap eviction so the model knows the retained output is not
  // the full output and that line numbers shifted (matches the truncation
  // markers used by other tools).
  if (lostOutput)statusMessage+='\n[LOST OUTPUT: requested cursor '+cursor+
    ' precedes the oldest retained cursor '+oldestAvailableCursor+'. Earlier lines were evicted. No implicit replay.]';
  if (result.evictedLines && result.evictedLines > 0) {
    const capKiB = Math.round(MAX_BUFFERED_OUTPUT_CHARS / 1024);
    statusMessage += `\n[WARNING: command output exceeded the ${capKiB} KiB rolling buffer; ${result.evictedLines} oldest lines were discarded. No line-count limit is applied. To preserve full logs, redirect the command to a file. Line totals refer only to retained lines.]`;
  }

  // Add process state info
  let processStateMessage = '';
  if (result.isComplete) {
    const runtimeStr = result.runtimeMs !== undefined 
      ? ` (runtime: ${(result.runtimeMs / 1000).toFixed(2)}s)` 
      : '';
    processStateMessage = `\n✅ Process completed with exit code ${result.exitCode}${runtimeStr}`;
  } else if (session) {
    // Analyze state for running processes
    const recentOutput = terminalManager.getRecentOutput(pid, 8192) ?? '';
    const processState = analyzeProcessState(recentOutput, pid);
    if (processState.isWaitingForInput) {
      processStateMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    }
  }

  // Add timing information if requested
  let timingMessage = '';
  if (verbose_timing) {
    const endTime = Date.now();
    timingMessage = `\n\n📊 Timing: ${endTime - startTime}ms`;
  }

  const responseText = output || '(No output in requested range)';

  return {
    content: [{
      type: "text",
      text: `${statusMessage}\n\n${responseText}${processStateMessage}${timingMessage}`
    }],
    structuredContent:{pid,sessionId:currentSessionId,recoveredFromDisk:false,
      processRunning:!result.isComplete,exitConfirmed:result.isComplete,
      exitCode:result.exitCode??null,requestedCursor:cursor??null,
      oldestAvailableCursor,nextCursor,lostOutput,evictedLines:result.evictedLines??0,
      readCount:result.readCount,hasMore:result.remaining>0,
      bufferCapBytes:500*1024,automaticProcessRetry:false}
  };
}

/**
 * Interact with a running process (renamed from send_input)
 * Automatically detects when process is ready and returns output
 */
export async function interactWithProcess(args: unknown): Promise<ServerResult> {
  const parsed = InteractWithProcessArgsSchema.safeParse(args);
  if (!parsed.success) {
    capture('server_interact_with_process_failed', {
      error: 'Invalid arguments'
    });
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for interact_with_process: ${parsed.error}` }],
      isError: true,
    };
  }

  const {
    pid,
    input,
    timeout_ms = 8000,
    wait_for_prompt = true,
    verbose_timing = false
  } = parsed.data;

  // Get config for output line limit
  const config = await configManager.getConfig();
  const maxOutputLines = config.fileReadLineLimit ?? 1000;

  // Check if this is a virtual Node session (node:local)
  if (virtualNodeSessions.has(pid)) {
    const session = virtualNodeSessions.get(pid)!;
    capture('server_interact_with_process_node_fallback', {
      pid: pid,
      inputLength: input.length
    });

    // Execute code via temp file approach
    // Respect per-call timeout if provided, otherwise use session default
    const effectiveTimeout = timeout_ms ?? session.timeout_ms;
    return executeNodeCode(input, effectiveTimeout);
  }

  // Reject stale PIDs BEFORE sending input; an exited process cannot accept input.
  if (!terminalManager.getSession(pid)) {
    const prior = terminalManager.listCompletedSessions().find(s => s.pid === pid);
    const code = prior ? 'PROCESS_ALREADY_EXITED' : 'PROCESS_NOT_ACTIVE';
    const advice = prior
      ? 'Process already exited. Use read_process_output to inspect exit code and logs.'
      : 'PID not active. Use list_sessions, or get_job / wait_jobs for managed commands.';
    return {
      isError:true,
      content:[{type:'text',text:code+': '+advice+' No input was sent.'}],
      structuredContent:{
        error:{code,message:advice,retryable:false},
        commandExecuted:false,pid,
        ...(prior?{exitCode:prior.exitCode}:{}),
        recovery:{automaticRetry:false,suggestion:advice}
      }
    };
  }

  // Timing telemetry
  const startTime = Date.now();
  let firstOutputTime: number | undefined;
  let lastOutputTime: number | undefined;
  const outputEvents: any[] = [];
  let exitReason: 'early_exit_quick_pattern' | 'early_exit_periodic_check' | 'process_finished' | 'timeout' | 'no_wait' = 'timeout';

  try {
    capture('server_interact_with_process', {
      pid: pid,
      inputLength: input.length
    });

    // Capture output snapshot BEFORE sending input
    // This handles REPLs where output is appended to the prompt line
    const outputSnapshot = terminalManager.captureOutputSnapshot(pid);

    const success = terminalManager.sendInputToProcess(pid, input);

    if (!success) {
      const reason = 'Process input was not accepted. Stdin may be closed or the process has exited.';
      return {
        content:[{type:'text',text:'PROCESS_INPUT_REJECTED: '+reason}],
        isError:true,
        structuredContent:{
          error:{code:'PROCESS_INPUT_REJECTED',message:reason,retryable:false},
          commandExecuted:false,pid,
          recovery:{automaticRetry:false,suggestion:'Check list_sessions or read_process_output before retrying any input.'}
        }
      };
    }

    // If not waiting for response, return immediately
    if (!wait_for_prompt) {
      exitReason = 'no_wait';
      let timingMessage = '';
      if (verbose_timing) {
        const endTime = Date.now();
        const timingInfo = {
          startTime,
          endTime,
          totalDurationMs: endTime - startTime,
          exitReason,
          firstOutputTime,
          lastOutputTime,
          timeToFirstOutputMs: undefined,
          outputEvents: undefined
        };
        timingMessage = formatTimingInfo(timingInfo);
      }
      return {
        content: [{
          type: "text",
          text: `✅ Input sent to process ${pid}. Use read_process_output to get the response.${timingMessage}`
        }],
      };
    }

    // Smart waiting with immediate and periodic detection
    let output = "";
    let processState: ProcessState | undefined;
    let earlyExit = false;

    // Quick prompt patterns for immediate detection
    const quickPromptPatterns = />>>\s*$|>\s*$|\$\s*$|#\s*$/;
    
    const waitForResponse = (): Promise<void> => {
      return new Promise((resolve) => {
        let resolved = false;
        let attempts = 0;
        const pollIntervalMs = 50; // Poll every 50ms for faster response
        const maxAttempts = Math.ceil(timeout_ms / pollIntervalMs);
        let interval: NodeJS.Timeout | null = null;
        let lastOutputLength = 0; // Track output length to detect new output

        let resolveOnce = () => {
          if (resolved) return;
          resolved = true;
          if (interval) clearInterval(interval);
          resolve();
        };

        // Fast-polling check - check every 50ms for quick responses
        interval = setInterval(() => {
          if (resolved) return;

          // Use snapshot-based reading to handle REPL prompt line appending
          const newOutput = outputSnapshot 
            ? terminalManager.getOutputSinceSnapshot(pid, outputSnapshot)
            : terminalManager.getNewOutput(pid);
            
          if (newOutput && newOutput.length > lastOutputLength) {
            const now = Date.now();
            if (!firstOutputTime) firstOutputTime = now;
            lastOutputTime = now;

            if (verbose_timing) {
              outputEvents.push({
                timestamp: now,
                deltaMs: now - startTime,
                source: 'periodic_poll',
                length: newOutput.length - lastOutputLength,
                snippet: newOutput.slice(lastOutputLength, lastOutputLength + 50).replace(/\n/g, '\\n')
              });
            }

            output = newOutput; // Replace with full output since snapshot
            lastOutputLength = newOutput.length;

            // Analyze current state
            processState = analyzeProcessState(output, pid);

            // Exit early if we detect the process is waiting for input
            if (processState.isWaitingForInput) {
              earlyExit = true;
              exitReason = 'early_exit_periodic_check';

              if (verbose_timing && outputEvents.length > 0) {
                outputEvents[outputEvents.length - 1].matchedPattern = 'periodic_check';
              }

              resolveOnce();
              return;
            }

            // Also exit if process finished
            if (processState.isFinished) {
              exitReason = 'process_finished';
              resolveOnce();
              return;
            }
          }

          attempts++;
          if (attempts >= maxAttempts) {
            exitReason = 'timeout';
            resolveOnce();
          }
        }, pollIntervalMs);
      });
    };
    
    await waitForResponse();

    // Clean and format output
    let cleanOutput = cleanProcessOutput(output, input);
    const timeoutReached = !earlyExit && !processState?.isFinished && !processState?.isWaitingForInput;
    
    // Apply output line limit to prevent context overflow
    let truncationMessage = '';
    const outputLines = cleanOutput.split('\n');
    if (outputLines.length > maxOutputLines) {
      const truncatedLines = outputLines.slice(0, maxOutputLines);
      cleanOutput = truncatedLines.join('\n');
      const remainingLines = outputLines.length - maxOutputLines;
      truncationMessage = `\n\n⚠️ Output truncated: showing ${maxOutputLines} of ${outputLines.length} lines (${remainingLines} hidden). Use read_process_output with offset/length for full output.`;
    }
    
    // Determine final state
    if (!processState) {
      processState = analyzeProcessState(output, pid);
    }
    
    let statusMessage = '';
    if (processState.isWaitingForInput) {
      statusMessage = `\n🔄 ${formatProcessStateMessage(processState, pid)}`;
    } else if (processState.isFinished) {
      statusMessage = `\n✅ ${formatProcessStateMessage(processState, pid)}`;
    } else if (timeoutReached) {
      statusMessage = '\n⏱️ Response may be incomplete (timeout reached)';
    }

    // Add timing information if requested
    let timingMessage = '';
    if (verbose_timing) {
      const endTime = Date.now();
      const timingInfo = {
        startTime,
        endTime,
        totalDurationMs: endTime - startTime,
        exitReason,
        firstOutputTime,
        lastOutputTime,
        timeToFirstOutputMs: firstOutputTime ? firstOutputTime - startTime : undefined,
        outputEvents: outputEvents.length > 0 ? outputEvents : undefined
      };
      timingMessage = formatTimingInfo(timingInfo);
    }

    if (cleanOutput.trim().length === 0 && !timeoutReached) {
      return {
        content: [{
          type: "text",
          text: `✅ Input executed in process ${pid}.\n📭 (No output produced)${statusMessage}${timingMessage}`
        }],
      };
    }

    // Format response with better structure and consistent emojis
    let responseText = `✅ Input executed in process ${pid}`;

    if (cleanOutput && cleanOutput.trim().length > 0) {
      responseText += `:\n\n📤 Output:\n${cleanOutput}`;
    } else {
      responseText += `.\n📭 (No output produced)`;
    }

    if (statusMessage) {
      responseText += `\n\n${statusMessage}`;
    }

    if (truncationMessage) {
      responseText += truncationMessage;
    }

    if (timingMessage) {
      responseText += timingMessage;
    }

    return {
      content: [{
        type: "text",
        text: responseText
      }],
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    capture('server_interact_with_process_error', {
      error: errorMessage
    });
    return {
      content: [{ type: "text", text: `Error interacting with process: ${errorMessage}` }],
      isError: true,
    };
  }
}

/**
 * Force terminate a process
 */
export async function forceTerminate(args: unknown): Promise<ServerResult> {
  const parsed = ForceTerminateArgsSchema.safeParse(args);
  if (!parsed.success) {
    return {
      content: [{ type: "text", text: `Error: Invalid arguments for force_terminate: ${parsed.error}` }],
      isError: true,
    };
  }

  const pid = parsed.data.pid;

  // Handle virtual Node.js sessions (node:local)
  if (virtualNodeSessions.has(pid)) {
    virtualNodeSessions.delete(pid);
    return {
      content: [{
        type: "text",
        text: `Cleared virtual Node.js session ${pid}`
      }],
    };
  }

  const success = terminalManager.forceTerminate(pid);
  return {
    content: [{
      type: "text",
      text: success
        ? `Successfully initiated termination of session ${pid}`
        : `No active session found for PID ${pid}`
    }],
  };
}

/**
 * List active sessions
 */
export async function listSessions(): Promise<ServerResult> {
  const sessions = terminalManager.listActiveSessions();

  // Include virtual Node.js sessions
  const virtualSessions = Array.from(virtualNodeSessions.entries()).map(([pid, session]) => ({
    pid,
    type: 'node:local',
    timeout_ms: session.timeout_ms
  }));

  const realSessionsText = sessions.map(s =>
    `PID: ${s.pid}, Blocked: ${s.isBlocked}, Runtime: ${Math.round(s.runtime / 1000)}s`
  );

  const virtualSessionsText = virtualSessions.map(s =>
    `PID: ${s.pid} (node:local), Timeout: ${s.timeout_ms}ms`
  );

  const allSessions = [...realSessionsText, ...virtualSessionsText];

  return {
    content: [{
      type: "text",
      text: allSessions.length === 0
        ? 'No active sessions'
        : allSessions.join('\n')
    }],
  };
}