/**
 * Explicit owner-approved OAuth client recovery for wrappers that retain a client_id
 * after the relay's client registry was reset, or do not implement DCR.
 * Never register a redirect URI from an unauthenticated /authorize request.
 */
import type { RelayStore } from '../store/types.js';

export interface ClientRecoveryInput {
  clientId: string;
  redirectUri: string;
  authorizeUrl?: string;
}

function onlyOne(params: URLSearchParams, name: string): string {
  const values = params.getAll(name);
  if (values.length !== 1 || !values[0]) throw new Error('Missing or duplicate ' + name);
  return values[0];
}

export function validateClientId(value: string): string {
  const clientId = value.trim();
  if (!/^[A-Za-z0-9._~:-]{1,128}$/.test(clientId)) throw new Error('Invalid client ID: use 1–128 URL-safe characters');
  return clientId;
}

export function validateRedirectUri(value: string): string {
  const redirectUri = value.trim();
  if (!redirectUri || redirectUri.length > 2048) throw new Error('Callback URL must be 1–2048 characters');
  let url: URL;
  try { url = new URL(redirectUri); } catch { throw new Error('Callback URL must be absolute'); }
  if (url.username || url.password || url.hash || !url.hostname)
    throw new Error('Callback URLs cannot include credentials or fragments');
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(loopback && url.protocol === 'http:'))
    throw new Error('Callback must be HTTPS (or HTTP on localhost for native apps)');
  return redirectUri; // Exact bytes matter to the OAuth redirect check.
}

export function parseAuthorizeRequest(raw: string, publicUrl: string): ClientRecoveryInput {
  if (raw.length > 8192) throw new Error('Authorization link is too long');
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Paste a complete authorization URL'); }
  const issuer = new URL(publicUrl);
  const expected = new URL('/authorize', issuer);
  if (url.origin !== expected.origin || url.pathname !== expected.pathname || url.username || url.password || url.hash)
    throw new Error('This is not an authorization URL for your BRC relay');
  if (onlyOne(url.searchParams, 'response_type') !== 'code') throw new Error('Only OAuth authorization code requests are supported');
  const clientId = validateClientId(onlyOne(url.searchParams, 'client_id'));
  const redirectUri = validateRedirectUri(onlyOne(url.searchParams, 'redirect_uri'));
  if (onlyOne(url.searchParams, 'code_challenge_method') !== 'S256') throw new Error('OAuth PKCE S256 is required');
  if (!/^[A-Za-z0-9_-]{43,128}$/.test(onlyOne(url.searchParams, 'code_challenge')))
    throw new Error('A valid PKCE code challenge is required');
  const resources = url.searchParams.getAll('resource');
  if (resources.length > 1 || (resources.length && resources[0] !== new URL('/mcp', issuer).toString()))
    throw new Error('The OAuth resource does not match this relay');
  return { clientId, redirectUri, authorizeUrl: url.toString() };
}

export async function approveCallback(
  store: RelayStore,
  input: ClientRecoveryInput,
  label: string,
): Promise<'registered' | 'added_callback' | 'already_registered'> {
  const clientId = validateClientId(input.clientId);
  const redirectUri = validateRedirectUri(input.redirectUri);
  const current = await store.getClient(clientId);
  if (!current) {
    const full = {
      client_id: clientId,
      client_name: label.trim().slice(0, 80) || 'Approved MCP client',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    };
    await store.insertClient({ client_id: clientId, client_secret: null, metadata: JSON.stringify(full), created_at: Date.now() });
    return 'registered';
  }
  const metadata = JSON.parse(current.metadata) as Record<string, unknown>;
  // Never silently weaken a previously confidential client.
  if (current.client_secret || (metadata.token_endpoint_auth_method && metadata.token_endpoint_auth_method !== 'none'))
    throw new Error('This client uses a secret. Re-register it through its original client flow.');
  const uris = Array.isArray(metadata.redirect_uris) ? metadata.redirect_uris : [];
  if (!uris.every((item) => typeof item === 'string')) throw new Error('Registered callback metadata is invalid');
  if (uris.includes(redirectUri)) return 'already_registered';
  if (uris.length >= 16) throw new Error('Maximum 16 callbacks per OAuth client');
  await store.updateClientMetadata(clientId, JSON.stringify({ ...metadata, redirect_uris: [...uris, redirectUri] }));
  return 'added_callback';
}
