# BRC reliability hardening — four-phase implementation

**Scope:** BRC local agent, shared MCP tool catalog, and relay-facing tool
guidance. Existing pairing, OAuth endpoint, MongoDB/SQLite storage and relay
recovery are unchanged. No separate LLM or Windows restricted-token sandbox.

## Phase 1 — honest command outcomes and idempotent append

`run_command` returns `commandExecuted`, `executionCompleted`,
`commandSucceeded`, `toolInfrastructureSucceeded`, `processOutcome`
(`success`, `nonzero_exit`, `timed_out`, `cancelled`, `uncertain`),
and `exitCode`. A *real* nonzero exit is still marked as an unsuccessful
MCP tool execution (`isError=true`) for compatibility with the job scheduler,
`run_parallel.depends_on`, the recovery journal and existing clients. This
is intentional: distinguishing transport failure from program failure must
never permit the next dependent mutation after a failed build.

`write_file` accepts `append_id` only with `mode:"append"`:

```json
{
 "path":"D:\\project\\logs\\report.txt",
 "mode":"append",
 "append_id":"49569c14-09ce-4e8d-af05-a0231c61569b",
 "expected_sha256":"SHA256_OF_FILE_BEFORE_CHUNK",
 "content":"next chunk..."
}
```

A stable ID binds a path and exact appended text to a metadata-only receipt.
Receipts use atomic fsync+rename writes, no file content, at most 128 entries
retained for seven days. A bounded 8 MiB destination is read and replaced
atomically; successful repeated calls with the same ID report
`alreadyApplied:true` and write **zero bytes**. An externally changed result
or conflicting operation ID returns `APPEND_OUTCOME_UNCERTAIN` or
`APPEND_ID_REUSED`; never blindly retry. Supplying the pre-write hash
is strongly recommended so even an expired/evicted receipt cannot silently
append a duplicate. **Legacy append without append_id is NOT idempotent.**

## Phase 2 — bounded, encrypted terminal recovery and independent cursors

`start_process` returns both PID and `sessionId` (UUID). Use:

```json
{"session_id":"SESSION_UUID","cursor":0,"length":150}
```

with `read_process_output`. Continue from returned `nextCursor`.
Independent absolute cursors do not consume each other's legacy offset=0
read position. `oldestAvailableCursor` and `lostOutput` report when earlier
output was evicted from the fixed in-memory tail. Old PID/offset calls remain
supported.

When the agent has existing device pairing, terminal output snapshots are
AES-256-GCM encrypted at rest with a derived pairing key, default enabled
(`BRC_TERMINAL_JOURNAL=0` disables). Output is saved only in bounded tails;
**never** command arguments, environment variables, conversation text or
project snapshots. TTL 24 hours, maximum 12 snapshots, maximum 8 MiB total
disk, maximum 500 KiB per snapshot, enforced after each save. If the agent
restarts, a recorded unfinished session returns `outcome_uncertain` rather
than pretending its process is still controllable or re-executing commands.

Existing live RAM caps remain: **500 KiB** per active terminal, one active
interactive terminal, and at most four completed buffers (aggregate 2 MiB).
The journal is disk-backed; snapshots are transiently serialized in bounded
buffers. This is not an OS-enforced process-wide RSS maximum.

Job output retention remains **off by default** unless requested via
`retain_output:true` or the existing local setting. `get_job` reports
which step outputs have retained, paginatable content, and which are only
available as a short preview. Stored output is best-effort redacted but
**must not be presumed secret-free**.

## Phase 3 — search dedup, streaming directory pagination, RAM pressure

Overlapping identical searches (same canonical root and all semantic options)
share one bounded ripgrep worker. A cancelled/released read-only subscriber
cannot terminate a coalesced worker another subscriber still needs.
`searchManager.dedupStatus()` and `agent_status.managedActivity.searchDedup`
report reuse counts.

`list_directory` supports `offset` and `limit`; defaults to 200 entries
per call, maximum 500 entries / 64 KiB response, maximum depth five and at
most 100 immediate items per nested directory. It iterates with
`fs.opendir`, so a gigantic top-level folder no longer requires an
unbounded `readdir` array. Pages are *live filesystem views, not snapshots*:
external changes can shift offsets. `read_file` on a directory uses the same
bounded fallback.

RAM responsiveness: the original 128 MiB approximate managed-context budget
and idle worker release remain. New telemetry detects agent RSS above
320 MiB or free physical RAM under 256 MiB and releases owned **idle** caches.
At agent RSS > 384 MiB, new ripgrep admission is reduced from two workers to
one; existing work is not forcibly killed. These are soft admission/cache
controls, not a guaranteed OS RAM limit; an LSP, compiler or external process
can have its own independent footprint.

For non-PDF remote URL reads, response consumption now enforces a 2 MiB
streamed-text or 4 MiB streamed-image bound instead of allocating unbounded
`response.text()` or `arrayBuffer()`. PDF parsing is still delegated to
the dedicated PDF implementation and does not share these text/image bounds.

## Phase 4 — safe path hints, verified moves and complete patches

Missing `read_file` or `read_code_file` paths return the nearest **allowed**
existing parent, at most five suggestion filenames from 256 directory
entries, and a safe next `list_directory` request. No guessed file is read
automatically, no path is created and no unauthorized directory is traversed.

`move_file` never overwrites an existing destination. Same-volume regular
files prefer an efficient no-clobber hardlink+unlink; different volumes use
a staged copy with SHA-256 of the source, stage and published destination
**before source removal**. Any uncertain partial publication preserves
available copies and explicitly requires manual inspection. Same-volume
directory rename remains supported. **Cross-volume directory moves are
intentionally rejected**: recursively copying/deleting an unbounded tree
is unsafe without a separate journaled tree-move protocol.

`apply_patch` supports:
- `*** Update File: relative/path` + exact unique `@@` line-context hunks
- `*** Add File: relative/path` + `+`-prefixed lines
- `*** Delete File: relative/path`
- `*** Move File: source -> destination`
- `*** Update File` followed by `*** Move to: destination`

All paths, file hashes, unique targets, hunks and destination conflicts are
preflighted before the first mutation. Maximum 16 files, 80 hunks, 8 MiB
per existing source and 16 MiB total patch-plan buffers. Writes are staged
and published per file with no overwrite; multi-file rollback is
best-effort. **This is not a crash-atomic multi-file transaction.** After a
`PATCH_PARTIAL` error or network interruption, inspect all involved paths
before retrying. Dry-run previews hashes and planned operations.

## Compatibility and activation

The public MCP tool definitions change only by adding arguments and expanding
`apply_patch` capability; existing names, relay authentication and device
pairing are preserved. Regenerate the bundled relay catalog before deployment:

```sh
pnpm --dir packages/agent build
node scripts/generate-relay-catalog.mjs
pnpm --dir packages/relay build
node scripts/generate-relay-catalog.mjs --check
```

Then run the agent and relay test suites. A **local agent restart** is needed
to load agent changes; the refreshed public MCP tool catalog requires a
**relay deployment and possibly a ChatGPT tool refresh/reconnection**. There
is no benefit to disconnecting the current live installation during
development. Neither step is performed by test/build/commit.

Tests: `idempotent-append.test.mjs`, `terminal-recovery.test.mjs`,
`directory-pagination.test.mjs`, `search-dedup.test.mjs`,
`path-move-reliability.test.mjs`, `extended-patch.test.mjs`, and all
existing agent/relay regression tests.
