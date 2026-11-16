# Relay admin, approved skills, automatic MCP estimates, and optional provider reports

The relay has a responsive self-hosted admin dashboard at **/admin** with a left sidebar. All styles are served locally. Navigation includes Overview, Devices, Activity, Pairing, MCP Marketplace, Agent Skills, Private MCP links, OAuth clients and API keys. Existing pairing, private URL, OAuth, device pause/resume and plugin approval endpoints remain unchanged.

## Automatic MCP traffic estimates (no ChatGPT usage API needed)

BRC can now estimate **only text that actually crosses its own MCP tools**, without asking ChatGPT to report usage.

- **Estimated model input:** text of MCP tool **results returned to the AI client** (including failures and owner-approved skill content).
- **Estimated model output:** tool name and structured **arguments received from the AI client**.
- **One offline tokenizer package for any MCP client:** `gpt-tokenizer` defaults to `o200k_base` for a universal **approximation**. When a client deliberately sets `X-BRC-Model: gpt-4-turbo`, `gpt-4.1`, `gpt-5`, `gpt-oss-120b` etc., BRC selects the corresponding supported OpenAI encoding (`cl100k_base`, `o200k_base`, `o200k_harmony`) inside the worker. Unknown/Claude/Gemini/DeepSeek/Llama/Qwen names fall back to `o200k_base` without any provider claim. Model hints are not verified; a matching encoding still does **not** equal actual model billing tokens. No cloud counting call, tokenizer download, or additional dependency is required.
- **Automatic:** enabled by default for both OAuth MCP and private capability URLs. Uses the authenticated owning account, including read-only connections.
- **Dashboard:** `/admin` displays estimated input/output, combined text traffic, actual MCP call count, matched-vs-universal encoding call counts, and exact **agent WebSocket tool payload bytes sent/received** (frames only, excluding WS framing and relay-only tools), organized daily (14 days), weekly (12 weeks), monthly (12 months). The separate optional actual provider-reported section is not summed with MCP estimates.
- **Persistence:** SQLite `mcp_estimate_daily` / MongoDB `mcp_estimate_daily` contain **only** per-account, per-UTC-day aggregated numeric counts (`input_tokens`, `output_tokens`, `calls`, `partial_calls`, `to_agent_bytes`, `from_agent_bytes`, `matched_calls`, `universal_calls`). An additive SQLite migration preserves existing counters. No prompts, file paths, tool arguments/results, chat messages, model IDs or passwords are stored in this table. Data expires after roughly 400 days.
- **Performance:** token estimation is deferred and BPE executes in a single worker thread. Exact tool-call/result WebSocket frame byte lengths are captured from frames already serialized by BRC, with only an extra local byte-length check/counter update. Database increments are batched every ~4 seconds, **never awaited by tool responses**. Nonzero CPU, event-loop scheduling and memory overhead remain possible; this is not a zero-latency guarantee.
- **Backpressure:** at most 64 outstanding events are sent to the worker. At most 524,288 characters of text per direction are processed for one event. Excess, image/video/audio/base64 and other non-text payloads are **marked incomplete**, never treated as fake text tokens. The dashboard reports incomplete call counts. No retries of the original tool operation are made.
- **Optional opt-out:** set `BRC_MCP_TOKEN_ESTIMATES=0` on the relay (not the agent) to disable the worker and its automatic accounting, without affecting existing stored totals.
- **What it cannot count:** ordinary ChatGPT messages, system/developer prompts, hidden reasoning, unseen tool schemas reused internally by ChatGPT, model-specific overhead, or full images/audio. It cannot infer actual billable ChatGPT tokens or historical conversations. Do not add these estimates to actual provider usage; they overlap when a provider reports the same tool traffic.

No plugin, API key, ChatGPT configuration, or additional MCP tool is required. Counts begin only after a call crosses the **updated relay**. Restart/redeploy the relay to activate this feature. This does not report or estimate full conversational/model usage.

### Optional model selection for clients that support HTTP headers

A client which actually knows its model may add the **optional** HTTP header `X-BRC-Model: gpt-4-turbo` (or `gpt-4.1`, `gpt-5`, `gpt-oss-120b`, etc.) to each authenticated MCP request. BRC then chooses the supported matching **OpenAI text encoding** offline. Clients which cannot add the header, or use Claude/Gemini/DeepSeek/Qwen/Llama/unknown models, are still counted with the universal fallback. The header is untrusted client metadata, not proof of model use; model-matched tokens are still **estimated MCP text tokens**, not the complete model usage. Never infer the model from an agent/device name.

If an instrumented **model host** (including an OpenAI/Anthropic/Gemini API backend or a local inference engine) exposes actual request usage, submit it via the existing authenticated `POST /api/usage/report` endpoint. Actual reports remain separate on the dashboard; do not sum them with MCP estimates or attempt a token-counting provider API call inside MCP execution.

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

**ChatGPT limitation:** The ChatGPT hosted chat interface does not send full model input/output token usage to arbitrary MCP relays. Without an instrumented model client, the **provider-reported** section remains empty, while the **automatic MCP traffic estimates** section still updates when tools are called. A direct OpenAI API client that receives `usage` may submit it; the relay alone cannot retrieve historical ChatGPT chat tokens.

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

- Tool calls do **not** await token counting, database writes or external analytics calls. A minimal notification schedules background BPE work; daily aggregate DB updates occur every ~4 seconds.
- The previous private MCP connection path looked up the same capability key **twice** in storage. The updated route does one fresh, uncached lookup **per HTTP request**; the next request after revocation is still denied.
- Device ownership/pause-state checks remain mandatory and awaited. Device last-seen writes after a completed call are background housekeeping and no longer hold up the returned result.
- There are no new external fonts, CDNs, frontend frameworks, analytics beacons or live polling in admin UI. The chart is plain server-rendered HTML/CSS, and only visiting the admin dashboard queries usage aggregates.
- **No awaited token-usage DB I/O on tool execution** is an architectural property. Background capture and worker/DB activity still use finite CPU and memory resources, so absolute zero overhead is impossible. Client scheduling, model inference, WebSocket RTT and command execution still take time.

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
