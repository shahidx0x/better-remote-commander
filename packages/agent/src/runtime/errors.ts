import type { ToolResult } from 'brc-shared';
import {renderResultText} from './result-presentation.js';
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
    APPEND_OUTCOME_UNCERTAIN:'A previous append may already have committed and its target has since changed. Inspect the file and operation receipt; do not retry automatically.',
    APPEND_ID_REUSED:'The append ID is bound to an earlier path and content. Supply a fresh ID for a distinct append; no bytes were written.',
    APPEND_JOURNAL_UNAVAILABLE:'The append receipt could not be persisted safely, so no append should be repeated without inspecting current file state.',
    APPEND_FILE_TOO_LARGE:'Idempotent append is limited to an 8 MiB destination for bounded memory usage. Use ordinary append with independent verification for bigger files.',
    MOVE_PARTIAL:'The verified destination may exist, but source cleanup or verification failed. Inspect both source and destination before retrying or deleting either file.',
    MOVE_DEST_EXISTS:'The destination already exists; no overwrite was performed. Choose a new destination or explicitly handle its existing content.',
    MOVE_DIRECTORY_EXDEV:'Cross-volume directory move was stopped without copying/deleting the directory. Use an approved recursive verified-copy workflow for folder trees.',
    BUSY:'The agent queue is full. Wait briefly, retry the read-only operation once; for writes inspect state before retrying.',
    WORKER_CAPACITY:'All worker slots are busy. Submit, release or renew a claim; do not create a competing plan.',
    WORKER_PLAN_BUSY:'An integration is already running. Check worker_tasks status before retrying.',
    WORKER_PLAN_CLOSED:'For restored plans, use worker_tasks status then coordinator-authorized resume after checking current source/scope. Do not reuse expired claim keys or staged patches.',
    WORKER_PLAN_NOT_FOUND:'The plan is not in RAM or durable checkpoints. Start a new plan; do not claim old work completed.',
    UNAPPROVED_CHANGES:'The source tree differs from the recorded checkpoint. Inspect changes and recreate or cancel the plan; never replay worker patches automatically.',
    SCOPE_CHANGED:'The saved worker scope now resolves elsewhere. Inspect the project/junction before starting another task.',
    SEMANTIC_DISABLED:'Compiler-backed TypeScript navigation is opt-in. Use mode=lexical or enable BRC_TS_SEMANTIC=1 for a future local-agent start.',
    SEMANTIC_BUSY:'One TypeScript semantic query is active. Retry when it settles, or use lexical search.',
    SEMANTIC_ARGUMENTS:'Specify the exact saved TS/JS file, symbol, and 1-based line/column; do not pass filePattern with semantic mode.',
    SEMANTIC_QUERY_FAILED:'Check exact symbol and source position. This is a compiler-service result, not a completed rename or proof of whole-project coverage.',
    SEMANTIC_WORKER_EXITED:'The bounded semantic worker exited or timed out. No files were modified. Use lexical search or retry only a read-only query.',
    SEMANTIC_PATH_CHANGED:'The resolved compiler result path changed; recheck the project path and query again.',
    CLAIM_EXPIRED:'Reclaim the task with worker_tasks, re-read current hashes and submit under the new claim. Old keys cannot be reused.',
    FILE_CONFLICT:'The expected_sha256 is stale, or the file changed before commit. No blind retry. Call read_code_file for the current SHA-256 and exact text, then submit a corrected edit after confirming the latest content.',
    PATH_CHANGED:'The file/junction resolved to a different location while waiting for a write lock. No tool operation started. Re-check the path and verify its canonical target before any new attempt.',
    SOURCE_HASH_REQUIRED:'Strict source observations are enabled. Read the current source and supply expected_sha256 before editing an existing code/configuration file.',
    TOOL_OUTCOME_UNCERTAIN:'A mutating tool did not confirm that it stopped. Inspect actual effects before repeating work.',
    PLUGIN_CALL_OUTCOME_UNCERTAIN:'A plugin call may have executed before its connection failed. Check external state; never replay blindly.',
    PATCH_CONTEXT_MISMATCH:'No patch file was written because an entire-line context matched zero or multiple locations. Re-read the affected source, add unique surrounding lines, and submit a corrected patch.',
    PATCH_FAILED:'A patch preflight or commit failed. Inspect the returned rollback report before attempting a corrected patch.',
    PATCH_PARTIAL:'A patch may have partially published changes. Inspect every path and the rollback report; do not repeat the patch automatically.',
    PATCH_TARGET_EXISTS:'Patch add/move destination already exists. No overwrite occurred; inspect and choose a different path.',
    PATCH_SYNTAX:'A patch directive or path is malformed or unsupported. Use *** Begin Patch, *** Update File, @@, exact context lines and *** End Patch; use file tools for add/delete/move.',
    PROGRAM_NOT_FOUND:'The direct executable does not exist on PATH. Use a native executable such as git.exe/node.exe, or command with a shell for .cmd/.bat; nothing executed.',
    PROGRAM_START_FAILED:'The native executable or its Windows Job launcher failed before starting. Check executable compatibility, permissions, PATH and containment diagnostics. No automatic shell fallback or replay.',
    ENOENT:'The requested file/path does not exist. Check the exact absolute path with list_directory or start_search(searchType:"files"); do not invent its contents or silently create it.',
    RESULT_TOO_LARGE:'Tool result exceeded the WebSocket budget. Request narrower ranges or fewer files. Mutations may already have completed: inspect results before any retry.',
    VERIFICATION_CHANGED:'Source changed during checks; stop parallel mutations and re-run validation when the tree is stable.',
    RESOURCE_ADMISSION_BUSY:'The selected CPU, I/O or startup lane reached its bounded waiting limit. No new worker started. Reduce concurrency or retry once when existing work settles.',
    RESOURCE_ADMISSION_TIMEOUT:'The requested tool could not acquire a resource permit within the wait budget. The queued task never started; check resourceLanes in agent_status before retrying.',
    PARSER_BUSY:'Reduce parser concurrency or the batch size and retry after in-flight parses finish.',
    UNSUPPORTED_ON_TERMUX:'Choose a tool advertised by this Android agent; for desktop-native work switch to a desktop BRC Agent.',
  };
  const next=guidance[code];
  return { isError: true, content: [{ type: 'text', text: `${code}: ${error.message}${next?'\\nNEXT ACTION: '+next:''}` }],
    structuredContent: { error, ...(next?{recovery:{suggestion:next,automaticRetry:false}}:{}) } };
}
export function result(data: Record<string, unknown>, isError = false): ToolResult {
  return { isError, content: [{ type: 'text', text: renderResultText(data) }], structuredContent: data };
}
