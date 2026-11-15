# Fast coding tools, Docker observation, images and optional isolation

This checkout exposes 67 agent tools plus the relay's `list_devices` (68 total in the default full profile). The work happens on the local agent; the relay authenticates, routes requests and advertises tools. There is no new model, orchestration framework, graph database or dependency installation for this upgrade.

## The short workflow

1. Use `project_context` or a focused `context_pack` when conventions are unknown.
2. Use `batch_tools` for independent reads and simple ordered coding calls.
3. Use `workspace_batch` for coordinated file edits/creation, readback and explicitly selected checks.
4. Inspect real infrastructure with `docker_inventory` / `docker_inspect` before proposing another container or image.
5. Use `read_images` to list local image assets, then request selected previews.
6. Use `sandbox_run` only when the user explicitly requests isolated execution. Ordinary trusted reads/writes do not pay container startup cost.

Do not insist on starting a coding session, building a graph, loading parsers or opening Docker for every tiny edit. The existing specialized tools remain available.

## Fewer round trips

### `batch_tools`

A batch accepts up to 64 calls. `mode: "auto"` is the default: consecutive independent read tools run in waves of at most four, with writes and stateful tools acting as sequential barriers. This preserves read-before-write and write-before-read ordering inside a batch. `mode: "sequential"` keeps strict serial execution. `mode: "parallel"` accepts only independent read tools and rejects a write before execution.

`stopOnError` defaults to true. Already-started reads finish, but later writes are not launched after an error. A generic batch is not transactional: earlier successful writes are not undone. Nested batches, arbitrary shell execution, configuration changes and Docker execution are not accepted in this batch.

Responses are compact by default: structured data is not duplicated again as text inside each child result. `maxChars` defaults to 96,000 and is capped at 256,000. Per-entry output is bounded, truncation is explicit, and work stops before the shared result budget is exhausted. This is an output budget, not permission to assume an incomplete result is complete. Image binaries are returned through `read_images`, not escaped inside a generic JSON batch.

### `workspace_batch`

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
pnpm bench:context
```

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

The existing sharp dependency loads only when a preview/metadata operation requires it. Its operation cache is disabled and native concurrency is one; image work is serialized with a bounded queue. No OCR, upload, disk thumbnail cache or hidden model call is performed.

## Languages

Text searching, bounded reads and hash-checked text edits are language-neutral for ordinary UTF-8 source, including unknown extensions. `.NET` is an ecosystem: C# has a syntax grammar; F# and VB have generic text navigation and project checks. `language_capabilities` reports the current exact parser tiers.

Popular generic identities now also cover Lua, R, Julia, Elixir, Erlang, Haskell, OCaml, Zig, SQL, Fortran, COBOL, HTML and configuration files. Generic declaration candidates are labeled and never authorize an AST body replacement or pretend to prove syntax validity. Installed parsers are still not full compiler/type/language-server implementations for every language on Earth.

## Bounded memory and storage

Code graphs, filename indexes, parser results and recent activity remain in RAM. There is no persistent context/index database or saved thumbnail cache: disk context-cache usage is zero.

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
