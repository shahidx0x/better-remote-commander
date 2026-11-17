/**
 * BRC agent <-> relay wire protocol (WebSocket, one JSON object per frame).
 * Agent connects outbound to `wss://<relay>/ws` with `Authorization: Bearer <device token>`.
 */
export const BRC_PROTOCOL_VERSION = 1;

import type { PluginAdminAction, PluginDefinition, PluginStatusSummary } from './plugins.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: unknown;
  annotations?: Record<string, unknown>;
}

export interface DeviceInfo {
  deviceId: string;
  name: string;
  platform: string;
  arch: string;
  hostname: string;
  agentVersion: string;
  coreVersion: string;
}

/** MCP-compatible tool result content block (subset we relay). */
export interface ContentBlock {
  type: 'text' | 'image' | 'resource';
  text?: string;
  data?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

/* ---------- agent -> relay ---------- */
export interface HelloMessage {
  type: 'hello';
  protocol: number;
  device: DeviceInfo;
  tools: ToolDefinition[];
}

export interface ResultMessage {
  type: 'result';
  id: string;
  result?: ToolResult;
  error?: { code: string; message: string };
}

export interface PongMessage { type: 'pong'; ts: number }

/**
 * Plugin status report (agent -> relay). Sent after `welcome` and whenever plugin state changes
 * (debounced). Old agents never send it; the relay then treats the device as "no plugin support".
 */
export interface PluginsMessage { type: 'plugins'; plugins: PluginStatusSummary[] }

/** Outcome of one `plugin_admin` request (agent -> relay). */
export interface PluginAdminResultMessage {
  type: 'plugin_admin_result';
  id: string;
  ok: boolean;
  error?: string;
  plugin?: PluginStatusSummary;
}

export type AgentMessage = HelloMessage | ResultMessage | PongMessage | PluginsMessage | PluginAdminResultMessage;

/* ---------- relay -> agent ---------- */
export interface WelcomeMessage {
  type: 'welcome';
  protocol: number;
  relayVersion: string;
  serverTime: number;
}

export interface CallMessage {
  type: 'call';
  id: string;
  tool: string;
  args: Record<string, unknown>;
  client?: { name?: string; version?: string };
  timeoutMs?: number;
}

export interface PingMessage { type: 'ping'; ts: number }

export interface ErrorMessage {
  type: 'error';
  code: string;
  message: string;
  fatal?: boolean;
}

/**
 * Owner-initiated plugin management (relay -> agent). Only sent from authenticated /admin actions
 * (never directly by an AI client). `id` is the request id echoed in `plugin_admin_result`.
 *   install  - define (or replace) `plugin` and install it; `env` = initial environment (secrets)
 *   enable / disable / remove - act on `pluginId`
 *   set_env  - merge `env` into the plugin's environment and drop `unsetEnv` keys
 *   refresh  - re-send the `plugins` report; with `pluginId`, also re-read that plugin's tool list
 */
export interface PluginAdminMessage {
  type: 'plugin_admin';
  id: string;
  action: PluginAdminAction;
  pluginId?: string;
  plugin?: PluginDefinition;
  env?: Record<string, string>;
  unsetEnv?: string[];
}

export type RelayMessage = WelcomeMessage | CallMessage | PingMessage | ErrorMessage | PluginAdminMessage;

export const DEFAULTS = {
  pingIntervalMs: 20_000,
  pongTimeoutMs: 45_000,
  callTimeoutMs: 120_000,
  reconnectMinMs: 1_000,
  reconnectMaxMs: 30_000,
} as const;

export function parseMessage<T>(raw: string | Buffer): T | null {
  try {
    const obj = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
    return obj && typeof obj.type === 'string' ? (obj as T) : null;
  } catch {
    return null;
  }
}
