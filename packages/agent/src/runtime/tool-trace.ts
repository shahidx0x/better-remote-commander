/**
 * Bounded, readable, local-only tool diagnostics.
 * Inline scripts, file bodies, edited source and binary payloads are not copied
 * to the log. Common credential patterns are redacted before retention.
 */
const MAX_TRACE_CHARS = 12_000;
const MAX_ARGUMENT_CHARS = 3_500;
const MAX_RESULT_CHARS = 9_000;
const SAFE_RESULT_TOOLS = new Set([
  'run_command', 'start_process', 'read_process_output', 'interact_with_process',
  'get_job', 'wait_jobs', 'list_jobs', 'verify_project', 'run_project_checks',
  'git_status', 'git_log', 'list_sessions', 'start_search', 'get_more_search_results',
]);

function sample(value: string, budget: number): string {
  if (value.length <= budget) return value;
  const head = Math.floor(budget * 0.4);
  const tail = Math.max(0, budget - head);
  return value.slice(0, head) + '\n  ... [skipped ' + (value.length - budget) +
    ' characters; full result remains available via the tool] ...\n' + value.slice(-tail);
}
export function redactTrace(value: string, budget = MAX_TRACE_CHARS): string {
  const sampled = sample(value, Math.max(120, Math.min(MAX_TRACE_CHARS, budget)));
  return sampled
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[PRIVATE KEY REDACTED]')
    .replace(/\b(?:mongodb(?:\+srv)?|postgres(?:ql)?|mysql|redis):\/\/[^\s"'<>]+/gi, '[CONNECTION URI REDACTED]')
    .replace(/\b(?:Bearer\s+)[A-Za-z0-9._~+\/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:brc_(?:dev|ak)_[A-Za-z0-9_-]{4,}|sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{16,})\b/g, '[CREDENTIAL REDACTED]')
    .replace(/((?:"|')?(?:password|passphrase|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|private[_-]?key|authorization|credential)(?:"|')?\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;}\r\n]+)/gi, '$1[REDACTED]')
    .replace(/((?:--(?:password|token|secret|api-key|access-key))\s+)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9+\/]{250,}={0,2}/g, '[LONG ENCODED DATA OMITTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\x1b]/g, ' ')
    .replace(/\r\n?/g, '\n');
}
function pathText(value: unknown): string {
  return typeof value === 'string' ? redactTrace(value, 580) : '';
}
function safeCommand(value: unknown): string {
  if (typeof value !== 'string') return '';
  // Arbitrary inline scripts may contain unknown credentials and code.
  if (/[\r\n\x60]|(?:^|\s)(?:-e|-c|--eval|--execute)(?=\s|=)|(?:;|&&|\|\|)|\$\{|\$\(/i.test(value)) {
    const first = value.trim().match(/^("[^"]+"|'[^']+'|[^\s]+)/)?.[0] ?? 'shell';
    return redactTrace(first, 180) + ' [inline/multi-command script omitted]';
  }
  return redactTrace(value, 1800);
}
const OMITTED_KEYS = /^(?:content|old_string|new_string|input|edits|files|replacements|patch|image|data|env|environment|password|token|secret|authorization|api_key|access_key|private_key)$/i;
const SCALAR_KEYS = [
  'command','cwd','path','file_path','source','destination','root','directory','outputPath',
  'pid','timeout_ms','max_runtime_ms','offset','length','maxOutputChars','id','ids',
  'shell','mode','raw','recursive','pattern','group','step_limit','output_chars',
  'verbose_timing','wait_for_prompt','depth','include_hidden','maxResults','max_results',
  'start','limit','page','query','dry_run','expect_replacements','expected_replacements'
] as const;

export function traceToolArguments(_tool: string, args: unknown): string {
  if (!args || typeof args !== 'object' || Array.isArray(args))
    return 'Arguments: (none)';
  const data = args as Record<string, unknown>;
  const lines: string[] = [];
  for (const key of SCALAR_KEYS) {
    const value = data[key];
    if (value === undefined || value === null) continue;
    if (key === 'command') {
      lines.push('  command: ' + safeCommand(value));
    } else if (Array.isArray(value)) {
      const values = value.filter(v => typeof v === 'string' || typeof v === 'number').slice(0, 6);
      lines.push('  ' + key + ': [' + values.map(v => pathText(String(v))).join(', ') +
        (value.length > 6 ? ', +' + (value.length - 6) + ' more' : '') + ']');
    } else if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string') {
      lines.push('  ' + key + ': ' + (typeof value === 'string' ? pathText(value) : String(value)));
    }
  }
  const omitted = Object.keys(data).filter(key =>
    OMITTED_KEYS.test(key) && data[key] !== undefined && data[key] !== null);
  for (const key of omitted.slice(0, 4)) {
    const value = data[key];
    const size = typeof value === 'string' ? value.length + ' chars'
      : Array.isArray(value) ? value.length + ' item(s)' : 'structured';
    lines.push('  ' + key + ': [' + size + ' omitted from activity log]');
  }
  const otherCount = Object.keys(data).filter(k => !SCALAR_KEYS.includes(k as typeof SCALAR_KEYS[number]) &&
    !OMITTED_KEYS.test(k)).length;
  if (otherCount) lines.push('  other parameters: ' + otherCount + ' (details omitted)');
  if (!lines.length) return 'Arguments: (none)';
  return 'Arguments:\n' + redactTrace(lines.join('\n'), MAX_ARGUMENT_CHARS);
}
function allowedStatus(meta: Record<string, unknown>): string[] {
  const fields = [
    'exitCode','pid','durationMs','timedOut','cancelled','pending','jobId',
    'status','outputTruncated','commandExecuted','maxRuntimeMs','isComplete',
    'nextOffset','hasMore','totalLines',
  ];
  const out: string[] = [];
  for (const field of fields) {
    const value = meta[field];
    if (typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
      out.push(field + '=' + redactTrace(String(value), 180));
    }
  }
  const err = meta.error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (typeof e.code === 'string') out.push('error=' + redactTrace(e.code, 120));
    if (typeof e.message === 'string') out.push('reason=' + redactTrace(e.message, 480));
  }
  return out;
}
export function traceToolResult(tool: string, result: unknown): string {
  if (!result || typeof result !== 'object') return 'Result: unavailable';
  const r = result as Record<string, unknown>;
  const meta = r.structuredContent && typeof r.structuredContent === 'object'
    ? r.structuredContent as Record<string, unknown> : {};
  const status = r.isError ? 'FAILED' : meta.pending === true ? 'PENDING' : 'OK';
  const metadata = allowedStatus(meta);
  const lines = ['Result: ' + status + (metadata.length ? ' | ' + metadata.join(' | ') : '')];
  const contents = Array.isArray(r.content) ? r.content as Array<Record<string, unknown>> : [];
  const texts = contents.filter(c => c && c.type === 'text' && typeof c.text === 'string')
    .map(c => String(c.text));
  const raw = texts.join('\n');
  // Code Mode outputs can contain arbitrary source data and intentionally
  // filtered model results. Never copy even an error preview to agent logs.
  if (tool === 'code_mode') return redactTrace(lines.join('\n')+'\nSandbox result omitted from activity log.', MAX_TRACE_CHARS);
  if (raw.length) {
    if (SAFE_RESULT_TOOLS.has(tool)) {
      let output = raw;
      if (tool === 'run_command') {
        const position = raw.search(/\n(?:\[exit code|\[TIMEOUT|\[CANCELLED|--- stdout ---|--- stderr ---)/);
        if (position !== -1) output = raw.slice(position + 1);
        else if (raw.startsWith('$ ')) output = '[command omitted; inspect tool response for details]';
      }
      lines.push('Output preview (' + Math.min(output.length, MAX_RESULT_CHARS) +
        ' of ' + output.length + ' chars):\n' +
        redactTrace(output, r.isError ? MAX_RESULT_CHARS : 6_000));
    } else if (r.isError) {
      lines.push('Error preview:\n' + redactTrace(raw, 2_500));
    } else {
      lines.push('Response: ' + raw.length + ' chars returned (file/source payload not copied to activity log)');
    }
  } else if (contents.length) {
    lines.push('Response: ' + contents.length + ' non-text block(s), payload omitted');
  }
  return redactTrace(lines.join('\n'), MAX_TRACE_CHARS);
}
