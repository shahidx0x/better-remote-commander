import type { ToolResult } from 'brc-shared';
export class AgentError extends Error {
  constructor(readonly code: string, message: string, readonly retryable = false) { super(message); this.name = 'AgentError'; }
}
export function errorCode(err: unknown): string {
  if (err instanceof AgentError) return err.code;
  const e = err as { code?: string; name?: string; message?: string };
  if (e?.name === 'AbortError' || e?.code === 'ABORT_ERR') return 'CANCELLED';
  if (e?.name === 'TimeoutError') return 'TIMEOUT';
  if (e?.name === 'ZodError') return 'INVALID_ARGUMENT';
  if (e?.code && /^[A-Z_]+$/.test(e.code)) return e.code;
  return 'TOOL_FAILED';
}
export function failure(err: unknown, callId?: string): ToolResult {
  const code = errorCode(err);
  const message = err instanceof Error ? err.message : String(err);
  const error = { code, message: message.slice(0, 4000), retryable: err instanceof AgentError ? err.retryable : false, callId };
  return { isError: true, content: [{ type: 'text', text: `${code}: ${error.message}` }], structuredContent: { error } };
}
export function result(data: Record<string, unknown>, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}
