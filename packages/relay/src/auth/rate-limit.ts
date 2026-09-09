/** Tiny in-memory login rate limiter: N failures per key -> lock for a window. */
export class LoginLimiter {
  private fails = new Map<string, { count: number; lockedUntil: number; last: number }>();
  constructor(private readonly maxFails = 5, private readonly lockMs = 5 * 60_000) {
    setInterval(() => {
      const cutoff = Date.now() - 2 * this.lockMs;
      for (const [k, v] of this.fails) if (v.last < cutoff) this.fails.delete(k);
    }, 60_000).unref();
  }
  /** Returns seconds remaining if locked, else 0. */
  locked(key: string): number {
    const e = this.fails.get(key);
    if (!e || e.lockedUntil <= Date.now()) return 0;
    return Math.ceil((e.lockedUntil - Date.now()) / 1000);
  }
  fail(key: string): void {
    const e = this.fails.get(key) ?? { count: 0, lockedUntil: 0, last: 0 };
    e.count++; e.last = Date.now();
    if (e.count >= this.maxFails) { e.lockedUntil = Date.now() + this.lockMs; e.count = 0; }
    this.fails.set(key, e);
  }
  ok(key: string): void { this.fails.delete(key); }
}
