# SES-RDP architecture

## Components
1. **Agent** (`agent/`) — runs on the user's machine. Reuses Desktop Commander tool core (MIT):
   files, terminal, processes, search. Replaces Supabase channel with our transport.
2. **Relay** (`relay/`) — self-hosted server. Two front doors, one tool dispatcher:
   - `/mcp` — MCP Streamable HTTP + OAuth 2.0 (PKCE, dynamic client registration)
   - `/api/*` + `/openapi.json` — REST for ChatGPT Custom GPT Actions
   - `/device/start`, `/device/poll` — OAuth device-authorization flow (agent pairing)
   - `/ws` — agent WebSocket hub (outbound from device, auto-reconnect)
3. **Storage** — interface: `PostgresStore` (cloud) | `SqliteStore` (local, default)
4. **Transport** — interface: `WebSocketTransport` (remote agents) | `LocalTransport` (in-process)

## Flow
Client -> relay (`/mcp` or `/api`) -> auth -> device router -> agent (WS or local) -> tool -> result back.

## Deployment modes (same code, config only)
| Mode | Relay | Public URL | Storage | Agent link |
|------|-------|------------|---------|------------|
| A cloud | VPS docker | own domain, Caddy TLS | Postgres | WSS internet |
| B tunnel | local docker/bare | ngrok / Cloudflare Tunnel | SQLite | WS localhost/LAN |
| C direct | local, agent in-process | ngrok / Cloudflare Tunnel | SQLite | none (function call) |

## Key config
- `PUBLIC_URL` — drives OAuth issuer, redirect URIs, OpenAPI `servers[]`
- `TRUST_PROXY=true` — honour X-Forwarded-* behind ngrok/Cloudflare
- `STORE=sqlite|postgres`, `TRANSPORT=ws|local`, `PORT`
- `scripts/tunnel.sh` — start ngrok, read URL from `localhost:4040/api/tunnels`, export `PUBLIC_URL`, run relay

## Agent <-> relay protocol (WebSocket, JSON frames)
- Agent connects `wss://PUBLIC_URL/ws` with `Authorization: Bearer <device token>`
- `hello` {deviceId, name, os, version, tools[]}  agent -> relay on connect
- `call`  {id, tool, args}                        relay -> agent
- `result`{id, ok, content | error}               agent -> relay
- `ping`/`pong` every 20 s; relay marks device offline after 2 missed
- Multiple devices per user; client picks via `deviceId` arg (as upstream)

## Security
- Agent never listens on a port; all connections outbound
- Device tokens revocable from relay dashboard; refresh via OAuth
- Blocked-commands list + allowedDirectories enforced on the agent side
- Audit log of every call (tool, args hash, device, timestamp) in store

## Docker compose profiles
- `local`  : relay (SQLite)
- `tunnel` : relay + ngrok or cloudflared sidecar
- `cloud`  : relay + postgres + caddy
