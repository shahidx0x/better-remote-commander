/**
 * BRC agent tool dispatcher: name -> handler, ported from upstream server.ts CallTool switch.
 * Returns MCP-shaped results; errors become { isError: true } text blocks (never throws).
 */
import * as handlers from './core/handlers/index.js';
import { getConfig, setConfigValue } from './core/tools/config.js';
import { getUsageStats } from './core/tools/usage.js';
import { buildToolDefinitions, EXCLUDED_TOOLS, type ToolDefinition } from './core/tool-definitions.js';
import { usageTracker } from './core/utils/usageTracker.js';
import { BRC_TOOL_HANDLERS, buildBrcToolDefinitions } from './tools/brc-tools.js';
import { JOB_TOOL_HANDLERS, buildJobToolDefinitions, setJobToolExecutor } from './tools/jobs.js';
import { PLUGIN_TOOL_HANDLERS, buildPluginToolDefinitions } from './tools/plugin-tools.js';
import { AST_GREP_TOOL_HANDLERS, buildAstGrepToolDefinitions } from './tools/ast-grep.js';
import { WORKSPACE_TOOL_HANDLERS, buildWorkspaceToolDefinitions } from './tools/workspace-batch.js';
import { CHECK_TOOL_HANDLERS, buildCheckToolDefinitions } from './tools/check-tools.js';
import type { ToolResult } from 'brc-shared';
import type { ServerResult } from './core/types.js';
import { randomUUID } from 'node:crypto';
import { activity } from './runtime/activity.js';
import { AgentError, failure } from './runtime/errors.js';
import { assertHash, withFileLocks } from './runtime/file-safety.js';
import { validatePath } from './core/tools/filesystem.js';
import { getCallContext, withCallContext, checkCancelled } from './context.js';

type Args = Record<string, unknown>;
type Handler = (args: Args) => Promise<unknown>;

const TOOL_HANDLERS: Map<string, Handler> = new Map<string, Handler>([
  ['get_config', () => getConfig()],
  ['set_config_value', (a) => setConfigValue(a)],
  ['get_usage_stats', () => getUsageStats()],
  ['get_recent_tool_calls', (a) => handlers.handleGetRecentToolCalls(a)],
  ['start_process', (a) => handlers.handleStartProcess(a)],
  ['read_process_output', (a) => handlers.handleReadProcessOutput(a)],
  ['interact_with_process', (a) => handlers.handleInteractWithProcess(a)],
  ['force_terminate', (a) => handlers.handleForceTerminate(a)],
  ['list_sessions', () => handlers.handleListSessions()],
  ['list_processes', () => handlers.handleListProcesses()],
  ['kill_process', (a) => handlers.handleKillProcess(a)],
  ['read_file', (a) => handlers.handleReadFile(a)],
  ['read_multiple_files', (a) => handlers.handleReadMultipleFiles(a)],
  ['write_file', (a) => handlers.handleWriteFile(a)],
  ['write_pdf', (a) => handlers.handleWritePdf(a)],
  ['create_directory', (a) => handlers.handleCreateDirectory(a)],
  ['list_directory', (a) => handlers.handleListDirectory(a)],
  ['move_file', (a) => handlers.handleMoveFile(a)],
  ['prepare_file_transfer', (a) => handlers.handlePrepareFileTransfer(a)],
  ['send_file_transfer', (a) => handlers.handleSendFileTransfer(a)],
  ['receive_file_transfer', (a) => handlers.handleReceiveFileTransfer(a)],
  ['get_file_info', (a) => handlers.handleGetFileInfo(a)],
  ['edit_block', (a) => handlers.handleEditBlock(a)],
  ['start_search', (a) => handlers.handleStartSearch(a)],
  ['get_more_search_results', (a) => handlers.handleGetMoreSearchResults(a)],
  ['stop_search', (a) => handlers.handleStopSearch(a)],
  ['list_searches', () => handlers.handleListSearches()],
  // BRC-native tools
  ...Object.entries(BRC_TOOL_HANDLERS),
  // Workers: background jobs + parallel fan-out
  ...Object.entries(JOB_TOOL_HANDLERS),
  // Plugins: MCP servers installed on this device
  ...Object.entries(PLUGIN_TOOL_HANDLERS),
  // Structural code search/rewrite (ast-grep binary plugin)
  ...Object.entries(AST_GREP_TOOL_HANDLERS),
  // Hash-checked multi-file edit/read batch
  ...Object.entries(WORKSPACE_TOOL_HANDLERS),
  // Discovered project checks
  ...Object.entries(CHECK_TOOL_HANDLERS),
]);

let cachedDefs: ToolDefinition[] | null = null;

export function listTools(): ToolDefinition[] {
  if (!cachedDefs) {
    cachedDefs = [...buildToolDefinitions(), ...buildBrcToolDefinitions(), ...buildJobToolDefinitions(), ...buildPluginToolDefinitions(), ...buildAstGrepToolDefinitions(), ...buildWorkspaceToolDefinitions(), ...buildCheckToolDefinitions()]
      .filter((t) => TOOL_HANDLERS.has(t.name) && !EXCLUDED_TOOLS.has(t.name));
  }
  return cachedDefs;
}

export function hasTool(name: string): boolean {
  return TOOL_HANDLERS.has(name);
}

/** Tools that write files; they run under per-file locks so concurrent calls cannot clobber each other. */
const MUTATIONS = new Set(['write_file', 'edit_block', 'move_file', 'create_directory', 'write_pdf']);
const HASH_CHECKED = new Set(['write_file', 'edit_block']);

export async function callTool(name: string, args: Args): Promise<ToolResult> {
  const parent = getCallContext();
  // Local/nested callers get their own context so every call has an id and can be cancelled/traced.
  if (!parent) return withCallContext({ id: randomUUID(), client: null, remote: false }, () => callTool(name, args));
  const start = performance.now();
  activity.tool('START', name, parent.id);
  let out: ToolResult;
  try {
    checkCancelled();
    const handler = TOOL_HANDLERS.get(name);
    if (!handler || EXCLUDED_TOOLS.has(name)) throw new AgentError('UNKNOWN_TOOL', `Unknown tool: ${name}`);
    args = args ?? {};
    const perform = async (): Promise<ToolResult> => {
      checkCancelled();
      // Optional optimistic concurrency: refuse to write if the file changed since the caller read it.
      if (HASH_CHECKED.has(name) && args.expected_sha256 !== undefined) {
        if (typeof args.expected_sha256 !== 'string' || !/^[a-fA-F0-9]{64}$/.test(args.expected_sha256))
          throw new AgentError('INVALID_ARGUMENT', 'expected_sha256 must be 64 hex characters.');
        const target = args.file_path ?? args.path;
        if (typeof target !== 'string') throw new AgentError('INVALID_ARGUMENT', 'A file path is required for expected_sha256.');
        const validated = await validatePath(target);
        await assertHash(validated, args.expected_sha256);
        return withCallContext({ ...parent, writePrecondition: { path: validated, sha256: args.expected_sha256 } }, () => handler(args) as Promise<ToolResult>);
      }
      return (await handler(args)) as ToolResult;
    };
    if (MUTATIONS.has(name)) {
      const targets = [args.file_path, args.path, args.source, args.destination, args.outputPath].filter((p): p is string => typeof p === 'string' && !!p);
      out = await withFileLocks(await Promise.all(targets.map((p) => validatePath(p))), perform);
    } else out = await perform();
    if (!out.isError) void usageTracker.trackSuccess(name);
    else void usageTracker.trackFailure(name);
  } catch (err) {
    void usageTracker.trackFailure(name);
    out = failure(err, parent.id);
  }
  const durationMs = Math.round(performance.now() - start);
  const code = (out.structuredContent?.error as { code?: string } | undefined)?.code;
  activity.tool(out.isError ? 'ERROR' : 'OK', name, parent.id, durationMs, code);
  return { ...out, _meta: { ...(out as { _meta?: Record<string, unknown> })._meta, callId: parent.id, durationMs } } as ToolResult;
}
// Job steps run through the same dispatcher (validation, usage tracking, error wrapping).
setJobToolExecutor(async (name, args) => (await callTool(name, args)) as ServerResult);
