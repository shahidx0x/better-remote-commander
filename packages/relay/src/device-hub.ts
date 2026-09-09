/**
 * SES-RDP relay device hub: holds live agent sockets, matches call/result by id,
 * runs heartbeat, and exposes the routing API used by MCP/REST layers.
 */
import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  DEFAULTS, SES_RDP_PROTOCOL_VERSION, parseMessage,
  type AgentMessage, type RelayMessage, type DeviceInfo, type ToolDefinition, type ToolResult,
} from '@ses-systems/rdp-shared';

export interface ConnectedDevice {
  info: DeviceInfo;
  tools: ToolDefinition[];
  ownerId: string;
  connectedAt: number;
  lastSeen: number;
  socket: WebSocket;
}

export interface DeviceSummary {
  deviceId: string;
  name: string;
  platform: string;
  hostname: string;
  agentVersion: string;
  online: boolean;
  lastSeen: number;
  toolCount: number;
}

interface Pending {
  resolve: (r: ToolResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DeviceHub {
  private devices = new Map<string, ConnectedDevice>();
  private pending = new Map<string, Pending>();
  private heartbeat: NodeJS.Timeout;

  constructor(private readonly relayVersion: string, private readonly log: (l: string, m: string) => void) {
    this.heartbeat = setInterval(() => this.tick(), DEFAULTS.pingIntervalMs);
  }

  /** Attach an authenticated socket; the agent must send `hello` as its first frame. */
  attach(socket: WebSocket, ownerId: string): void {
    let deviceId: string | null = null;

    socket.on('message', (raw) => {
      const msg = parseMessage<AgentMessage>(raw as Buffer);
      if (!msg) return;

      if (msg.type === 'hello') {
        if (msg.protocol !== SES_RDP_PROTOCOL_VERSION) {
          this.sendTo(socket, { type: 'error', code: 'PROTOCOL_MISMATCH', message: `relay speaks v${SES_RDP_PROTOCOL_VERSION}`, fatal: true });
          return socket.close(1002, 'protocol mismatch');
        }
        deviceId = msg.device.deviceId;
        const prev = this.devices.get(deviceId);
        if (prev && prev.socket !== socket) {
          this.log('info', `device ${deviceId} reconnected; closing stale socket`);
          prev.socket.terminate();
        }
        this.devices.set(deviceId, { info: msg.device, tools: msg.tools, ownerId, connectedAt: Date.now(), lastSeen: Date.now(), socket });
        this.sendTo(socket, { type: 'welcome', protocol: SES_RDP_PROTOCOL_VERSION, relayVersion: this.relayVersion, serverTime: Date.now() });
        this.log('info', `device online: ${msg.device.name} [${deviceId}] ${msg.device.platform} tools=${msg.tools.length}`);
        return;
      }

      if (!deviceId) return; // ignore anything before hello
      const dev = this.devices.get(deviceId);
      if (dev) dev.lastSeen = Date.now();

      if (msg.type === 'pong') return;
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (!p) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result ?? { content: [] });
      }
    });

    socket.on('close', () => {
      if (deviceId && this.devices.get(deviceId)?.socket === socket) {
        this.devices.delete(deviceId);
        this.log('info', `device offline: ${deviceId}`);
      }
    });
  }

  /** Route a tool call to a device. Throws if offline or timed out. */
  call(deviceId: string, tool: string, args: Record<string, unknown>, opts: { client?: { name?: string; version?: string }; timeoutMs?: number } = {}): Promise<ToolResult> {
    const dev = this.devices.get(deviceId);
    if (!dev) return Promise.reject(new Error(`DEVICE_OFFLINE: ${deviceId}`));
    if (!dev.tools.some((t) => t.name === tool)) return Promise.reject(new Error(`UNKNOWN_TOOL: ${tool}`));
    const id = randomUUID();
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.callTimeoutMs;
    return new Promise<ToolResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CALL_TIMEOUT: ${tool} after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.sendTo(dev.socket, { type: 'call', id, tool, args, client: opts.client, timeoutMs });
    });
  }

  list(ownerId?: string): DeviceSummary[] {
    return [...this.devices.values()]
      .filter((d) => !ownerId || d.ownerId === ownerId)
      .map((d) => ({
        deviceId: d.info.deviceId, name: d.info.name, platform: d.info.platform, hostname: d.info.hostname,
        agentVersion: d.info.agentVersion, online: true, lastSeen: d.lastSeen, toolCount: d.tools.length,
      }));
  }

  get(deviceId: string): ConnectedDevice | undefined { return this.devices.get(deviceId); }

  /** Single online device for an owner, or null when 0 or >1 (caller must ask for deviceId). */
  resolveDefault(ownerId?: string): string | null {
    const list = this.list(ownerId);
    return list.length === 1 ? list[0].deviceId : null;
  }

  private tick(): void {
    const now = Date.now();
    for (const [id, dev] of this.devices) {
      if (now - dev.lastSeen > DEFAULTS.pongTimeoutMs) {
        this.log('warn', `device ${id} missed heartbeats; terminating`);
        dev.socket.terminate();
        this.devices.delete(id);
        continue;
      }
      this.sendTo(dev.socket, { type: 'ping', ts: now });
    }
  }

  private sendTo(socket: WebSocket, msg: RelayMessage): void {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const d of this.devices.values()) d.socket.close(1001, 'relay shutdown');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('RELAY_SHUTDOWN')); }
  }
}
