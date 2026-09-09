/**
 * REST + OpenAPI door for ChatGPT Custom GPT Actions (and any plain HTTP client).
 *   GET  /openapi.json           public; generated from cached tool definitions (30-op GPT limit respected)
 *   GET  /api/devices            bearer
 *   GET  /api/tools              bearer; live tool list
 *   POST /api/tools/{tool}       bearer; body = tool args (+ optional deviceId)
 * GPT Actions constraints handled: ~45 s timeout (calls capped at 40 s), ~100 KB response (text truncated with a note).
 */
import { Router, json, type Request, type RequestHandler } from 'express';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { DeviceHub } from '../device-hub.js';
import type { SqliteStore } from '../store/sqlite.js';
import { invokeTool, listUserDevices } from '../mcp/invoke.js';
import { liveTools, withDeviceId, LIST_DEVICES_TOOL } from '../mcp/server.js';

const REST_TIMEOUT_MS = 40_000;
const MAX_TEXT_BYTES = 90_000;
const GPT_MAX_OPERATIONS = 30;

function clip(text: string): string {
  if (Buffer.byteLength(text) <= MAX_TEXT_BYTES) return text;
  let cut = text.slice(0, MAX_TEXT_BYTES);
  while (Buffer.byteLength(cut) > MAX_TEXT_BYTES) cut = cut.slice(0, -1000);
  return `${cut}\n\n[truncated by relay: response exceeded ${MAX_TEXT_BYTES} bytes; use offset/length or pagination]`;
}

export function buildOpenApi(publicUrl: string, tools: { name: string; description: string; inputSchema: unknown }[], relayVersion: string) {
  const paths: Record<string, unknown> = {
    '/api/devices': { get: { operationId: 'list_devices', summary: LIST_DEVICES_TOOL.description, responses: { '200': { description: 'Devices', content: { 'application/json': { schema: { type: 'object' } } } } } } },
  };
  for (const t of tools.slice(0, GPT_MAX_OPERATIONS - 1)) {
    paths[`/api/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: t.description.trim().split('\n')[0].slice(0, 120),
        description: t.description.trim().slice(0, 2000),
        requestBody: { required: true, content: { 'application/json': { schema: withDeviceId(t.inputSchema) } } },
        responses: { '200': { description: 'Tool result', content: { 'application/json': { schema: { type: 'object', properties: { ok: { type: 'boolean' }, device: { type: 'string' }, text: { type: 'string' }, isError: { type: 'boolean' } } } } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SES-RDP', version: relayVersion, description: 'Files, terminal and processes on your paired devices via the SES-RDP relay.' },
    servers: [{ url: publicUrl }],
    paths,
    components: { securitySchemes: { oauth2: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: `${publicUrl}/authorize`, tokenUrl: `${publicUrl}/token`, refreshUrl: `${publicUrl}/token`, scopes: { 'mcp:tools': 'Run tools on paired devices' } } } } } },
    security: [{ oauth2: ['mcp:tools'] }],
  };
}

export interface RestDeps { hub: DeviceHub; store: SqliteStore; bearer: RequestHandler; publicUrl: string; relayVersion: string; adminUserId: string }

export function restRouter(d: RestDeps): Router {
  const r = Router();
  const ctxOf = (req: Request) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth!;
    return { userId: String(auth.extra?.userId ?? ''), clientId: auth.clientId };
  };

  // Public spec. Single-user v1: built from the admin's cached tools so it works even with all devices offline.
  r.get('/openapi.json', (_req, res) => {
    const cached = d.store.cachedTools(d.adminUserId);
    res.json(buildOpenApi(d.publicUrl, cached, d.relayVersion));
  });

  r.get('/api/devices', d.bearer, (req, res) => {
    res.json({ devices: listUserDevices(d.hub, d.store, ctxOf(req).userId) });
  });

  r.get('/api/tools', d.bearer, (req, res) => {
    const { online, tools } = liveTools(d.hub, d.store, ctxOf(req).userId);
    res.json({ online, tools: tools.map((t) => ({ name: t.name, summary: t.description.trim().split('\n')[0], inputSchema: t.inputSchema })) });
  });

  r.post('/api/tools/:tool', d.bearer, json({ limit: '8mb' }), async (req, res) => {
    const tool = String(req.params.tool);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const out = await invokeTool(d.hub, d.store, ctxOf(req), tool, body, { timeoutMs: REST_TIMEOUT_MS });
    if (!out.ok) return res.status(out.status).json({ ok: false, error: out.message });
    const text = out.result.content.filter((c) => c.type === 'text').map((c) => c.text ?? '').join('\n');
    const images = out.result.content.filter((c) => c.type === 'image').length;
    res.json({ ok: !out.result.isError, isError: !!out.result.isError, device: out.deviceName, deviceId: out.deviceId, ms: out.ms, text: clip(text), ...(images ? { note: `${images} image block(s) omitted from REST response` } : {}) });
  });

  return r;
}
