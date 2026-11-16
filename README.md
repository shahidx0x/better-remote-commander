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
- **Control**: browser dashboard to pair, pause, rename and remove devices, manage OAuth clients and see bounded live activity.

## Features

- **Remote MCP relay** with OAuth 2.0 (dynamic client registration, PKCE) and API keys, for Claude and ChatGPT.
- **Device pairing**: the agent shows a code, you approve it in the browser. Device tokens are stored hashed.
- **Multi-device**: every tool takes an optional `deviceId`. With one device online it is picked automatically.
- **Outbound-only agents**: no open ports on your machines. Automatic reconnect, heartbeat and re-pairing.
- **Admin dashboard** (`/admin`): rename, pause, resume and delete devices, view current-process activity and stats.
  `/auth/clients` manages OAuth clients and `/auth/apikeys` manages API keys.
- **Live-only diagnostics**: concise tool activity in the console and bounded RAM-only dashboard metadata. No persisted tool-call logs.
- **Encrypted file transfer** between devices (see below).
- **One-shot commands** (`run_command`): run a command and get exit code, stdout and stderr in a single call,
  with timeout and process-tree kill.
- **Multi-edit**: `edit_block` applies several find/replace edits to a file in one call, all-or-nothing.
- **Blocking search**: `start_search` with `wait: true` returns all results in one call (grep-style).
- **Ranged multi-file reads**: `read_multiple_files` accepts per-file line ranges.
- **Workers** (`run_parallel`, `spawn_job`, `wait_jobs`): the AI splits work into pieces that run in parallel
  on the device as background jobs, then collects the results. No extra model or API key needed.
- **Safe delete** (`delete_file`) and **git helpers** (`git_status`, `git_diff`, `git_log`).
- **Fast agent**: heavy document libraries (Excel, PDF, DOCX) load on demand, system info is cached,
  parser libraries load lazily, diagnostic telemetry is disabled, and activity metrics stay in memory.
  Performance depends on workload and network; no fixed speedup is claimed.
- **OS service install** (`--install-service`) so the agent starts at login.
- **Security**: login rate limiting, signed session cookies, security headers, blocked-command list and
  `allowedDirectories` on the agent. See `SECURITY.md`.
- **Deployment**: Docker Compose profiles for Caddy (auto-TLS), Cloudflare Tunnel, ngrok or localhost.
- **Android agent** (branch `feat/android-agent`): native Kotlin agent that exposes Android-specific tools
  (accessibility automation, screenshots, notifications, contacts, SMS, location, camera/mic capture, screen
  recording, app install, automation jobs, Shizuku/Device Owner modes). See [docs/android-agent.md](docs/android-agent.md).

## Coding-agent reliability and diagnostics

The source build includes batched coding operations, hash-checked atomic file edits, search-and-read context, explicit build/test verification, an optional watched filename index, request isolation, bounded execution/cancellation, structured errors and latency metrics. Tool START/OK/ERROR lines are visible by default. Diagnostics are live-only: no agent log writer and no SQLite audit inserts. Credentials and settings are preserved. Project context, parser-backed navigation and RAM-only coding sessions help the AI inspect, edit and verify changes.

See [the coding harness and local launch guide](docs/coding-agent.md) for limits, cleanup timing, Windows startup instructions and service migration. On Windows, `START_AGENT.cmd` runs this checkout's compiled agent without a global install.

Set `BRC_TOOL_PROFILE=coding` before starting the agent to hide document/transfer/history tools from discovery. The default preserves the full tool set. This is an advertisement filter, not an access-control boundary.

## Tools available to the AI

The relay adds `list_devices`, `search_mcp_registry`, and `request_plugin_install`. The agent provides 80 tools, derived from Desktop Commander plus BRC additions.

| Category | Tools |
| --- | --- |
| Devices | `list_devices` |
| Plugins | `list_plugin_tools`, `call_plugin_tool` (agent); `search_mcp_registry`, `request_plugin_install` (relay) |
| Code structure | `ast_search`, `ast_rewrite` (ast-grep) |
| Config | `get_config`, `set_config_value` |
| Files | `read_file`, `read_multiple_files`, `write_file`, `create_directory`, `list_directory`, `move_file`, `delete_file`, `get_file_info` |
| Editing | `edit_block` (single or multi-edit), `write_pdf` |
| Search | `start_search` (streaming or `wait=true` blocking), `get_more_search_results`, `stop_search`, `list_searches` |
| Commands | `run_command` (one-shot: exit code + stdout/stderr) |
| Processes | `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Git | `git_status`, `git_diff`, `git_log` |
| Workers | `run_parallel`, `spawn_job`, `wait_jobs`, `get_job`, `list_jobs`, `cancel_job` |
| File transfer | `prepare_file_transfer`, `send_file_transfer`, `receive_file_transfer` |
| Coding workflows | `read_code_file`, `read_code_context`, `edit_files`, `batch_tools`, `verify_project`, `project_index`, `agent_status`, `cancel_operation` |
| Project context | `project_context`, `project_preferences`, `project_map`, `vscode_tasks` |
| Code navigation | `read_code_ranges`, `code_outline`, `find_symbols`, `read_symbol`, `find_references`, `related_files` |
| Refactoring | `replace_symbol`, `edit_code_ranges`, `code_diagnostics` |
| Verification/harness | `discover_checks`, `run_project_checks`, `test_impact`, `coding_session`, `review_changes` |
| Live diagnostics | `get_usage_stats`, `get_recent_tool_calls` |

Note: `write_pdf` downloads Chrome on first use.

### Fewer round trips

These cut the number of calls the AI needs for common work (each call crosses the relay):

- **`run_command`**: run a non-interactive command and get exit code, stdout and stderr in one call.
  stdin is closed so prompts fail fast; on timeout (default 60s, max 110s) the process tree is killed;
  output is capped, keeping the beginning and end. Use `start_process` only for REPLs and servers.
- **`edit_block` multi-edit**: pass `edits: [{old_string, new_string, expected_replacements?}, ...]`.
  Edits apply in order; for text files it is all-or-nothing (nothing is written if any edit fails).
- **`start_search` with `wait: true`**: blocks until done and returns grep-style results
  (stops at `maxResults`, default 200, or `timeout_ms`, default 30s).
- **`read_multiple_files` ranges**: `files: [{path, offset, length}]` alongside `paths`.
- **`delete_file`**: deletes a file or directory (`recursive: true` for non-empty). Refuses filesystem
  roots, the home directory and allowed roots.
- **`git_status` / `git_diff` / `git_log`**: compact git output with size caps.

All path arguments respect `allowedDirectories`, and commands respect `blockedCommands`.

### Workers: parallel and background jobs

The AI in your chat (Claude, ChatGPT, ...) stays the only one that thinks. It splits a task into pieces and
hands them to workers on the device, which run in parallel and report back. This works through the plain MCP
connector: no API key, no second model.

```
AI plans the task
  -> run_parallel / spawn_job x N    (workers run at the same time, on one or many devices)
  -> wait_jobs                       (collects each worker's result; call again until all are done)
  -> AI reads the results, decides the next step
```

- **`run_parallel`**: several tool calls and/or commands at once, all results in one call, in input order.
  Items: `{tool, args}` (any BRC tool) or `{command, cwd?, timeout_ms?}`. Calls still running after
  `timeout_ms` (default 90s, max 100s) keep going as background jobs (`wait_jobs({group})`).
- **`spawn_job`**: start a background job and get its id immediately. A job is one `command` or a list of
  `steps` run in order (e.g. `edit_block` -> build -> test); a failed step stops the job unless
  `continue_on_error`. Jobs are not limited by the 2-minute call timeout (default 30 min, max 6 h).
  Up to 4 jobs run at once (`BRC_MAX_JOBS`), the rest are queued. Use `group` to handle related jobs together.
- **`wait_jobs`**: wait up to 100s for jobs (`ids`, `group`, or everything pending). `mode: "any"` returns as
  soon as one more finishes. Each finished job's output is shown once.
- **`get_job`** (full output), **`list_jobs`**, **`cancel_job`** (kills the process tree).

Job steps go through the normal tool dispatcher, so `allowedDirectories` and `blockedCommands` apply. Finished
jobs are saved to `$BRC_HOME/jobs/` and are still listed after an agent restart.

### Encrypted file transfer

Move a file from one paired device to another without routing it through the relay. The encrypted blob is hosted temporarily on tmpfiles.org:

1. `prepare_file_transfer` on the destination. Returns a `receiveId` and `recipientPublicKey`.
2. `send_file_transfer` on the source with that public key. The file is encrypted and uploaded;
   it returns a `transferToken` holding the download URL and a wrapped key (never the raw AES key).
3. `receive_file_transfer` on the destination with the `receiveId` and `transferToken`.
   It downloads, authenticates, decrypts and saves the file.

### Plugins: extra MCP servers on your devices

The agent can run other MCP servers on the device and pass their tools to your AI through two tools,
`list_plugin_tools` and `call_plugin_tool`, so the tool list stays small. Plugins start the first time they are used.

**Installed automatically on first start** (in the background, once; later starts only check files on disk):

| Plugin | What the AI gets | Default |
| --- | --- | --- |
| `playwright` ([Playwright MCP](https://github.com/microsoft/playwright-mcp)) | Control a real browser (uses your Chrome/Edge if installed) | on |
| `computer-use` ([computer-use-mcp](https://github.com/domdomegg/computer-use-mcp)) | Screenshots, mouse and keyboard | on for Windows and Linux (skipped without a display), **off on macOS** |
| `ast-grep` | Powers `ast_search` / `ast_rewrite` | on |
| `rtk` ([rtk](https://github.com/rtk-ai/rtk), open-source `rtk-oss` build) | Shorter command output in `run_command` (`raw=true` for full output) | on |
| `serena` ([Serena](https://github.com/oraios/serena), GPL-3.0) | Go to definition, find references, symbol edits | on, needs Python |
| `markitdown` ([MarkItDown MCP](https://github.com/microsoft/markitdown)) | PDF, Word, Excel, PowerPoint to Markdown | on, needs Python |

Everything goes into `~/.brc` (`$BRC_HOME`): no Docker, no admin rights, no PATH changes. Versions are pinned and
downloaded programs are checked against a sha256. For the Python plugins the agent uses your Python 3.10+ if it has
one, otherwise it downloads [uv](https://github.com/astral-sh/uv) and a private Python into `~/.brc`. Only if both
fail does it ask you to install Python (the python.org installer is downloaded but never run for you; on Linux it
shows the package-manager command). On macOS, `computer-use` also needs Screen Recording and Accessibility permission.

**Marketplace**: `/admin/marketplace` searches the official [MCP Registry](https://registry.modelcontextprotocol.io)
and installs npm, PyPI or hosted (https) servers on the devices you pick; Docker-only servers are not supported.
A Custom form adds any npm package, PyPI package, command or URL. API keys you enter go straight to the device
(stored in `~/.brc/plugins.json`, mode 0600) and are never stored on the relay. The AI can search the registry and
*request* an install with `request_plugin_install`, but nothing is installed until you approve it in `/admin`.
Plugins run with your user account's permissions; BRC's `allowedDirectories` do not apply inside a plugin.

**Agent flags**: `--list-plugins`, `--add-plugin <id>` (or `--add-plugin <id> --npm pkg@1.2.3 | --pypi pkg==1.2.3 |
--command "cmd args" | --url https://... [--env KEY=VALUE]`), `--remove-plugin <id>`, `--enable-plugin <id>`,
`--disable-plugin <id>`, `--update-plugins`, `--no-plugins` (or `BRC_PLUGINS=none`). Set
`BRC_PLUGIN_REMOTE_ADMIN=0` on a device to refuse plugin changes from the relay.

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
npm i -g brc-relay
PUBLIC_URL=https://rdp.example.com BRC_ADMIN_PASSWORD=... BRC_SESSION_SECRET=... brc-relay
```
Put it behind any HTTPS reverse proxy (Caddy, nginx, Cloudflare Tunnel) that forwards WebSockets, and set `TRUST_PROXY=true`.

### 2. Agent (on every machine you want to control)

```bash
npm i -g brc-agent          # any OS with Node 22.13+
brc-agent --relay https://rdp.example.com --name "My PC"
```
The agent prints a pairing code and opens `https://rdp.example.com/device/verify`; sign in and approve.
Then make it start at login: `brc-agent --install-service`.

Docker agent (Linux servers): `docker run -d -v brc-agent:/home/rdp/.brc -e BRC_RELAY=https://rdp.example.com -e BRC_NAME=srv1 ghcr.io/shahidx0x/better-remote-commander/agent`

**Android phone** (branch `feat/android-agent`): build the APK from `apps/android-agent`, install it, enter your relay
URL and approve the pairing. Full guide, tool list and permissions: [docs/android-agent.md](docs/android-agent.md).

### 3. Connect your AI

- **Claude**: Settings → Connectors → Add custom connector → URL `https://rdp.example.com/mcp` → Add → Connect → sign in → Allow.
- **ChatGPT (MCP)**: Settings → Connectors → add `https://rdp.example.com/mcp`.

Useful URLs on your relay: `/admin` (devices, live activity), `/device/verify` (pairing), `/auth/clients`, `/health`.

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

## Multilingual coding harness

Code navigation and `related_files` are no longer JS/TS-only. C#, Rust, Python, Go, Java, C/C++ and additional portable grammars provide syntax-aware support; unknown text languages retain explicit generic fallback. An agent-local RAM graph, budgeted `context_pack`, scoped Claude/Codex-style guidance and manifest-backed checks improve context retrieval without another model or a graph database. Relay schema reuse preserves live permission checks and bounds per-device load. See [the multilingual guide](docs/polyglot-harness.md) for precise limits and validation.

## Faster batches, infrastructure and images

See [the fast-agent guide](docs/fast-agent.md) for 64-call read waves/write barriers, combined workspace edits/readback/checks, Docker observation, actual image previews, optional restricted execution, automatic cache eviction and `pnpm bench:io`. Diagnostics remain live-only. These tools do not add another model or a graph database.

## Optional host-native worker coordination

See [the parallel-worker guide](docs/parallel-workers.md) for `worker_tasks`, `worker_patch`, and `worker_integrate`. Native AI workers, when the host actually supports them with BRC access, can claim independent scopes and submit patches without directly editing shared source. One parent integrates and verifies. Hosts without native workers keep ordinary batches; no model/API calls are added. `workspace_batch` also supports optional 1-4-way distinct-file publication with settled-wave rollback. Diagnostics and coordinator state remain live-only/RAM-only.
