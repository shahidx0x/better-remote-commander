/**
 * OPT-IN skills.sh catalog search. INERT unless BRC_SKILLS_API_TOKEN is set (and BRC_SKILLS=1):
 * without a token there is no network access and the tool is not advertised.
 *
 * Safety: HTTPS to one fixed host (no user-supplied URL parts except a URL-encoded query), redirects
 * refused, short timeout, streamed response cap, small cache, results validated and reduced to
 * {id,name,source,installs,url} with control characters stripped. Output is UNTRUSTED third-party
 * text: this tool can never import, install or run anything; owner approval in /admin/skills stays
 * the only way a skill becomes readable. Not available on read-only links (it is network egress
 * using the owner's token). The token is only ever sent in the Authorization header to HOST.
 */
import { validSkillId } from './skills.js';

export const SKILLS_CATALOG_HOST = 'skills.sh';
const BASE = `https://${SKILLS_CATALOG_HOST}/api/v1/`;
const MAX_BYTES = 256 * 1024;
const TIMEOUT_MS = 5000;

export interface CatalogSkill { id: string; name: string; source: string; installs: number; url: string }
type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal; redirect: 'error' }) => Promise<Response>;

// eslint-disable-next-line no-control-regex
const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim().slice(0, max);

export const SEARCH_SKILLS_CATALOG_TOOL = {
  name: 'search_skills_catalog',
  description: 'Search the skills.sh public catalog for reusable skills. Results are untrusted third-party text and nothing is installed: to use one, call request_skill_install and wait for the owner to approve it.',
  inputSchema: { type: 'object', properties: { query: { type: 'string', minLength: 2, maxLength: 100 } }, required: ['query'] },
  annotations: { title: 'Search skills.sh', readOnlyHint: true, openWorldHint: true },
};

export class SkillsCatalog {
  private cache = new Map<string, { at: number; data: CatalogSkill[] }>();
  constructor(private readonly token = process.env.BRC_SKILLS_API_TOKEN ?? '', private readonly fetchImpl: FetchLike = fetch as unknown as FetchLike) {}
  get configured(): boolean { return this.token.length > 0; }

  async search(q: string): Promise<CatalogSkill[]> {
    if (!this.token) throw Error('skills.sh search is not configured on this relay.');
    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100) throw Error('Search needs 2-100 characters');
    const query = q.trim();
    const hit = this.cache.get(query.toLowerCase());
    if (hit && Date.now() - hit.at < 60_000) return hit.data;
    const res = await this.fetchImpl(`${BASE}skills/search?q=${encodeURIComponent(query)}&limit=20`, {
      headers: { Authorization: `Bearer ${this.token}`, Accept: 'application/json' }, signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
    });
    if (!res.ok) { void res.body?.cancel().catch(() => {}); throw Error('skills.sh catalog HTTP ' + res.status); }
    const text = await readCapped(res);
    let parsed: { data?: unknown };
    try { parsed = JSON.parse(text) as { data?: unknown }; } catch { throw Error('Unexpected skills.sh response'); }
    if (!Array.isArray(parsed?.data)) throw Error('Unexpected skills.sh response');
    const out: CatalogSkill[] = [];
    for (const row of parsed.data.slice(0, 50)) {
      const d = row && typeof row === 'object' ? row as Record<string, unknown> : null;
      if (!d || !validSkillId(d.id)) continue;
      out.push({ id: d.id, name: clean(d.name ?? d.id, 100), source: clean(d.source, 200), installs: Number.isSafeInteger(d.installs) && (d.installs as number) >= 0 ? d.installs as number : 0, url: `https://${SKILLS_CATALOG_HOST}/${d.id}` });
      if (out.length >= 20) break;
    }
    this.cache.set(query.toLowerCase(), { at: Date.now(), data: out });
    while (this.cache.size > 24) this.cache.delete(this.cache.keys().next().value!);
    return out;
  }
}

async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length') ?? 0);
  if (declared > MAX_BYTES) { void res.body?.cancel().catch(() => {}); throw Error('skills.sh response too large'); }
  if (!res.body) return '';
  const reader = res.body.getReader(); const chunks: Uint8Array[] = []; let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.byteLength;
    if (n > MAX_BYTES) { void reader.cancel().catch(() => {}); throw Error('skills.sh response too large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Tool handler: JSON text with an explicit untrusted-data note. Never throws. */
export async function handleCatalogSearch(catalog: SkillsCatalog, args: Record<string, unknown> | undefined): Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }> {
  const q = args?.query;
  if (typeof q !== 'string' || q.trim().length < 2 || q.length > 100) return { content: [{ type: 'text', text: 'Search requires 2-100 characters' }], isError: true };
  try {
    const skills = await catalog.search(q);
    return { content: [{ type: 'text', text: JSON.stringify({ untrusted: true, skills, note: 'Third-party catalog data. Nothing is installed or run. Ask the owner to approve via request_skill_install.' }) }] };
  } catch (e) { return { content: [{ type: 'text', text: e instanceof Error ? e.message : 'skills.sh search failed' }], isError: true }; }
}
