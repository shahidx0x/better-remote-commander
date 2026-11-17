/**
 * Tool-invocation path for /mcp: device resolution, pause check, and audit.
 */
import { createHash } from 'node:crypto';
import type { DeviceHub } from '../device-hub.js';
import type { SqliteStore } from '../store/sqlite.js';
import type { ToolResult } from 'brc-shared';

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

/** Explain WHY no device is usable, scoped to this account only (never reveals other users' devices). */
export function connectionStatus(hub: DeviceHub, store: SqliteStore, userId: string) {
  const devices = listUserDevices(hub, store, userId);
  if (devices.some((d) => d.online && !d.paused)) return { devices, status: 'ready' as const, message: 'Retry list_devices.' };
  if (devices.length) return {
    devices,
    status: devices.some((d) => d.online) ? 'paused' as const : 'paired_device_offline' as const,
    message: devices.some((d) => d.online)
      ? 'The paired device is paused by this account. Resume it in BRC Admin.'
      : 'The devices paired to this account are offline. Restart brc-agent using the saved device pairing.',
  };
  return {
    devices, status: 'no_devices_for_account' as const,
    message: 'This account has no paired devices. If a PC appears online on the relay homepage, reconnect OAuth while signed in as the same BRC account that paired it.',
  };
}

export async function invokeTool(
  hub: DeviceHub, store: SqliteStore, ctx: InvokeContext,
  tool: string, rawArgs: Record<string, unknown> | undefined, opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<InvokeOutcome> {
  const args = { ...(rawArgs ?? {}) };
  const requested = typeof args.deviceId === 'string' && args.deviceId ? args.deviceId : undefined;
  delete args.deviceId;
  const deviceId = requested ?? hub.resolveDefault(ctx.userId);
  if (!deviceId) {
    const n = hub.list(ctx.userId).length;
    if (n === 0) return { ok: false, status: 503, message: 'No device is online for this account. ' + connectionStatus(hub, store, ctx.userId).message };
    return { ok: false, status: 409, message: `${n} devices are online for this account; pass deviceId (see list_devices).` };
  }
  const dev = hub.get(deviceId);
  if (!dev || dev.ownerId !== ctx.userId) return { ok: false, status: 404, message: `Device ${deviceId} is not online or not yours.` };
  if (store.getDevice(deviceId)?.paused) return { ok: false, status: 423, message: `Device ${dev.info.name} is paused by its owner.` };

  const started = Date.now();
  try {
    const result = await hub.call(deviceId, tool, args, { client: { name: ctx.clientId }, timeoutMs: opts.timeoutMs, signal: opts.signal });
    const ms = Date.now() - started;
    store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool, args_hash: argsHash(args), ok: result.isError ? 0 : 1, ms, error: null });
    store.touchDevice(deviceId);
    return { ok: true, deviceId, deviceName: dev.info.name, result, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool, args_hash: argsHash(args), ok: 0, ms: Date.now() - started, error: message });
    const status = message.startsWith('UNKNOWN_TOOL') ? 404 : message.startsWith('CALL_TIMEOUT') ? 504 : /^(?:RELAY_BUSY|DEVICE_BUSY|RELAY_BACKPRESSURE)/.test(message) ? 503 : message.startsWith('CALL_TOO_LARGE') ? 413 : 502;
    return { ok: false, status, message: `Relay error: ${message}` };
  }
}
