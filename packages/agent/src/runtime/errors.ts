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
  // Model-facing recovery is metadata, not an automatic retry. In particular,
  // an interrupted mutation must never be replayed without checking its result.
  const guidance: Record<string,string> = {
    SHELL_SYNTAX:'Windows PowerShell 5.1 does not support && or ||. For simple native chains specify shell:"cmd.exe", or use valid PowerShell sequencing; nothing executed.',
    INVALID_CWD:'Specify an absolute working directory that exists and is allowed; no command ran.',
    COMMAND_BLOCKED:'The command was rejected by agent policy. Do not work around restrictions; request an authorized alternative.',
    SHELL_START_FAILED:'Check shell executable, installation and PATH. The command did not start.',
    WRITE_LINE_LIMIT:'No file was changed. Split content into smaller chunks; start new file with rewrite, then append subsequent chunks, or use precise edit_block changes.',
    WRITE_SIZE_LIMIT:'No file was changed. Write a smaller <=1 MiB chunk, then append only unwritten content; avoid blind retries.',
    WRITE_MODE_REQUIRED:'No file was changed. State mode=rewrite or mode=append explicitly.',
    BUSY:'The agent queue is full. Wait briefly, retry the read-only operation once; for writes inspect state before retrying.',
    WORKER_CAPACITY:'All worker slots are busy. Submit, release or renew a claim; do not create a competing plan.',
    WORKER_PLAN_BUSY:'An integration is already running. Check worker_tasks status before retrying.',
    CLAIM_EXPIRED:'Reclaim the task with worker_tasks, re-read current hashes and submit under the new claim. Old keys cannot be reused.',
    FILE_CONFLICT:'The expected_sha256 is stale, or the file changed before commit. No blind retry. Call read_code_file for the current SHA-256 and exact text, then submit a corrected edit after confirming the latest content.',
    ENOENT:'The requested file/path does not exist. Check the exact absolute path with list_directory or start_search(searchType:"files"); do not invent its contents or silently create it.',
    RESULT_TOO_LARGE:'Tool result exceeded the WebSocket budget. Request narrower ranges or fewer files. Mutations may already have completed: inspect results before any retry.',
    VERIFICATION_CHANGED:'Source changed during checks; stop parallel mutations and re-run validation when the tree is stable.',
    PARSER_BUSY:'Reduce parser concurrency or the batch size and retry after in-flight parses finish.',
    UNSUPPORTED_ON_TERMUX:'Choose a tool advertised by this Android agent; for desktop-native work switch to a desktop BRC Agent.',
  };
  const next=guidance[code];
  return { isError: true, content: [{ type: 'text', text: `${code}: ${error.message}${next?'\\nNEXT ACTION: '+next:''}` }],
    structuredContent: { error, ...(next?{recovery:{suggestion:next,automaticRetry:false}}:{}) } };
}
export function result(data: Record<string, unknown>, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text: JSON.stringify(data, null, 2) }], structuredContent: data };
}
