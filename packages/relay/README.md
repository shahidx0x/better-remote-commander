# brc-relay

Relay server for **Better Remote Commander** — the self-hosted bridge between AI clients (Claude, ChatGPT) and your
machines running [`brc-agent`](https://www.npmjs.com/package/brc-agent). One process, SQLite, your domain.

Doors it exposes:
- `/mcp` — remote MCP (Streamable HTTP) with OAuth 2.0 (PKCE, dynamic client registration) or API-key bearer auth
- `/admin`, `/device/verify`, `/auth/clients`, `/auth/apikeys` — browser dashboard: pair / pause / remove devices, OAuth clients, API keys, audit log
- `/ws` — agent WebSocket (agents connect outbound; nothing to open on their side)

## Install & run

```bash
npm i -g brc-relay
PUBLIC_URL=https://brc.example.com BRC_ADMIN_PASSWORD=change-me BRC_SESSION_SECRET=random-string TRUST_PROXY=true brc-relay
```
Put it behind any HTTPS reverse proxy or tunnel that forwards WebSockets (Caddy, nginx, Cloudflare Tunnel, ngrok).
Docker Compose profiles for VPS / Cloudflare Tunnel / ngrok are in the repository.

### Easypanel Docker builds

The relay Dockerfile supports two build contexts. With the repository root as context, it builds the checked-out source directly. If Easypanel supplies only `packages/relay` instead, it fetches the public repository at the exact `GIT_SHA` build argument (which Easypanel supplies), then builds that revision. It checks the resulting commit hash and refuses a mismatch; no source files are taken from a misleading partial context. The image build therefore needs outbound HTTPS access to GitHub in the fallback case. `GIT_SHA` is optional for standalone builds without a GitHub source and defaults to `main` only when omitted.

Recommended Easypanel settings are **Build Path `/`** with **Dockerfile `packages/relay/Dockerfile`**. The alternative **Build Path `/packages/relay`** with **Dockerfile `Dockerfile`** also works using the fallback. Neither layout requires modifying the project source tree in Easypanel.

## Configuration

| Env | Meaning |
|---|---|
| `PUBLIC_URL` | exact public origin; drives OAuth issuer and pairing links |
| `PORT`, `HOST` | listen address (default 3000 / 0.0.0.0) |
| `TRUST_PROXY` | `true` behind a proxy/tunnel |
| `BRC_ADMIN_USER`, `BRC_ADMIN_PASSWORD` | dashboard login (single-user) |
| `BRC_SESSION_SECRET` | cookie signing secret |
| `BRC_DB` | SQLite file (default `data/relay.sqlite`) |

## Connect clients

- **Claude**: Settings → Connectors → add `https://brc.example.com/mcp` → sign in → Allow
- **ChatGPT (MCP)**: same URL as a connector

Full docs: https://github.com/shahidx0x/better-remote-commander · License MIT.
