/**
 * PKCE compatibility shim for confidential clients that do not send PKCE (ChatGPT GPT Actions).
 * The MCP SDK's authorize/token handlers require code_challenge/code_verifier. For clients that
 * hold a client_secret we synthesize a deterministic PKCE pair so the SDK's check passes; the
 * client is still authenticated by its secret at /token, which is the standard confidential-client flow.
 * Public clients (no secret) are never exempted.
 */
import { createHash } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type { SqliteStore } from '../store/sqlite.js';

const verifierFor = (clientId: string) => `nopkce-${createHash('sha256').update(`ses-rdp:${clientId}`).digest('base64url')}`;
const challengeFor = (clientId: string) => createHash('sha256').update(verifierFor(clientId)).digest('base64url');

export function pkceCompat(store: SqliteStore) {
  const isConfidential = (clientId: unknown) => typeof clientId === 'string' && !!store.getClient(clientId)?.client_secret;

  return (req: Request, _res: Response, next: NextFunction) => {
    if (req.path === '/authorize') {
      const src = req.method === 'POST' ? (req.body as Record<string, string> | undefined) : undefined;
      const url = new URL(req.originalUrl, 'http://x');
      const clientId = src?.client_id ?? url.searchParams.get('client_id');
      const hasChallenge = src ? !!src.code_challenge : url.searchParams.has('code_challenge');
      if (!hasChallenge && isConfidential(clientId)) {
        if (src) { src.code_challenge = challengeFor(clientId!); src.code_challenge_method = 'S256'; }
        else {
          url.searchParams.set('code_challenge', challengeFor(clientId!));
          url.searchParams.set('code_challenge_method', 'S256');
          req.url = url.pathname + url.search;
        }
      }
    }
    if (req.path === '/token' && req.method === 'POST') {
      const b = req.body as Record<string, string> | undefined;
      if (b && b.grant_type === 'authorization_code' && !b.code_verifier && b.client_secret && isConfidential(b.client_id)) {
        b.code_verifier = verifierFor(b.client_id);
      }
    }
    next();
  };
}
