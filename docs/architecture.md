# SES-RDP architecture

## Components
1. **Agent** (`packages/agent`, npm `@ses-systems/rdp-agent`) — runs on the machine to control. Tool core vendored from
   Desktop Commander (MIT): files, terminal, processes, search, edit. Our transport: outbound WebSocket, device pairing,
   credential persistence in `$SES_RDP_HOME` (default `~/.ses-rdp`).
2. **Relay** (`packages/relay`, npm `@ses-systems/rdp-relay`) — self-hosted server (Express + MCP SDK). Doors:
   - `/mcp` — MCP Streamable HTTP, bearer-protected (Claude connector, ChatGPT remote MCP)
   - `/api/*` + `/openapi.json` — REST for ChatGPT GPT Actions (Phase 4)
   - `/.well-known/*`, `/authorize`, `/token`, `/register`, `/revoke` — OAuth 2.0 (PKCE, dynamic client registration)
   - `/device/start|poll|verify|approve` — device pairing; `/auth/*`, `/` — browser pages
   - `/ws` — agent socket (device token)
3. **Shared** (`packages/shared`) — wire protocol + types used by both.
4. **Store** — `node:sqlite` (`SES_RDP_DB`). Postgres is a possible later addition, not required.

## Flow
Client -> relay (`/mcp` or `/api`) -> OAuth bearer -> device router -> agent (WS) -> tool -> result back. Audit row per call.

## Deployment modes (same image, config only)
| Profile | Relay runs | Public URL | Agent link |
|---------|-----------|------------|------------|
| `local` | your PC, Docker | http://localhost:PORT (dev only) | ws://localhost |
| `tunnel` + `cloudflare` / `ngrok` | your PC, Docker | Cloudflare Tunnel hostname / static ngrok domain | ws://localhost or wss://public |
| `cloud` | VPS, Docker + Caddy | your domain, auto TLS | wss://public |
Agents anywhere connect outbound only; several agents per relay; `deviceId` selects the target.

## Key config
- `PUBLIC_URL` — drives OAuth issuer, redirect validation, pairing URLs. Must be the exact public origin.
- `TRUST_PROXY=true` behind Caddy/ngrok/Cloudflare. `PORT`, `HOST`, `SES_RDP_DB`, `LOG_LEVEL`
- `SES_RDP_ADMIN_USER` / `SES_RDP_ADMIN_PASSWORD` (single-user v1), `SES_RDP_SESSION_SECRET`
- Agent: `SES_RDP_RELAY`, `SES_RDP_NAME`, `SES_RDP_HOME`, `SES_RDP_DEBUG`; `--logout`, `--no-browser`

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


## Phase 2 status (done)
- relay moved to Express (MCP SDK `mcpAuthRouter` is Express-native); `ws` handles the /ws upgrade
- store: node:sqlite (`SES_RDP_DB`, default data/relay.sqlite) - users, oauth_clients, auth_codes, tokens (hashed), devices (hashed token, paused), device_codes, audit
- OAuth 2.0: PKCE S256, dynamic client registration, consent page, refresh rotation, revocation, `.well-known/oauth-authorization-server` + `oauth-protected-resource/mcp`
- browser pages: /auth/login, /auth/consent, /device/verify, /device/approve, / (device list). Signed-cookie sessions (`SES_RDP_SESSION_SECRET`)
- device pairing: POST /device/start -> code; owner approves in browser; POST /device/poll -> device token. Agent stores it in `$SES_RDP_HOME/device.json` (0600), re-pairs automatically on 401
- /mcp: stateless Streamable HTTP, bearer-protected. Tools = list_devices + union of online agents' tools, each with optional `deviceId`; single online device is auto-selected; audit row per call
- single-user v1: admin user from `SES_RDP_ADMIN_USER` (default admin) / `SES_RDP_ADMIN_PASSWORD` (required)
- e2e: `node scripts/e2e-oauth.mjs <url> <user> <pass>` - 14/14 checks pass (discovery, DCR, PKCE, login, consent, token, initialize, tools/list, list_devices, start_process on device, 401 on bad token, refresh rotation)

### Run locally (Phase 2)
    $env:PORT=3210; $env:PUBLIC_URL='http://localhost:3210'; $env:SES_RDP_ADMIN_PASSWORD='...'; $env:SES_RDP_SESSION_SECRET='...'
    node packages/relay/dist/cli.js
    node packages/agent/dist/cli.js --relay http://localhost:3210 --name MyPC     # prints pairing code, opens browser
    # Claude: Settings -> Connectors -> add  <PUBLIC_URL>/mcp  -> sign in -> Allow

## Phase 3 status (done)
- images: packages/relay/Dockerfile (node:24-alpine, 263 MB, non-root, HEALTHCHECK) and packages/agent/Dockerfile (node:24-bookworm-slim + bash/git/curl, for Linux servers)
- docker-compose.yml profiles: `local` (relay on 127.0.0.1:PORT), `tunnel` + `cloudflare` (cloudflared sidecar, TUNNEL_TOKEN) or `tunnel` + `ngrok` (static NGROK_DOMAIN), `cloud` (relay + Caddy auto-TLS on DOMAIN)
- deploy/Caddyfile, .env.example, .dockerignore, scripts/tunnel-ngrok.{sh,ps1} for a quick random-URL dev tunnel
- verified: local profile 14/14 e2e; device tokens persist in `relay-data` volume across `compose down/up`; Windows host agent + Linux container agent on one relay; multi-device routing (`scripts/e2e-multidevice.mjs`)
- compose gotcha: profile-specific `${VAR:?}` breaks every profile (compose interpolates all services) -> use `${VAR:-}` defaults

### Deploy cheat sheet
    cp .env.example .env   # set PUBLIC_URL, SES_RDP_ADMIN_PASSWORD, SES_RDP_SESSION_SECRET
    docker compose --profile local up -d                            # http://localhost:3000
    docker compose --profile tunnel --profile cloudflare up -d      # + CLOUDFLARE_TUNNEL_TOKEN, PUBLIC_URL=https://rdp.yourdomain
    docker compose --profile tunnel --profile ngrok up -d           # + NGROK_AUTHTOKEN, NGROK_DOMAIN, PUBLIC_URL=https://<domain>
    docker compose --profile cloud up -d                            # VPS: DOMAIN=..., PUBLIC_URL=https://DOMAIN
    docker run -d -v ses-rdp-agent:/home/rdp/.ses-rdp -e SES_RDP_RELAY=https://... -e SES_RDP_NAME=srv ses-systems/rdp-agent

## Phase 4 status (done)
- shared invocation path `mcp/invoke.ts` (device resolution, pause check, audit) used by both /mcp and /api
- REST for GPT Actions: GET /api/devices, GET /api/tools, POST /api/tools/{tool} (body = args + optional deviceId); 40 s call cap, text clipped at 90 KB with a note; images omitted
- GET /openapi.json (public): OpenAPI 3.1 built from cached tool definitions (`device_tools` table filled on every agent hello, so the spec is stable even with devices offline); <= 30 operations; oauth2 authorizationCode security scheme
- OAuth client management page /auth/clients: create confidential clients (client_secret_post) with redirect URIs, delete = revoke
- `auth/pkce-compat.ts`: ChatGPT GPT Actions do not send PKCE; for confidential clients only, a deterministic PKCE pair is synthesized so the SDK's mandatory check passes (secret still required at /token). Public clients always need real PKCE
- ChatGPT remote MCP (Developer mode / connectors): uses the same /mcp + DCR as Claude, nothing extra needed. Deep-research connectors would additionally want `search`/`fetch` tools - not implemented
- e2e: `node scripts/e2e-gpt-actions.mjs <url> <user> <pass>` 13/13; `e2e-oauth.mjs` 14/14 (tests now shell-agnostic: fresh agents on Windows default to cmd.exe)

### Connect a Custom GPT
1. Relay must be public (Phase 3). Sign in at PUBLIC_URL -> OAuth clients -> create "ChatGPT" (redirect can be empty for now) -> copy ID + secret
2. GPT builder -> Actions -> Import from URL: PUBLIC_URL/openapi.json
3. Authentication: OAuth; Client ID/Secret from step 1; Auth URL PUBLIC_URL/authorize; Token URL PUBLIC_URL/token; Scope mcp:tools; Token exchange: Default (POST)
4. ChatGPT shows the callback URL (https://chat.openai.com/aip/g-.../oauth/callback) -> edit the client on /auth/clients and add it (delete + recreate in v1)

## Phase 5 status (done) - v1.0
- /admin dashboard: devices (rename / pause / resume / delete = revoke token + disconnect), call stats, last 100 audit rows
- pause enforced on /mcp and /api (HTTP 423); delete closes the live socket with 4401
- OAuth client edit page (/auth/clients/edit): name + redirect URIs (needed once ChatGPT reveals its callback URL)
- login rate limit: 5 failures per IP+username -> 5 min lock (429)
- agent `--install-service` / `--uninstall-service`: Windows Task Scheduler (ONLOGON, hidden via .cmd + wscript, log ~/.ses-rdp/agent.log), Linux systemd --user unit, macOS LaunchAgent. Pair first, then install
- agent `--allow-dir <path>` (repeatable) persists allowedDirectories; upstream default is the home directory, blocked-commands list unchanged
- e2e: `scripts/e2e-admin.mjs` 8/8; previous suites unchanged

### Not done (deliberately)
- Postgres store: SQLite is sufficient for a single relay instance; add only for multi-instance
- multi-tenant users: v1 is single admin user
- dropping md-to-pdf/puppeteer from the agent (write_pdf downloads Chrome on first use)
