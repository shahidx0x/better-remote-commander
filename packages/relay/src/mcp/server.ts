/**
 * MCP server factory: one low-level Server per HTTP request (stateless Streamable HTTP).
 * Tools = `list_devices` + union of tools reported by the user's online agents,
 * each augmented with an optional `deviceId` argument. Invocation goes through invoke.ts.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceHub } from '../device-hub.js';
import type { SqliteStore } from '../store/sqlite.js';
import { invokeTool, listUserDevices, type InvokeContext } from './invoke.js';
import { PLUGIN_RELAY_TOOLS, handlePluginRelayTool, type PluginToolDeps } from './plugin-tools.js';
import { SKILL_RELAY_TOOLS, SKILL_TOOL_NAMES, SKILL_READ_ONLY_TOOLS, handleSkillRelayTool } from './skill-tools.js';
import type { McpTrafficEstimator } from '../features/mcp-estimates.js';

export type McpContext = InvokeContext;
/** Opt-in extras; both default off. */
export interface McpFeatures { skills?: boolean; estimator?: McpTrafficEstimator }

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

/** Tools a read-only private link may use: inspect files/git/search only. Nothing that writes, runs commands, kills processes or reaches plugins. */
const READ_ONLY_TOOLS = new Set([
  'read_file', 'read_multiple_files', 'list_directory', 'get_file_info',
  'git_status', 'git_diff', 'git_log',
  'start_search', 'get_more_search_results', 'stop_search', 'list_searches',
  'ast_search', 'read_images',
  // code navigation (read-only, memory-only caches)
  'read_code_file', 'code_outline', 'find_symbols', 'read_symbol', 'find_references', 'related_files',
  'project_context', 'project_map', 'context_pack', 'code_graph', 'language_capabilities',
  'session_handoff', 'code_diagnostics', 'review_changes', 'test_impact', 'vscode_tasks', 'docker_inventory', 'docker_inspect',
  'discover_checks', // lists runnable checks; never runs them
  'batch_tools', // listed for read-only links, but every nested call is validated at call time (readOnlyToolAllowed)
]);
/** Relay-level tools a read-only link may call. */
const READ_ONLY_RELAY_TOOLS = new Set(['list_devices', 'search_mcp_registry']);
/** Visible to read-only links (tools/list). Not sufficient to call: use readOnlyToolAllowed(name, args). */
export function readOnlyToolListed(name: string): boolean {
  return READ_ONLY_TOOLS.has(name) || READ_ONLY_RELAY_TOOLS.has(name);
}
const MAX_BATCH_CALLS = 64;
/**
 * Call-time gate for read-only links. batch_tools is a tunnel for other tools, so it is allowed only when EVERY
 * nested call names a plain read-only tool (never batch_tools itself, never a relay tool) and carries no URL-fetch flag.
 * Fails closed on any malformed shape.
 */
export function readOnlyToolAllowed(name: string, args?: unknown): boolean {
  if (name !== 'batch_tools') return readOnlyToolListed(name) && !(args as { isUrl?: unknown } | undefined)?.isUrl;
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  const calls = (args as { calls?: unknown }).calls;
  if (!Array.isArray(calls) || calls.length < 1 || calls.length > MAX_BATCH_CALLS) return false;
  return calls.every((call: unknown) => {
    if (!call || typeof call !== 'object' || Array.isArray(call)) return false;
    const { tool, arguments: childArgs } = call as { tool?: unknown; arguments?: unknown };
    if (typeof tool !== 'string' || tool === 'batch_tools' || !READ_ONLY_TOOLS.has(tool)) return false;
    if (childArgs === undefined) return true;
    return !!childArgs && typeof childArgs === 'object' && !Array.isArray(childArgs) && !(childArgs as { isUrl?: unknown }).isUrl;
  });
}
export const LIST_DEVICES_TOOL = {
  name: 'list_devices',
  description: 'List devices paired to this relay, with online state and ids. Call this first when more than one device may be connected.',
  inputSchema: { type: 'object', properties: {} },
  annotations: { title: 'List devices', readOnlyHint: true },
};

/** Live tool set for a user: union across online, non-paused devices (with deviceId prop). */
export function liveTools(hub: DeviceHub, store: SqliteStore, userId: string) {
  const online = hub.list(userId).filter((d) => !store.getDevice(d.deviceId)?.paused);
  const merged = new Map<string, { name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> }>();
  for (const d of online) for (const t of hub.get(d.deviceId)?.tools ?? []) if (!merged.has(t.name)) merged.set(t.name, { ...t, inputSchema: withDeviceId(t.inputSchema) });
  return { online: online.length, tools: [...merged.values()] };
}

/** `plugins` enables the marketplace tools (search_mcp_registry, request_plugin_install). */
export function createMcpServer(hub: DeviceHub, store: SqliteStore, ctx: McpContext, relayVersion: string, plugins?: Omit<PluginToolDeps, 'hub' | 'store'>, access: 'read' | 'full' = 'full', features: McpFeatures = {}): Server {
  const skills = !!features.skills;
  const allowedReadOnly = (n: string, a?: unknown) => !(a as { isUrl?: unknown } | undefined)?.isUrl && (readOnlyToolAllowed(n, a) || (skills && SKILL_READ_ONLY_TOOLS.has(n)));
  const listedReadOnly = (n: string) => readOnlyToolListed(n) || (skills && SKILL_READ_ONLY_TOOLS.has(n));
  const server = new Server({ name: 'brc', version: relayVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { online, tools } = liveTools(hub, store, ctx.userId);
    const relayTools = [...(plugins ? PLUGIN_RELAY_TOOLS : []), ...(skills ? SKILL_RELAY_TOOLS : [])].filter((t) => access !== 'read' || listedReadOnly(t.name));
    const reserved = new Set([...(plugins ? PLUGIN_RELAY_TOOLS : []), ...(skills ? SKILL_RELAY_TOOLS : [])].map((t) => t.name));
    const visible = tools.filter((t) => !reserved.has(t.name) && (access !== 'read' || readOnlyToolListed(t.name)))
      .map((t) => (access === 'read' ? { ...t, ...(t.name === 'batch_tools' ? { description: 'READ-ONLY CONNECTION: every nested tool must be a permitted read tool. ' + t.description } : {}), annotations: { ...t.annotations, readOnlyHint: true, destructiveHint: false } } : t));
    const note = access === 'read' ? ' THIS CONNECTION IS READ-ONLY: only the advertised read tools may be used.' : '';
    return { tools: [{ ...LIST_DEVICES_TOOL, description: `${LIST_DEVICES_TOOL.description} ${online} device(s) currently online.${note}` }, ...relayTools, ...visible] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const { name, arguments: args } = req.params;
    // Enforced at call time, not just hidden in tools/list: a read-only link must never reach a write tool by name.
    if (access === 'read' && !allowedReadOnly(name, args)) {
      return { content: [{ type: 'text', text: `READ_ONLY_CONNECTION: ${name} is not available on a read-only connection (writes, commands, plugins and URL fetches are blocked).` }], isError: true };
    }
    if (name === 'list_devices') {
      return { content: [{ type: 'text', text: JSON.stringify({ devices: listUserDevices(hub, store, ctx.userId) }, null, 2) }] };
    }
    if (skills && SKILL_TOOL_NAMES.has(name)) {
      const handled = handleSkillRelayTool(store, ctx, name, args as Record<string, unknown> | undefined);
      if (handled) return handled;
    }
    if (plugins) {
      const handled = await handlePluginRelayTool({ ...plugins, hub, store }, ctx, name, args as Record<string, unknown> | undefined);
      if (handled) return handled;
    }
    const out = await invokeTool(hub, store, ctx, name, args as Record<string, unknown> | undefined, { signal: extra.signal });
    if (!out.ok) return { content: [{ type: 'text', text: out.message }], isError: true };
    features.estimator?.track(ctx.userId, name, args, out.result);
    // structuredContent carries machine-readable error codes / continuation hints from the agent.
    return { content: out.result.content, isError: out.result.isError ?? false,
      ...(out.result.structuredContent ? { structuredContent: out.result.structuredContent } : {}),
      _meta: { ...out.result._meta, deviceId: out.deviceId, deviceName: out.deviceName } } as never;
  });

  return server;
}
