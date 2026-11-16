# Relay admin, approved skills and actual model-token reporting

The relay has a responsive self-hosted admin dashboard at **/admin** with a left sidebar. All styles are served locally. Navigation includes Overview, Devices, Activity, Pairing, MCP Marketplace, Agent Skills, Private MCP links, OAuth clients and API keys. Existing pairing, private URL, OAuth, device pause/resume and plugin approval endpoints remain unchanged.

## Actual model token counts (not estimated)

MCP tools do **not** receive the model's prompt, generation or token usage from ChatGPT, Claude or other hosted clients. Tool-call counts, text byte lengths and execution duration are not reliable model token counts. The relay therefore **never fabricates model usage**.

A model client, SDK or backend that receives the provider's **real** usage fields can opt in to the separate reporting API after the model request finishes. The endpoint is never called from the agent, terminal, WebSocket routing, tool audit or MCP hot path.

1. Create a dedicated, revocable API key at **/auth/apikeys** (e.g. "Model usage reporter").
2. From a backend you trust, send a report for each finished model request using the provider's real `input_tokens` and `output_tokens`.
3. View the **Model token analytics** section at `/admin` and switch **Daily**, **Weekly** or **Monthly**. The chart uses UTC dates, including Monday-start weeks.

### Reporting API

`POST https://your-relay.example/api/usage/report`

Headers:

```http
Authorization: Bearer brc_ak_<your-revocable-API-key>
Content-Type: application/json
```

Example body (replace these example counts with real provider usage, **never** a guess):

```json
{
  "event_id": "model-request-006e71e4f9",
  "timestamp": 1794830400000,
  "provider": "openai",
  "model": "gpt-6",
  "input_tokens": 125000,
  "output_tokens": 37000
}
```

- `event_id`: unique within your relay account (8–128 URL-safe characters). Retrying the same event is idempotent and does **not** double-count.
- `timestamp`: optional Unix epoch **milliseconds** (UTC); defaults to relay receipt time, accepts the last 400 days.
- `provider` and `model`: identifiers (max 80 characters); no prompts or generated responses are accepted.
- `input_tokens` and `output_tokens`: actual nonnegative integer provider values, at least one positive; max 1 trillion each.
- Reports are protected by an existing account API key. No agent token, browser cookie or private MCP link can submit reports. Rate limit: 120 reports per minute, per API key in a relay process, with a maximum JSON body size of 8 KiB.
- Success returns HTTP **201** for first insert or **200** for a previously received event. Invalid credentials return **401**.
- Only the event ID, account ID, date, provider, model and token totals are stored; no user prompt, response, file contents or tool arguments are stored in this usage table.
- **SQLite:** dedicated `model_usage` table, indexed by account/day, unique account/event IDs. **MongoDB:** collection with unique `_id`, account/day index and TTL cleanup. Both retain up to 400 days of reported records, and only the selected 14 days / 12 weeks / 12 months are shown.
- If no events were received, the UI says **No model usage reported yet**. Values shown as M/B are display formatting, not estimates.

**ChatGPT limitation:** The ChatGPT hosted chat interface does not send full model input/output token usage to arbitrary MCP relays. Without an instrumented client/provider integration, the dashboard remains empty. A direct OpenAI API client that receives `usage` could submit it; the relay alone cannot retrieve historical ChatGPT chat tokens.

## Approved agent Skills

At **/admin/skills**, the relay owner can maintain reusable **SKILL.md** instruction packs, analogous to agent skills listed on [skills.sh](https://skills.sh). This is a relay-managed content library, not installation of ChatGPT's native Skills feature, and not a remote code execution mechanism.

- **Manual import:** Review a third-party skill's `SKILL.md`, paste it with a repository/skill ID and description, confirm approval. Works completely offline without a token.
- **Optional catalog:** skills.sh's official `/api/v1/` search and skill-detail API is protected by a short-lived **Vercel OIDC token**, not a general public API key. Set `BRC_SKILLS_API_TOKEN` only when a valid OIDC token is available; it expires and may need renewal. A typical self-hosted relay cannot browse that authenticated API without Vercel integration; manual import remains available.
- **AI discovery:** MCP clients can call `list_skills`, `read_skill`, `search_skills_catalog` and `request_skill_install`. The last one only files a request for owner review; it cannot approve or install automatically.
- **Account boundary:** Approved skill text and pending requests are scoped to the authenticated owner account in SQLite or MongoDB.
- **Safety:** Skill text is *untrusted third-party content*. It is returned as data/instructions for the AI to consider under its own higher-priority rules. This relay does not run `scripts/`, shell commands or code from skill archives. Installing executable MCP servers remains a separate explicit plugin-approval action.
- **Limits:** 32 text files/skill, 128 KiB total; no path traversal, no arbitrary remote URL fetch. skills.sh discovery uses a fixed endpoint, 6.5s timeout, 512 KiB response cap and a small 60s cache.

### Persistent storage

No manual schema migration is required for new installations: SQLite and MongoDB store initializers create the usage, approved-skills and pending-request schema/indexes alongside existing relay data. Keep your SQLite `/data` volume or persistent MongoDB storage across redeployments.

When MongoDB is selected with `MONGODB_URI`, the relay does not switch to SQLite on connection failure. New usage and skills data follows the same storage selection.

## Performance boundaries

- Tool calls do **not** write token-usage rows or read skill catalog entries automatically.
- The previous private MCP connection path looked up the same capability key **twice** in storage. The updated route does one fresh, uncached lookup **per HTTP request**; the next request after revocation is still denied.
- Device ownership/pause-state checks remain mandatory and awaited. Device last-seen writes after a completed call are background housekeeping and no longer hold up the returned result.
- There are no new external fonts, CDNs, frontend frameworks, analytics beacons or live polling in admin UI. The chart is plain server-rendered HTML/CSS, and only visiting the admin dashboard queries usage aggregates.
- **Zero model-usage DB I/O on tool execution is an architectural property**; zero total network latency is not possible. Client scheduling, model inference, WebSocket RTT and command execution still take time.

## Verification

Run from a checkout with dependencies properly installed:

```powershell
pnpm build
pnpm typecheck
node --test packages/relay/test/skills-usage.test.mjs
pnpm test:unit
pnpm test:agent
pnpm test:e2e
```

Optional `pnpm test:mongo` requires an actual isolated MongoDB test server. Standard suites exercise SQLite and compiled MongoDB code, but do not prove live MongoDB behavior when no database is available.
