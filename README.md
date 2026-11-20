# Better Remote Commander — Extended Fork

**Self-hosted remote control and coding tools for your own devices through MCP.** Connect compatible AI clients such as ChatGPT or Claude to a relay you operate, then use approved tools on paired Windows, Linux and macOS computers.

**Repository:** [Rifatul-Islam-Munna/better-better-remote-commander](https://github.com/Rifatul-Islam-Munna/better-better-remote-commander)

**Development branch:** `marge-branch` | **Integrated upstream version:** 2.0.7

**Upstream:** [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander)

> This README describes the source code in this fork's `marge-branch`. Local commits are not automatically available on GitHub or deployed to a running relay; push and redeploy separately when appropriate.

```text
ChatGPT / Claude / other MCP client
                |
        HTTPS + OAuth / API key / private link
                |
     Self-hosted relay  (MCP + dashboard)
          /     |     \
         /      |      \
       WSS     WSS     WSS   (outbound connections)
        |       |       |
     Agent A  Agent B  Agent C
     Files, terminals, jobs, coding tools and optional MCP plugins
```

## Highlights

| Area | What this fork provides |
| --- | --- |
| Remote access | OAuth with PKCE, device-code pairing, outbound WebSockets, multiple devices, reconnect/re-pairing, stable tool discovery |
| Connection options | Standard `/mcp` OAuth, API keys, and revocable private MCP URLs with read-only/full access |
| Persistence | SQLite by default; optional MongoDB for relay accounts, pairings, plugin metadata, approved skills and model token aggregates |
| Coding tools | File inspection, hash-checked edits, source navigation, project checks, multi-file batches and live diagnostics |
| Performance | Fast command-start paths, optimized searches/reads, optional compact graph/context outlines (with exact source on demand), lazy dependencies, bounded outputs and RTK compression when installed |
| Jobs | Concurrent tool/command execution and persistent finished background-job history |
| Coordination | Optional scoped patch submission from real host-native subagents; no built-in LLM spawning |
| MCP extensions | Extra per-device MCP servers, default plugin setup, marketplace, owner-approved installs and admin controls |
| Administration | Modern responsive left-sidebar dashboard, device controls, OAuth clients, API keys, private links, skill approvals, MCP marketplace, token analytics and live activity |
| Security | Session CSRF protection, rate limits, device token revocation, scoped built-in filesystem tools and explicitly gated plugin/skill approval |

## Main capabilities

- **Control several paired devices.** Each agent connects *outbound* to the relay; use an optional `deviceId` when more than one is online. Pausing or deleting a device is enforced at the relay.
- **Read, search, edit and transfer files.** Includes multi-file reads, exact edits, git inspection, fast native image previews/contact sheets, PDF tooling and encrypted transfers between paired devices. For images, prefer `read_images` to avoid sending full-resolution originals with `read_file`.
- **Work inside real codebases.** Project mapping, declarations, syntax-aware navigation, multi-language context, cross-file references, SHA-256 preconditions and manifest-backed verification.
- **Reduce unnecessary round trips.** `read_multiple_files`, `batch_tools`, `workspace_batch` and `run_parallel` combine suitable work rather than sending many individual MCP calls.
- **Send compact context first.** `context_pack` with `mode=outline` and `code_graph` with `format=compact` return smaller RAM graph/file/symbol references. Expand exact code only as needed with `read_code_ranges` or `read_symbol`. This is not an LLM proxy, graph database, or persistent conversation compression. [Details and benchmark](docs/agent-context-and-terminal.md).
- **Run background jobs.** Launch commands or sequential tool steps, wait for completion, inspect results and cancel jobs without keeping one MCP request open.
- **Connect more MCP servers to a device.** Use Playwright, computer-use, Serena, MarkItDown or another supported server *when actually installed and configured*.
- **Owner-approved reusable skills.** Import SKILL.md text from reviewed sources, browse the optional skills.sh catalog, and allow AI clients to discover/read approved skills without automatic code execution.
- **Count visible MCP traffic automatically.** The relay estimates text tokens for AI tool arguments and tool results using a local o200k_base tokenizer in a worker thread. Daily, weekly and monthly estimates are stored in SQLite or MongoDB without waiting on tool calls. These are **not** ChatGPT's full model tokens. The existing provider-reported usage endpoint remains separate and optional.
- **Keep your existing custom relay features.** This fork retains MongoDB support, private MCP URLs, OAuth recovery/reconnection logic and scoped worker coordination alongside the upstream additions.

## MCP tool catalog

The **default Code Mode-first MCP profile** (`BRC_MCP_TOOL_PROFILE=codemode`) exposes only **14 top-level tools** (15 when operation recovery is enabled). `code_mode` is listed first and can progressively discover and call dozens of local coding, testing, Git, process and installed external MCP methods inside one request. The previous `BRC_MCP_TOOL_PROFILE=core` profile still exposes 40 main tools when a traditional direct-tool workflow is preferable. The four installed plugin types (computer-use, Playwright, Serena, MarkItDown) are accessible on demand through `list_plugin_tools` and `call_plugin_tool`, not exposed as separate top-level tools. When operation recovery is enabled, it adds one tool in the default compact profile (15 total); in the 40-tool Core it replaces `list_sessions` to stay at 40. `focused` exposes 48 agent tools and `full` exposes 64; both include the relay marketplace and skills tools separately. Nineteen redundant **public entries** are retired across profiles; their legacy handlers remain installed and the internal worker-batch engine stays intact. Discovery does not change permissions. After deploying, **refresh the MCP tool definitions in ChatGPT**. `BRC_TOOL_PROFILE=coding` is a separate agent-side filter.

Within Code Mode, write two files by calling **`await tools.call("write_file", {...})` once for each file** and verify each result; use `mode=rewrite` for the first chunk and `mode=append` for later chunks. For precise source edits, read current content/hash and use `edit_block`. Core also includes guarded multi-file source updates using `edit_files` and `apply_patch`; the legacy `workspace_batch` entry stays hidden. See [ChatGPT tool selection and recovery](docs/chatgpt-mcp-tool-guide.md).

### Local Code Mode (one MCP call, multiple local tool operations)

`code_mode` is the FIRST tool in the default **14–15-tool Code Mode-first profile**, with the 40-tool Core still selectable. Model-authored JavaScript runs in a memory-bounded **QuickJS/WASM worker on the paired device**, not in Node.js, the relay, or Cloudflare Workers. Only the injected `tools.search`, `tools.describe` and `tools.call` API can invoke existing BRC tools. A script can read several files, branch on results, apply reviewed edits and run a check without intermediate relay round trips.

```js
// code_mode({source: "...the following JavaScript...", max_calls: 12})
const matches = await tools.search("git");
const git = await tools.describe("git_status");
const status = await tools.call("git_status", {path:"D:/projects/example"});
const check = await tools.call("run_command", {
  program:"node", args:["--version"], cwd:"D:/projects/example"
});
return {available:matches.length,tool:git.name,
  status:status.text.slice(0,600),exitCode:check.structuredContent.exitCode};
```

Use direct tools for one quick action. The default Code Mode budget is 48 nested tool calls (maximum 96), not unlimited work; the runtime is 85 seconds by default (maximum 105 seconds). For long builds, call `spawn_job` and then `get_job`/`wait_jobs` in later MCP calls; a started job is not a completed build. The Code Mode worker cannot import packages, access Node/OS objects or browse the network directly. Nested tool calls still use BRC's normal path limits, permissions, error handling and operation receipts. Memory, output, call count and execution time are bounded; uncertain writes must be inspected before any retry. No live agent/relay restart is implied by building the source.

### Relay tools (3 in Core, 7 in Focused/Full; plus optional operation recovery)

| Tool | Purpose |
| --- | --- |
| `list_devices` | List paired devices and online status |
| `search_mcp_registry` | Search the official MCP Registry for potential plugin servers |
| `request_plugin_install` | File a pending install request for owner approval; **never installs automatically** |
| `list_skills` | List skills approved by the relay owner for this account |
| `read_skill` | Read a skill's SKILL.md and approved supporting text files |
| `search_skills_catalog` | Search skills.sh with optional Vercel OIDC authentication; unavailable without it |
| `request_skill_install` | Request owner review of a skill; **no automatic installation** |

### Active public agent tools (64 in `BRC_MCP_TOOL_PROFILE=full`)

| Category | Tools |
| --- | --- |
| Configuration (2) | `get_config`, `set_config_value` |
| Files and editing (10) | `read_file`, `read_multiple_files`, `write_file`, `write_pdf`, `create_directory`, `list_directory`, `move_file`, `get_file_info`, `edit_block`, `delete_file` |
| Guarded multi-file source edits (2) | `edit_files`, `apply_patch` |
| Encrypted transfer (3) | `prepare_file_transfer`, `send_file_transfer`, `receive_file_transfer` |
| Search (4) | `start_search`, `get_more_search_results`, `stop_search`, `list_searches` |
| Commands and processes (8) | `run_command`, `start_process`, `read_process_output`, `interact_with_process`, `force_terminate`, `list_sessions`, `list_processes`, `kill_process` |
| Live status and cancellation (2) | `agent_status`, `cancel_operation` |
| Git inspection (3) | `git_status`, `git_diff`, `git_log` |
| Coding snapshot (1) | `read_code_file` |
| Project discovery (3) | `project_context`, `project_preferences`, `project_map` |
| Code navigation (5) | `code_outline`, `find_symbols`, `read_symbol`, `find_references`, `related_files` |
| Verified project checks (2) | `discover_checks`, `run_project_checks` |
| Language context (4) | `language_capabilities`, `code_graph`, `context_pack`, `session_handoff` |
| Language server navigation (1) | `lsp_query` |
| Image preview (1) | `read_images` |
| Parallel/background jobs (6) | `run_parallel`, `spawn_job`, `wait_jobs`, `get_job`, `list_jobs`, `cancel_job` |
| Device plugins and AST search (3) | `list_plugin_tools`, `call_plugin_tool`, `ast_search` |
| Local sandboxed Code Mode (1) | `code_mode` |
| Optional native-worker coordination (3) | `worker_tasks`, `worker_patch`, `worker_integrate` |

**Choosing the right tool:** Use `code_mode` for multi-step dependent coding workflows; use `read_file` for one known file, `read_multiple_files` for multiple known files, `write_file` for creation/rewrite/append and `edit_block` for focused existing-file edits. Use `run_command` for one-shot commands, `start_process` for interactive programs and `run_parallel` for independent work. Use `discover_checks` and `run_project_checks` for actual check evidence. Tool selection guidance lives in [`packages/agent/src/tool-routing.ts`](packages/agent/src/tool-routing.ts) and the relay MCP initialization rules.

### Two different kinds of parallel work

**1. Command and tool workers — no extra AI models.** `run_parallel` runs independent tool/command steps together. `spawn_job` returns a job ID immediately; `wait_jobs`, `get_job`, `list_jobs` and `cancel_job` manage the result. The agent allows up to three concurrent background workers (scaled to CPU availability), with one CPU-heavy job at a time; excess jobs queue. Background jobs can run longer than a normal MCP request (up to the configured maximum of 6 hours), and completed job records can survive an agent restart.

**2. Host-native AI workers — only if your AI client genuinely supports them.** `worker_tasks`, `worker_patch` and `worker_integrate` coordinate independent source scopes, proposed patches and a parent-owned verified integration. These tools **do not** create extra ChatGPT/Claude/Codex models or invoke an inference API. Coordination plans/claims live in the agent's memory and disappear on agent restart. See [parallel worker coordination](docs/parallel-workers.md).

## Extra MCP servers and marketplace

Built-in plugin management is available in the device agent and relay dashboard. The first agent launch can set up a default plugin set in the background. **Availability depends on the operating system, installed programs, Python, display permissions and successful installation**; listing a default does not guarantee it is ready.

| Default plugin | Purpose | Requirements / notes |
| --- | --- | --- |
| `playwright` | Browser automation | Browser/Playwright MCP must install successfully |
| `computer-use` | Screen, mouse and keyboard | GUI/display permissions; macOS default is off |
| `ast-grep` | Structural `ast_search` and `ast_rewrite` | Local ast-grep executable |
| `rtk` | Compress supported command output | Optional; `run_command` can fall back to ordinary output |
| `serena` | Symbol-level code intelligence | Python environment and Serena installation |
| `markitdown` | Convert supported documents to Markdown | Python environment and MarkItDown installation |

**From the relay dashboard:** Open `/admin` to see devices, installed-plugin status and pending AI requests. Use `/admin/marketplace` to search the MCP Registry or add a custom npm, PyPI, command or HTTPS MCP server. The owner explicitly approves installations; Docker-only registry packages are not supported by the marketplace.

**From the agent CLI:**

```powershell
node packages/agent/dist/cli.js --list-plugins
node packages/agent/dist/cli.js --add-plugin playwright
node packages/agent/dist/cli.js --enable-plugin playwright
node packages/agent/dist/cli.js --disable-plugin playwright
node packages/agent/dist/cli.js --remove-plugin playwright
node packages/agent/dist/cli.js --update-plugins
```

Other supported sources: `--npm package@version`, `--pypi package==version`, `--command "executable args"` and `--url https://host/mcp`, with optional `--env KEY=VALUE`. To **skip the default setup on startup**, use `--no-plugins` or `BRC_PLUGINS=none`. To refuse relay-initiated plugin changes on a device, set `BRC_PLUGIN_REMOTE_ADMIN=0`.

Plugin secrets are kept on the device, not persisted by the relay's plugin-request database. **Important:** third-party MCP plugins run with their own process permissions and do not automatically obey BRC's built-in `allowedDirectories` restriction. Install only plugins you trust.

## Skills and model token analytics

The self-hosted admin at `/admin` now has a fixed responsive sidebar, device cards, plugin controls, and daily / weekly / monthly model token charts. `/admin/skills` stores explicitly approved `SKILL.md` instruction packs for MCP clients; `list_skills` and `read_skill` expose them. A third-party skill is never executed or installed automatically.

**Automatic MCP-visible estimates:** one offline `gpt-tokenizer` package estimates text for all AI clients; it selects a matching OpenAI encoding when a client opts to send a `X-BRC-Model` hint and otherwise uses a universal fallback. Exact, already-serialized agent tool-message bytes are counted separately. The relay counts tool-result text (estimated model input) and tool-call arguments (estimated model output) using a separate BPE worker. It aggregates only per-account/day counts every ~4 seconds in SQLite or MongoDB; no prompt, response or tool-content archive is stored, and no tool call awaits counting. **These are not full ChatGPT or billable model tokens.** Actual provider-reported counts, when available, remain separately available via `POST /api/usage/report`; do not add the two sources together. [Scope, accuracy and setup](docs/relay-skills-usage.md).

## Authentication, connections and persistence

### Connecting a client

| Method | Endpoint / management | Notes |
| --- | --- | --- |
| OAuth MCP | `https://your-domain/mcp` | Normal authorization-code flow, PKCE and owner consent |
| Private MCP URL | `/auth/links` (creates a private `/c/.../mcp` link) | No OAuth configuration for the client; secret URL, revocable, read-only or full |
| API key | `/auth/apikeys` | Bearer credential for supported clients/integrations |
| Pair new device | `/device/verify` | Approve the agent's pairing code |
| Relay dashboard | `/admin` | Manage devices, plugin requests and recent activity |

Private links can be configured for periods including **1 or 2 years**, but long-lived full-access links carry substantial risk. Anyone holding an active full-access credential may invoke powerful device tools. Use HTTPS, read-only access where possible, and revoke links you no longer use.

### SQLite and MongoDB

- **SQLite (default):** `BRC_DB=/data/relay.sqlite` in the container. Keep the `/data` volume persistent between deployments. Approved skill content and reported token events use the same database.
- **MongoDB (optional):** set `MONGODB_URI` and, when needed, `MONGODB_DB`. Use a MongoDB deployment with its own persistent storage. Skills and token events use the selected MongoDB database. When MongoDB is configured but unavailable, the relay **does not silently switch to SQLite**.
- User accounts, pairing, OAuth data, connection links and plugin-request metadata are operational state. **Tool-call activity is live/in-memory only** in this fork; it is not a durable audit transcript.
- Finished **background-job history** on the agent is distinct from ephemeral live diagnostic logs and ephemeral host-native worker coordination.

## Start from this fork's source

**Requirements:** Node.js 22.13+ (Node 24 is also supported by this checkout), pnpm 11, a reachable relay address, and a modern browser for pairing. Run commands from your existing local checkout; cloning from GitHub will reflect only commits that have actually been pushed.

```powershell
# In the repository root
pnpm install --frozen-lockfile
pnpm build
pnpm catalog:check
```

### Local relay on Windows / PowerShell

In the first PowerShell window:

```powershell
$env:PUBLIC_URL = "http://127.0.0.1:3000"
$env:PORT = "3000"
$env:BRC_ADMIN_PASSWORD = "replace-with-a-strong-password"
$env:BRC_SESSION_SECRET = "replace-with-a-long-random-secret"
pnpm relay
```

In another PowerShell window on the device to control:

```powershell
.\START_AGENT.cmd --relay http://127.0.0.1:3000 --name "My PC"
```

Open `http://127.0.0.1:3000/device/verify`, sign in and approve the displayed code. Later launches can use `.\START_AGENT.cmd` to reuse the saved connection. The portable `START_AGENT.bat` can register the built project's location and be copied anywhere on the same Windows computer; see [launcher setup](docs/agent-context-and-terminal.md). `.\START_AGENT.cmd --setup` opens connection settings; `--forget-relay` clears only the agent's *local* saved connection, not the relay's paired-device entry.

On Windows, `START_AGENT.bat --register-only` records the built project path once; then you can copy just the BAT to Desktop/other folders or drives and double-click it. The agent's redesigned interactive terminal supports **M** settings, **S** connection status, **L** recent activity, **V** MyMCP-style/detailed/verbose/compact cycling and **?** help. The default terminal follows the **actual MyMCP remote-device console**: `[HH:MM:SS] 🔧 Received tool call <id>: ... metadata: ...` and `[HH:MM:SS] ✅ Tool call <tool> completed:` followed by a JSON output preview (or ❌ for failures). The preview is capped at 4 KiB and redacted on a best-effort basis; inline scripts, sensitive files and binary payloads are omitted. Longer JSON automatically wraps in the terminal. The local heartbeat still checks every 30 seconds but prints only when activity/connection changes or after five idle minutes. `--verbose` shows START and bounded redacted previews; `--compact` keeps the older concise format. The retained live log plus pending stdout and history-write payload budgets total **500 KiB** (428 KiB history, 40 KiB stdout queue, 32 KiB disk-write queue) without duplicating terminal scrollback. Separate sanitized **tool-history.jsonl** storage keeps at most **1,000 records**, each with a redacted **4-KiB output preview**, in a single file capped at **5 MiB**. It lives in the agent's local `~/.brc/logs/` folder; `BRC_TOOL_HISTORY=0` disables new disk history. Raw file contents, arbitrary arguments and Code Mode source are excluded. On other machines the BAT still needs a built checkout or globally installed agent.

For non-Windows devices, run `node packages/agent/dist/cli.js --relay https://your-domain --name "My Device"` from a built checkout. On supported systems the agent also offers `--install-service` and `--uninstall-service`.

### Docker relay / cloud deployment

The Compose file **builds the relay from this checkout** when run with `--build`. Prefer that during development; do not assume an image previously published under the upstream namespace contains this fork's changes.

```bash
# Copy .env.example to .env, then edit PUBLIC_URL,
# BRC_ADMIN_PASSWORD, BRC_SESSION_SECRET and optional storage values.
docker compose --profile local up -d --build
# or: docker compose --profile tunnel --profile cloudflare up -d --build
# or: docker compose --profile tunnel --profile ngrok up -d --build
# or: docker compose --profile cloud up -d --build
```

Local test profiles use HTTP on loopback; public deployments need HTTPS and correct `PUBLIC_URL` / `TRUST_PROXY` settings. The relay container can run independently of the Windows desktop agent.

### Important environment variables

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Exact public relay origin; used for OAuth issuer and callback validation |
| `BRC_ADMIN_USER`, `BRC_ADMIN_PASSWORD` | Dashboard login; use a strong password |
| `BRC_SESSION_SECRET` | Secret for signed browser sessions |
| `BRC_DB` | SQLite database path when MongoDB is not selected |
| `MONGODB_URI`, `MONGODB_DB` | Optional MongoDB storage (no silent SQLite fallback) |
| `BRC_RELAY`, `BRC_NAME`, `BRC_HOME` | Agent relay URL, device name and local state directory |
| `BRC_TOOL_PROFILE` | Tool-advertisement profile (e.g. `coding`); not a security boundary |
| `BRC_FAST_EXEC=0` | Disable the optional fast command-start optimization |
| `BRC_MAX_JOBS` | Background job concurrency |
| `BRC_PLUGINS=none` | Skip agent default-plugin installation/setup |
| `BRC_PLUGIN_REMOTE_ADMIN=0` | Reject remote plugin changes on the device |
| `BRC_PARSER_WORKERS` | Configure optional parser-worker pool size |
| `BRC_IMAGE_WORKERS` | Concurrent native image decodes per preview request (default 2; 1-3 supported) |
| `BRC_SKILLS_API_TOKEN` | Optional short-lived Vercel OIDC JWT for skills.sh catalog search; manual skills import needs no token |
| `BRC_MCP_TOKEN_ESTIMATES` | `1` (default) automatically estimates MCP-visible text tokens in a worker; set `0` to disable |
| `BRC_MCP_TOOL_PROFILE` | `codemode` (default, 11 native fallback + 3 relay tools; 15 with recovery), `core` (40 total), `focused` (48 agent tools), or `full` (64 agent tools). Set on the **relay**; 19 retired entries are not advertised. |
| `BRC_MAX_RESULT_BYTES` | Optional **agent** setting, default 524288 bytes (512 KiB), clamped from 64 KiB to 512 KiB; the relay also enforces a 512 KiB result forwarding cap for old agents. |

See [`.env.example`](.env.example) for relay and tunnel variables. Do not commit a real `.env`, pairing tokens or plugin secrets.

## Test, verify and benchmark

```bash
pnpm build
pnpm typecheck
pnpm catalog:check
pnpm test:unit
pnpm test:agent
pnpm test:e2e
pnpm test
pnpm bench:io
pnpm bench:images
pnpm bench:context
```

`pnpm test:mongo` is an additional opt-in MongoDB integration suite and requires a suitable MongoDB test environment. The normal `pnpm test` runs the unit, agent and end-to-end suites.

**Integration validation on this fork (2026-11-16):** build and catalog verification passed; the agent suite reported **195 passed, 2 skipped, 0 failed**; relay unit tests and relay-plugin tests passed; and the end-to-end suites passed. Those runs validate the tested scenarios, not every third-party plugin, operating system, production database or external deployment.

## Operational limits and safety

- Built-in file tools enforce configured filesystem restrictions, and ordinary commands pass through the agent's command policy. **This is not a full OS sandbox**, especially for arbitrary shells and external MCP plugins.
- `docker_inventory` and `docker_inspect` are observational tools. `sandbox_run` requires explicitly authorized execution, a running local Docker daemon and an existing suitable image; it does not automatically pull images.
- `ast_search` / `ast_rewrite` require the ast-grep executable. Language navigation is syntax-aware where supported, but candidate references are not guaranteed semantic/LSP results.
- `write_pdf` may require a Chrome download. `read_images` previews images but does not provide OCR.
- Running a command, starting a background job or finding a test command is **not evidence that it passed**. Inspect actual exit status and verification results.
- If a client caches an old tool list, reconnect or refresh the MCP connector after deploying updated relay/agent code.
- An experimental Android agent is documented separately; it is **not part of this current `marge-branch` checkout**.

## More documentation

- [Architecture and protocol](docs/architecture.md)
- [Relay dashboard, automatic MCP token estimates and provider reports](docs/relay-skills-usage.md)
- [Compact code context and portable Windows agent console](docs/agent-context-and-terminal.md)
- [Coding-agent setup and diagnostics](docs/coding-agent.md)
- [Fast batches, images and sandbox](docs/fast-agent.md)
- [Parallel worker coordination](docs/parallel-workers.md)
- [Multilingual coding harness](docs/polyglot-harness.md)
- [Android agent notes (separate work)](docs/android-agent.md)
- [Security notes](SECURITY.md)

## License and credits

MIT — see [LICENSE](LICENSE). The device tool core includes work derived from [Desktop Commander MCP](https://github.com/wonderwhy-er/DesktopCommanderMCP), by Eduard Ruzga and contributors, under its license. See [NOTICE](NOTICE) for attribution. This repository builds on [shahidx0x/better-remote-commander](https://github.com/shahidx0x/better-remote-commander) and retains additional fork-specific relay, storage, connection and coordination features.
