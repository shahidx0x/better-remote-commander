# SES-RDP — Remote Desktop Agent / MCP Harness

Goal: own remote-desktop agent (files, terminal, processes) exposed to
- Claude (web/desktop) via remote MCP connector
- ChatGPT via Custom GPT Actions (OpenAPI/REST) and/or ChatGPT remote MCP

## Reference
- `reference-desktop-commander/` — clone of wonderwhy-er/DesktopCommanderMCP (MIT, v0.2.50)
  - `src/remote-device/` — device relay / remote MCP layer (start here)
  - `src/tools/`, `src/handlers/` — tool definitions and implementations
  - `src/terminal-manager.ts`, `src/search-manager.ts` — process + search engines

## Planned architecture
```
[Claude / ChatGPT] --(MCP over HTTPS / OpenAPI)--> [SES-RDP Relay (cloud)]
                                                        |  WebSocket, per-device auth
                                                  [SES-RDP Agent (Windows/Linux/mac)]
                                                        files | terminal | processes
```

## Layout
- `agent/`  — local device agent (Node/TS, fork or reuse of DC core)
- `relay/`  — cloud relay: MCP Streamable HTTP endpoint + REST/OpenAPI for GPT Actions
- `openapi/` — OpenAPI spec for ChatGPT Custom GPT Action
- `docs/`   — design notes, auth model, security

## Next steps
1. Read `src/remote-device/` to understand the device<->relay protocol
2. Decide: fork DC core vs. thin wrapper
3. Minimal relay with MCP endpoint + OAuth for Claude connector
4. OpenAPI wrapper for ChatGPT Actions
