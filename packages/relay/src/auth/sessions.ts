/**
 * Minimal signed-cookie sessions for the relay's browser pages (login, consent, device verify, admin).
 * Cookie: brc_session=<userId>.<exp>.<hmac>
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Request, Response } from 'express';

const COOKIE = 'brc_session';
const TTL_MS = 12 * 3_600_000;

export class Sessions {
  constructor(private readonly secret: string, private readonly secure: boolean) {}

  private sign(payload: string): string {
    return createHmac('sha256', this.secret).update(payload).digest('base64url');
  }

  issue(res: Response, userId: string): void {
    const exp = Date.now() + TTL_MS;
    const payload = `${userId}.${exp}`;
    res.cookie(COOKIE, `${payload}.${this.sign(payload)}`, {
      httpOnly: true, sameSite: 'lax', secure: this.secure, maxAge: TTL_MS, path: '/',
    });
  }

  clear(res: Response): void {
    res.clearCookie(COOKIE, { path: '/' });
  }

  userId(req: Request): string | null {
    const raw = req.cookies?.[COOKIE] as string | undefined;
    if (!raw) return null;
    const [userId, exp, sig] = raw.split('.');
    if (!userId || !exp || !sig) return null;
    const expected = this.sign(`${userId}.${exp}`);
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    if (Number(exp) < Date.now()) return null;
    return userId;
  }
}
