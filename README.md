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

### Android agent

The native Android agent lives in `apps/android-agent` and supports pairing with the same BRC relay, a persistent foreground connection, Android UI automation, screenshots, apps/settings, files, notifications, clipboard/media, contacts, phone/SMS, location, automation jobs, and optional Device Owner/Shizuku/root integrations.

GitHub Actions workflow `.github/workflows/android.yml` builds and tests the Android release on changes to the Android app, on pull requests, and by manual dispatch. Successful runs upload `app-release-unsigned.apk` as an artifact named `brc-android-release-<commit SHA>` for 30 days.

The CI release APK is intentionally **unsigned**. Production deployments must sign it with the deployment owner's Android signing key; signing keys and passwords must never be committed to the repository.

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

Android release build:

```bash
cd apps/android-agent
./gradlew clean testDebugUnitTest assembleRelease
```

The Android release APK is written to `apps/android-agent/app/build/outputs/apk/release/app-release-unsigned.apk`. Requires JDK 21 and Android SDK/API 36.

The desktop packages require Node 22.13+ (uses `node:sqlite`) and pnpm 11. Design notes: `docs/architecture.md`. Security notes: `SECURITY.md`.

## License

MIT — see [LICENSE](LICENSE).

## Credits

The agent's tool implementation (`packages/agent/src/core`) is derived from
[Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP) by Eduard Ruzga and contributors (MIT).
Desktop Commander's hosted remote relay is proprietary; this project provides an open, self-hostable relay with the same
device-agent model, plus OAuth for Claude/ChatGPT, device pairing, and a browser dashboard. See [NOTICE](NOTICE).
