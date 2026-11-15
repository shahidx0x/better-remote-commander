/**
 * MCP server factory: one low-level Server per HTTP request (stateless Streamable HTTP).
 * Publish stable agent tool schemas even with zero connected devices. Many MCP clients
 * snapshot tools/list at first connection and never refresh automatically.
 * Online agents override bundled schemas; authorization and execution always use
 * live owner/device/pause checks in invoke.ts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceHub } from '../device-hub.js';
import type { SqliteStore } from '../store/sqlite.js';
import { invokeTool, listUserDevices, type InvokeContext } from './invoke.js';
import { BUNDLED_AGENT_TOOL_CATALOG } from './agent-tools.catalog.js';

export type McpContext = InvokeContext;

export const DEVICE_ID_PROP = {
  deviceId: { type: 'string', description: 'Target device id (from list_devices). Required when more than one device is online; may be omitted when only one device is connected.' },
};

export function withDeviceId(schema: unknown): Record<string, unknown> {
  const s = (schema && typeof schema === 'object' ? { ...(schema as Record<string, unknown>) } : {}) as Record<string, unknown>;
  delete s.$schema;
  s.type = 'object';
  s.properties = { ...((s.properties as Record<string, unknown>) ?? {}), ...DEVICE_ID_PROP };
  return s;
}

// Explicit allowlist: do not trust an unreviewed tool annotation to enforce read-only access.
const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_file_info',
  'read_code_file', 'read_code_ranges', 'read_code_context', 'read_symbol', 'code_outline',
  'find_symbols', 'find_references', 'related_files', 'code_diagnostics',
  'project_context', 'project_map', 'context_pack', 'language_capabilities',
  'vscode_tasks', 'git_status', 'git_diff', 'git_log', 'test_impact',
  'docker_inventory', 'docker_inspect', 'read_images', 'agent_status',
  'discover_checks', 'review_changes', 'session_handoff',
  'batch_tools', // Read-only clients may batch, but every nested tool is validated below.
]);

/** Prevent a read-only capability URL from using batch_tools as a mutation tunnel. */
export function readOnlyToolAllowed(name: string, args: unknown): boolean {
  if (!READ_ONLY_TOOLS.has(name)) return false;
  if (name !== 'batch_tools') return true;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const calls = (args as { calls?: unknown }).calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > 64) return false;
  return calls.every((call: unknown) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return false;
    const child = call as { tool?: unknown; arguments?: unknown };
    return typeof child.tool === 'string' && child.tool !== 'batch_tools'
      && READ_ONLY_TOOLS.has(child.tool)
      && (child.arguments === undefined || (!!child.arguments && typeof child.arguments === 'object' && !Array.isArray(child.arguments)));
  });
}

export const LIST_DEVICES_TOOL = {
  name: 'list_devices',
  description: 'USE WHEN: identify your paired PCs and their real online state/device IDs, especially with multiple devices. USE INSTEAD: for files on a known device use the file/code tools; for agent operations use agent_status. IMPORTANT: an online device is not proof files are accessible or tests passed.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'List devices', readOnlyHint: true },
};

// Cache schema transformation only, NEVER authentication, ownership or pause checks.
// Device objects change on reconnect/hello; pause state is read freshly for every tools/list.
type ToolCache = {devices:object[];definitions:unknown[];tools:{name:string;description:string;inputSchema:unknown;annotations?:Record<string,unknown>}[]};
const schemaCaches = new WeakMap<DeviceHub,Map<string,ToolCache>>();
// Advertise reviewed guidance for ALL known tools, even when an older agent
// reconnects with verbose or contradictory legacy descriptions. The live INPUT
// SCHEMA still wins for every tool except the explicitly strengthened
// read_multiple_files cross-field schema.
const ROUTING_DESCRIPTIONS = new Map(BUNDLED_AGENT_TOOL_CATALOG.map(t => [t.name, t.description] as const));
// Keep multi-file JSON Schema's cross-field rule visible even when the online
// agent has not yet been restarted with its updated tool definitions.
const MULTI_FILE_INPUT_SCHEMA = BUNDLED_AGENT_TOOL_CATALOG.find(t => t.name === 'read_multiple_files')?.inputSchema;
/** Stable tool set plus online agent-specific schemas; execution still requires a live, owned device. */
export function liveTools(hub: DeviceHub, store: SqliteStore, userId: string) {
  const online = hub.list(userId).filter((d) => !store.getDevice(d.deviceId)?.paused);
  const devices=online.map(d=>hub.get(d.deviceId)!).filter(Boolean);
  let cache=schemaCaches.get(hub);if(!cache){cache=new Map();schemaCaches.set(hub,cache);}
  const prior=cache.get(userId);
  if(prior&&prior.devices.length===devices.length&&devices.every((d,i)=>prior.devices[i]===d&&prior.definitions[i]===d.tools)){
    cache.delete(userId);cache.set(userId,prior);return{online:devices.length,tools:prior.tools};
  }
  // Seed with stable definitions so a client connecting while the agent is offline
  // gets the same tools as one connecting while it is online.
  // Do not cache user authorization: this is only static, public schema metadata.
  const merged = new Map<string, { name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> }>();
  for (const t of BUNDLED_AGENT_TOOL_CATALOG)
    merged.set(t.name, { ...t, inputSchema: withDeviceId(t.inputSchema) });
  // Prefer currently connected agent schemas if its installed version differs.
  // Overriding preserves catalog order for the usual tools/list snapshot.
  for (const d of devices) for (const t of d.tools)
    merged.set(t.name, { ...t, description: ROUTING_DESCRIPTIONS.get(t.name) ?? t.description,
      inputSchema: withDeviceId(t.name === 'read_multiple_files' && MULTI_FILE_INPUT_SCHEMA
        ? MULTI_FILE_INPUT_SCHEMA : t.inputSchema) });
  const tools=[...merged.values()];cache.set(userId,{devices,definitions:devices.map(d=>d.tools),tools});
  while(cache.size>128)cache.delete(cache.keys().next().value!);
  return { online: devices.length, tools };
}

/** Concise routing guidance placed in MCP initialize and repeated by key tool descriptions.
 * AI hosts decide which tool to call; this cannot force model behavior. */
export const TOOL_ROUTING_GUIDANCE = [
  'BRC FAST TOOL CHOICE (minimize MCP round trips):',
  '2+ known files to read -> ONE read_multiple_files call with paths[] or files[] (per-file ranges). Do NOT issue repeated or Promise.all(read_file) for known paths.',
  'One file/range -> read_file. Code snapshots needing full-file SHA-256 -> read_code_file. Multiple specific code ranges/hashes -> read_code_ranges.',
  'Unknown files -> start_search(wait=true) or read_code_context; do not poll start_search unless a streaming search is necessary.',
  'Multiple DIFFERENT independent read/context operations -> ONE batch_tools call (mode=auto, bounded concurrency); do not nest batches or make unrelated work depend on results not yet known.',
  'Multiple code writes + readback/checks -> ONE workspace_batch (hash-checked, dryRun defaults true; execute only when user authorized). Single tiny edit -> edit_block with precondition.',
  'One-shot build/test/git/system command -> run_command (final exit code in one call); only long-running or interactive commands -> start_process then read_process_output/interact_with_process when needed.',
  'Syntax/lexical candidates (code_diagnostics, find_references, related_files, test_impact) are NOT typecheck, semantic references, full impact, or passing tests. Use discover_checks/run_project_checks or verify_project for executed evidence.',
  'Discover project patterns with project_context/context_pack when needed; use scoped source and real tests, not blanket repository dumps.',
  'Inspect Docker/images with docker_inventory/read_images only when relevant; never assume a missing image/container.',
  'Subagents only if host natively supports them with BRC access; otherwise use existing batches. The relay does not spawn models.',
  'Never invent a tool name, path, file contents, running service, test result, subagent or successful edit. If a tool is unavailable or fails, say so and use the observed output. Tool descriptions are guidance, not permission; device ownership, scope and safe edit checks still apply.'
].join(' ');

export function createMcpServer(hub: DeviceHub, store: SqliteStore, ctx: McpContext, relayVersion: string, access: 'read' | 'full' = 'full'): Server {
  const server = new Server({ name: 'brc', version: relayVersion }, { capabilities: { tools: {} },
    instructions: TOOL_ROUTING_GUIDANCE + (access === 'read' ? ' THIS CONNECTION IS READ-ONLY: batch_tools accepts only read tools; do not attempt terminal or file mutations.' : '') });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { online, tools } = liveTools(hub, store, ctx.userId);
    const selected = access === 'read' ? tools.filter(t => READ_ONLY_TOOLS.has(t.name)).map(t =>
      t.name === 'batch_tools' ? { ...t, description: 'READ-ONLY BATCH: all nested tools must be permitted reads. ' + t.description,
        annotations: { ...t.annotations, readOnlyHint: true, destructiveHint: false } } : t) : tools;
    return { tools: [{ ...LIST_DEVICES_TOOL, description: `${LIST_DEVICES_TOOL.description} ${online} device(s) currently online.` }, ...selected] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    if (name === 'list_devices') {
      return { content: [{ type: 'text', text: JSON.stringify({ devices: listUserDevices(hub, store, ctx.userId) }, null, 2) }] };
    }
    // Defense in depth: hiding a write tool from tools/list is not enough.
    if (access === 'read' && !readOnlyToolAllowed(name, args))
      return { content: [{ type: 'text', text: 'This connection URL is read-only. Create a full-access URL to use editing or terminal tools.' }], isError: true };
    const out = await invokeTool(hub, store, ctx, name, args as Record<string, unknown> | undefined, {signal:extra.signal});
    if (!out.ok) return { content: [{ type: 'text', text: out.message }], isError: true };
    return { ...out.result, isError: out.result.isError ?? false, _meta: { ...out.result._meta, deviceId: out.deviceId, deviceName: out.deviceName, relayDurationMs: out.ms } } as never;
  });

  return server;
}
