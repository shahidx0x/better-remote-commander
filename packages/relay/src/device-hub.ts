/**
 * BRC relay device hub: holds live agent sockets, matches call/result by id,
 * runs heartbeat, and exposes the routing API used by MCP/REST layers.
 */
import type WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import {
  DEFAULTS, BRC_PROTOCOL_VERSION, parseMessage, sanitizePluginSummary,
  type AgentMessage, type RelayMessage, type DeviceInfo, type ToolDefinition, type ToolResult,
  type PluginAdminMessage, type PluginStatusSummary,
} from 'brc-shared';

export interface ConnectedDevice {
  info: DeviceInfo;
  tools: ToolDefinition[];
  ownerId: string;
  connectedAt: number;
  lastSeen: number;
  socket: WebSocket;
  /** Latest `plugins` report; undefined = agent never reported (too old for plugin admin). */
  plugins?: PluginStatusSummary[];
  pluginsAt?: number;
}

export interface PluginAdminOutcome { ok: boolean; error?: string; plugin?: PluginStatusSummary }
export type PluginAdminRequest = Omit<PluginAdminMessage, 'type' | 'id'>;

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
  socket: WebSocket;
  cleanup: () => void;
  resolve: (r: ToolResult) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export class DeviceHub {
  /** A fresh, non-secret identifier on each relay process start. Helps spot load-balancer misrouting. */
  readonly instanceId = randomUUID().slice(0, 12);
  private devices = new Map<string, ConnectedDevice>();
  private pending = new Map<string, Pending>();
  private adminPending = new Map<string, { deviceId: string; resolve: (r: PluginAdminOutcome) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private heartbeat: NodeJS.Timeout;

  onHello?: (device: DeviceInfo, tools: ToolDefinition[]) => void;
  /** Exact UTF-8 WebSocket message payload byte counts for tool call/result frames.
   * No extra serialization, network request, or database write on tool execution.
   */
  onWireTraffic?: (ownerId:string,direction:'to-agent'|'from-agent',bytes:number)=>void;
  /** Called with every (sanitised) plugin report, e.g. to persist the last-known list. */
  onPlugins?: (deviceId: string, plugins: PluginStatusSummary[]) => void;

  constructor(private readonly relayVersion: string, private readonly log: (l: string, m: string) => void) {
    this.heartbeat = setInterval(() => this.tick(), DEFAULTS.pingIntervalMs);
  }

  /** Attach an authenticated socket; the agent must send `hello` as its first frame. */
  attach(socket: WebSocket, ownerId: string, expectedDeviceId?: string): void {
    let deviceId: string | null = null;

    socket.on('message', (raw) => {
      const msg = parseMessage<AgentMessage>(raw as Buffer);
      if (!msg) return;

      if (msg.type === 'hello') {
        if(!msg.device||typeof msg.device.deviceId!=='string'||!Array.isArray(msg.tools)||msg.tools.length>256||msg.tools.some(t=>!t||typeof t.name!=='string'||!/^[a-zA-Z0-9_-]{1,80}$/.test(t.name)||(t.description!==undefined&&(typeof t.description!=='string'||t.description.length>32000))||!t.inputSchema||typeof t.inputSchema!=='object')){
          this.sendTo(socket,{type:'error',code:'INVALID_HELLO',message:'Invalid or oversized device tool catalog',fatal:true});socket.close(1008,'invalid catalog');return;
        }

        if (msg.protocol !== BRC_PROTOCOL_VERSION) {
          this.sendTo(socket, { type: 'error', code: 'PROTOCOL_MISMATCH', message: `relay speaks v${BRC_PROTOCOL_VERSION}`, fatal: true });
          return socket.close(1002, 'protocol mismatch');
        }
        if (expectedDeviceId && msg.device.deviceId !== expectedDeviceId) {
          this.sendTo(socket, { type: 'error', code: 'DEVICE_ID_MISMATCH', message: 'hello.deviceId does not match the paired device token', fatal: true });
          return socket.close(4403, 'device id mismatch');
        }
        deviceId = msg.device.deviceId;
        const prev = this.devices.get(deviceId);
        if (prev && prev.socket !== socket) {
          this.log('info', `device ${deviceId} reconnected; closing stale socket`);
          prev.socket.terminate();
        }
        this.devices.set(deviceId, { info: msg.device, tools: msg.tools, ownerId, connectedAt: Date.now(), lastSeen: Date.now(), socket });
        this.sendTo(socket, { type: 'welcome', protocol: BRC_PROTOCOL_VERSION, relayVersion: this.relayVersion, serverTime: Date.now() });
        this.log('info', `device online: ${msg.device.name} [${deviceId}] ${msg.device.platform} tools=${msg.tools.length}`);
        try { this.onHello?.(msg.device, msg.tools); } catch (e) { this.log('warn', `onHello failed: ${e instanceof Error ? e.message : String(e)}`); }
        return;
      }

      if (!deviceId) return; // ignore anything before hello
      const dev = this.devices.get(deviceId);
      // Ignore all late frames from a socket replaced by a newer connection.
      // A stale pong/result must not keep the replacement 'alive' or affect its calls.
      if (!dev || dev.socket !== socket) return;
      dev.lastSeen = Date.now();

      if (msg.type === 'pong') return;
      if (msg.type === 'result') {
        const p = this.pending.get(msg.id);
        if (!p || p.socket !== socket) return;
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        p.cleanup();
        const resultBytes=Buffer.isBuffer(raw)?raw.length:
          Array.isArray(raw)?raw.reduce((total,b)=>total+b.length,0):raw.byteLength;
        try { this.onWireTraffic?.(dev.ownerId,'from-agent',resultBytes); } catch { /* telemetry must not alter tools */ }
        if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        else if(resultBytes>512*1024) {
          // Guard the MCP/ChatGPT stream even when the connected agent is old
          // and has no 512 KiB result cap. The operation may already be done.
          const message='Tool response exceeded the relay 512 KiB forwarding budget. '+
            'For reads request fewer lines/pages/images. For mutations inspect the current file or job state BEFORE retrying.';
          p.resolve({isError:true,content:[{type:'text',text:'RESULT_TOO_LARGE: '+message}],
            structuredContent:{error:{code:'RESULT_TOO_LARGE',message,retryable:false},
              recovery:{automaticRetry:false,suggestion:'Use a narrower read; inspect existing changes before retrying a mutation.'},
              truncated:true}});
        }
        else p.resolve(msg.result ?? { content: [] });
        return;
      }
      if (msg.type === 'plugins') {
        if (!dev || !Array.isArray(msg.plugins)) return;
        dev.plugins = msg.plugins.slice(0, 500).map(sanitizePluginSummary).filter((p): p is PluginStatusSummary => !!p);
        dev.pluginsAt = Date.now();
        try { this.onPlugins?.(deviceId, dev.plugins); } catch (e) { this.log('warn', `onPlugins failed: ${e instanceof Error ? e.message : String(e)}`); }
        return;
      }
      if (msg.type === 'plugin_admin_result') {
        const p = typeof msg.id === 'string' ? this.adminPending.get(msg.id) : undefined;
        if (!p || p.deviceId !== deviceId) return;
        this.adminPending.delete(msg.id);
        clearTimeout(p.timer);
        const plugin = msg.plugin ? sanitizePluginSummary(msg.plugin) ?? undefined : undefined;
        p.resolve({ ok: msg.ok === true, error: typeof msg.error === 'string' ? msg.error.slice(0, 2000) : undefined, plugin });
      }
    });

    socket.on('close', () => {
      for (const [id, p] of this.pending) {
        if (p.socket !== socket) continue;
        clearTimeout(p.timer); p.cleanup(); this.pending.delete(id); p.reject(new Error('DEVICE_DISCONNECTED: operation outcome may be unknown; do not blindly retry mutations'));
      }
      if (deviceId && this.devices.get(deviceId)?.socket === socket) {
        this.devices.delete(deviceId);
        this.log('info', `device offline: ${deviceId}`);
        for (const [id, p] of this.adminPending) {
          if (p.deviceId !== deviceId) continue;
          this.adminPending.delete(id);
          clearTimeout(p.timer);
          p.reject(new Error(`DEVICE_OFFLINE: ${deviceId} disconnected`));
        }
      }
    });
  }

  /** Route a tool call to a device. Throws if offline or timed out. */
  call(deviceId: string, tool: string, args: Record<string, unknown>, opts: { client?: { name?: string; version?: string }; timeoutMs?: number; signal?: AbortSignal; callId?: string } = {}): Promise<ToolResult> {
    const dev = this.devices.get(deviceId);
    if (!dev) return Promise.reject(new Error(`DEVICE_OFFLINE: ${deviceId}`));
    if (!dev.tools.some((t) => t.name === tool)) return Promise.reject(new Error(`UNKNOWN_TOOL: ${tool}`));
    if (opts.signal?.aborted) return Promise.reject(new Error('CALL_CANCELLED'));
    if (this.pending.size >= 512) return Promise.reject(new Error('RELAY_BUSY'));
    if([...this.pending.values()].filter(p=>p.socket===dev.socket).length>=64)return Promise.reject(new Error('DEVICE_BUSY: too many outstanding calls for this device'));
    if(dev.socket.readyState!==dev.socket.OPEN)return Promise.reject(new Error('DEVICE_OFFLINE'));
    if(dev.socket.bufferedAmount>8*1024*1024)return Promise.reject(new Error('RELAY_BACKPRESSURE: outbound device buffer is full; request was not dispatched'));
    if(Buffer.byteLength(JSON.stringify(args))>16*1024*1024)return Promise.reject(new Error('CALL_TOO_LARGE: split the operation into smaller bounded requests'));

    // A relay-journaled call uses the SAME durable operation ID on the wire.
    // The agent's own receipt can then be queried after a lost response.
    const id = opts.callId ?? randomUUID();
    if(this.pending.has(id))return Promise.reject(new Error('DUPLICATE_IN_FLIGHT: inspect durable operation status'));
    const timeoutMs = opts.timeoutMs ?? DEFAULTS.callTimeoutMs;
    return new Promise<ToolResult>((resolve, reject) => {
      const abort = () => {
        const p = this.pending.get(id); if (!p) return;
        this.pending.delete(id); clearTimeout(p.timer); p.cleanup();
        this.sendTo(dev.socket, { type:'cancel', id, reason:'client cancelled' });
        reject(new Error('CALL_CANCELLED'));
      };
      const cleanup = () => opts.signal?.removeEventListener('abort', abort);
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup();
        this.sendTo(dev.socket, {type:'cancel',id,reason:'relay deadline'});
        reject(new Error(`CALL_TIMEOUT: ${tool} after ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, socket:dev.socket, cleanup });
      opts.signal?.addEventListener('abort', abort, {once:true});
      const sentBytes=this.sendTo(dev.socket,{ type:'call',id,tool,args,client:opts.client,timeoutMs });
      if(sentBytes) try { this.onWireTraffic?.(dev.ownerId,'to-agent',sentBytes); }
      catch { /* no observer failure should interrupt execution */ }
    });
  }

  /**
   * Send an owner-approved plugin_admin request to a device and wait for its result.
   * Rejects with DEVICE_OFFLINE, PLUGINS_UNSUPPORTED (agent never sent `plugins`) or ADMIN_TIMEOUT.
   */
  pluginAdmin(deviceId: string, req: PluginAdminRequest, timeoutMs = 30_000): Promise<PluginAdminOutcome> {
    const dev = this.devices.get(deviceId);
    if (!dev) return Promise.reject(new Error(`DEVICE_OFFLINE: ${deviceId}`));
    if (!dev.plugins) return Promise.reject(new Error('PLUGINS_UNSUPPORTED: this agent version does not support plugins; update brc-agent'));
    const id = randomUUID();
    return new Promise<PluginAdminOutcome>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.adminPending.delete(id);
        reject(new Error(`ADMIN_TIMEOUT: ${req.action} still running after ${timeoutMs} ms`));
      }, timeoutMs);
      this.adminPending.set(id, { deviceId, resolve, reject, timer });
      this.sendTo(dev.socket, { type: 'plugin_admin', id, ...req });
    });
  }

  /** Latest plugin report of an online device (undefined when offline or never reported). */
  plugins(deviceId: string): PluginStatusSummary[] | undefined {
    return this.devices.get(deviceId)?.plugins;
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

  /** Best-effort notification only AFTER a durable result has been saved.
   * A dropped ACK does not erase the relay journal, and an old agent ignores it. */
  acknowledgeResult(deviceId:string,id:string,relayPersisted:boolean):boolean{
    const device=this.devices.get(deviceId);
    if(!device||!relayPersisted)return false;
    return this.sendTo(device.socket,{type:'result_ack',id,relayPersisted:true,serverTime:Date.now()})>0;
  }

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

  private sendTo(socket: WebSocket, msg: RelayMessage): number {
    if (socket.readyState !== socket.OPEN) return 0;
    try {
      const encoded=JSON.stringify(msg);
      socket.send(encoded);
      return Buffer.byteLength(encoded);
    } catch { socket.terminate(); return 0; }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const d of this.devices.values()) d.socket.close(1001, 'relay shutdown');
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.cleanup(); p.reject(new Error('RELAY_SHUTDOWN')); }
    this.pending.clear(); this.devices.clear();
  }
}
