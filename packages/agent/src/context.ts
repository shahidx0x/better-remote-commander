/** Each async tool chain has its own client identity, deadline and cancellation signal. */
import { AsyncLocalStorage } from 'node:async_hooks';
export interface CallContext { id: string; client: { name?: string; version?: string } | null; remote: boolean; signal?: AbortSignal; deadline?: number; depth?: number; writePrecondition?: { path: string; sha256: string } }
const calls = new AsyncLocalStorage<CallContext>();
export let currentClient = { name: 'brc-agent', version: '0.0.0' };
export function setCurrentClient(info: { name?: string; version?: string }): void { currentClient = { name: info.name ?? 'unknown', version: info.version ?? 'unknown' }; }
export function withCallContext<T>(context: CallContext, fn: () => T): T { return calls.run(context, fn); }
export function getCallContext(): CallContext | undefined { return calls.getStore(); }
export function getCurrentRemoteClient() { return calls.getStore()?.client ?? null; }
export function isRemoteCall(): boolean { return calls.getStore()?.remote ?? false; }
export function checkCancelled(): void { calls.getStore()?.signal?.throwIfAborted(); }
