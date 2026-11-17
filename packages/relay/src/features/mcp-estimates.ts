/**
 * OPT-IN (BRC_MCP_TOKEN_ESTIMATES=1) estimates of tokens in MCP-visible text. OFF by default.
 * - Tool arguments/results are tokenized in a worker thread and only integer counts leave it;
 *   text is never stored or logged. Only per user/UTC-day aggregates are persisted.
 * - track() never throws, never awaits, never touches the DB: work is queued with setImmediate,
 *   results are merged in memory and written in batches. Failures only mark the day "partial".
 * These are NOT complete model usage.
 */
import { Worker } from 'node:worker_threads';
import type { SqliteStore } from '../store/sqlite.js';
import { utcDay, type McpEstimateDelta } from './usage.js';

const MAX_CHARS = 262_144;
const MAX_OUTSTANDING = 64;
const FLUSH_INTERVAL_MS = 4000;
const OMIT_KEYS = /^(?:data|base64|blob|binary|bytes|image_data|audio_data)$/i;

interface Buf { parts: string[]; remaining: number; partial: boolean; seen: WeakSet<object> }
const newBuf = (): Buf => ({ parts: [], remaining: MAX_CHARS, partial: false, seen: new WeakSet() });
function add(b: Buf, s: string): void {
  if (!s) return;
  if (b.remaining < s.length) b.partial = true;
  if (b.remaining <= 0) return;
  const slice = s.length > b.remaining ? s.slice(0, b.remaining) : s;
  b.parts.push(slice); b.remaining -= slice.length;
}
const looksBinary = (s: string) => /^data:(?:image|audio|video|application\/octet-stream)\//i.test(s.slice(0, 90)) || (s.length > 4096 && /^[A-Za-z0-9+/=\r\n]{2048}$/.test(s.slice(0, 2048)));
function walk(v: unknown, b: Buf, depth = 0): void {
  if (b.remaining <= 0) { b.partial = true; return; }
  if (v === null || v === undefined) return;
  if (typeof v === 'string') { if (looksBinary(v)) { b.partial = true; return; } add(b, JSON.stringify(v.slice(0, b.remaining))); return; }
  if (typeof v === 'number' || typeof v === 'boolean') { add(b, String(v)); return; }
  if (typeof v !== 'object' || depth > 12 || ArrayBuffer.isView(v) || v instanceof ArrayBuffer || b.seen.has(v)) { b.partial = true; return; }
  b.seen.add(v);
  if (Array.isArray(v)) {
    add(b, '[');
    for (let i = 0; i < Math.min(512, v.length); i++) { walk(v[i], b, depth + 1); add(b, ','); }
    if (v.length > 512) b.partial = true;
    add(b, ']'); return;
  }
  const obj = v as Record<string, unknown>;
  if (typeof obj.type === 'string' && ['image', 'audio', 'video', 'resource_link'].includes(obj.type)) { b.partial = true; return; }
  add(b, '{'); let n = 0;
  for (const key in obj) {
    if (!Object.hasOwn(obj, key)) continue;
    if (n++ >= 512) { b.partial = true; break; }
    if (OMIT_KEYS.test(key)) { b.partial = true; continue; }
    add(b, JSON.stringify(key) + ':'); walk(obj[key], b, depth + 1); add(b, ',');
  }
  add(b, '}');
}

/** Direction is from the model's perspective: tool results are model input, tool arguments are model output. */
export function visibleMcpText(tool: string, args: unknown, result: unknown): { modelInputText: string; modelOutputText: string; partial: boolean } {
  const out = newBuf(); add(out, tool + '('); walk(args ?? {}, out); add(out, ')');
  const inp = newBuf();
  const row = result as { content?: unknown; structuredContent?: unknown } | null;
  const blocks = row && Array.isArray(row.content) ? row.content : [];
  if (!row || (!Array.isArray(row.content) && row.structuredContent === undefined)) inp.partial = true;
  let found = false;
  for (const block of blocks) {
    const b = block as { type?: unknown; text?: unknown } | null;
    if (b && b.type === 'text' && typeof b.text === 'string') {
      found = true;
      if (looksBinary(b.text)) { inp.partial = true; continue; }
      add(inp, b.text); add(inp, '\n');
    } else inp.partial = true;
  }
  if (!found && row?.structuredContent !== undefined) walk(row.structuredContent, inp);
  return { modelInputText: inp.parts.join(''), modelOutputText: out.parts.join(''), partial: inp.partial || out.partial };
}

type Reply = { id: number; input: number; output: number; partial: boolean; matched?: boolean };
type Job = { user_id: string; day: string };

export const mcpEstimatesEnabled = (env: NodeJS.ProcessEnv = process.env): boolean => env.BRC_MCP_TOKEN_ESTIMATES === '1';

export class McpTrafficEstimator {
  readonly enabled: boolean;
  get active(): boolean { return this.enabled && !!this.worker; }
  private worker?: Worker;
  private interval?: NodeJS.Timeout;
  private nextId = 0;
  private outstanding = new Map<number, Job>();
  private pending = new Map<string, McpEstimateDelta>();
  private stopping = false;
  private warned = false;
  constructor(private readonly store: SqliteStore, private readonly log: (level: string, message: string) => void, enabled = mcpEstimatesEnabled()) {
    this.enabled = enabled;
    if (!enabled) return;
    try {
      this.worker = new Worker(new URL('./mcp-estimate-worker.js', import.meta.url));
      this.worker.unref();
      this.worker.on('message', (r: Reply) => this.onResult(r));
      this.worker.on('error', () => this.workerFailed());
      this.worker.on('exit', (code) => { if (code !== 0 && !this.stopping) this.workerFailed(); });
    } catch { this.workerFailed(); }
    this.interval = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    this.interval.unref();
  }
  private merge(d: McpEstimateDelta): void {
    const key = d.user_id + '|' + d.day;
    const e = this.pending.get(key);
    if (e) {
      e.input_tokens += d.input_tokens; e.output_tokens += d.output_tokens; e.calls += d.calls; e.partial_calls += d.partial_calls;
      e.to_agent_bytes = (e.to_agent_bytes ?? 0) + (d.to_agent_bytes ?? 0); e.from_agent_bytes = (e.from_agent_bytes ?? 0) + (d.from_agent_bytes ?? 0);
      e.matched_calls = (e.matched_calls ?? 0) + (d.matched_calls ?? 0); e.universal_calls = (e.universal_calls ?? 0) + (d.universal_calls ?? 0);
    }
    else this.pending.set(key, { ...d });
  }
  private missed(job: Job): void { this.merge({ ...job, input_tokens: 0, output_tokens: 0, calls: 1, partial_calls: 1 }); }
  private workerFailed(): void {
    this.worker = undefined;
    for (const j of this.outstanding.values()) this.missed(j);
    this.outstanding.clear();
    if (!this.warned) { this.warned = true; this.log('warn', 'MCP token estimator worker unavailable; estimates may be incomplete. Tool execution is unaffected.'); }
  }
  private onResult(r: Reply): void {
    const job = this.outstanding.get(r?.id);
    if (!job) return;
    this.outstanding.delete(r.id);
    if (!Number.isSafeInteger(r.input) || !Number.isSafeInteger(r.output) || r.input < 0 || r.output < 0) return this.missed(job);
    this.merge({ ...job, input_tokens: r.input, output_tokens: r.output, calls: 1, partial_calls: r.partial ? 1 : 0, matched_calls: r.matched ? 1 : 0, universal_calls: r.matched ? 0 : 1 });
  }
  /**
   * Exact UTF-8 payload bytes of an agent call/result frame (DeviceHub.onWireTraffic). O(1) in-memory
   * aggregate, written in batches with the estimates. Counts only; never throws; no-op when disabled.
   */
  trackWireBytes(userId: string, direction: 'to-agent' | 'from-agent', bytes: number): void {
    try {
      if (!this.enabled || this.stopping || !Number.isSafeInteger(bytes) || bytes < 0) return;
      this.merge({ user_id: userId, day: utcDay(Date.now()), input_tokens: 0, output_tokens: 0, calls: 0, partial_calls: 0,
        to_agent_bytes: direction === 'to-agent' ? bytes : 0, from_agent_bytes: direction === 'from-agent' ? bytes : 0 });
    } catch { /* never affect tool execution */ }
  }
  /** Called after tool completion; fire-and-forget, never throws. modelHint is an unverified X-BRC-Model value. */
  track(userId: string, tool: string, args: unknown, result: unknown, modelHint?: string): void {
    try {
      if (!this.enabled || this.stopping) return;
      const job = { user_id: userId, day: utcDay(Date.now()) };
      if (!this.worker || this.outstanding.size >= MAX_OUTSTANDING) { this.missed(job); return; }
      const id = ++this.nextId;
      this.outstanding.set(id, job);
      setImmediate(() => {
        if (!this.outstanding.has(id)) return;
        try {
          const t = visibleMcpText(tool, args, result);
          if (!this.worker) { this.outstanding.delete(id); this.missed(job); return; }
          this.worker.postMessage({ id, model_input_text: t.modelInputText, model_output_text: t.modelOutputText, partial: t.partial, model_hint: typeof modelHint === 'string' ? modelHint.slice(0, 100) : undefined });
        } catch { this.outstanding.delete(id); this.missed(job); }
      });
    } catch { /* never affect tool execution */ }
  }
  /** Persist aggregates. Snapshots may lag live traffic by the flush interval. */
  flush(): void {
    if (!this.pending.size) return;
    const batch = [...this.pending.values()];
    this.pending.clear();
    try { this.store.recordMcpEstimates(batch); }
    catch {
      for (const r of batch) this.merge(r);
      if (!this.warned) { this.warned = true; this.log('warn', 'MCP token estimates could not be saved; will retry.'); }
    }
  }
  async close(): Promise<void> {
    if (!this.enabled) return;
    this.stopping = true;
    if (this.interval) clearInterval(this.interval);
    const deadline = Date.now() + 2000;
    while (this.outstanding.size && Date.now() < deadline) await new Promise<void>((r) => setTimeout(r, 15));
    for (const j of this.outstanding.values()) this.missed(j);
    this.outstanding.clear();
    this.flush();
    if (this.worker) await this.worker.terminate();
  }
}
