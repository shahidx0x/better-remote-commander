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

export function createMcpServer(hub: DeviceHub, store: SqliteStore, ctx: McpContext, relayVersion: string): Server {
  const server = new Server({ name: 'brc', version: relayVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const { online, tools } = liveTools(hub, store, ctx.userId);
    return { tools: [{ ...LIST_DEVICES_TOOL, description: `${LIST_DEVICES_TOOL.description} ${online} device(s) currently online.` }, ...tools] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: args } = req.params;
    if (name === 'list_devices') {
      return { content: [{ type: 'text', text: JSON.stringify({ devices: listUserDevices(hub, store, ctx.userId) }, null, 2) }] };
    }
    const out = await invokeTool(hub, store, ctx, name, args as Record<string, unknown> | undefined);
    if (!out.ok) return { content: [{ type: 'text', text: out.message }], isError: true };
    return { content: out.result.content, isError: out.result.isError ?? false, _meta: { deviceId: out.deviceId, deviceName: out.deviceName } } as never;
  });

  return server;
}
