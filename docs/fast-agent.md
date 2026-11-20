# BRC coding tools, bounded results and legacy tool reference

This checkout implements an 83-entry offline compatibility catalog, but the relay now defaults to **14–15 Code Mode-first MCP tools** (the previous 40-tool Core is available explicitly). Focused exposes 48 native agent tools and Full exposes 64, plus relay tools. The 19 retired public entries include competing multi-file editors and Docker-specific tools. The agent executes authorized calls; the relay authenticates, routes and limits results. Existing internal worker-batch functionality is retained. No new model, orchestration framework or graph database is required.

## Code Mode for workflows requiring several dependent tools

For most coding and testing workflows involving more than one step, prefer `code_mode`: run model-authored JavaScript in the paired device's QuickJS/WASM sandbox and use `await tools.search(query)`, `await tools.describe(name)` and `await tools.call(name,args)` for progressive tool discovery, file edits, Git and real test execution. No direct Node/OS globals are exposed in the guest; each nested call passes the original BRC dispatcher and permission checks. It consumes **one remote MCP call** but still performs its nested local operations. Use direct tools for one short action, `spawn_job` plus later `get_job`/`wait_jobs` for builds that outlive a Code Mode call, and **never** auto-replay uncertain mutations. The worker limits memory, time, output and nested tool calls. See [Code Mode guide](chatgpt-mcp-tool-guide.md#local-javascript-code-mode-for-multi-step-coding).

## The short workflow

1. When **two or more paths are already known**, call `read_multiple_files` **once** with `paths` or per-file `files` ranges. Avoid multiple separate `read_file` calls or Promise.all(read_file). The tool itself overlaps up to eight file reads.
2. For **one** file/range, use `read_file`; use `read_code_file` if the caller needs the SHA-256 for a safe edit. If paths are **unknown**, prefer `start_search` with `wait=true`, then read the matches.
3. For independent non-file operations use `run_parallel` (bounded concurrency and combined output). For many known file reads prefer `read_multiple_files`. Do not nest batches.
4. For file changes use `write_file` (explicit rewrite/append) or `edit_block` (focused replacement). For multiple files, apply each authorized change in a deliberate sequence and verify the result. The internal `workspaceBatch` engine is reserved for worker integration and legacy compatibility.
5. Load `project_context` or a focused `context_pack` only when conventions are unknown; avoid blanket context dumps.
6. Inspect image assets with `read_images` when appropriate. Docker-specific MCP tools are retired from public discovery; run system commands only if the user authorized them.
7. Use `run_command` for one-shot commands with a final exit code; use `start_process` only for interactive or long-running processes. The retired `sandbox_run` tool is not advertised.

Each legacy agent handler has a `USE WHEN`/`USE INSTEAD` rule in `packages/agent/src/tool-routing.ts`; the relay serves only the non-retired subset. These rules are prepended to the local agent's tool definitions and the relay's stable catalog, including when an older agent reconnects. CI tests verify that every tool has a rule and that schemas/permissions are unchanged. The relay's additional `list_devices` tool has its own decision rule. The catalog adds no model call, network hop, persistent data, or project index.

**Ground claims in tool output:** lexical matches are not semantic references, syntax checks are not compiler passes, Docker errors are not empty inventories, and starting a command is not completing it. Only report executed checks, edits, service status and worker results that the actual tools verified. A model/host still chooses the tools; these rules are guidance, not a way to force third-party models to obey.

Do not insist on starting a coding session, building a graph, loading parsers or opening Docker for every tiny edit. The existing specialized tools remain available.

## Reliable file budgets and project checks

The BRC agent bounds direct file I/O with explicit pagination and errors:

- `read_file` defaults to 300 lines on new installs (configurable `fileReadLineLimit`), hard max 2,000 lines. Model-facing plain text is capped at 128,000 characters and UI preview at 256,000. Huge single lines return **OUTPUT TRUNCATED**; request a smaller range or use `read_code_file` for character offsets.
- `read_multiple_files` defaults to 200 lines per file, accepts explicit per-file ranges up to 2,000 lines, and caps returned content to 48,000 text characters per item, 160,000 characters combined and 2 MiB of image data. Truncated results are labeled; use smaller batches or `read_images`.
- `write_file` defaults to 1,000 lines per call on new installs, configurable with `fileWriteLineLimit` (hard max: 2,000), and **1 MiB UTF-8 per call**. Oversized writes return structured `WRITE_LINE_LIMIT` or `WRITE_SIZE_LIMIT` **before changing a file**. Existing nonempty files require explicit `mode=rewrite` or `mode=append`, otherwise `WRITE_MODE_REQUIRED` prevents accidental overwrite.
- Write larger new files in deliberate rewrite + append chunks. For existing source edits, use focused, hash-preconditioned `edit_block` changes. Public batch writers are retired; internal worker integration still uses hash-checked batching. Limits apply per request, **not total project size**. Append is not automatically idempotent; inspect results before retrying.
- `project_context` now supports a planned focus file and missing nested directories, reading existing scoped instructions. Missing project roots return `PROJECT_NOT_FOUND`; symlink/junction escapes remain blocked.
- `run_project_checks` now returns `CHECK_FAILED` with the failing check, exit code and bounded log excerpt (up to 8,000 chars per step) rather than an opaque `TOOL_FAILED`. It still marks failed tests as failures. `VERIFICATION_CHANGED` indicates files changed while checks were running. Use `discover_checks` to find valid check IDs.

Existing saved configuration can override new-install defaults. Use `get_config` to inspect current values and `set_config_value` to adjust them within hard bounds. Rebuild and restart the agent to use changed source code; the relay itself does not replace a running agent.

These caps reduce oversized MCP results but cannot guarantee that the independent ChatGPT message stream never fails. Pillow/Python deprecation warnings are not BRC agent errors.

## Fewer round trips

### Bounded parallel jobs

`run_parallel` now uses a bounded 4-wide default and 8-wide hard cap, regardless of a higher requested concurrency. `BRC_MAX_JOBS` is bounded to 8 pooled jobs. Independent jobs can still run concurrently; do not write the same file from multiple jobs at once.

To avoid very large MCP replies, `run_parallel`, `wait_jobs`, and `get_job` cap their complete **combined** response at 128,000 characters. If a response says `MORE PARALLEL RESULTS`, use its group with `wait_jobs({group: "par-..."})` to retrieve still-unreported jobs, **not another run_parallel call**. For a long multi-step job, call `get_job({id,step_offset:0,step_limit:10,output_chars:8000})`, and follow the returned `MORE JOB STEPS` offset until complete. Jobs continue when output is truncated; it is never safe to blindly replay a timed-out mutation.

Each job step retains a bounded output excerpt in memory; job count is bounded. If the host disconnects or the agent restarts, inspect target files and hashes before reconstructing plans; in-RAM worker plans do not survive an agent restart. Actual host-native subagents are outside BRC: worker coordination stages/verifies patches, but does not spawn models.

### Retired public tool: `batch_tools` (legacy compatibility reference)

A batch accepts up to 64 calls. `mode: "auto"` is the default: consecutive independent read tools run in waves of at most four, with writes and stateful tools acting as sequential barriers. This preserves read-before-write and write-before-read ordering inside a batch. `mode: "sequential"` keeps strict serial execution. `mode: "parallel"` accepts only independent read tools and rejects a write before execution.

`stopOnError` defaults to true. Already-started reads finish, but later writes are not launched after an error. A generic batch is not transactional: earlier successful writes are not undone. Nested batches, arbitrary shell execution, configuration changes and Docker execution are not accepted in this batch.

Responses are compact by default: structured data is not duplicated again as text inside each child result. `maxChars` defaults to 96,000 and is capped at 256,000. Per-entry output is bounded, truncation is explicit, and work stops before the shared result budget is exhausted. This is an output budget, not permission to assume an incomplete result is complete. Image binaries are returned through `read_images`, not escaped inside a generic JSON batch.

### Internal/legacy tool: `workspace_batch` (not publicly advertised)

The `path` is a project root. One call can contain up to 64 changes, 64 reads and five existing check IDs. The sequence is: validate all changes and check IDs, commit changes, return readbacks/hashes, then run selected checks. `dryRun` defaults to true. Checks never run in a dry run.

```json
{
  "path": "D:\\projects\\example",
  "dryRun": false,
  "changes": [
    {
      "path": "src/example.rs",
      "expected_sha256": "<hash from a fresh read>",
      "edits": [{ "old_string": "return 1;", "new_string": "return 2;" }]
    },
    {
      "path": "notes.txt",
      "expected_sha256": null,
      "content": "A deliberately created file.\n"
    }
  ],
  "reads": [{ "path": "src/example.rs", "offset": 0, "length": 80 }],
  "checks": ["cargo:check"]
}
```

Replace the example hash with the real 64-character SHA-256. `expected_sha256: null` means create only if absent; racing file creation is not overwritten. A change supplies full `content` OR exact `edits`. Existing parent directories are required. Read entries can supply `known_sha256`; unchanged files return their hash without repeating source text.

Input arguments are capped at 8 MiB, before/after snapshots at 16 MiB total, and individual existing files/edited results at 4 MiB. Exact edits preserve existing line-ending style. Each replacement/publication is atomic; coordinated edits validate first and attempt conflict-aware rollback. This is not a crash-atomic multi-file transaction or a filesystem compare-and-swap against all external editors. A later failing build/test does not undo code.

### Measure instead of guessing

```powershell
pnpm bench:io
pnpm bench:images
pnpm bench:context
```

`bench:images` generates six temporary JPEG fixtures, times native `read_images` single/batch/sheet/metadata operations, and removes the fixtures. Its timings exclude the network and AI host. `BRC_IMAGE_WORKERS=1` can reduce memory pressure on lower-RAM devices; the default is 2.

`bench:io` runs a disposable loopback HTTP MCP -> relay -> WebSocket -> separate compiled agent benchmark. It verifies contents/hashes, compares 32 separate reads/writes with batched equivalents, prints median timings across three rounds and cleans up. It writes no benchmark report/log. `bench:context` measures graph reuse separately.

Local numbers do not measure the public VPS, tunnel, ChatGPT tool scheduling or model generation. If a deployment really has a 60 ms round-trip cost, 32 serialized network calls contribute about 1,920 ms of round-trip waiting, whereas one batch contributes one such round trip plus its local execution and transfer time. Batching reduces the number of round trips; it cannot make the underlying network round trip disappear.

Results expose local `agentQueueMs`, `agentTotalMs`, handler `durationMs`, and relay duration metadata. These are measured durations, not synchronized cross-host timestamps.

## Docker truth before creating infrastructure

`docker_inventory` lists existing containers (including stopped ones by default), images/tags/IDs and published ports from the Docker CLI's current context. `docker_inspect` reads selected image/container state, health, mount and port metadata. Environment values and startup commands are omitted.

These tools never build, pull, remove, prune, start or restart anything. Inspection is fresh, bounded and timestamped. An unavailable daemon or truncated/unparseable response is an error/unknown state, not proof that no images or containers exist. The inventory is not a permanent cache: inspect again before making a reuse decision.

## Optional sandbox

`sandbox_run` previews by default. `execute: true` is a mutation that must be explicitly authorized. It requires a running local Docker Engine and an existing **Linux** image. It never pulls/builds an image, starts Docker Desktop, changes a production container or falls back to executing on the host.

The image is resolved to its immutable local ID. Images declaring writable `VOLUME`s are refused. The Docker endpoint must be a local Unix socket or Windows named pipe, not an SSH/TCP remote context. Inputs are a disposable copy of non-ignored regular project files: at most 2,000 files, 4 MiB per file and 64 MiB total. Known credential paths are excluded. Original project files are never mounted.

The container has no network, a read-only root, a read-only source mount, no capabilities, no-new-privileges, a non-root user, 64 PIDs, one CPU, a 256 MiB memory/swap ceiling and a 64 MiB `/tmp`. It has no Docker socket or host credentials mount. Container logging is disabled. On completion/timeout/cancellation, only its randomly named BRC container is removed, and cleanup confirmation is reported.

Only `/tmp` is writable. Copy/build there when needed, using a suitable already-installed image. This deliberately small sandbox does not reproduce arbitrary development environments or automatically download dependencies. Repository filenames cannot guarantee source contains no secrets. It requires a trusted image/daemon/kernel and is not VM-grade isolation against every escape or side channel. Other ordinary shell tools still run with their existing host authority; adding this tool does not silently sandbox them.

At implementation time Docker was installed on the target PC but its daemon was unavailable. Argument restrictions, sanitized staging, cleanup and refusal behavior are covered by isolated tests; actual container execution on that PC was not validated. Do not turn mock-backed tests into a claim that a container was run.

## Images without giant payloads

`read_images` mode `list` reads the filename inventory and sizes without loading the image decoder. Select up to 12 files for `metadata`, `previews` or `sheet`. A contact sheet is ordered left-to-right, top-to-bottom, with zero-based indexes mapped back to filenames.

PNG, JPEG, WebP, GIF, AVIF and TIFF inputs are supported when the installed decoder can read them. Only the first animation frame/page is read. Inputs are limited to 16 MiB and 16 megapixels each. Selected previews are resized, auto-oriented, stripped of metadata and returned as real MCP `image` blocks, with a 2 MiB encoded preview budget. Originals are never changed. SVG/XML/HTML masquerading as raster images is refused; inspect SVG source with text tools instead.

For model-facing inspection, prefer `read_images` over `read_file`: the latter returns the complete original raster bytes, which can be much larger over MCP. Sharp uses native libvips; the library loads lazily and its operation cache remains disabled. Requests are queued (maximum eight) and each request decodes up to **two images concurrently** by default (`BRC_IMAGE_WORKERS=1..3`, clamped to 1-3). A sheet composes raw RGB cells and encodes WebP once instead of re-encoding each tile. The same 16 MiB / 16 MP input and 2 MiB final encoded output limits apply; native image operations are CPU/memory-bounded and cannot remove network or model latency. No OCR, upload, disk thumbnail cache or hidden model call is performed.

## Languages

Text searching, bounded reads and hash-checked text edits are language-neutral for ordinary UTF-8 source, including unknown extensions. `.NET` is an ecosystem: C# has a syntax grammar; F# and VB have generic text navigation and project checks. `language_capabilities` reports the current exact parser tiers.

Popular generic identities now also cover Lua, R, Julia, Elixir, Erlang, Haskell, OCaml, Zig, SQL, Fortran, COBOL, HTML and configuration files. Generic declaration candidates are labeled and never authorize an AST body replacement or pretend to prove syntax validity. Installed parsers are still not full compiler/type/language-server implementations for every language on Earth.

## Bounded memory and storage

Code graphs, filename indexes, parser results and recent activity remain in RAM. `context_pack` mode=outline and `code_graph` format=compact are optional dictionary-coded output projections; source can be read on demand, with no external model calls. There is no persistent context/index database or saved thumbnail cache: disk context-cache usage is zero.

Retained context caches have an aggregate estimated-payload budget of 256 MiB, with much smaller individual limits. Parser-cache accounting includes source strings and symbol/import metadata. Cache entries and file watchers expire after five idle minutes; project slots evict least-recently-used idle roots rather than requiring manual clearing. The pool now defaults to one lazy parser worker, with at most two explicitly configured through `BRC_PARSER_WORKERS`, a 16-job queue, idle termination and a 64 MiB V8 old-generation limit per worker.

BRC-owned sandbox input scratch has a separate 256 MiB disk budget. Normal completion removes it immediately. Startup, periodic maintenance and admission checks delete old inactive entries after two hours or evict oldest inactive entries under size pressure. Active inputs are protected; admission fails when necessary rather than deleting user data. Ownership markers restrict cleanup to known disposable directories.

These are not an OS-enforced limit on whole-process RSS or total installed disk footprint. JavaScript/native/WASM allocations, image decoding, in-flight requests and allocator behavior can temporarily exceed cache payload accounting. `agent_status` reports RSS and estimates; soft memory pressure reclaims idle caches/workers. Installed packages, Docker images, projects and operational authentication databases are **not** auto-deleted. The optional sandbox has its own resource limit and Docker Desktop has its own overhead.

## Live-only diagnostics and relay work

Logs remain compact live START/OK/ERROR lines, with no persisted activity/transcripts/SQLite audit rows. Authentication/device/configuration state stays intact. Operational API-key `last_used` writes are coalesced to at most one per 30 seconds; every authorization lookup still executes against current rows, so revocation is immediate. The relay reuses compiled fixed SQL statements, not authorization results.

## Study basis and adaptation

- [Learn Harness Engineering](https://github.com/walkinglabs/learn-harness-engineering): explicit instructions, state, verification, scope and lifecycle.
- [Lecture 6: initialization](https://github.com/walkinglabs/learn-harness-engineering/blob/main/docs/en/lectures/lecture-06-why-initialization-needs-its-own-phase/index.md): inspect actual environment before implementation; applied here to Docker/image discovery.
- [Lecture 11: observability](https://github.com/walkinglabs/learn-harness-engineering/blob/main/docs/en/lectures/lecture-11-why-observability-belongs-inside-the-harness/index.md): expose runtime evidence, not merely more logs; adapted here to bounded live results and real verification.
- [Lecture 14: orchestration cost](https://github.com/walkinglabs/learn-harness-engineering/blob/main/docs/en/lectures/lecture-14-graph-engineering/index.md): parallelize independent work only when coordination costs justify it; applied as simple read waves/write barriers, not a new multi-agent framework.
- [Docker security](https://docs.docker.com/engine/security/) and [run reference](https://docs.docker.com/reference/cli/docker/container/run/): isolation boundaries and runtime restrictions.
- [sharp resource controls](https://sharp.pixelplumbing.com/api-utility/): bounded decoder concurrency and cache configuration.

The lessons do not establish a measured speedup for this implementation. Use the actual benchmark and integration tests. Persistent task tracing/progress files from other harness patterns are deliberately not adopted because this project requires live-only diagnostics.

## Startup connection menu and cleanup boundary

`START_AGENT.cmd` with no arguments asks for a URL only on first use. Saved connections auto-start after four seconds; Enter connects now and M opens settings. M remains available during idle live operation, even after new logs. Active tool calls are never interrupted by opening settings. See [the launch guide](coding-agent.md#run-your-checkout). The menu has no file-operation hot-path work and adds no dependency.

Automatic cleanup removes only disposable graph/index/parser memory, known legacy BRC log files, and marked BRC sandbox input copies. No disk graph database exists. Source projects, Docker images, active credentials, and operational relay accounts are not targets. Forget is a separate explicit action: it removes only this agent's saved relay URL/token, not the old server's device entry.

## Optional host-native worker coordination

See [the parallel-worker guide](parallel-workers.md) for `worker_tasks`, `worker_patch`, and `worker_integrate`. Native AI workers, when the host actually supports them with BRC access, can claim independent scopes and submit patches without directly editing shared source. One parent integrates and verifies. Hosts without native workers keep ordinary batches; no model/API calls are added. `workspace_batch` also supports optional 1-4-way distinct-file publication with settled-wave rollback. Diagnostics and coordinator state remain live-only/RAM-only.
