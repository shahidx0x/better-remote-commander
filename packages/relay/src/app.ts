/**
 * SES-RDP relay HTTP server (Express; MCP SDK's auth router is Express-native).
 * Routes:
 *   GET  /                      home / device list (cookie session)
 *   GET  /health
 *   .well-known/*, /authorize, /token, /register, /revoke  (mcpAuthRouter)
 *   GET|POST /auth/login, POST /auth/consent, GET /auth/logout
 *   POST /device/start, POST /device/poll, GET|POST /device/verify, POST /device/approve
 *   ALL  /mcp                   Streamable HTTP (bearer, stateless per request)
 *   WS   /ws                    agent socket (device token)
 */
import express, { type Request, type Response, type NextFunction } from 'express';
import cookieParser from 'cookie-parser';
import { createServer, type Server as HttpServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { DeviceHub } from './device-hub.js';
import { SqliteStore, verifyPassword } from './store/sqlite.js';
import { RelayOAuthProvider, SCOPES } from './auth/provider.js';
import { Sessions } from './auth/sessions.js';
import { pkceCompat } from './auth/pkce-compat.js';
import { createMcpServer } from './mcp/server.js';
import * as pages from './pages/html.js';
import { restRouter } from './api/rest.js';

export interface RelayConfig {
  port: number;
  host: string;
  publicUrl: string;
  trustProxy: boolean;
  dbFile: string;
  sessionSecret: string;
  adminUser: string;
  adminPassword: string;
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
    dbFile: env.SES_RDP_DB ?? 'data/relay.sqlite',
    sessionSecret: env.SES_RDP_SESSION_SECRET ?? '',
    adminUser: env.SES_RDP_ADMIN_USER ?? 'admin',
    adminPassword: env.SES_RDP_ADMIN_PASSWORD ?? '',
    relayVersion: '0.3.0',
  };
}

const DEVICE_CODE_TTL_MS = 15 * 60_000;
const DEVICE_POLL_INTERVAL_S = 5;

export interface Relay { http: HttpServer; hub: DeviceHub; store: SqliteStore; close(): Promise<void> }

export function buildRelay(cfg: RelayConfig, log: (level: string, msg: string) => void): Relay {
  const store = new SqliteStore(cfg.dbFile);
  const admin = store.upsertUser(cfg.adminUser, cfg.adminPassword);
  const sessions = new Sessions(cfg.sessionSecret, cfg.publicUrl.startsWith('https://'));
  const hub = new DeviceHub(cfg.relayVersion, log);
  hub.onHello = (device, tools) => store.saveDeviceTools(device.deviceId, tools);
  const publicUrl = new URL(cfg.publicUrl);

  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false }));

  const currentUser = (req: Request) => sessions.userId(req);

  /* ---------- OAuth ---------- */
  const provider = new RelayOAuthProvider({
    store,
    currentUserId: (res) => sessions.userId(res.req),
    renderLogin: (res, returnTo) => res.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    renderConsent: (res, pendingId, client, scopes) =>
      res.type('html').send(pages.consentPage(pendingId, client.client_name ?? client.client_id, client.redirect_uris?.[0] ?? '', scopes)),
  });

  app.use(pkceCompat(store));
  app.use(mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    resourceServerUrl: new URL('/mcp', publicUrl),
    scopesSupported: SCOPES,
    resourceName: 'SES-RDP',
    clientRegistrationOptions: { clientSecretExpirySeconds: undefined },
  }));

  // Consent page re-entry after login (provider.authorize parked the request under `pending`).
  app.get('/auth/consent', (req, res) => {
    const pendingId = String(req.query.pending ?? '');
    const p = provider.pending.get(pendingId);
    if (!p) return res.status(400).type('html').send(pages.messagePage('Expired', 'This authorization request has expired. Retry from your AI client.', false));
    if (!currentUser(req)) return res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);
    res.type('html').send(pages.consentPage(pendingId, p.client.client_name ?? p.client.client_id, p.params.redirectUri, p.params.scopes ?? SCOPES));
  });

  app.post('/auth/consent', (req, res) => {
    const userId = currentUser(req);
    if (!userId) return res.status(401).type('html').send(pages.messagePage('Not signed in', 'Sign in first.', false));
    const pendingId = String(req.body.pending ?? '');
    if (req.body.decision !== 'allow') {
      const url = provider.denyCode(pendingId);
      return url ? res.redirect(url) : res.type('html').send(pages.messagePage('Denied', 'Authorization denied.', false));
    }
    try { res.redirect(provider.issueCode(pendingId, userId)); }
    catch { res.status(400).type('html').send(pages.messagePage('Expired', 'This authorization request has expired. Retry from your AI client.', false)); }
  });

  /* ---------- login / logout / home ---------- */
  const safeReturn = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

  app.get('/auth/login', (req, res) => res.type('html').send(pages.loginPage(safeReturn(req.query.returnTo))));
  app.post('/auth/login', (req, res) => {
    const { username, password, returnTo } = req.body as Record<string, string>;
    const user = store.getUserByName(String(username ?? ''));
    if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
      log('warn', `login failed for "${username}" from ${req.ip}`);
      return res.status(401).type('html').send(pages.loginPage(safeReturn(returnTo), 'Invalid username or password.'));
    }
    sessions.issue(res, user.id);
    res.redirect(safeReturn(returnTo));
  });
  app.get('/auth/logout', (_req, res) => { sessions.clear(res); res.redirect('/'); });

  app.get('/', (req, res) => {
    const userId = currentUser(req);
    const online = new Set(hub.list(userId ?? undefined).map((d) => d.deviceId));
    const devices = userId ? store.listDevices(userId).map((d) => ({ ...d, online: online.has(d.device_id) })) : [];
    res.type('html').send(pages.homePage(cfg.publicUrl, !!userId, devices));
  });

  app.get('/health', (_req, res) => res.json({ ok: true, version: cfg.relayVersion, devices: hub.list().length, publicUrl: cfg.publicUrl }));

  /* ---------- device pairing (OAuth device-authorization style) ---------- */
  app.post('/device/start', express.json(), (req, res) => {
    const clientName = String((req.body as Record<string, unknown>)?.client_name ?? 'ses-rdp-agent').slice(0, 80);
    const row = store.createDeviceCode(clientName, DEVICE_CODE_TTL_MS);
    res.json({
      device_code: row.device_code, user_code: row.user_code,
      verification_uri: `${cfg.publicUrl}/device/verify`,
      verification_uri_complete: `${cfg.publicUrl}/device/verify?user_code=${row.user_code}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S,
    });
  });

  app.post('/device/poll', express.json(), (req, res) => {
    const { device_code, device_id, name, platform } = (req.body ?? {}) as Record<string, string | undefined>;
    const row = device_code ? store.getDeviceCode(device_code) : undefined;
    if (!row) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown device_code' });
    if (row.expires_at < Date.now()) { store.deleteDeviceCode(row.device_code); return res.status(400).json({ error: 'expired_token' }); }
    if (row.denied) { store.deleteDeviceCode(row.device_code); return res.status(400).json({ error: 'access_denied' }); }
    if (!row.approved || !row.user_id) return res.status(400).json({ error: 'authorization_pending', interval: DEVICE_POLL_INTERVAL_S });
    const deviceId = device_id || row.device_id || `dev_${row.user_code.replace('-', '').toLowerCase()}`;
    const token = store.issueDeviceToken(deviceId, row.user_id, name || row.client_name, platform ?? null);
    store.deleteDeviceCode(row.device_code);
    log('info', `device paired: ${name || row.client_name} [${deviceId}] for user ${row.user_id}`);
    res.json({ device_token: token, device_id: deviceId, token_type: 'bearer', ws_url: cfg.publicUrl.replace(/^http/, 'ws') + '/ws' });
  });

  const requireLogin = (req: Request, res: Response, next: NextFunction) =>
    currentUser(req) ? next() : res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);

  app.get('/device/verify', requireLogin, (req, res) => res.type('html').send(pages.deviceVerifyPage(String(req.query.user_code ?? ''))));
  app.post('/device/verify', requireLogin, (req, res) => {
    const row = store.getDeviceCodeByUserCode(String(req.body.user_code ?? ''));
    if (!row || row.expires_at < Date.now()) return res.status(404).type('html').send(pages.deviceVerifyPage('', 'Code not found or expired.'));
    res.type('html').send(pages.deviceApprovePage(row.user_code, row.client_name));
  });
  app.post('/device/approve', requireLogin, (req, res) => {
    const userId = currentUser(req)!;
    const row = store.getDeviceCodeByUserCode(String(req.body.user_code ?? ''));
    if (!row || row.expires_at < Date.now()) return res.status(404).type('html').send(pages.messagePage('Not found', 'Code not found or expired.', false));
    if (req.body.decision !== 'allow') { store.denyDeviceCode(row.device_code); return res.type('html').send(pages.messagePage('Denied', 'Device pairing denied.', false)); }
    store.approveDeviceCode(row.device_code, userId, row.device_id ?? '');
    res.type('html').send(pages.messagePage('Device approved', `${row.client_name} can now connect. The agent will finish pairing automatically.`));
  });


  /* ---------- OAuth client management (for GPT Actions etc.) ---------- */
  const clientRows = () => store.listClients().map((c) => {
    const m = JSON.parse(c.metadata) as { client_name?: string; redirect_uris?: string[] };
    return { client_id: c.client_id, name: m.client_name ?? c.client_id, redirect_uris: m.redirect_uris ?? [], hasSecret: !!c.client_secret, created_at: c.created_at };
  });
  app.get('/auth/clients', requireLogin, (_req, res) => res.type('html').send(pages.clientsPage(clientRows())));
  app.post('/auth/clients', requireLogin, (req, res) => {
    const name = String(req.body.name ?? '').trim().slice(0, 80) || 'client';
    const uris = String(req.body.redirect_uris ?? '').split(/\r?\n/).map((s) => s.trim()).filter((s) => /^https?:\/\//.test(s));
    const created = provider.clientsStore.registerClient({
      client_name: name, redirect_uris: uris, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      token_endpoint_auth_method: 'client_secret_post', scope: SCOPES.join(' '),
    });
    log('info', `oauth client created: ${name} [${created.client_id}]`);
    res.type('html').send(pages.clientsPage(clientRows(), { client_id: created.client_id, client_secret: created.client_secret ?? '' }));
  });
  app.post('/auth/clients/delete', requireLogin, (req, res) => {
    store.deleteClient(String(req.body.client_id ?? ''));
    res.redirect('/auth/clients');
  });

  /* ---------- MCP endpoint (stateless: new server + transport per request) ---------- */
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: SCOPES, resourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp` });

  app.all('/mcp', bearer, express.json({ limit: '32mb' }), async (req, res) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth!;
    const userId = String(auth.extra?.userId ?? '');
    if (!userId) return res.status(401).json({ error: 'invalid_token' });
    const server = createMcpServer(hub, store, { userId, clientId: auth.clientId }, cfg.relayVersion);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      log('error', `mcp request failed: ${err instanceof Error ? err.message : String(err)}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  });

  /* ---------- REST + OpenAPI (GPT Actions) ---------- */
  app.use(restRouter({ hub, store, bearer, publicUrl: cfg.publicUrl, relayVersion: cfg.relayVersion, adminUserId: admin.id }));

  /* ---------- agent WebSocket (device token) ---------- */
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url ?? '/', cfg.publicUrl);
    if (url.pathname !== '/ws') return socket.destroy();
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token');
    const dev = token ? store.getDeviceByToken(token) : undefined;
    if (!dev) { log('warn', `agent auth failed from ${req.socket.remoteAddress}`); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.attach(ws, dev.user_id, dev.device_id);
      store.touchDevice(dev.device_id);
    });
  });

  const housekeeping = setInterval(() => store.vacuumExpired(), 10 * 60_000);
  housekeeping.unref();

  log('info', `admin user "${admin.username}" ready; db ${cfg.dbFile}`);

  return {
    http, hub, store,
    close: async () => { clearInterval(housekeeping); hub.close(); wss.close(); await new Promise<void>((r) => http.close(() => r())); store.close(); },
  };
}
