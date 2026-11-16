/**
 * Background MCP-visible token estimates.
 * No counting, disk writes, network calls or waiting in MCP request handlers:
 * jobs are queued with setImmediate, tokenized in one worker and persisted in
 * 4-second batches. Estimates are NOT complete ChatGPT/model usage.
 */
import { Worker } from 'node:worker_threads';
import type { RelayStore } from '../store/types.js';
import type { McpEstimateDelta } from './usage.js';

const MAX_CHARS_PER_DIRECTION = 524_288;
const MAX_OUTSTANDING = 64;
const FLUSH_INTERVAL_MS = 4000;
const OMIT_KEYS = /^(?:data|base64|blob|binary|bytes|image_data|audio_data)$/i;

interface TextBuffer {
  parts: string[];
  remaining: number;
  partial: boolean;
  seen: WeakSet<object>;
}
function newBuffer(): TextBuffer {
  return {parts: [], remaining: MAX_CHARS_PER_DIRECTION, partial: false, seen: new WeakSet()};
}
function addText(b: TextBuffer, s: string): void {
  if (!s) return;
  if (b.remaining < s.length) b.partial = true;
  if (b.remaining <= 0) return;
  const slice = s.length > b.remaining ? s.slice(0, b.remaining) : s;
  b.parts.push(slice);
  b.remaining -= slice.length;
}
function looksBinary(s: string): boolean {
  if (/^data:(?:image|audio|video|application\/octet-stream)\//i.test(s.slice(0,90))) return true;
  // Long encoded binary payloads are not model-text tokens. Check only a prefix.
  return s.length > 4096 && /^[A-Za-z0-9+/=\r\n]{2048}$/.test(s.slice(0, 2048));
}
function walk(v: unknown, b: TextBuffer, depth = 0): void {
  if (b.remaining <= 0) { b.partial = true; return; }
  if (v === null || v === undefined) return;
  if (typeof v === 'string') {
    if (looksBinary(v)) { b.partial = true; return; }
    addText(b, JSON.stringify(v.slice(0, b.remaining)));
    if (v.length > MAX_CHARS_PER_DIRECTION) b.partial = true;
    return;
  }
  if (typeof v === 'number' || typeof v === 'boolean') { addText(b, String(v)); return; }
  if (typeof v !== 'object' || depth > 12 || ArrayBuffer.isView(v) || v instanceof ArrayBuffer) { b.partial = true; return; }
  if (b.seen.has(v)) { b.partial = true; return; }
  b.seen.add(v);
  if (Array.isArray(v)) {
    addText(b, '[');
    for (let i=0; i < Math.min(512,v.length); i++) { walk(v[i],b,depth+1); addText(b,','); }
    if (v.length > 512) b.partial = true;
    addText(b, ']');
    return;
  }
  const obj = v as Record<string,unknown>;
  if (obj.type && typeof obj.type === 'string' && ['image','audio','video','resource_link'].includes(obj.type)) {
    b.partial = true; return;
  }
  addText(b,'{');
  let n=0;
  for (const key in obj) {
    if (!Object.hasOwn(obj,key)) continue;
    if (n++ >= 512) { b.partial=true; break; }
    if (OMIT_KEYS.test(key)) { b.partial=true; continue; }
    addText(b,JSON.stringify(key)+':');
    walk(obj[key],b,depth+1);
    addText(b,',');
  }
  addText(b,'}');
}

export function visibleMcpText(tool: string, args: unknown, result: unknown): {
  modelInputText: string; modelOutputText: string; partial: boolean
} {
  const output = newBuffer();
  addText(output,tool + '(');
  walk(args ?? {}, output);
  addText(output,')');
  const input = newBuffer();
  const row=result as { content?: unknown; structuredContent?: unknown } | null;
  const blocks = row && Array.isArray(row.content) ? row.content : [];
  if (!row || (!Array.isArray(row.content) && row.structuredContent === undefined)) input.partial=true;
  let foundText=false;
  for (const block of blocks) {
    if (!block || typeof block !== 'object') continue;
    const b=block as {type?:unknown;text?:unknown};
    if (b.type === 'text' && typeof b.text === 'string') {
      foundText=true;
      if (looksBinary(b.text)) { input.partial=true; continue; }
      addText(input,b.text);
      addText(input,'\n');
    } else {
      // Images/audio/resource links cannot be converted to model token counts
      // merely by counting their base64 transport representation.
      input.partial=true;
    }
  }
  if (!foundText && row?.structuredContent !== undefined)
    walk(row.structuredContent,input);
  return {
    modelInputText:input.parts.join(''),
    modelOutputText:output.parts.join(''),
    partial:input.partial || output.partial,
  };
}

type WorkerReply = {id:number;row:McpEstimateDelta};
type JobIdentity = {user_id:string;day:string};

export class McpTrafficEstimator {
  readonly enabled: boolean;
  get active():boolean { return this.enabled && !!this.worker; }
  private worker?: Worker;
  private interval?: NodeJS.Timeout;
  private nextId = 0;
  private outstanding = new Map<number,JobIdentity>();
  private pending = new Map<string,McpEstimateDelta>();
  private writing: Promise<void> = Promise.resolve();
  private stopping = false;
  private warned = false;
  constructor(private readonly store:RelayStore, private readonly log:(level:string,message:string)=>void,
    enabled = process.env.BRC_MCP_TOKEN_ESTIMATES !== '0') {
    this.enabled=enabled;
    if (!enabled) return;
    try {
      this.worker=new Worker(new URL('./mcp-estimate-worker.js',import.meta.url));
      this.worker.unref();
      this.worker.on('message',(reply:WorkerReply)=>this.onWorkerResult(reply));
      this.worker.on('error',()=>this.workerFailed());
      this.worker.on('exit',(code)=>{if(code!==0&&!this.stopping)this.workerFailed()});
    } catch {
      this.workerFailed();
    }
    this.interval=setInterval(()=>{void this.flush()},FLUSH_INTERVAL_MS);
    this.interval.unref();
  }
  private merge(delta:McpEstimateDelta):void {
    const key=delta.user_id+'|'+delta.day;
    const existing=this.pending.get(key);
    if (existing) {
      existing.input_tokens+=delta.input_tokens;
      existing.output_tokens+=delta.output_tokens;
      existing.calls+=delta.calls;
      existing.partial_calls+=delta.partial_calls;
      existing.to_agent_bytes+=delta.to_agent_bytes;
      existing.from_agent_bytes+=delta.from_agent_bytes;
      existing.matched_calls+=delta.matched_calls;
      existing.universal_calls+=delta.universal_calls;
    } else this.pending.set(key,{...delta});
    // Only the timer or explicit close flushes writes, avoiding retry loops on DB outage.
  }
  private missed(job:JobIdentity):void {
    this.merge({...job,input_tokens:0,output_tokens:0,calls:1,partial_calls:1,
      to_agent_bytes:0,from_agent_bytes:0,matched_calls:0,universal_calls:0});
  }
  private workerFailed():void {
    if (!this.worker && this.warned) return;
    this.worker=undefined;
    for (const identity of this.outstanding.values())this.missed(identity);
    this.outstanding.clear();
    if (!this.warned) {
      this.warned=true;
      this.log('warn','MCP token estimator worker unavailable; token estimates may be incomplete. Tool execution remains unaffected.');
    }
  }
  private onWorkerResult(reply:WorkerReply):void {
    const identity=this.outstanding.get(reply.id);
    if (!identity)return;
    this.outstanding.delete(reply.id);
    const r=reply.row;
    if (!r || !Number.isSafeInteger(r.input_tokens) || !Number.isSafeInteger(r.output_tokens) ||
        r.input_tokens<0 || r.output_tokens<0) return this.missed(identity);
    this.merge({
      user_id:identity.user_id,day:identity.day,
      input_tokens:r.input_tokens,output_tokens:r.output_tokens,calls:1,partial_calls:r.partial_calls ? 1 : 0,
      to_agent_bytes:0,from_agent_bytes:0,
      matched_calls:r.matched_calls ? 1 : 0,universal_calls:r.universal_calls ? 1 : 0
    });
  }
  /** Already-serialized agent WebSocket frames: exact payload bytes, not full HTTP/WS framing.
   * O(1) aggregate, batched with estimates; no tool-content persistence.
   */
  trackWireBytes(userId:string,direction:'to-agent'|'from-agent',bytes:number):void {
    if (!this.enabled || this.stopping || !Number.isSafeInteger(bytes) || bytes<0) return;
    const day=new Date().toISOString().slice(0,10);
    this.merge({user_id:userId,day,input_tokens:0,output_tokens:0,calls:0,
      partial_calls:0,to_agent_bytes:direction==='to-agent'?bytes:0,
      from_agent_bytes:direction==='from-agent'?bytes:0,matched_calls:0,universal_calls:0});
  }
  /** Called after tool completion; never awaited by the MCP handler. */
  track(userId:string,tool:string,args:unknown,result:unknown,modelHint?:string):void {
    if (!this.enabled || this.stopping)return;
    const identity={user_id:userId,day:new Date().toISOString().slice(0,10)};
    if (!this.worker || this.outstanding.size >= MAX_OUTSTANDING) {
      this.missed(identity); return;
    }
    const id=++this.nextId;
    this.outstanding.set(id,identity);
    // The completed tool response can proceed before text extraction or BPE work.
    setImmediate(()=>{
      const job=this.outstanding.get(id);
      if (!job)return;
      try {
        const data=visibleMcpText(tool,args,result);
        this.worker?.postMessage({
          id,...job,model_input_text:data.modelInputText,
          model_output_text:data.modelOutputText,partial:data.partial,
          model_hint:modelHint
        });
        if (!this.worker) {this.outstanding.delete(id);this.missed(job);}
      } catch {
        this.outstanding.delete(id);
        this.missed(job);
      }
    });
  }
  /** Queryable database snapshots may lag live traffic by the flush interval. */
  async flush():Promise<void> {
    if (!this.pending.size) { await this.writing; return; }
    const batch=[...this.pending.values()];
    this.pending.clear();
    this.writing=this.writing.then(async()=>{
      try { await this.store.recordMcpEstimates(batch); }
      catch {
        for (const row of batch)this.merge(row);
        if (!this.warned) {this.warned=true;this.log('warn','MCP token estimates could not be saved; will retry during next flush.');}
      }
    });
    await this.writing;
  }
  async close():Promise<void> {
    if (!this.enabled)return;
    this.stopping=true;
    if (this.interval)clearInterval(this.interval);
    const deadline=Date.now()+3500;
    while (this.outstanding.size && Date.now()<deadline) {
      await new Promise<void>(resolve=>setTimeout(resolve,15));
    }
    for(const identity of this.outstanding.values())this.missed(identity);
    this.outstanding.clear();
    await this.flush();
    if (this.worker) await this.worker.terminate();
  }
}
