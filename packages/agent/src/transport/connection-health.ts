/**
 * Local-only, bounded transport diagnostics.
 * ChatGPT's model/SSE stream is NOT visible here. This records only the
 * local agent <-> relay WebSocket, so long-session failures can be attributed.
 * No URL, token, tool arguments, results or file contents are retained.
 */
export type ConnectionEvent = {
  at: number;
  type: 'connecting' | 'connected' | 'disconnected' | 'socket_error'
    | 'heartbeat_missed' | 'relay_error' | 'result_dropped' | 'send_backpressure';
  code?: string;
  inFlight?: number;
};

const MAX_RECENT_EVENTS = 32;
const cleanCode = (value: unknown): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return String(value).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
};

export class ConnectionHealth {
  private readonly startedAt = Date.now();
  private events: ConnectionEvent[] = [];
  private attempts = 0;
  private connectedAt: number | null = null;
  private lastPingAt: number | null = null;
  private disconnectedAt: number | null = null;
  private lastDisconnectCode: string | null = null;
  private missedHeartbeats = 0;
  private errors = 0;
  private droppedResults = 0;
  private pingsReceived = 0;

  record(type: ConnectionEvent['type'], code?: unknown, inFlight?: number): void {
    const at = Date.now();
    if (type === 'connecting') this.attempts++;
    if (type === 'connected') this.connectedAt = at;
    if (type === 'disconnected') {
      this.disconnectedAt = at;
      this.lastDisconnectCode = cleanCode(code) ?? 'UNKNOWN';
    }
    if (type === 'heartbeat_missed') this.missedHeartbeats++;
    if (type === 'socket_error' || type === 'relay_error') this.errors++;
    if (type === 'result_dropped' || type === 'send_backpressure') this.droppedResults++;
    this.events.push({
      at, type,
      ...(cleanCode(code) ? { code: cleanCode(code) } : {}),
      ...(typeof inFlight === 'number' ? { inFlight: Math.max(0, inFlight) } : {}),
    });
    if (this.events.length > MAX_RECENT_EVENTS)
      this.events.splice(0, this.events.length - MAX_RECENT_EVENTS);
  }

  ping(): void {
    this.lastPingAt = Date.now();
    this.pingsReceived++;
  }

  snapshot(): {
    agentUptimeMs: number; connectionAttempts: number; reconnects: number;
    connectedAt: number | null; lastHeartbeatAt: number | null;
    heartbeatAgeMs: number | null; lastDisconnectedAt: number | null;
    lastDisconnectCode: string | null; missedHeartbeats: number;
    socketErrors: number; droppedToolResults: number; pingsReceived: number;
    recentEvents: ConnectionEvent[]; persistent: false;
  } {
    return {
      agentUptimeMs: Math.max(0, Date.now() - this.startedAt),
      connectionAttempts: this.attempts,
      reconnects: Math.max(0, this.attempts - 1),
      connectedAt: this.connectedAt,
      lastHeartbeatAt: this.lastPingAt,
      heartbeatAgeMs: this.lastPingAt === null ? null : Math.max(0, Date.now() - this.lastPingAt),
      lastDisconnectedAt: this.disconnectedAt,
      lastDisconnectCode: this.lastDisconnectCode,
      missedHeartbeats: this.missedHeartbeats,
      socketErrors: this.errors,
      droppedToolResults: this.droppedResults,
      pingsReceived: this.pingsReceived,
      recentEvents: this.events.slice(-12),
      persistent: false,
    };
  }
}

export const connectionHealth = new ConnectionHealth();
