# SES-RDP — Remote Desktop Agent / MCP Harness

Self-hosted remote desktop agent + relay that exposes files, terminal and processes of your
machines to Claude (remote MCP connector) and ChatGPT (remote MCP / GPT Actions).
Tool core is vendored from Desktop Commander (MIT); the relay is our own.

## Status
- [x] Phase 0 — monorepo scaffold, tool core vendored, build green
- [x] Phase 1 — agent WS transport + relay device hub, end-to-end tool calls
- [ ] Phase 2 — `/mcp` + OAuth + device pairing + SQLite (Claude connector)
- [ ] Phase 3 — Docker profiles: local / tunnel (ngrok, Cloudflare) / cloud (Caddy)
- [ ] Phase 4 — ChatGPT: remote MCP + REST/OpenAPI for GPT Actions
- [ ] Phase 5 — policy, dashboard, Postgres, service install

## Layout
- `packages/shared` — wire protocol + types
- `packages/agent`  — device agent (`ses-rdp-agent`), `src/core` = vendored tool core
- `packages/relay`  — relay server (`ses-rdp-relay`)
- `docs/architecture.md` — design, deployment modes, protocol
- `scripts/` — `extract-tools.mjs` regenerates `core/tool-definitions.ts` from `server.ts.ref`
- `reference-desktop-commander/` — upstream clone (gitignored, for reference only)

## Quick start
```
pnpm install && pnpm build
# relay
$env:PORT=3210; $env:PUBLIC_URL='http://localhost:3210'
$env:SES_RDP_ADMIN_PASSWORD='choose-a-password'; $env:SES_RDP_SESSION_SECRET='random-string'
node packages/relay/dist/cli.js
# agent (on the machine to control) - prints a pairing code, opens the approval page
node packages/agent/dist/cli.js --relay http://localhost:3210 --name MyPC
# Claude: Settings -> Connectors -> Add custom connector -> http://<PUBLIC_URL>/mcp
# verify everything: node scripts/e2e-oauth.mjs http://localhost:3210 admin choose-a-password
```
Agent state lives in `~/.ses-rdp/` (override with `SES_RDP_HOME`); `--logout` removes the saved device token. Upstream telemetry is off.