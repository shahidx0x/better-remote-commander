/**
 * BRC agent transport: outbound WebSocket to the relay with auth, hello, heartbeat,
 * exponential-backoff reconnect, unauthorized handling and call dispatch.
 */
import WebSocket from 'ws';
import os from 'node:os';
import {
  DEFAULTS, BRC_PROTOCOL_VERSION, parseMessage,
  type AgentMessage, type RelayMessage, type CallMessage, type DeviceInfo, type ToolDefinition,
} from 'brc-shared';
import { withCallContext } from '../context.js';
import { failure } from '../runtime/errors.js';
import { PluginAdmin } from './plugin-admin.js';
import { boundedAgentFrame } from './result-budget.js';

export interface WsClientOptions {
  relayUrl: string;          // https://host or wss://host
  token: string;
  deviceId: string;
  name: string;
  agentVersion: string;
  coreVersion: string;
  tools: ToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  log?: (level: 'info' | 'warn' | 'error' | 'debug', msg: string) => void;
  /** Called when the relay rejects our token. Return true if the caller takes over (no further reconnects). */
  onUnauthorized?: () => Promise<boolean>;
  /** Called after each successful connect (hello sent). */
  onConnected?: () => void;
}

export class WsClient {
  private ws: WebSocket | null = null;
  private stopped = false;
  private backoff: number = DEFAULTS.reconnectMinMs;
  private pongTimer: NodeJS.Timeout | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private lastUnauthorized = false;
  private unauthorizedCount = 0;
  private readonly log: NonNullable<WsClientOptions['log']>;
  readonly wsUrl: string;
  /** Plugin status reports + relay-driven plugin administration (protocol additions, v1-compatible). */
  private readonly plugins: PluginAdmin;

  constructor(private readonly opts: WsClientOptions) {
    this.log = opts.log ?? (() => {});
    this.wsUrl = WsClient.toWsUrl(opts.relayUrl);
    this.plugins = new PluginAdmin((m) => this.send(m), this.log);
  }

  static toWsUrl(relayUrl: string): string {
    const u = new URL(relayUrl);
    u.protocol = u.protocol === 'https:' ? 'wss:' : u.protocol === 'http:' ? 'ws:' : u.protocol;
    if (!u.pathname.endsWith('/ws')) u.pathname = u.pathname.replace(/\/$/, '') + '/ws';
    return u.toString();
  }

  start(): void { this.stopped = false; this.plugins.start(); this.connect(); }

  stop(): void {
    this.stopped = true;
    this.plugins.stop();
    this.clearPongTimer();
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const ws = this.ws;
    this.ws = null;
    ws?.close(1000, 'agent stopped');
  }

  private connect(): void {
    if (this.stopped) return;
    this.log('info', `Connecting to ${this.wsUrl}`);
    const ws = new WebSocket(this.wsUrl, {
      headers: { Authorization: `Bearer ${this.opts.token}`, 'X-BRC-Protocol': String(BRC_PROTOCOL_VERSION) },
      handshakeTimeout: 15_000,
    });
    this.ws = ws;

    ws.on('open', () => {
      this.backoff = DEFAULTS.reconnectMinMs;
      this.unauthorizedCount = 0;
      this.send({ type: 'hello', protocol: BRC_PROTOCOL_VERSION, device: this.deviceInfo(), tools: this.opts.tools });
      this.armPongTimer();
      this.log('info', 'Connected, hello sent');
      try { this.opts.onConnected?.(); } catch { /* listener errors must not break the socket */ }
    });

    ws.on('message', (data) => void this.onMessage(data as Buffer));

    ws.on('unexpected-response', (_req, res) => {
      if (res.statusCode === 401 || res.statusCode === 403) this.lastUnauthorized = true;
      this.log('error', `Relay refused connection: HTTP ${res.statusCode}`);
      ws.terminate();
    });

    ws.on('close', (code, reason) => {
      if (this.ws !== ws) return; // stale socket (replaced or stopped)
      this.clearPongTimer();
      this.ws = null;
      if (this.stopped) return;
      if (code === 4401 || code === 4403 || this.lastUnauthorized) {
        this.lastUnauthorized = false;
        void this.handleUnauthorized(code);
        return;
      }
      this.log('warn', `Disconnected (${code} ${reason?.toString() || ''}); retry in ${this.backoff} ms`);
      this.scheduleConnect(this.backoff);
      this.backoff = Math.min(this.backoff * 2, DEFAULTS.reconnectMaxMs);
    });

    ws.on('error', (err) => this.log('error', `Socket error: ${err.message}`));
  }

  private async handleUnauthorized(code: number): Promise<void> {
    this.unauthorizedCount++;
    if (this.opts.onUnauthorized && this.unauthorizedCount <= 1) {
      this.stopped = true;
      const handled = await this.opts.onUnauthorized().catch((e) => { this.log('error', `re-pair failed: ${e instanceof Error ? e.message : String(e)}`); return false; });
      if (handled) { this.plugins.stop(); return; }
      this.stopped = false;
    }
    const wait = Math.min(DEFAULTS.reconnectMaxMs, 10_000 * this.unauthorizedCount);
    this.log('error', `Unauthorized (code ${code}); retry in ${wait} ms`);
    this.scheduleConnect(wait);
  }

  private scheduleConnect(delay: number): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connect(); }, delay);
  }

  private async onMessage(raw: Buffer): Promise<void> {
    const msg = parseMessage<RelayMessage>(raw);
    if (!msg) return this.log('warn', 'Dropped malformed frame');
    switch (msg.type) {
      case 'welcome':
        this.log('info', `Relay ${msg.relayVersion} (protocol ${msg.protocol})`);
        this.plugins.sendStatus();
        return;
      case 'ping':
        this.armPongTimer();
        this.send({ type: 'pong', ts: msg.ts });
        return;
      case 'call':
        return this.handleCall(msg);
      case 'plugin_admin':
        return this.plugins.handle(msg);
      case 'error':
        this.log('error', `Relay error ${msg.code}: ${msg.message}`);
        if (msg.fatal) this.stop();
        return;
    }
  }

  private async handleCall(msg: CallMessage): Promise<void> {
    this.log('debug', `call ${msg.id} ${msg.tool}`);
    try {
      const result = await withCallContext({ id: msg.id, client: msg.client ?? null, remote: true }, () => this.opts.callTool(msg.tool, msg.args ?? {}));
      this.send({ type: 'result', id: msg.id, result: result as never });
    } catch (err) {
      this.send({ type: 'result', id: msg.id, result: failure(err, msg.id) });
    }
  }

  private send(msg: AgentMessage): void {
    const ws = this.ws;
    if (ws?.readyState !== WebSocket.OPEN) return;
    try {
      const frame = boundedAgentFrame(msg);
      if (frame.replaced) this.log('warn', 'Oversized/unencodable result replaced with a bounded error');
      ws.send(frame.encoded);
    } catch (e) {
      this.log('warn', `Could not send frame: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private deviceInfo(): DeviceInfo {
    return {
      deviceId: this.opts.deviceId, name: this.opts.name, platform: process.platform, arch: process.arch,
      hostname: os.hostname(), agentVersion: this.opts.agentVersion, coreVersion: this.opts.coreVersion,
    };
  }

  private armPongTimer(): void {
    this.clearPongTimer();
    this.pongTimer = setTimeout(() => {
      this.log('warn', 'No ping from relay; forcing reconnect');
      this.ws?.terminate();
    }, DEFAULTS.pongTimeoutMs);
  }

  private clearPongTimer(): void {
    if (this.pongTimer) clearTimeout(this.pongTimer);
    this.pongTimer = null;
  }
}
