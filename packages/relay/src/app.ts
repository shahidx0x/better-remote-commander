/**
 * BRC relay HTTP server (Express; MCP SDK's auth router is Express-native).
 * Routes:
 *   GET  /                      home / device list (cookie session)
 *   GET  /health
 *   .well-known/*, /authorize, /token, /register, /revoke  (mcpAuthRouter)
 *   GET|POST /auth/login, POST /auth/consent, GET /auth/logout
 *   POST /device/start, POST /device/poll, GET|POST /device/verify, POST /device/approve
 *   ALL  /mcp                   Streamable HTTP (bearer, stateless per request)
 *   WS   /ws                    agent socket (device token)
 *   GET  /admin, /admin/marketplace, POST /admin/plugins/*  (see plugins/admin-routes.ts)
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
import { MongoStore } from './store/mongo.js';
import type { RelayStore } from './store/types.js';
import { RelayOAuthProvider, SCOPES } from './auth/provider.js';
import { parseAuthorizeRequest, validateClientId, validateRedirectUri, approveCallback } from './auth/client-recovery.js';
import { Sessions } from './auth/sessions.js';
import { createMcpServer } from './mcp/server.js';
import { BUNDLED_AGENT_TOOL_CATALOG } from './mcp/agent-tools.catalog.js';
import * as pages from './pages/html.js';
import * as adminPages from './pages/admin.js';
import { LoginLimiter } from './auth/rate-limit.js';
import { RegistryClient } from './plugins/registry.js';
import { registerPluginRoutes } from './plugins/admin-routes.js';
import { PLUGIN_RELAY_TOOLS } from './mcp/plugin-tools.js';
import { SKILL_RELAY_TOOLS } from './mcp/skill-tools.js';
import { SkillsCatalog } from './features/skills.js';
import { registerSkillsRoutes } from './features/skills-routes.js';
import { validateUsageReport, usageView, type UsagePeriod } from './features/usage.js';
import { dashboardPage } from './pages/dashboard.js';

export interface RelayConfig {
  port: number;
  host: string;
  publicUrl: string;
  trustProxy: boolean;
  dbFile: string;
  mongoUri?: string;
  mongoDb?: string;
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
    dbFile: env.BRC_DB ?? 'data/relay.sqlite',
    mongoUri: env.MONGODB_URI || undefined,
    mongoDb: env.MONGODB_DB || undefined,
    sessionSecret: env.BRC_SESSION_SECRET ?? '',
    adminUser: env.BRC_ADMIN_USER ?? 'admin',
    adminPassword: env.BRC_ADMIN_PASSWORD ?? '',
    relayVersion: '2.0.7',
  };
}

const DEVICE_CODE_TTL_MS = 15 * 60_000;
const DEVICE_POLL_INTERVAL_S = 5;

export interface Relay { http: HttpServer; hub: DeviceHub; store: RelayStore; close(): Promise<void> }

export async function buildRelay(cfg: RelayConfig, log: (level: string, msg: string) => void): Promise<Relay> {
  // MongoDB is the durable primary when selected; never fall back silently to an empty SQLite.
  const store: RelayStore = cfg.mongoUri ? await MongoStore.connect(cfg.mongoUri, cfg.mongoDb) : new SqliteStore(cfg.dbFile);
  let admin;
  try { admin = await store.upsertUser(cfg.adminUser, cfg.adminPassword); }
  catch (error) { await store.close(); throw error; }
  const sessions = new Sessions(cfg.sessionSecret, cfg.publicUrl.startsWith('https://'));
  const hub = new DeviceHub(cfg.relayVersion, log);
  const registry = RegistryClient.fromEnv();
  const skills = new SkillsCatalog();
  const publicUrl = new URL(cfg.publicUrl);

  const app = express();
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  app.use(cookieParser());
  app.use(express.urlencoded({ extended: false, limit: '64kb' }));
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (cfg.publicUrl.startsWith('https://')) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next();
  });

  const currentUser = (req: Request) => sessions.userId(req);

  /* ---------- OAuth ---------- */
  const provider = new RelayOAuthProvider({
    store,
    currentUserId: (res) => sessions.userId(res.req),
    renderLogin: (res, returnTo) => res.redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`),
    renderConsent: (res, pendingId, client, scopes) =>
      res.type('html').send(pages.consentPage(pendingId, client.client_name ?? client.client_id, client.redirect_uris?.[0] ?? '', scopes)),
    issuer: cfg.publicUrl,
  });

  // Publish OAuth metadata explicitly so ChatGPT sees the current MCP OAuth 2.1 contract.
  const oauthMetadata = {
    issuer: cfg.publicUrl,
    authorization_endpoint: `${cfg.publicUrl}/authorize`,
    token_endpoint: `${cfg.publicUrl}/token`,
    registration_endpoint: `${cfg.publicUrl}/register`,
    revocation_endpoint: `${cfg.publicUrl}/revoke`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    scopes_supported: SCOPES,
    authorization_response_iss_parameter_supported: true,
  };
  const protectedResourceMetadata = {
    resource: `${cfg.publicUrl}/mcp`,
    authorization_servers: [cfg.publicUrl],
    scopes_supported: SCOPES,
    resource_name: 'Better Remote Commander (BRC)',
  };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(oauthMetadata));
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json(protectedResourceMetadata));
  app.get('/.well-known/oauth-protected-resource/mcp', (_req, res) => res.json(protectedResourceMetadata));

  // A lost/stale client ID or a newly requested callback gets a useful recovery
  // screen. No registration happens here: only an authenticated admin can approve it.
  // Valid registered clients continue through the SDK's standard exact-match checks.
  app.get('/authorize', async (req, res, next) => {
    let requested;
    try { requested = parseAuthorizeRequest(cfg.publicUrl + req.originalUrl, cfg.publicUrl); }
    catch { return next(); } // Let the OAuth SDK reject malformed requests normally.
    const saved = await store.getClient(requested.clientId);
    let allowed = false;
    if (saved) {
      try {
        const metadata = JSON.parse(saved.metadata) as { redirect_uris?: string[] };
        allowed = Array.isArray(metadata.redirect_uris) && metadata.redirect_uris.includes(requested.redirectUri);
      } catch { /* Invalid saved metadata should not authorize any redirect. */ }
    }
    if (allowed) return next();
    const approve = new URL('/auth/clients', cfg.publicUrl);
    approve.searchParams.set('authorize', requested.authorizeUrl!);
    return res.status(400).type('html').send(
      pages.oauthClientRecoveryPage(requested.clientId, requested.redirectUri, approve.pathname + approve.search, !saved),
    );
  });

  app.use(mcpAuthRouter({
    provider,
    issuerUrl: publicUrl,
    baseUrl: publicUrl,
    resourceServerUrl: new URL('/mcp', publicUrl),
    scopesSupported: SCOPES,
    resourceName: 'Better Remote Commander (BRC)',
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

  app.post('/auth/consent', async (req, res) => {
    const userId = currentUser(req);
    if (!userId) return res.status(401).type('html').send(pages.messagePage('Not signed in', 'Sign in first.', false));
    const pendingId = String(req.body.pending ?? '');
    if (req.body.decision !== 'allow') {
      const url = provider.denyCode(pendingId);
      return url ? res.redirect(url) : res.type('html').send(pages.messagePage('Denied', 'Authorization denied.', false));
    }
    try { res.redirect(await provider.issueCode(pendingId, userId)); }
    catch { res.status(400).type('html').send(pages.messagePage('Expired', 'This authorization request has expired. Retry from your AI client.', false)); }
  });

  /* ---------- login / logout / home ---------- */
  const safeReturn = (v: unknown) => (typeof v === 'string' && v.startsWith('/') && !v.startsWith('//') ? v : '/');

  app.get('/auth/login', (req, res) => {
    const target = safeReturn(req.query.returnTo);
    // A valid browser session is sufficient; do not request the password again.
    // Prevent redirect loops from links accidentally targeting /auth/login.
    if (currentUser(req)) return res.redirect(target === '/' || target.startsWith('/auth/login') ? '/admin' : target);
    res.type('html').send(pages.loginPage(target));
  });
  const limiter = new LoginLimiter();
  app.post('/auth/login', async (req, res) => {
    const { username, password, returnTo } = req.body as Record<string, string>;
    const key = `${req.ip}|${String(username ?? '').toLowerCase()}`;
    const wait = limiter.locked(key);
    if (wait) return res.status(429).type('html').send(pages.loginPage(safeReturn(returnTo), `Too many attempts. Try again in ${wait} s.`));
    const user = await store.getUserByName(String(username ?? ''));
    if (!user || !verifyPassword(String(password ?? ''), user.password_hash)) {
      limiter.fail(key);
      log('warn', `login failed for "${username}" from ${req.ip}`);
      return res.status(401).type('html').send(pages.loginPage(safeReturn(returnTo), 'Invalid username or password.'));
    }
    limiter.ok(key);
    sessions.issue(res, user.id);
    res.redirect(safeReturn(returnTo));
  });
  app.get('/auth/logout', (_req, res) => { sessions.clear(res); res.redirect('/'); });

  app.get('/', async (req, res) => {
    const userId = currentUser(req);
    const online = new Set(hub.list(userId ?? undefined).map((d) => d.deviceId));
    const devices = userId ? (await store.listDevices(userId)).map((d) => ({ ...d, online: online.has(d.device_id) })) : [];
    res.type('html').send(pages.homePage(cfg.publicUrl, !!userId, devices));
  });

  app.get('/health', async (_req, res) => {
    if (store instanceof MongoStore) {
      try { await store.ping(); }
      catch { return res.status(503).json({ ok: false, storage: 'mongodb', error: 'database_unavailable' }); }
    }
    res.json({ ok: true, version: cfg.relayVersion, devices: hub.list().length, publicUrl: cfg.publicUrl,
      mcpTools: BUNDLED_AGENT_TOOL_CATALOG.length + 1 + PLUGIN_RELAY_TOOLS.length + SKILL_RELAY_TOOLS.length, storage: cfg.mongoUri ? 'mongodb' : 'sqlite', relayInstance: hub.instanceId });
  });

  /* ---------- device pairing (OAuth device-authorization style) ---------- */
  app.post('/device/start', express.json({ limit: '4kb' }), async (req, res) => {
    const clientName = String((req.body as Record<string, unknown>)?.client_name ?? 'brc-agent').slice(0, 80);
    const row = await store.createDeviceCode(clientName, DEVICE_CODE_TTL_MS);
    res.json({
      device_code: row.device_code, user_code: row.user_code,
      verification_uri: `${cfg.publicUrl}/device/verify`,
      verification_uri_complete: `${cfg.publicUrl}/device/verify?user_code=${row.user_code}`,
      expires_in: DEVICE_CODE_TTL_MS / 1000, interval: DEVICE_POLL_INTERVAL_S,
    });
  });

  app.post('/device/poll', express.json({ limit: '4kb' }), async (req, res) => {
    const { device_code, device_id, name, platform } = (req.body ?? {}) as Record<string, string | undefined>;
    const row = device_code ? await store.getDeviceCode(device_code) : undefined;
    if (!row) return res.status(400).json({ error: 'invalid_grant', error_description: 'unknown device_code' });
    if (row.expires_at < Date.now()) { await store.deleteDeviceCode(row.device_code); return res.status(400).json({ error: 'expired_token' }); }
    if (row.denied) { await store.deleteDeviceCode(row.device_code); return res.status(400).json({ error: 'access_denied' }); }
    if (!row.approved || !row.user_id) return res.status(400).json({ error: 'authorization_pending', interval: DEVICE_POLL_INTERVAL_S });
    const deviceId = device_id || row.device_id || `dev_${row.user_code.replace('-', '').toLowerCase()}`;
    const token = await store.issueDeviceToken(deviceId, row.user_id, name || row.client_name, platform ?? null);
    await store.deleteDeviceCode(row.device_code);
    log('info', `device paired: ${name || row.client_name} [${deviceId}] for user ${row.user_id}`);
    res.json({ device_token: token, device_id: deviceId, token_type: 'bearer', ws_url: cfg.publicUrl.replace(/^http/, 'ws') + '/ws' });
  });

  const requireLogin = (req: Request, res: Response, next: NextFunction) =>
    currentUser(req) ? next() : res.redirect(`/auth/login?returnTo=${encodeURIComponent(req.originalUrl)}`);

  // CSRF for the signed-in forms (device pairing approval, device admin, API keys, OAuth clients).
  // Pages get a session-bound hidden `csrf` field added to every POST form that lacks one;
  // POST handlers then require it (the plugin routes check it themselves).
  const withCsrfFields = (req: Request, res: Response, next: NextFunction) => {
    const token = sessions.csrfToken(req);
    if (!token) return next();
    const send = res.send.bind(res);
    res.send = ((body: unknown) => {
      if (typeof body === 'string' && body.includes('<form')) {
        body = body.replace(/<form method="post"[^>]*>/g, (tag: string, offset: number, all: string) => {
          const end = all.indexOf('</form>', offset);
          const inner = all.slice(offset, end === -1 ? undefined : end);
          return inner.includes('name="csrf"') ? tag : `${tag}<input type="hidden" name="csrf" value="${token}">`;
        });
      }
      return send(body as never);
    }) as typeof res.send;
    next();
  };
  const requireCsrf = (req: Request, res: Response, next: NextFunction) => {
    if (req.get('sec-fetch-site') === 'cross-site' || !sessions.checkCsrf(req, (req.body as Record<string, unknown> | undefined)?.csrf)) {
      log('warn', `CSRF check failed for ${req.path} from ${req.ip}`);
      return res.status(403).type('html').send(pages.messagePage('Request blocked', 'This form expired or came from another site. Go back, reload the page and try again.', false));
    }
    next();
  };
  for (const p of ['/admin', '/auth/clients', '/auth/apikeys', '/device/verify']) app.use(p, withCsrfFields);

  app.get('/device/verify', requireLogin, async (req, res) => {
    const code = typeof req.query.user_code === 'string' ? req.query.user_code.slice(0, 64) : '';
    // The agent opens a link with the code filled in. For an already signed-in
    // user, show the device details and approval choice directly (never auto-approve).
    if (code) {
      const row = await store.getDeviceCodeByUserCode(code);
      if (!row || row.expires_at < Date.now() || row.denied)
        return res.status(404).type('html').send(pages.deviceVerifyPage(code, 'This pairing code is invalid, denied or expired. Start a new pairing from your agent.'));
      if (row.approved)
        return res.type('html').send(pages.messagePage('Already approved', 'This pairing is already approved. Return to your agent for the connection status.'));
      return res.type('html').send(pages.deviceApprovePage(row.user_code, row.client_name));
    }
    res.type('html').send(pages.deviceVerifyPage(''));
  });
  app.post('/device/verify', requireLogin, requireCsrf, async (req, res) => {
    const row = await store.getDeviceCodeByUserCode(String(req.body.user_code ?? ''));
    if (!row || row.expires_at < Date.now()) return res.status(404).type('html').send(pages.deviceVerifyPage('', 'Code not found or expired.'));
    res.type('html').send(pages.deviceApprovePage(row.user_code, row.client_name));
  });
  app.post('/device/approve', requireLogin, requireCsrf, async (req, res) => {
    const userId = currentUser(req)!;
    const row = await store.getDeviceCodeByUserCode(String(req.body.user_code ?? ''));
    if (!row || row.expires_at < Date.now()) return res.status(404).type('html').send(pages.messagePage('Not found', 'Code not found or expired.', false));
    if (req.body.decision !== 'allow') { await store.denyDeviceCode(row.device_code); return res.type('html').send(pages.messagePage('Denied', 'Device pairing denied.', false)); }
    await store.approveDeviceCode(row.device_code, userId, row.device_id ?? '');
    res.type('html').send(pages.messagePage('Device approved', `${row.client_name} can now connect. The agent will finish pairing automatically.`));
  });


  /* ---------- OAuth clients registered automatically via DCR ---------- */
  const clientRows = async () => (await store.listClients()).map((c) => {
    const m = JSON.parse(c.metadata) as { client_name?: string; redirect_uris?: string[] };
    return { client_id: c.client_id, name: m.client_name ?? c.client_id, redirect_uris: m.redirect_uris ?? [], hasSecret: !!c.client_secret, created_at: c.created_at };
  });
  app.get('/auth/clients', requireLogin, async (req, res) => {
    const csrf = sessions.csrfToken(req)!;
    const pasted = typeof req.query.authorize === 'string' ? req.query.authorize : '';
    let recovery;
    let feedback;
    if (pasted) {
      try {
        const details = parseAuthorizeRequest(pasted, cfg.publicUrl);
        recovery = { authorizeUrl: details.authorizeUrl!, clientId: details.clientId, redirectUri: details.redirectUri };
      } catch (error) {
        feedback = { ok: false, message: error instanceof Error ? error.message : 'Invalid authorization request' };
      }
    } else if (req.query.added === '1') {
      feedback = { ok: true, message: 'OAuth callback approved. You can retry connecting your AI application.' };
    }
    res.type('html').send(pages.clientsPage(await clientRows(), csrf, recovery, feedback));
  });
  app.post('/auth/clients/import', requireLogin, async (req, res) => {
    if (!sessions.checkCsrf(req, req.body?.csrf)) return res.status(403).type('html').send(pages.messagePage('Forbidden', 'Invalid form token. Reload the clients page.', false));
    if (req.body?.trust !== 'yes') return res.status(400).type('html').send(pages.messagePage('Not approved', 'You must explicitly approve the callback destination.', false));
    const csrf = sessions.csrfToken(req)!;
    try {
      const rawAuthorize = String(req.body?.authorization_url ?? '').trim();
      const input = rawAuthorize
        ? parseAuthorizeRequest(rawAuthorize, cfg.publicUrl)
        : { clientId: validateClientId(String(req.body?.client_id ?? '')), redirectUri: validateRedirectUri(String(req.body?.redirect_uri ?? '')) };
      await approveCallback(store, input, String(req.body?.client_name ?? ''));
      // Redirect only to an already validated same-issuer /authorize URL;
      // the SDK still checks PKCE, scope and exact registered callback.
      if (input.authorizeUrl) return res.redirect(303, input.authorizeUrl);
      res.redirect(303, '/auth/clients?added=1');
    } catch (error) {
      res.status(400).type('html').send(pages.clientsPage(await clientRows(), csrf, undefined, {
        ok: false,
        message: error instanceof Error ? error.message : 'Could not approve callback',
      }));
    }
  });
  app.post('/auth/clients/delete', requireLogin, async (req, res) => {
    if (!sessions.checkCsrf(req, req.body?.csrf)) return res.status(403).type('html').send(pages.messagePage('Forbidden', 'Invalid form token. Reload the clients page.', false));
    await store.deleteClient(String(req.body?.client_id ?? ''));
    res.redirect('/auth/clients');
  });

  /* ---------- MCP endpoint (stateless: new server + transport per request) ---------- */
  const bearer = requireBearerAuth({ verifier: provider, requiredScopes: SCOPES, resourceMetadataUrl: `${cfg.publicUrl}/.well-known/oauth-protected-resource/mcp` });

  const handleMcp = async (req: Request, res: Response, userId: string, clientId: string, access: 'read' | 'full' = 'full') => {
    const server = createMcpServer(hub, store, { userId, clientId }, cfg.relayVersion, access, { registry, publicUrl: cfg.publicUrl, skills });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (err) {
      // Never log credential-bearing URLs or request bodies.
      log('error', `mcp request failed: ${err instanceof Error ? err.name : 'unexpected error'}`);
      if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'internal error' }, id: null });
    }
  };

  app.all('/mcp', bearer, express.json({ limit: '32mb' }), async (req, res) => {
    const auth = (req as Request & { auth?: AuthInfo }).auth!;
    const userId = String(auth.extra?.userId ?? '');
    if (!userId) return res.status(401).json({ error: 'invalid_token' });
    await handleMcp(req, res, userId, auth.clientId);
  });

  // OAuth-free capability URLs: no redirect_uri, no Authorization header, no public anonymous access.
  // A fresh SQLite token-hash lookup is required for every request, including after revocation.
  // One FRESH authorization lookup per request. Reuse the verified row only
  // within this HTTP request; never cache a private credential across requests.
  // This removes a redundant MongoDB RTT without weakening next-request revocation.
  app.all('/c/:key/mcp', async (req, res, next) => {
    const link = await store.getConnectionLink(String(req.params.key ?? ''));
    if (!link) return res.status(404).json({ error: 'invalid_connection' });
    res.locals.connectionLink = link;
    next();
  }, express.json({ limit: '32mb' }), async (req, res) => {
    const link = res.locals.connectionLink as Awaited<ReturnType<RelayStore['getConnectionLink']>>;
    if (!link) return res.status(404).json({ error: 'invalid_connection' });
    await handleMcp(req, res, link.user_id, `link:${link.id}`, link.mode);
  });

  /* ---------- plugins: marketplace, per-device plugin admin, AI install requests ---------- */
  const pluginUi = registerPluginRoutes({ app, hub, store, sessions, registry, requireLogin, log });
  registerSkillsRoutes(app, store, sessions, skills, requireLogin);

  /* ---------- provider-reported token events (not part of MCP execution) ---------- */
  const usageRate = new Map<string, { at: number; count: number }>();
  app.post('/api/usage/report', express.json({ limit: '8kb' }), async (req, res) => {
    // Only an existing, revocable owner API key may submit usage. A private MCP
    // capability URL or agent token does NOT grant access to this endpoint.
    const auth = req.get('authorization') ?? '';
    if (!/^Bearer brc_ak_[A-Za-z0-9_-]{43}$/.test(auth))
      return res.status(401).json({ error: 'api_key_required' });
    const key = await store.getApiKey(auth.slice(7));
    if (!key) return res.status(401).json({ error: 'invalid_api_key' });
    const now = Date.now();
    const old = usageRate.get(key.prefix);
    const rate = old && now - old.at < 60_000 ? old : { at: now, count: 0 };
    if (++rate.count > 120) return res.status(429).json({ error: 'rate_limited' });
    usageRate.set(key.prefix, rate);
    if (usageRate.size > 1000) for (const [id,v] of usageRate)
      if (now - v.at > 60_000) usageRate.delete(id);
    try {
      const usage = validateUsageReport(req.body, key.user_id, now);
      const recorded = await store.recordTokenUsage(usage);
      return res.status(recorded ? 201 : 200).json({
        recorded, duplicate: !recorded, source: 'provider-reported', utc_day: usage.day
      });
    } catch(e) {
      return res.status(400).json({ error: 'invalid_usage_report',
        message: e instanceof Error ? e.message.slice(0,200) : 'Invalid report' });
    }
  });

  /* ---------- admin dashboard ---------- */
  app.get('/admin', requireLogin, async (req, res) => {
    const userId = currentUser(req)!;
    const online = new Set(hub.list(userId).map((d) => d.deviceId));
    const devices = (await store.listDevices(userId)).map((d) => ({ ...d, online: online.has(d.device_id) }));
    const names = new Map(devices.map((d) => [d.device_id, d.name]));
    const audit = (await store.recentAudit(userId, 100)).map((a) => ({ ts: a.ts, device: names.get(a.device_id ?? '') ?? (a.device_id ?? '?').slice(0, 8), client: a.client, tool: a.tool, ok: a.ok, ms: a.ms, error: a.error }));
    const period: UsagePeriod = req.query.period === 'week' ? 'week' : req.query.period === 'month' ? 'month' : 'day';
    const since = new Date(Date.now()-366*86_400_000).toISOString().slice(0,10);
    const days = await store.usageDays(userId, since);
    res.type('html').send(dashboardPage(cfg.publicUrl, devices, audit, await store.auditStats(userId), usageView(days,period), await pluginUi.adminSections(req,userId),pluginUi.flash(req)));
  });
  app.post('/admin/device', requireLogin, requireCsrf, async (req, res) => {
    const userId = currentUser(req)!;
    const { device_id, action, name } = req.body as Record<string, string>;
    const dev = await store.getDevice(String(device_id ?? ''));
    if (!dev || dev.user_id !== userId) return res.status(404).type('html').send(pages.messagePage('Not found', 'Unknown device.', false));
    switch (action) {
      case 'rename': await store.renameDevice(dev.device_id, String(name ?? '').trim().slice(0, 80) || dev.name); break;
      case 'pause': await store.setDevicePaused(dev.device_id, true); break;
      case 'resume': await store.setDevicePaused(dev.device_id, false); break;
      case 'delete': await store.deleteDevice(dev.device_id); hub.get(dev.device_id)?.socket.close(4401, 'device removed'); break;
    }
    log('info', `admin: ${action} device ${dev.device_id}`);
    res.redirect('/admin');
  });

  /* ---------- API keys ---------- */
  app.get('/auth/apikeys', requireLogin, async (req, res) => res.type('html').send(adminPages.apiKeysPage(await store.listApiKeys(currentUser(req)!))));
  app.post('/auth/apikeys', requireLogin, async (req, res) => {
    const userId = currentUser(req)!;
    const name = String(req.body.name ?? '').trim().slice(0, 80) || 'api-key';
    const { raw } = await store.createApiKey(userId, name);
    log('info', `api key created: ${name}`);
    res.type('html').send(adminPages.apiKeysPage(await store.listApiKeys(userId), { name, raw }));
  });
  app.post('/auth/apikeys/revoke', requireLogin, async (req, res) => {
    await store.revokeApiKey(currentUser(req)!, String(req.body.prefix ?? ''));
    res.redirect('/auth/apikeys');
  });

  /* ---------- Copy/paste connection URLs: no OAuth callback required ---------- */
  app.get('/auth/links', requireLogin, async (req, res) => {
    const userId = currentUser(req)!;
    res.type('html').send(adminPages.connectionLinksPage(await store.listConnectionLinks(userId), sessions.csrfToken(req)!));
  });
  app.post('/auth/links', requireLogin, async (req, res) => {
    if (!sessions.checkCsrf(req, req.body?.csrf)) return res.status(403).type('html').send(pages.messagePage('Forbidden', 'Invalid form token. Reload the links page.', false));
    const userId = currentUser(req)!;
    const csrf = sessions.csrfToken(req)!;
    try {
      if (publicUrl.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(publicUrl.hostname))
        throw new Error('A public connection URL requires HTTPS.');
      const name = String(req.body?.name ?? '').trim().slice(0, 80);
      const mode = req.body?.mode === 'full' ? 'full' : req.body?.mode === 'read' ? 'read' : null;
      const days = Number(req.body?.days);
      if (!mode) throw new Error('Choose a valid access level.');
      const created = await store.createConnectionLink(userId, name, mode, days);
      const url = `${cfg.publicUrl}/c/${created.key}/mcp`;
      res.type('html').send(adminPages.connectionLinksPage(await store.listConnectionLinks(userId), csrf, { name, url, expiresAt: created.expiresAt }));
    } catch (error) {
      res.status(400).type('html').send(adminPages.connectionLinksPage(await store.listConnectionLinks(userId), csrf, undefined, error instanceof Error ? error.message : 'Invalid request'));
    }
  });
  app.post('/auth/links/revoke', requireLogin, async (req, res) => {
    if (!sessions.checkCsrf(req, req.body?.csrf)) return res.status(403).type('html').send(pages.messagePage('Forbidden', 'Invalid form token. Reload the links page.', false));
    await store.revokeConnectionLink(currentUser(req)!, String(req.body?.link_id ?? ''));
    res.redirect('/auth/links');
  });

  /* ---------- agent WebSocket (device token) ---------- */
  const http = createServer(app);
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });

  http.on('upgrade', (req, socket, head) => {
    void (async () => {
    const url = new URL(req.url ?? '/', cfg.publicUrl);
    if (url.pathname !== '/ws') return socket.destroy();
    const h = req.headers.authorization;
    const token = h?.startsWith('Bearer ') ? h.slice(7).trim() : url.searchParams.get('token');
    const dev = token ? await store.getDeviceByToken(token) : undefined;
    if (!dev) { log('warn', `agent auth failed from ${req.socket.remoteAddress}`); socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); return socket.destroy(); }
    wss.handleUpgrade(req, socket, head, (ws) => {
      hub.attach(ws, dev.user_id, dev.device_id);
      void Promise.resolve(store.touchDevice(dev.device_id)).catch(() => log('warn', 'Agent last-seen update failed'));
    });
    })().catch(() => { log('warn', 'Agent authentication storage unavailable'); socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n'); socket.destroy(); });
  });

  // Async errors must fail safely, not expose database addresses, credentials or stack traces.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    log('error', `relay request failed: ${err instanceof Error ? err.name : 'unexpected error'}`);
    if (res.headersSent) return next(err);
    res.status(503).json({ error: 'service_unavailable' });
  });

  const housekeeping = setInterval(() => { void Promise.resolve(store.vacuumExpired()).catch(() => log('warn', 'Storage cleanup failed; will retry next minute')); }, 60_000);
  housekeeping.unref();

  log('info', `admin user "${admin.username}" ready; storage ${cfg.mongoUri ? 'MongoDB' : 'SQLite'}`);

  return {
    http, hub, store,
    close: async () => { clearInterval(housekeeping); hub.close(); wss.close(); await new Promise<void>((r) => http.close(() => r())); await store.close(); },
  };
}
