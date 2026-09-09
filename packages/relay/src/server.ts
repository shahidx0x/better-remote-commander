/**
 * SES-RDP relay HTTP/WS server (Phase 1).
 * Routes: GET /health, GET /ws (agent socket), GET /debug/devices, POST /debug/call
 * Auth (Phase 1): static tokens from env. SES_RDP_DEVICE_TOKEN for agents, SES_RDP_ADMIN_TOKEN for /debug.
 */
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import websocket from '@fastify/websocket';
import { DeviceHub } from './device-hub.js';

export interface RelayConfig {
  port: number;
  host: string;
  publicUrl: string;
  trustProxy: boolean;
  deviceToken: string;
  adminToken: string;
  relayVersion: string;
}

export function loadConfig(): RelayConfig {
  const env = process.env;
  const port = Number(env.PORT ?? 3000);
  return {
    port,
    host: env.HOST ?? '0.0.0.0',
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
    trustProxy: env.TRUST_PROXY === 'true' || env.TRUST_PROXY === '1',
    deviceToken: env.SES_RDP_DEVICE_TOKEN ?? '',
    adminToken: env.SES_RDP_ADMIN_TOKEN ?? '',
    relayVersion: '0.1.0',
  };
}

function bearer(req: FastifyRequest): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
}

export async function buildServer(cfg: RelayConfig): Promise<{ app: FastifyInstance; hub: DeviceHub }> {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' }, trustProxy: cfg.trustProxy });
  const log = (l: string, m: string) => (app.log as any)[l === 'warn' ? 'warn' : l === 'error' ? 'error' : 'info'](m);
  const hub = new DeviceHub(cfg.relayVersion, log);

  await app.register(websocket, { options: { maxPayload: 64 * 1024 * 1024 } });

  app.get('/health', async () => ({ ok: true, version: cfg.relayVersion, devices: hub.list().length, publicUrl: cfg.publicUrl }));

  // Agent socket. Phase 1: single shared device token; owner is the fixed "local" user.
  app.get('/ws', { websocket: true }, (socket, req) => {
    const token = bearer(req) ?? (req.query as Record<string, string | undefined>).token ?? null;
    if (!cfg.deviceToken || token !== cfg.deviceToken) {
      app.log.warn({ ip: req.ip }, 'agent auth failed');
      socket.close(4401, 'unauthorized');
      return;
    }
    hub.attach(socket, 'local');
  });

  // Debug/admin routes (Phase 1 only; replaced by MCP/REST + OAuth in Phase 2).
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/debug/')) return;
    if (!cfg.adminToken || bearer(req) !== cfg.adminToken) return reply.code(401).send({ error: 'unauthorized' });
  });

  app.get('/debug/devices', async () => ({ devices: hub.list() }));

  app.get('/debug/tools', async (req, reply) => {
    const { deviceId } = req.query as { deviceId?: string };
    const id = deviceId ?? hub.resolveDefault();
    const dev = id ? hub.get(id) : undefined;
    if (!dev) return reply.code(404).send({ error: 'device not found or ambiguous; pass ?deviceId=' });
    return { deviceId: id, tools: dev.tools.map((t) => ({ name: t.name, description: t.description.trim().split('\n')[0] })) };
  });

  app.post('/debug/call', async (req, reply) => {
    const body = (req.body ?? {}) as { deviceId?: string; tool?: string; args?: Record<string, unknown>; timeoutMs?: number };
    if (!body.tool) return reply.code(400).send({ error: 'tool required' });
    const id = body.deviceId ?? hub.resolveDefault();
    if (!id) return reply.code(404).send({ error: 'no device online or ambiguous; pass deviceId' });
    const started = Date.now();
    try {
      const result = await hub.call(id, body.tool, body.args ?? {}, { client: { name: 'debug', version: cfg.relayVersion }, timeoutMs: body.timeoutMs });
      return { deviceId: id, tool: body.tool, ms: Date.now() - started, result };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const code = message.startsWith('DEVICE_OFFLINE') ? 404 : message.startsWith('CALL_TIMEOUT') ? 504 : 500;
      return reply.code(code).send({ error: message });
    }
  });

  app.addHook('onClose', async () => hub.close());
  return { app, hub };
}
