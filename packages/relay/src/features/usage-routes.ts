/** Opt-in usage reporting + estimates wiring. Everything here is inert unless an owner API key reports usage
 * or BRC_MCP_TOKEN_ESTIMATES=1 produced data. */
import express, { type Express, type Request } from 'express';
import type { SqliteStore } from '../store/sqlite.js';
import { LoginLimiter } from '../auth/rate-limit.js';
import { validateUsageReport, usageTotals, formatTokens, utcDay, type UsageDay, type UsageTotals } from './usage.js';

const REPORTS_PER_MINUTE = 60;

export function registerUsageRoutes(app: Express, store: SqliteStore, log: (level: string, msg: string) => void): void {
  const rate = new Map<string, { at: number; count: number }>();
  const badKeys = new LoginLimiter(20, 5 * 60_000);
  // Only an existing, revocable owner API key (brc_ak_...) may submit usage. OAuth tokens, device tokens and
  // private MCP links are deliberately NOT accepted.
  app.post('/api/usage/report', express.json({ limit: '8kb' }), (req: Request, res) => {
    const ip = `usage:${req.ip}`;
    if (badKeys.locked(ip)) return res.status(429).json({ error: 'too_many_requests' });
    const h = req.get('authorization') ?? '';
    const raw = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
    const key = /^brc_ak_[A-Za-z0-9_-]{20,80}$/.test(raw) ? store.getApiKey(raw) : undefined;
    if (!key) { badKeys.fail(ip); return res.status(401).json({ error: 'invalid_api_key' }); }
    const now = Date.now();
    const r = rate.get(key.prefix);
    const w = r && now - r.at < 60_000 ? r : { at: now, count: 0 };
    w.count++; rate.set(key.prefix, w);
    if (rate.size > 1000) for (const [k, v] of rate) if (now - v.at > 60_000) rate.delete(k);
    if (w.count > REPORTS_PER_MINUTE) { res.setHeader('Retry-After', '60'); return res.status(429).json({ error: 'rate_limited' }); }
    try {
      const rec = validateUsageReport(req.body, key.user_id, now);
      const recorded = store.recordTokenUsage(rec);
      return res.status(recorded ? 201 : 200).json({ recorded, duplicate: !recorded, source: 'provider-reported', utc_day: rec.day });
    } catch (e) {
      log('warn', 'usage report rejected');
      return res.status(400).json({ error: 'invalid_usage_report', message: e instanceof Error ? e.message : 'invalid' });
    }
  });
}

const totalsRow = (label: string, t: UsageTotals) => `<tr><td>${label}</td><td>${formatTokens(t.input)}</td><td>${formatTokens(t.output)}</td><td>${formatTokens(t.total)}</td><td>${t.reports}</td></tr>`;
const table = (title: string, note: string, days: UsageDay[], countLabel: string) => {
  const t = usageTotals(days);
  return `<div class="section"><div class="section-head"><div><h2>${title}</h2><p>${note}</p></div></div><div class="panel table-wrap" style="padding:0"><table><thead><tr><th>Period (UTC)</th><th>Input</th><th>Output</th><th>Total</th><th>${countLabel}</th></tr></thead><tbody>${totalsRow('Today', t.day)}${totalsRow('Last 7 days', t.week)}${totalsRow('Last 30 days', t.month)}</tbody></table></div></div>`;
};
/** Read-only usage tables for the admin page; empty string when there is no data. */
export function usageSection(store: SqliteStore, userId: string): string {
  const since = utcDay(Date.now() - 29 * 86_400_000);
  const reported = store.usageDays(userId, since), est = store.mcpEstimateDays(userId, since);
  return (reported.length ? table('Model usage', 'Provider-reported token counts submitted with your API key.', reported, 'Reports') : '')
    + (est.length ? table('MCP token estimates', 'Approximate tokens in MCP tool text only (not model usage or billing). Aggregated counts; no content is stored.', est, 'Calls') : '');
}
