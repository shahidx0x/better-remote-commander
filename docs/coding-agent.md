# Coding agent: local launch, live output and project harness

This source build exposes 67 agent tools, plus the relay's `list_devices` (68 total). The new tools do not contain another AI model: the connected AI chooses the work, and the local agent provides context, performs authorized operations and verifies results.

## Run your checkout

From the repository root on Windows:

```powershell
pnpm install
pnpm build
.\START_AGENT.cmd --relay https://YOUR-RELAY.example --name "My Windows PC" --no-browser
```

Use your actual BRC relay base URL, not the example, and not its `/mcp` endpoint. Approve the pairing code. After pairing, simply run:

```powershell
.\START_AGENT.cmd
```

The launcher runs `node packages/agent/dist/cli.js`. No globally published `brc-agent` package is necessary. Rebuild and restart this local process after changing its source. Rebuild/redeploy the relay too when changing relay code; a local build does not update a VPS.

Optional: `BRC_TOOL_PROFILE=coding` hides six document/transfer/history tools from discovery. The default advertises the full compatible set. This is not a security boundary or per-tool authorization system.

## Live logging only

Normal foreground output is limited to compact activity lines:

```text
[20:30:01] START read_symbol [a1234567]
[20:30:01] OK    read_symbol [a1234567] 8ms
[20:30:05] ERROR edit_files [b1234567] 2ms FILE_CONFLICT
```

No activity JSONL, `agent.log`, persisted tool history, periodic idle status messages or diagnostic telemetry is produced. The former `BRC_LOG_FILE` and retention settings cannot re-enable log persistence. Tool arguments, file contents and results are not printed by the activity logger. `--debug` only adds live diagnostic detail.

Console lines are bounded to at most 160 characters, adjusted to terminal width, with a bounded 200-line pending output queue and backpressure handling. A 1,000-event metadata ring supports current-process status/latency queries. It disappears when the process exits and is never written to disk.

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
