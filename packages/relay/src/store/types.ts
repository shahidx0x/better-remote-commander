/**
 * Common persistence contract. SQLite returns values synchronously; MongoDB
 * resolves them asynchronously. Callers must await both reads and writes.
 * Never fall back to SQLite when a configured MongoDB is unavailable.
 */
import type { SqliteStore } from './sqlite.js';

export type Awaitable<T> = T | Promise<T>;
export type RelayStore = {
  [K in keyof SqliteStore as SqliteStore[K] extends (...args: any[]) => any ? K : never]:
    SqliteStore[K] extends (...args: infer A) => infer R ? (...args: A) => Awaitable<R> : never
};
