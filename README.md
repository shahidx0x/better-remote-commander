# Better Remote Commander

Self-hosted remote control of your own computers from **Claude** and **ChatGPT**.
Files, terminal and processes on any machine you pair — through a relay **you** host, on **your** domain.

```
Claude / ChatGPT  ──HTTPS (OAuth 2.0)──▶  relay (your server or PC)  ──outbound WebSocket──▶  agent on your machine
```

- **Claude**: add the relay as a custom connector (remote MCP). Works in claude.ai web, desktop and mobile.
- **ChatGPT**: remote MCP connector, or a Custom GPT via the built-in OpenAPI spec (GPT Actions).
- **Your infrastructure**: run the relay on a VPS, or on your PC behind a Cloudflare Tunnel / ngrok. SQLite, one container, no third-party service.
- **Many machines**: pair Windows, macOS, Linux boxes and containers to one relay; agents only connect outbound.
- **Control**: browser dashboard to pair, pause, rename and remove devices, manage OAuth clients and see an audit log.

Tools available to the AI (24): `read_file`, `write_file`, `edit_block`, `list_directory`, `move_file`, `get_file_info`,
`start_process`, `interact_with_process`, `read_process_output`, `list_processes`, `kill_process`, `start_search`,
`write_pdf`, `get_config`, `set_config_value` and more — the same tool set as Desktop Commander.

## Install

### 1. Relay (once, on a server or your PC)

**Docker (recommended)**
```bash
git clone https://github.com/shahidx0x/better-remote-commander.git && cd better-remote-commander
cp .env.example .env        # set PUBLIC_URL, BRC_ADMIN_PASSWORD, BRC_SESSION_SECRET
docker compose --profile cloud up -d                            # VPS with your domain (Caddy, auto-TLS)
docker compose --profile tunnel --profile cloudflare up -d      # your PC via Cloudflare Tunnel
docker compose --profile tunnel --profile ngrok up -d           # your PC via a static ngrok domain
docker compose --profile local up -d                            # localhost only (testing)
```
Images are published to `ghcr.io/shahidx0x/better-remote-commander/relay` and `/agent`.

**Without Docker**
```bash
npm i -g https://github.com/shahidx0x/better-remote-commander/releases/latest/download/brc-relay-2.0.0.tgz
PUBLIC_URL=https://rdp.example.com BRC_ADMIN_PASSWORD=... BRC_SESSION_SECRET=... brc-relay
```
Put it behind any HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) that forwards WebSockets, and set `TRUST_PROXY=true`.

### 2. Agent (on every machine you want to control)

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/shahidx0x/better-remote-commander/main/install.sh | bash
# Windows (PowerShell)
irm https://raw.githubusercontent.com/shahidx0x/better-remote-commander/main/install.ps1 | iex

brc-agent --relay https://rdp.example.com --name "My PC"
```
The agent prints a pairing code and opens `https://rdp.example.com/device/verify`; sign in and approve.
Then make it start at login: `brc-agent --install-service`.

Docker agent (Linux servers): `docker run -d -v brc-agent:/home/rdp/.brc -e BRC_RELAY=https://rdp.example.com -e BRC_NAME=srv1 ghcr.io/shahidx0x/better-remote-commander/agent`

### 3. Connect your AI

- **Claude**: Settings → Connectors → Add custom connector → URL `https://rdp.example.com/mcp` → Add → Connect → sign in → Allow.
- **ChatGPT (MCP)**: Settings → Connectors → add `https://rdp.example.com/mcp`.
- **ChatGPT (Custom GPT Action)**: open `https://rdp.example.com/auth/clients`, create a client, then in the GPT builder import `https://rdp.example.com/openapi.json`, choose OAuth, paste client ID/secret, auth URL `/authorize`, token URL `/token`, scope `mcp:tools`, and add the callback URL ChatGPT shows you to the client.

Useful URLs on your relay: `/admin` (devices, audit), `/device/verify` (pairing), `/auth/clients`, `/health`.

## Build from source
```bash
pnpm install && pnpm build && pnpm test
node packages/relay/dist/cli.js      # relay
node packages/agent/dist/cli.js      # agent
```
Requires Node 22.13+ (uses `node:sqlite`) and pnpm 11. Design notes: `docs/architecture.md`. Security notes: `SECURITY.md`.

## License

MIT — see [LICENSE](LICENSE).

## Credits

The agent's tool implementation (`packages/agent/src/core`) is derived from
[Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) by Eduard Ruzga and contributors (MIT).
Desktop Commander's hosted remote relay is proprietary; this project provides an open, self-hostable relay with the same
device-agent model, plus OAuth for Claude/ChatGPT, device pairing, a dashboard and a REST/OpenAPI door. See [NOTICE](NOTICE).
