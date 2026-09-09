/**
 * SES-RDP OAuth 2.0 provider for @modelcontextprotocol/sdk's mcpAuthRouter.
 * Authorization code + PKCE (S256), dynamic client registration, refresh tokens, revocation.
 * User login is a cookie session set by /auth/login (see sessions.ts); authorize() renders consent.
 */
import type { Response } from 'express';
import type { OAuthServerProvider, AuthorizationParams } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { OAuthClientInformationFull, OAuthTokens, OAuthTokenRevocationRequest } from '@modelcontextprotocol/sdk/shared/auth.js';
import { InvalidGrantError, InvalidRequestError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import { SqliteStore, randomToken, sha256 } from '../store/sqlite.js';

export const SCOPES = ['mcp:tools'];
const AUTH_CODE_TTL_MS = 10 * 60_000;
const ACCESS_TTL_MS = 60 * 60_000;
const REFRESH_TTL_MS = 30 * 86_400_000;

/** Per-client option (metadata key `x_redirect_base`): after consent, send the browser to this origin
 *  instead of the client's requested redirect_uri host. Path, `code` and `state` are preserved.
 *  The requested redirect_uri is still validated against the registered list. */
export const REDIRECT_BASE_KEY = 'x_redirect_base';
export function applyRedirectOverride(client: OAuthClientInformationFull, url: URL): string {
  const base = (client as Record<string, unknown>)[REDIRECT_BASE_KEY];
  if (typeof base !== 'string' || !/^https?:\/\//.test(base)) return url.toString();
  try {
    const b = new URL(base);
    const out = new URL(url.toString());
    out.protocol = b.protocol; out.host = b.host;
    const prefix = b.pathname.replace(/\/$/, '');
    if (prefix) out.pathname = prefix + out.pathname;
    return out.toString();
  } catch { return url.toString(); }
}

export class RelayClientsStore implements OAuthRegisteredClientsStore {
  constructor(private readonly store: SqliteStore) {}

  getClient(clientId: string): OAuthClientInformationFull | undefined {
    const row = this.store.getClient(clientId);
    return row ? (JSON.parse(row.metadata) as OAuthClientInformationFull) : undefined;
  }

  registerClient(client: Omit<OAuthClientInformationFull, 'client_id' | 'client_id_issued_at'>): OAuthClientInformationFull {
    const full: OAuthClientInformationFull = {
      ...client,
      client_id: `cl_${randomToken(16)}`,
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    if (client.token_endpoint_auth_method !== 'none') full.client_secret = randomToken(32);
    this.store.insertClient({ client_id: full.client_id, client_secret: full.client_secret ?? null, metadata: JSON.stringify(full), created_at: Date.now() });
    return full;
  }
}

export interface ProviderDeps {
  store: SqliteStore;
  /** Resolve logged-in user id from the request cookie, or null. */
  currentUserId: (res: Response) => string | null;
  /** Render login page that returns to `returnTo` after success. */
  renderLogin: (res: Response, returnTo: string) => void;
  /** Render consent page; form posts back to /auth/consent with the pending id. */
  renderConsent: (res: Response, pendingId: string, client: OAuthClientInformationFull, scopes: string[]) => void;
}

/** Authorization request parked between login/consent and code issuance (in memory; short-lived). */
export interface PendingAuth { client: OAuthClientInformationFull; params: AuthorizationParams; createdAt: number }

export class RelayOAuthProvider implements OAuthServerProvider {
  readonly clientsStore: RelayClientsStore;
  readonly pending = new Map<string, PendingAuth>();

  constructor(private readonly deps: ProviderDeps) {
    this.clientsStore = new RelayClientsStore(deps.store);
    setInterval(() => {
      const cutoff = Date.now() - AUTH_CODE_TTL_MS;
      for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
    }, 60_000).unref();
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    const pendingId = randomToken(16);
    this.pending.set(pendingId, { client, params, createdAt: Date.now() });
    const userId = this.deps.currentUserId(res);
    if (!userId) return this.deps.renderLogin(res, `/auth/consent?pending=${pendingId}`);
    return this.deps.renderConsent(res, pendingId, client, params.scopes ?? SCOPES);
  }

  /** Called by the consent POST handler after the user approved. Returns the redirect URL. */
  issueCode(pendingId: string, userId: string): string {
    const p = this.pending.get(pendingId);
    if (!p) throw new InvalidRequestError('authorization request expired');
    this.pending.delete(pendingId);
    const code = randomToken(32);
    this.deps.store.insertAuthCode({
      code, client_id: p.client.client_id, user_id: userId, code_challenge: p.params.codeChallenge,
      redirect_uri: p.params.redirectUri, scopes: (p.params.scopes ?? SCOPES).join(' '),
      resource: p.params.resource?.toString() ?? null, expires_at: Date.now() + AUTH_CODE_TTL_MS,
    });
    const url = new URL(p.params.redirectUri);
    url.searchParams.set('code', code);
    if (p.params.state) url.searchParams.set('state', p.params.state);
    return applyRedirectOverride(p.client, url);
  }

  denyCode(pendingId: string): string | null {
    const p = this.pending.get(pendingId);
    if (!p) return null;
    this.pending.delete(pendingId);
    const url = new URL(p.params.redirectUri);
    url.searchParams.set('error', 'access_denied');
    if (p.params.state) url.searchParams.set('state', p.params.state);
    return applyRedirectOverride(p.client, url);
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const row = this.deps.store.peekAuthCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('invalid authorization code');
    return row.code_challenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string, _codeVerifier?: string, redirectUri?: string, resource?: URL): Promise<OAuthTokens> {
    const row = this.deps.store.takeAuthCode(authorizationCode);
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('invalid authorization code');
    if (redirectUri && redirectUri !== row.redirect_uri) throw new InvalidGrantError('redirect_uri mismatch');
    return this.mint(client.client_id, row.user_id, row.scopes.split(' '), resource?.toString() ?? row.resource);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string, scopes?: string[], resource?: URL): Promise<OAuthTokens> {
    const row = this.deps.store.getToken(refreshToken, 'refresh');
    if (!row || row.client_id !== client.client_id) throw new InvalidGrantError('invalid refresh token');
    this.deps.store.revokeToken(refreshToken);
    const granted = row.scopes.split(' ');
    const wanted = scopes?.length ? scopes.filter((s) => granted.includes(s)) : granted;
    return this.mint(client.client_id, row.user_id, wanted, resource?.toString() ?? row.resource);
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const row = this.deps.store.getToken(token, 'access');
    if (!row) throw new InvalidTokenError('invalid or expired access token');
    return {
      token, clientId: row.client_id, scopes: row.scopes.split(' '),
      expiresAt: row.expires_at ? Math.floor(row.expires_at / 1000) : undefined,
      resource: row.resource ? new URL(row.resource) : undefined,
      extra: { userId: row.user_id },
    };
  }

  async revokeToken(client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    const row = this.deps.store.getToken(request.token, 'access') ?? this.deps.store.getToken(request.token, 'refresh');
    if (row && row.client_id === client.client_id) this.deps.store.revokeToken(request.token);
  }

  private mint(clientId: string, userId: string, scopes: string[], resource: string | null): OAuthTokens {
    const access = `sesrdp_at_${randomToken(32)}`;
    const refresh = `sesrdp_rt_${randomToken(32)}`;
    const now = Date.now();
    this.deps.store.insertToken({ token_hash: sha256(access), kind: 'access', client_id: clientId, user_id: userId, scopes: scopes.join(' '), resource, expires_at: now + ACCESS_TTL_MS, created_at: now, revoked: 0 });
    this.deps.store.insertToken({ token_hash: sha256(refresh), kind: 'refresh', client_id: clientId, user_id: userId, scopes: scopes.join(' '), resource, expires_at: now + REFRESH_TTL_MS, created_at: now, revoked: 0 });
    return { access_token: access, token_type: 'bearer', expires_in: ACCESS_TTL_MS / 1000, refresh_token: refresh, scope: scopes.join(' ') };
  }
}
