/** A deliberately narrow diagnostic summary for local console activity.
 * Never print command arguments, raw stderr, arbitrary build output or source code here.
 * The full bounded result remains available through the existing tool/job APIs. */
export interface CommandActivityResult {
  exitCode: number | null;
  detail: string;
}
export function summarizeCommandActivity(result: unknown): CommandActivityResult {
  const r = result && typeof result === 'object' ? result as Record<string, unknown> : {};
  const meta = r.structuredContent && typeof r.structuredContent === 'object'
    ? r.structuredContent as Record<string, unknown> : {};
  const exitCode = typeof meta.exitCode === 'number' && Number.isSafeInteger(meta.exitCode)
    ? meta.exitCode : null;
  if (meta.cancelled === true) return {exitCode, detail:'cancelled by request'};
  if (meta.timedOut === true) return {exitCode, detail:'hard runtime limit reached'};
  if (!r.isError) return {exitCode, detail:exitCode === null ? 'finished' : 'exit '+exitCode};
  const content = Array.isArray(r.content) ? r.content : [];
  const text = content.filter(c => c && typeof c === 'object' &&
    (c as Record<string,unknown>).type === 'text')
    .map(c => String((c as Record<string,unknown>).text ?? '')).join('\n').slice(-160_000);
  // Only whitelist machine-readable numbers and diagnostic identifiers.
  const eslint = /^\s*(\d{1,7}):(\d{1,5})\s+error\s+[^\r\n]{0,240}?\b([a-z][a-z\d-]*\/[a-z][a-z\d-]*)\s*$/mi.exec(text);
  if (eslint) return {exitCode,detail:'exit '+(exitCode ?? '?')+
    ' | ESLint '+eslint[1]+':'+eslint[2]+' '+eslint[3].slice(0,75)};
  const ts = /(?:^|\n)[^\r\n]{0,160}?\((\d{1,7}),(\d{1,5})\):\s*error\s+(TS\d{3,6})\b/i.exec(text);
  if (ts) return {exitCode,detail:'exit '+(exitCode ?? '?')+
    ' | TypeScript '+ts[3].toUpperCase()+' at '+ts[1]+':'+ts[2]};
  const genericTs = /\berror\s+(TS\d{3,6})\b/i.exec(text);
  if (genericTs) return {exitCode,detail:'exit '+(exitCode ?? '?')+
    ' | TypeScript '+genericTs[1].toUpperCase()};
  return {exitCode,detail:(exitCode === null ? 'failed' : 'exit '+exitCode)+
    ' | inspect get_job for the full error'};
}
