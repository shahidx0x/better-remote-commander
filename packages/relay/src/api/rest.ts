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

/** GPT Actions limits: description <= 300 chars, every object schema needs `properties`, components.schemas must exist. */
const GPT_DESC_MAX = 300;
function shortDesc(desc: string): string {
  const paras = desc.trim().split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  let out = '';
  for (const p of paras) { if ((out + ' ' + p).trim().length > GPT_DESC_MAX) break; out = (out + ' ' + p).trim(); }
  if (!out) out = paras[0] ?? '';
  return out.length > GPT_DESC_MAX ? out.slice(0, GPT_DESC_MAX - 1).replace(/\s+\S*$/, '') + '…' : out;
}
const RESULT_SCHEMA = { type: 'object', properties: { ok: { type: 'boolean' }, isError: { type: 'boolean' }, device: { type: 'string' }, deviceId: { type: 'string' }, ms: { type: 'integer' }, text: { type: 'string', description: 'Tool output (clipped to 90 KB)' }, note: { type: 'string' }, error: { type: 'string' } } };
const DEVICES_SCHEMA = { type: 'object', properties: { devices: { type: 'array', items: { type: 'object', properties: { deviceId: { type: 'string' }, name: { type: 'string' }, platform: { type: 'string' }, online: { type: 'boolean' }, paused: { type: 'boolean' }, lastSeen: { type: 'integer' } } } } } };

/** Deep-clean a JSON schema for the GPT Actions validator: object nodes get `properties`, $schema dropped, descriptions capped. */
function gptSafe(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(gptSafe);
  if (!node || typeof node !== 'object') return node;
  const s = { ...(node as Record<string, unknown>) };
  delete s.$schema;
  if (typeof s.description === 'string' && s.description.length > GPT_DESC_MAX) s.description = shortDesc(s.description);
  if (s.type === 'object' && !s.properties) s.properties = {};
  if (s.additionalProperties && typeof s.additionalProperties === 'object' && Object.keys(s.additionalProperties as object).length === 0) s.additionalProperties = true;
  for (const k of ['properties', 'items', 'anyOf', 'oneOf', 'allOf', 'additionalProperties']) if (k in s && typeof s[k] === 'object') s[k] = k === 'properties' ? Object.fromEntries(Object.entries(s[k] as Record<string, unknown>).map(([n, v]) => [n, gptSafe(v)])) : gptSafe(s[k]);
  return s;
}

export function buildOpenApi(publicUrl: string, tools: { name: string; description: string; inputSchema: unknown }[], relayVersion: string) {
  const paths: Record<string, unknown> = {
    '/api/devices': { get: { operationId: 'list_devices', summary: 'List paired devices', description: shortDesc(LIST_DEVICES_TOOL.description), responses: { '200': { description: 'Devices', content: { 'application/json': { schema: DEVICES_SCHEMA } } } } } },
  };
  for (const t of tools.slice(0, GPT_MAX_OPERATIONS - 1)) {
    const d = shortDesc(t.description);
    paths[`/api/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: d.split('. ')[0].slice(0, 120),
        description: d,
        requestBody: { required: true, content: { 'application/json': { schema: gptSafe(withDeviceId(t.inputSchema)) } } },
        responses: { '200': { description: 'Tool result', content: { 'application/json': { schema: RESULT_SCHEMA } } } },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: { title: 'SES-RDP', version: relayVersion, description: 'Files, terminal and processes on your paired devices via the SES-RDP relay.' },
    servers: [{ url: publicUrl }],
    paths,
    components: { schemas: { ToolResult: RESULT_SCHEMA, Devices: DEVICES_SCHEMA }, securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key from /auth/apikeys' }, oauth2: { type: 'oauth2', flows: { authorizationCode: { authorizationUrl: `${publicUrl}/authorize`, tokenUrl: `${publicUrl}/token`, refreshUrl: `${publicUrl}/token`, scopes: { 'mcp:tools': 'Run tools on paired devices' } } } } } },
    security: [{ bearerAuth: [] }, { oauth2: ['mcp:tools'] }],
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
  // GPT Actions accept exactly one security scheme: ?auth=bearer (default, API key) or ?auth=oauth.
  r.get('/openapi.json', (req, res) => {
    const cached = d.store.cachedTools(d.adminUserId);
    const mode = String(req.query.auth ?? 'bearer') === 'oauth' ? 'oauth' : 'bearer';
    const spec = buildOpenApi(d.publicUrl, cached, d.relayVersion) as { components: { securitySchemes: Record<string, unknown> }; security: unknown[] };
    if (mode === 'bearer') { spec.components.securitySchemes = { bearerAuth: spec.components.securitySchemes.bearerAuth }; spec.security = [{ bearerAuth: [] }]; }
    else { spec.components.securitySchemes = { oauth2: spec.components.securitySchemes.oauth2 }; spec.security = [{ oauth2: ['mcp:tools'] }]; }
    res.json(spec);
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
