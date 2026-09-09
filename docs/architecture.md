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

## Phase 1 status (done)
- shared: wire protocol v1 (hello/welcome/call/result/ping/pong/error), DEFAULTS
- agent: dispatcher (24 tools, ported from upstream switch), WsClient with backoff reconnect + pong watchdog, CLI (--relay --token --name --device-id --debug)
- relay: Fastify + @fastify/websocket, DeviceHub (call/result matching, heartbeat, stale-socket replacement), /health, /ws, /debug/devices, /debug/tools, /debug/call
- agent uses ~/.ses-rdp (SES_RDP_HOME) - never touches Desktop Commander's ~/.claude-server-commander
- upstream telemetry hard-off unless SES_RDP_UPSTREAM_TELEMETRY=1
- smoke test: read_file 8 ms, start_process 579 ms via relay; agent survives relay restart

### Run locally
    $env:PORT=3210; $env:SES_RDP_DEVICE_TOKEN='dev-device-token'; $env:SES_RDP_ADMIN_TOKEN='dev-admin-token'
    node packages/relay/dist/cli.js
    node packages/agent/dist/cli.js --relay http://localhost:3210 --token dev-device-token --name MyPC --device-id mypc
    curl -H "Authorization: Bearer dev-admin-token" -X POST http://localhost:3210/debug/call -H "content-type: application/json" -d '{"tool":"list_sessions","args":{}}'
