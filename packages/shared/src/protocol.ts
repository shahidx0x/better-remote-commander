/**
 * SES-RDP agent <-> relay wire protocol (WebSocket, one JSON object per frame).
 * Agent connects outbound to `wss://<relay>/ws` with `Authorization: Bearer <device token>`.
 */
export const SES_RDP_PROTOCOL_VERSION = 1;

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

export type AgentMessage = HelloMessage | ResultMessage | PongMessage;

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

export type RelayMessage = WelcomeMessage | CallMessage | PingMessage | ErrorMessage;

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
