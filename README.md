# Better Remote Commander

Self-hosted remote control of your own computers from **Claude** and **ChatGPT**.
Files, terminal and processes on any machine you pair — through a relay **you** host, on **your** domain.

```
Claude / ChatGPT  ──HTTPS (OAuth 2.0)──▶  relay (your server or PC)  ──outbound WebSocket──▶  agent on your machine
```

- **Claude**: add the relay as a custom connector (remote MCP). Works in claude.ai web, desktop and mobile.
- **ChatGPT**: add the relay as a remote MCP connector.
- **Your infrastructure**: run the relay on a VPS, or on your PC behind a Cloudflare Tunnel / ngrok. SQLite, one container, no third-party service.
- **Many machines**: pair Windows, macOS, Linux boxes and containers to one relay; agents only connect outbound.
- **Control**: browser dashboard to pair, pause, rename and remove devices, manage OAuth clients and see an audit log.

## Features

- **Remote MCP relay** with OAuth 2.0 (dynamic client registration, PKCE) and API keys, for Claude and ChatGPT.
- **Device pairing**: the agent shows a code, you approve it in the browser. Device tokens are stored hashed.
- **Multi-device**: every tool takes an optional `deviceId`. With one device online it is picked automatically.
- **Outbound-only agents**: no open ports on your machines. Automatic reconnect, heartbeat and re-pairing.
- **Admin dashboard** (`/admin`): rename, pause, resume and delete devices, view the audit log and stats.
  `/auth/clients` manages OAuth clients and `/auth/apikeys` manages API keys.
- **Audit log** of every tool call, and per-device pause switch.
- **Encrypted file transfer** between devices (see below).
- **OS service install** (`--install-service`) so the agent starts at login.
- **Security**: login rate limiting, signed session cookies, security headers, blocked-command list and
  `allowedDirectories` on the agent. See `SECURITY.md`.
- **Deployment**: Docker Compose profiles for Caddy (auto-TLS), Cloudflare Tunnel, ngrok or localhost.
- **Android agent** (branch `feat/android-agent`, `apps/android-agent`): native Kotlin agent that exposes
  Android-specific tools (accessibility automation, screenshots, notifications, contacts, SMS, location,
  camera/mic capture, screen recording, app install, automation jobs, Shizuku/Device Owner modes).

## Tools available to the AI

The relay adds `list_devices`. The agent provides 28 tools, derived from Desktop Commander plus BRC additions.

| Category | Tools |
| --- | --- |
| Devices | `list_devices` |
| Config | `get_config`, `set_config_value` |
| Files | `read_file`, `read_multiple_files`, `write_file`, `create_directory`, `list_directory`, `move_file`, `get_file_info` |
| Editing | `edit_block` (surgical text replace), `write_pdf` |
| Search | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Processes | `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| File transfer | `prepare_file_transfer`, `send_file_transfer`, `receive_file_transfer` |
| Diagnostics | `get_usage_stats`, `get_recent_tool_calls`, `get_prompts`, `give_feedback_to_desktop_commander` |

Note: `write_pdf` downloads Chrome on first use.

### Encrypted file transfer

Move a file from one paired device to another without routing it through the relay. The encrypted blob is hosted temporarily on tmpfiles.org:

1. `prepare_file_transfer` on the destination. Returns a `receiveId` and `recipientPublicKey`.
2. `send_file_transfer` on the source with that public key. The file is encrypted and uploaded;
   it returns a `transferToken` holding the download URL and a wrapped key (never the raw AES key).
3. `receive_file_transfer` on the destination with the `receiveId` and `transferToken`.
   It downloads, authenticates, decrypts and saves the file.

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
```ash
npm i -g brc-relay
PUBLIC_URL=https://rdp.example.com BRC_ADMIN_PASSWORD=... BRC_SESSION_SECRET=... brc-relay
```
Put it behind any HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) that forwards WebSockets, and set `TRUST_PROXY=true`.

### 2. Agent (on every machine you want to control)

```ash
npm i -g brc-agent          # any OS with Node 22.13+
brc-agent --relay https://rdp.example.com --name "My PC"
```
The agent prints a pairing code and opens `https://rdp.example.com/device/verify`; sign in and approve.
Then make it start at login: `brc-agent --install-service`.

Docker agent (Linux servers): `docker run -d -v brc-agent:/home/rdp/.brc -e BRC_RELAY=https://rdp.example.com -e BRC_NAME=srv1 ghcr.io/shahidx0x/better-remote-commander/agent`

### 3. Connect your AI

- **Claude**: Settings → Connectors → Add custom connector → URL `https://rdp.example.com/mcp` → Add → Connect → sign in → Allow.
- **ChatGPT (MCP)**: Settings → Connectors → add `https://rdp.example.com/mcp`.

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
device-agent model, plus OAuth for Claude/ChatGPT, device pairing, and a browser dashboard. See [NOTICE](NOTICE).
