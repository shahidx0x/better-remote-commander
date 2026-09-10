# brc-relay

Relay server for **Better Remote Commander** — the self-hosted bridge between AI clients (Claude, ChatGPT) and your
machines running [`brc-agent`](https://www.npmjs.com/package/brc-agent). One process, SQLite, your domain.

Doors it exposes:
- `/mcp` — remote MCP (Streamable HTTP) with OAuth 2.0 (PKCE, dynamic client registration) or API-key bearer auth
- `/api/*` + `/openapi.json` — REST for ChatGPT GPT Actions
- `/admin`, `/device/verify`, `/auth/clients`, `/auth/apikeys` — browser dashboard: pair / pause / remove devices, OAuth clients, API keys, audit log
- `/ws` — agent WebSocket (agents connect outbound; nothing to open on their side)

## Install & run

```bash
npm i -g brc-relay
PUBLIC_URL=https://brc.example.com BRC_ADMIN_PASSWORD=change-me BRC_SESSION_SECRET=random-string TRUST_PROXY=true brc-relay
```
Put it behind any HTTPS reverse proxy or tunnel that forwards WebSockets (Caddy, nginx, Cloudflare Tunnel, ngrok).
Docker Compose profiles for VPS / Cloudflare Tunnel / ngrok are in the repository.

## Configuration

| Env | Meaning |
|---|---|
| `PUBLIC_URL` | exact public origin; drives OAuth issuer, pairing links, OpenAPI `servers` |
| `PORT`, `HOST` | listen address (default 3000 / 0.0.0.0) |
| `TRUST_PROXY` | `true` behind a proxy/tunnel |
| `BRC_ADMIN_USER`, `BRC_ADMIN_PASSWORD` | dashboard login (single-user) |
| `BRC_SESSION_SECRET` | cookie signing secret |
| `BRC_DB` | SQLite file (default `data/relay.sqlite`) |

## Connect clients

- **Claude**: Settings → Connectors → add `https://brc.example.com/mcp` → sign in → Allow
- **ChatGPT (MCP)**: same URL as a connector
- **ChatGPT GPT Action**: import `https://brc.example.com/openapi.json`, Authentication → API Key → Bearer, key from `/auth/apikeys`

Full docs: https://github.com/shahidx0x/better-remote-commander · License MIT.
