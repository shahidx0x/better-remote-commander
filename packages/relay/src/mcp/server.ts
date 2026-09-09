/**
 * MCP server factory: one low-level Server per HTTP request (stateless Streamable HTTP).
 * Tools = `list_devices` + union of tools reported by the user's online agents,
 * each augmented with an optional `deviceId` argument.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { DeviceHub } from '../device-hub.js';
import type { SqliteStore } from '../store/sqlite.js';
import { createHash } from 'node:crypto';

export interface McpContext {
  userId: string;
  clientId: string;
}

const DEVICE_ID_PROP = {
  deviceId: { type: 'string', description: 'Target device id (from list_devices). Required when more than one device is online; may be omitted when only one device is connected.' },
};

function withDeviceId(schema: unknown): unknown {
  const s = (schema && typeof schema === 'object' ? { ...(schema as Record<string, unknown>) } : { type: 'object' }) as Record<string, unknown>;
  s.type = 'object';
  s.properties = { ...((s.properties as Record<string, unknown>) ?? {}), ...DEVICE_ID_PROP };
  return s;
}

const argsHash = (args: unknown) => createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);

export function createMcpServer(hub: DeviceHub, store: SqliteStore, ctx: McpContext, relayVersion: string): Server {
  const server = new Server({ name: 'ses-rdp', version: relayVersion }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    const online = hub.list(ctx.userId).filter((d) => !store.getDevice(d.deviceId)?.paused);
    const merged = new Map<string, { name: string; description: string; inputSchema: unknown; annotations?: Record<string, unknown> }>();
    for (const d of online) {
      const dev = hub.get(d.deviceId);
      for (const t of dev?.tools ?? []) if (!merged.has(t.name)) merged.set(t.name, { ...t, inputSchema: withDeviceId(t.inputSchema) });
    }
    const listDevices = {
      name: 'list_devices',
      description: `List devices paired to this relay, with online state and ids. Call this first when more than one device may be connected. ${online.length} device(s) currently online.`,
      inputSchema: { type: 'object', properties: {} },
      annotations: { title: 'List devices', readOnlyHint: true },
    };
    return { tools: [listDevices, ...merged.values()] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const { name, arguments: rawArgs } = req.params;
    const args = { ...(rawArgs ?? {}) } as Record<string, unknown>;

    if (name === 'list_devices') {
      const online = new Set(hub.list(ctx.userId).map((d) => d.deviceId));
      const rows = store.listDevices(ctx.userId).map((d) => ({
        deviceId: d.device_id, name: d.name, platform: d.platform, online: online.has(d.device_id), paused: !!d.paused, lastSeen: d.last_seen,
      }));
      return { content: [{ type: 'text', text: JSON.stringify({ devices: rows }, null, 2) }] };
    }

    const requested = typeof args.deviceId === 'string' ? args.deviceId : undefined;
    delete args.deviceId;
    const deviceId = requested ?? hub.resolveDefault(ctx.userId);
    if (!deviceId) {
      const n = hub.list(ctx.userId).length;
      const msg = n === 0 ? 'No device is online. Start ses-rdp-agent on the target machine.' : `${n} devices are online; pass deviceId (see list_devices).`;
      return { content: [{ type: 'text', text: msg }], isError: true };
    }
    const dev = hub.get(deviceId);
    if (!dev || dev.ownerId !== ctx.userId) return { content: [{ type: 'text', text: `Device ${deviceId} is not online or not yours.` }], isError: true };
    if (store.getDevice(deviceId)?.paused) return { content: [{ type: 'text', text: `Device ${dev.info.name} is paused by its owner.` }], isError: true };

    const started = Date.now();
    try {
      const result = await hub.call(deviceId, name, args, { client: { name: ctx.clientId } });
      store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool: name, args_hash: argsHash(args), ok: result.isError ? 0 : 1, ms: Date.now() - started, error: null });
      store.touchDevice(deviceId);
      return { content: result.content, isError: result.isError ?? false, _meta: { deviceId, deviceName: dev.info.name } } as never;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool: name, args_hash: argsHash(args), ok: 0, ms: Date.now() - started, error: message });
      return { content: [{ type: 'text', text: `Relay error: ${message}` }], isError: true };
    }
  });

  return server;
}
