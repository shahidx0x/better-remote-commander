/**
 * Tool-invocation path for /mcp: device resolution, pause check, and audit.
 */
import type { DeviceHub } from '../device-hub.js';
import type { RelayStore } from '../store/types.js';
import type { ToolResult } from 'brc-shared';

export interface InvokeContext { userId: string; clientId: string }
export type InvokeOutcome =
  | { ok: true; deviceId: string; deviceName: string; result: ToolResult; ms: number }
  | { ok: false; status: number; message: string };


export async function listUserDevices(hub: DeviceHub, store: RelayStore, userId: string) {
  const online = new Set(hub.list(userId).map((d) => d.deviceId));
  return (await store.listDevices(userId)).map((d) => ({
    deviceId: d.device_id, name: d.name, platform: d.platform, online: online.has(d.device_id), paused: !!d.paused, lastSeen: d.last_seen,
  }));
}

/** Scope every detail to the OAuth principal. Never expose other users' device names or IDs. */
export async function connectionStatus(hub: DeviceHub, store: RelayStore, userId: string) {
  const devices = await listUserDevices(hub, store, userId);
  const eligible = devices.some(d => d.online && !d.paused);
  if (eligible) return { devices, status: 'ready' as const };
  if (devices.length) return {
    devices,
    status: devices.some(d => d.online) ? 'paused' as const : 'paired_device_offline' as const,
    message: devices.some(d => d.online)
      ? 'The paired device is paused by this account. Resume it in BRC Admin.'
      : 'The devices paired to this OAuth account are offline. Restart brc-agent using the saved device pairing.',
  };
  // A globally connected device belongs to someone else, not necessarily this
  // OAuth principal. Never silently pick it (or reassign its user_id).
  return {
    devices,
    status: 'no_devices_for_oauth_account' as const,
    message: 'This OAuth account has no paired devices. If your PC appears online on the relay homepage, reconnect OAuth while signed in as the same BRC account that paired that PC. No pairing or OAuth credentials need to be cleared.',
  };
}

export async function invokeTool(
  hub: DeviceHub, store: RelayStore, ctx: InvokeContext,
  tool: string, rawArgs: Record<string, unknown> | undefined, opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<InvokeOutcome> {
  const args = { ...(rawArgs ?? {}) };
  const requested = typeof args.deviceId === 'string' && args.deviceId ? args.deviceId : undefined;
  delete args.deviceId;
  const deviceId = requested ?? hub.resolveDefault(ctx.userId);
  if (!deviceId) {
    const n = hub.list(ctx.userId).length;
    if (n === 0) {
      const status = await connectionStatus(hub, store, ctx.userId);
      return { ok: false, status: 503, message: 'No device is online for this OAuth account. ' +
        (status.status === 'ready' ? 'Retry list_devices.' : status.message) };
    }
    return { ok: false, status: 409, message: `${n} devices are online for this account; pass deviceId (see list_devices).` };
  }
  const dev = hub.get(deviceId);
  if (!dev || dev.ownerId !== ctx.userId) return { ok: false, status: 404, message: `Device ${deviceId} is not online or not yours.` };
  if ((await store.getDevice(deviceId))?.paused) return { ok: false, status: 423, message: `Device ${dev.info.name} is paused by its owner.` };

  const started = Date.now();
  try {
    const result = await hub.call(deviceId, tool, args, { client: { name: ctx.clientId }, timeoutMs: opts.timeoutMs, signal: opts.signal });
    const ms = Date.now() - started;
    result._meta = {...result._meta, auditPersisted:false, activityStorage:"memory-only"};
    try {
      // Audit is in-memory only. Device last-seen is housekeeping, never an
      // authorization check; do not delay the completed tool result on Mongo I/O.
      void store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool, args_hash: null, ok: result.isError ? 0 : 1, ms, error: null });
      void Promise.resolve().then(() => store.touchDevice(deviceId)).catch(() => {});
    } catch {
      // The command may already have changed files. Never invite a blind replay.
      result._meta = {...result._meta, auditPersisted:false, auditWarning:'Live activity update failed; tool result is still valid.'};
    }
    return { ok: true, deviceId, deviceName: dev.info.name, result, ms };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try {
    await store.audit({ ts: started, user_id: ctx.userId, device_id: deviceId, client: ctx.clientId, tool, args_hash: null, ok: 0, ms: Date.now() - started, error: /^[A-Z_]+/.exec(message)?.[0] ?? 'RELAY_ERROR' });
    } catch { /* Preserve the original execution error if diagnostic storage also fails. */ }
    const status = message.startsWith('UNKNOWN_TOOL') ? 404 : message.startsWith('CALL_TIMEOUT') ? 504 : /^(?:RELAY_BUSY|DEVICE_BUSY|RELAY_BACKPRESSURE)/.test(message) ? 503 : message.startsWith('CALL_TOO_LARGE') ? 413 : 502;
    return { ok: false, status, message: `Relay error: ${message}` };
  }
}
