/**
 * Single tool-invocation path shared by /mcp and /api: device resolution, pause check, audit.
 */
import { createHash } from 'node:crypto';
import type { DeviceHub } from '../device-hub.js';
import type { SqliteStore } from '../store/sqlite.js';
import type { ToolResult } from '@ses-systems/rdp-shared';

export interface InvokeContext { userId: string; clientId: string }
export type InvokeOutcome =
  | { ok: true; deviceId: string; deviceName: string; result: ToolResult; ms: number }
  | { ok: false; status: number; message: string };

const argsHash = (args: unknown) => createHash('sha256').update(JSON.stringify(args ?? {})).digest('hex').slice(0, 16);

export function listUserDevices(hub: DeviceHub, store: SqliteStore, userId: string) {
  const online = new Set(hub.list(userId).map((d) => d.deviceId));
  return store.listDevices(userId).map((d) => ({
    deviceId: d.device_id, name: d.name, platform: d.platform, online: online.has(d.device_id), paused: !!d.paused, lastSeen: d.last_seen,
  }));
}

export async function invokeTool(
  hub: DeviceHub, store: SqliteStore, ctx: InvokeContext,
  tool: string, rawArgs: Record<string, unknown> | undefined, opts: { timeoutMs?: number } = {},
): Promise<InvokeOutcome> {
  const args = { ...(rawArgs ?? {}) };
  const requested = typeof args.deviceId === 'string' && args.deviceId ? args.deviceId : undefined;
  delete args.deviceId;
  const deviceId = requested ?? hub.resolveDefault(ctx.userId);
  if (!deviceId) {
    const n = hub.list(ctx.userId).length;
    return { ok: false, status: n === 0 ? 503 : 409, message: n === 0 ? 'No device is online. Start ses-rdp-agent on the target machine.' : `${n} devices are online; pass deviceId (see list_devices).` };
  }
  const dev = hub.get(deviceId);
  if (!dev || dev.ownerId !== ctx.userId) return { ok: false, status: 404, message: `Device ${deviceId} is not online or not yours.` };
  if (store.getDevice(deviceId)?.paused) return { ok: false, status: 423, message: `Device ${dev.info.name} is paused by its owner.` };

  const started = Date.now();
  try {
    const result = await hub.call(deviceId, tool, args, { client: { name: ctx.clientId }, timeoutMs: opts.timeoutMs });
    const ms = Date.now() - started;
    store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool, args_hash: argsHash(args), ok: result.isError ? 0 : 1, ms, error: null });
    store.touchDevice(deviceId);
    return { ok: true, deviceId, deviceName: dev.info.name, result, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool, args_hash: argsHash(args), ok: 0, ms: Date.now() - started, error: message });
    const status = message.startsWith('UNKNOWN_TOOL') ? 404 : message.startsWith('CALL_TIMEOUT') ? 504 : 502;
    return { ok: false, status, message: `Relay error: ${message}` };
  }
}
