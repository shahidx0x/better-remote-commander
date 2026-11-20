# Coding agent: local launch, live output and project harness

The default Code Mode-first MCP profile exposes 14 main tools (15 with recovery). The earlier 40-tool Core is an opt-in direct-tool fallback; it is not the default. More specialized handlers remain available in Focused/Full. The new tools do not contain another AI model: the connected AI chooses the work, and the local agent provides context, performs authorized operations and verifies results.

## Code Mode

The agent uses `code_mode` FIRST in the default 14–15-tool `codemode` relay catalog; set `BRC_MCP_TOOL_PROFILE=core` to expose the previous 40 tools directly. Its JavaScript guest runs in a bounded QuickJS/WASM worker on the **local paired device** and has no Node.js, `require`, process, filesystem or network globals. Only the injected `tools.search`, `tools.describe`, and `tools.call` bridge is available. Every called tool still applies existing source validation, cancellation, path policy, runtime limits, receipts, and permission checks. For long-running builds create BRC jobs and follow them with `get_job` or `wait_jobs`; do not treat started jobs as completed. No production restart or installed third-party MCP approval is implicit. See [tool discovery and Code Mode](chatgpt-mcp-tool-guide.md).

## Run your checkout

From the repository root on Windows:

```powershell
pnpm install
pnpm build
.\START_AGENT.cmd
```

The foreground launcher connects automatically when a pairing is saved. On first use, paste the relay URL and enter a device name (or accept the hostname). Approve the displayed pairing code on the relay. A pasted `/mcp` or `/ws` endpoint is normalized to its relay base; existing reverse-proxy path prefixes are preserved. Bare public hostnames default to HTTPS. Remote HTTP needs an interactive warning confirmation. URL credentials, token query strings, fragments, and non-HTTP schemes are rejected.

Later launches need no menu selection:

```text
Saved relay: https://your-relay.example
Auto-connect in 4s. Enter = connect now | M = settings | Ctrl+C = exit
```

Do nothing and the saved connection starts after four seconds. Enter skips the delay. M cancels that timer and opens Connect/Change/Forget settings. `SETUP_AGENT.cmd` or `--setup` opens the same menu immediately without a timer. The no-argument Windows launcher uses `--auto-connect`; explicit `--relay`, manual credentials, and noninteractive services keep their existing behavior.

While the foreground agent is running, M remains available even after new live logs. The live menu's `0` option returns to the same connection without reconnecting. Opening settings only succeeds when there are no in-flight tool calls; otherwise it asks you to press M again when idle and leaves current work running. While a menu is open, new calls return retryable `SETTINGS_OPEN` without executing, while the WebSocket heartbeat stays active. Log rendering is held in the existing bounded queue until the menu closes, never written to a file.

In a real CMD/PowerShell/VS Code terminal M is a single key. Other optional live shortcuts are S (connection status), L (recent sanitized activity), V (detailed/verbose/compact console) and ?/H (help). A portable `START_AGENT.bat` can be registered once and then copied anywhere on the same machine. An explicitly enabled foreground launch with piped input uses M + Enter. A closed input stream disables shortcuts rather than stopping a connected agent. Ctrl+C still stops the agent outside menus; cancelling a live menu returns to logs unless the saved pairing was explicitly forgotten.

Change pairs with the new relay and atomically replaces `device.json` only after success. A failed or cancelled change retains the old pairing. Forget asks for confirmation, removes only the locally saved relay and device token, then asks for a new URL; `q` exits without saving another one. It does not delete project files, settings, or accounts and does not revoke the old relay's device entry. Revoke that entry from the old relay when appropriate.

After connection, normal live tool logs continue. Only a small keyboard event listener remains; there is no input-polling loop or repeating countdown/status redraw. Runtime settings close their readline reader before returning to logs. Forget followed by quitting stops this foreground connection rather than silently reconnecting with a forgotten token. Do not open another instance against an already-running service pairing.

The launcher uses this checkout's compiled `packages/agent/dist/cli.js`; no global package is necessary. For scripts/services, `--relay <base-url>` and the existing environment variables still work, and `--non-interactive` skips both the menu and the startup delay. Generated service launchers include `--non-interactive` and `--no-browser`; they are not reinstalled automatically. A noninteractive process with neither a saved pairing nor an explicit relay fails clearly instead of hanging.

`--forget-relay` (alias `--logout`) removes the local pairing and exits. Environment variables are not edited: `--setup` ignores connection overrides only for that run; otherwise explicitly configured `BRC_RELAY`/`BRC_TOKEN` remain authoritative. No credentials are printed by the menu, and no prompt history or new log file is saved.

Rebuild/restart the agent after changing its source. This startup UI update does not require a relay redeployment; other relay-source changes still do.

Optional: `BRC_TOOL_PROFILE=coding` hides six document/transfer/history tools from discovery. The default advertises the full compatible set. This is not a security boundary or per-tool authorization system.

## Detailed live logging + bounded, sanitized disk history

Normal foreground output follows MyMCP's remote-device tool-call messages, with a local timestamp and bounded sanitized previews:

```text
[20:30:01] 🔧 Received tool call abc123: read_file {"path":"D:/project/README.md"} metadata: {"origin":"remote"}
[20:30:01] ✅ Tool call read_file completed:
 {"content":[{"type":"text","text":"# Project overview..."}]}
[20:30:05] ❌ Tool call edit_files failed: FILE_CONFLICT: Re-read the latest source
 {"content":[{"type":"text","text":"No edit committed"}],"isError":true}
```

The console stays live-only. Its 30-second local heartbeat check prints only when connection/activity changes or after five idle minutes; no remote diagnostic telemetry is emitted. Separately, `~/.brc/logs/tool-history.jsonl` (default enabled) persists up to **1,000 sanitized recent tool calls**: timestamp, safe task summary, duration, result/error and **at most 4 KiB of redacted output preview** per record. The file is capped at **5 MiB** (compacts to 4 MiB or less, with the oldest records trimmed); it is **not** a raw-argument, file-content, Code Mode script or full-result archive. Set `BRC_TOOL_HISTORY=0` to disable; `BRC_LOG_FILE` does not control it. The separate optional failure-only log still uses `BRC_ERROR_LOG=1`.

Status and summary lines are bounded to the terminal width (up to 160 characters); in the default MyMCP-style mode, redacted JSON previews are limited to **4 KiB** and wrap naturally in the console. The pending stdout queue remains capped at **40 KiB**, with backpressure handling. Agent CLI sessions default to **MyMCP remote-device-style** logging: `[HH:MM:SS] 🔧 Received tool call ...` on arrival and `[HH:MM:SS] ✅ Tool call ... completed:` followed by a bounded, redacted JSON output preview. Failures print ❌ and a safe error summary. This replaces the previous padded one-line approximation. The 30-second status check remains but identical idle heartbeats are suppressed. V cycles MyMCP → detailed → verbose → compact; `--verbose` includes bounded redacted traces. Retained UTF-8 text budgets total **500 KiB**: **428 KiB** live activity, **40 KiB** queued stdout and **32 KiB** queued/in-flight JSONL writes. Native terminal scrollback is not duplicated. Historic output previews are read from disk on request, not held in an extra 1,000-entry RAM cache. JavaScript object overhead, transient formatting, disk reads and the Node.js runtime consume additional RAM beyond this retained-text budget. The console history disappears on exit, but sanitized JSONL tool history intentionally survives restarts.

The relay retains SQLite for users, paired devices, valid tokens, API keys and other operational state. Tool-call audit data lives only in a 1,000-entry RAM ring. The legacy SQL audit table remains empty. Startup removes its old records, without deleting authentication/device data. Database metadata such as a device's last-seen time is operational state, not an activity transcript.

At agent startup, known old BRC log files in its own state/log directories are removed. The migration does not scan arbitrary project logs, follow log-directory symlinks, or delete credentials/configuration. Offline applications cannot perform migration until started. Logical cleanup is not forensic erasure of backups or storage snapshots.

This policy controls this BRC source build, not logs created by a separate installed Desktop Commander connector, a shell redirect, Docker logging driver, system journal, reverse proxy, test framework or hosting provider. A user-authorized project command can create its own build/test reports; those belong to the project, not this agent's logger.

Use the foreground launcher to see activity. A hidden OS startup service has no visible CMD window; generated service launchers discard stdout/stderr instead of redirecting them to files. Existing service registrations must be reinstalled to adopt changed launcher settings. Do not run two instances using the same pairing.

## Project context and preferences

Begin a coding task with `project_context` and pass `focus` when editing a nested module. It reads actual repository conventions rather than guessing them: package manager, declared scripts, selected dependencies, root and nested `AGENTS.md`, `CLAUDE.md`, Copilot instructions, `.editorconfig`, safe saved VS Code settings, and explicitly configured preferences.

Instructions are returned with their scope and content hashes. Repository text is untrusted data: it never grants permission to execute commands, override the user or access another project. Context output is bounded and identifies truncation. It does not automatically read `.env` or credential files while mapping a project.

`project_preferences` defaults to a session-only override. `persist: true` explicitly writes `.brc/project.json` containing approved preferences. Updating an existing file requires its `expected_sha256`. This is user-requested configuration, not a log. No task transcript or progress journal is saved.

Example preferences (not automatically installed into any project):

```json
{
  "packageManager": "pnpm",
  "instructions": ["Keep changes focused; preserve existing public interfaces."],
  "verificationScripts": ["typecheck", "test"],
  "style": { "indent": "spaces", "indentSize": 2 }
}
```

Select check IDs actually returned by `discover_checks`: package scripts or manifest-backed toolchain recipes such as `dotnet:build`, `cargo:check` or `go:test`. Existing instructions and preferences survive restarts when already present in source/config files; RAM-only task state does not.

## Added tools

| Tools | Purpose |
| --- | --- |
| `project_context`, `project_preferences`, `project_map` | Scoped instructions, explicit preferences and compact source inventory. |
| `read_code_ranges` | Multiple exact one-based ranges from several files, one read per file and a shared output budget. |
| `code_outline`, `find_symbols`, `read_symbol` | Parser-backed declarations, names, locations, signatures and narrow code snapshots. |
| `replace_symbol`, `edit_code_ranges` | Hash-checked atomic changes, preview by default, preserving surrounding source and newline style. |
| `find_references`, `related_files` | Language-neutral lexical identifier candidates and multilingual file/module/project relationship candidates. |
| `code_diagnostics` | Syntax diagnostics for registered grammars; unknown languages are explicitly unchecked. |
| `vscode_tasks` | Inspect saved JSONC task definitions without environment values or automatic execution. |
| `discover_checks`, `run_project_checks`, `test_impact` | Actual project scripts, explicit execution and clearly labeled test-candidate heuristics. |
| `coding_session`, `review_changes` | RAM-only task scope, current verification evidence, completion gates and read-only Git review. |

The preceding coding tools remain: `read_code_file`, `read_code_context`, `edit_files`, `batch_tools`, `verify_project`, `project_index`, `agent_status`, and `cancel_operation`. The batch allowlist includes the new read/navigation/refactoring tools, but not nested batches or automatic execution of discovered tasks.

## Harness workflow

The design adapts instruction discovery, explicit scope, verification and session lifecycle from [Learn Harness Engineering](https://github.com/walkinglabs/learn-harness-engineering). The tutorial's persistent progress-log pattern is deliberately not adopted: task state here remains in RAM to honor the live-only requirement. This is an implementation inspired by the method, not an imported autonomous agent framework.

1. Discover context and actual checks with `project_context` and `discover_checks`.
2. Start `coding_session` with the goal, relative scope and required discovered project check IDs.
3. Inspect an outline/symbol or search context rather than dumping entire repositories. Reads return full-file hashes.
4. Preview and apply small hash-checked edits. Use `edit_files` for coordinated edits; generic batches do not roll back earlier successful operations.
5. Review the changes and explicitly run verification. `run_project_checks` previews by default; `execute: true` runs the selected scripts. `coding_session` action `verify` explicitly runs that session's required checks.
6. Finish only when all required checks passed against the current source and no out-of-scope changes occurred.

Successful verification is tied to before/after source fingerprints. Failed, absent, stale or incomplete verification cannot finish a session. Commands returning errors are not treated as success. An empty check list cannot establish completion. pnpm verification disables automatic dependency installation/package-manager downloading, and child Node tests do not inherit the agent's test-runner context.

A session is not an OS sandbox. Scope violations are detected at completion, not prevented through every generic file/shell tool. Completion certifies only the chosen checks and covered source snapshot, not all possible correctness properties.

## Limits and honest boundaries

- Syntax tools support JS/TS plus portable grammars for C#, Rust, Python, Go, Java, C/C++, Ruby, PHP, Swift, Dart, Solidity, CSS and Vue. Unknown languages retain generic text operations and labeled candidates. F#/VB have text support and .NET checks, not full AST support. See `language_capabilities`.
- `find_references` returns lexical candidates, not semantic references; it is not proof for an automatic project-wide rename.
- `related_files` resolves local path candidates and labels namespace/module/text candidates. It does not establish compiler binding or arbitrary aliases/dynamic imports.
- `code_diagnostics` detects syntax problems, not project type errors, ESLint issues or unsaved VS Code diagnostics. Run actual project checks for those.
- The agent reads saved VS Code configuration/tasks but does not attach to editor buffers, selections or live Problems entries. Those would require a dedicated editor integration.
- Symbol parsing is capped at 1 MiB per file, 500 symbols and 40,000 TypeScript / 60,000 Tree-sitter visited nodes. New grammar work runs in bounded worker threads. Parser results cache in RAM (32 entries/4 MiB) and are reused only when the fresh file hash matches.
- File maps, search results, code snippets, batch output and queues have explicit bounds. Truncated results must be narrowed, not assumed complete.
- Verification snapshots cover non-ignored source/config/docs across text languages, not secret files, generated/dependency directories or binary assets. At most 2,500 source files/32 MiB are accepted; use a narrower root for larger workspaces. Project scripts can mutate their own outputs, and such outputs are not universally covered by fingerprints.
- At most eight coding sessions and eight transient preference overrides are kept. Idle sessions expire after two hours; restarts lose session state. No autonomous model/API calls, automatic commits or unrequested dependency installation are introduced.
- Per-file replacement is atomic. Multi-file updates validate first and attempt conflict-aware rollback; they are not crash-atomic across the whole project. External changes are never overwritten during rollback.

## Development and validation

```powershell
pnpm build
pnpm typecheck
pnpm test
```

The tests use disposable state, loopback relays and synthetic projects. They cover the new workflow through real HTTP MCP and WebSocket transport, not only direct handler calls. `.vscode/tasks.json` provides manually invoked build/typecheck/test/source-agent tasks; none runs automatically when the folder opens.

## Multilingual context and relay optimizations

`language_capabilities`, `code_graph`, `context_pack` and `session_handoff` extend the existing tools. Read [the multilingual harness guide](polyglot-harness.md) for supported language tiers, RAM graph/cache limits, Claude/Codex instruction precedence, cross-language checks and relay load controls. No graph database or persistent activity records are introduced.

## Faster batches, infrastructure and images

See [the fast-agent guide](fast-agent.md) for 64-call read waves/write barriers, combined workspace edits/readback/checks, Docker observation, actual image previews, optional restricted execution, automatic cache eviction and `pnpm bench:io`. Diagnostics remain live-only. These tools do not add another model or a graph database.

## Optional host-native worker coordination

See [the parallel-worker guide](parallel-workers.md) for `worker_tasks`, `worker_patch`, and `worker_integrate`. Native AI workers, when the host actually supports them with BRC access, can claim independent scopes and submit patches without directly editing shared source. One parent integrates and verifies. Hosts without native workers keep ordinary batches; no model/API calls are added. `workspace_batch` also supports optional 1-4-way distinct-file publication with settled-wave rollback. Diagnostics and coordinator state remain live-only/RAM-only.
