/** Provider-reported model usage (owner API key only) and separate, labeled MCP-text estimates (opt-in). */
export interface UsageRecord { id: string; user_id: string; ts: number; day: string; provider: string; model: string; input_tokens: number; output_tokens: number }
export interface UsageDay { day: string; input_tokens: number; output_tokens: number; reports: number }
/** Aggregated counts only. Never tool names, arguments or results. */
export interface McpEstimateDelta { user_id: string; day: string; input_tokens: number; output_tokens: number; calls: number; partial_calls: number;
  /** Exact UTF-8 bytes of agent WebSocket call/result frames (no content). Optional: absent = 0. */
  to_agent_bytes?: number; from_agent_bytes?: number;
  /** Calls counted with a recognised model-hint encoding vs the universal fallback. */
  matched_calls?: number; universal_calls?: number }
export interface McpEstimateExtra { partial_calls: number; to_agent_bytes: number; from_agent_bytes: number; matched_calls: number; universal_calls: number }

const DAY = 86_400_000;
export const utcDay = (t: number) => new Date(Math.floor(t / DAY) * DAY).toISOString().slice(0, 10);

export function validateUsageReport(x: unknown, user: string, now = Date.now()): UsageRecord {
  if (!x || typeof x !== 'object' || Array.isArray(x)) throw Error('Expected a JSON object');
  const r = x as Record<string, unknown>;
  if (typeof r.event_id !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(r.event_id)) throw Error('Invalid event_id');
  const ts = r.timestamp === undefined ? now : r.timestamp;
  if (typeof ts !== 'number' || !Number.isSafeInteger(ts) || ts > now + 300_000 || ts < now - 400 * DAY) throw Error('timestamp must be milliseconds within 400 days');
  const count = (key: string) => { const v = r[key]; if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0 || v > 1e12) throw Error('Invalid ' + key); return v; };
  const input_tokens = count('input_tokens'), output_tokens = count('output_tokens');
  if (!input_tokens && !output_tokens) throw Error('No tokens supplied');
  const str = (key: string) => { const v = r[key]; if (typeof v !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,79}$/.test(v)) throw Error('Invalid ' + key); return v; };
  return { id: r.event_id, user_id: user, ts, day: utcDay(ts), provider: str('provider'), model: str('model'), input_tokens, output_tokens };
}

export interface UsageTotals { input: number; output: number; total: number; reports: number }
/** Day / last-7-days / last-30-days totals (UTC), from per-day aggregates. */
export function usageTotals(days: UsageDay[], now = Date.now()): { day: UsageTotals; week: UsageTotals; month: UsageTotals } {
  const sum = (from: number): UsageTotals => {
    const t = { input: 0, output: 0, total: 0, reports: 0 }; const since = utcDay(from);
    for (const d of days) if (d.day >= since) { t.input += d.input_tokens; t.output += d.output_tokens; t.total += d.input_tokens + d.output_tokens; t.reports += d.reports; }
    return t;
  };
  return { day: sum(now), week: sum(now - 6 * DAY), month: sum(now - 29 * DAY) };
}
export function formatTokens(n: number): string {
  return n >= 1e9 ? (n / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B' : n >= 1e6 ? (n / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'K' : String(n);
}
