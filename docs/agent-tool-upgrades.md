# BRC agent tool upgrades (excluding sandboxing)

These capabilities use the current BRC local agent and relay, with no new
model calls, separate database, or installed service required to run the agent.
They are enabled by default wherever the prerequisites exist.

## 1. Fresh source context from one search

`start_search({path,pattern,searchType:"content",wait:true})` now returns:
- Existing capped search matches and continuation.
- Up to four **fresh, authorized source files** with one-based line snippets,
  full-file SHA-256, and an explicit status for unavailable/oversized files.
- No second ripgrep search. Large files (over 512 KiB) are skipped; up to five
  match lines and 1,800 characters are included per file, subject to the
  existing 48,000-character tool response budget.

`includeSource:false` remains available when filenames/match lines alone
suffice. Only blocking content searches hydrate source; file searches and
streaming searches are unchanged. File hashes refer to fresh on-disk content,
not an atomic whole-repository snapshot. Do not assume a file did not change
between reading and writing.

## 2. Public guarded multi-file patches

The reviewed internal `edit_files` implementation is now in the default
Core/Focussed/Full MCP tool catalog. No duplicate patch engine was added.

Supply 1-16 source files with the current full-file SHA-256 and exact
`old_string` / `new_string` replacements. The engine validates all targets
before writing, enforces unique file paths, uses per-file atomic replacements,
and attempts hash-checked rollback when a later file publication fails.
`dryRun:true` previews hashes and bounded before/after hunk text.
**Not crash-atomic across multiple files.** A disconnected mutation can have
partially committed; inspect filesystem state before repeating.

## 3. Lazy C#/Rust/Python language intelligence

New MCP tool `lsp_query` supports `status`, `definition`, `references`,
`hover`, `implementation` and `document_symbols` for saved `.cs`, `.rs`,
and `.py` files. It checks project-boundary permissions, uses a one-process
LSP stdio JSON-RPC transport, opens or updates source files with exact
SHA-256, caps transport to 1 MiB, caps returned result presentation, and
closes the LSP process after 90 seconds idle.

**No language server is installed automatically.** Users who need semantic
results must separately install the chosen trusted executable and put it on
the local machine's PATH:
- C#: `csharp-ls`
- Rust: `rust-analyzer`
- Python: `pylsp`

On the development PC these binaries were not installed, so integration was
verified using a disposable fake LSP server, **not against actual C#/Rust/Python
language servers**. BRC's existing lazy TypeScript semantic worker remains
separate and unchanged. An LSP server is a third-party executable: verify its
trustworthiness before installing. This is not Windows sandboxing.

## 4. Faster native Windows subprocess selection

The existing kill-on-close Windows Job Object helper still owns eligible
subprocesses. BRC's native launch preflight now uses a 64-entry, 30-second
file-fingerprint cache for PE header verification and a short-lived dotnet
PATH lookup cache. Changed file metadata invalidates the PE cache. No native
failure is retried through an unsafe weaker path.

Development PC selection benchmark: 3,000 selections in five batches,
**564.1 -> 197.4 microseconds per preflight**, approximately 65% less
selection overhead. This is **not a 65% reduction in overall tool execution
time**. A tiny Node child still takes ~110 ms with the containment wrapper vs
~42 ms without. Direct launch of the compiled apphost `BrcWinJob.exe` was
measured slightly slower (~112 ms) than `dotnet BrcWinJob.dll` (~110 ms),
so the wrapper entrypoint is unchanged.

## 5. Dependency-aware workflows in existing run_parallel

Use existing `run_parallel` with an optional `depends_on` array of earlier
zero-based step indices on each call. Example:
```json
{
  "calls":[
    {"tool":"write_file","args":{"path":"C:\\temp\\a.txt","content":"A"}},
    {"tool":"read_file","args":{"path":"C:\\temp\\a.txt"},"depends_on":[0]},
    {"tool":"write_file","args":{"path":"C:\\temp\\b.txt","content":"B"},"depends_on":[0]}
  ]
}
```
Before dispatch, duplicate, self, and future dependencies are rejected.
Independent work can overlap within existing CPU/IO limits. Each dependent
call waits for every prerequisite to succeed. A failed, cancelled or missing
predecessor fails the dependent job with `DEPENDENCY_FAILED`, **without**
running its command or write. No automatic model planning, retries, implicit
argument substitution, or elevation of permissions. All steps still pass
through BRC's original tool dispatcher and resource controls.

### Deployment and compatibility

The source compiles on branch `harness-learn`. The local agent must restart
to load compiled changes. The static relay MCP catalog was regenerated so
`edit_files`, `lsp_query` and `run_parallel.depends_on` are discoverable
when the agent is offline; publishing that catalog requires a relay deployment
and the ChatGPT host may need a tool-catalog refresh. Preserve the same OAuth
client, endpoint, pairing and database. No live service was restarted as part
of development.

Windows restricted-token sandboxing is **not included**, by request.

## Most-used tool reliability pass (commands, edits, search)

The local agent's bounded failure history (last 100 failures) showed that
**real command exits** and **exact edit mismatches** were the dominant failure
categories, ahead of search regex and resource admission. A nonzero exit is
never reclassified as a successful command, and the system does not replay a
possibly committed command just to mask a failure.

### Direct native command invocation

Prefer `run_command({program:"git",args:["status","--short"],cwd:"D:\\project"})`
for Git, Node, Python, dotnet, rg and other native executables.
`program+args` passes each argument literally to the process, bypassing
PowerShell quoting and command injection via shell operators in data.
Use `command:"pnpm build"` or an explicitly chosen shell for .cmd/.bat
scripts and pipelines. On Windows argv-mode resolves .exe only, honors
blockedCommands, command environment isolation, managed process ownership,
timeouts and cancellation, and returns `PROGRAM_NOT_FOUND` or
`PROGRAM_START_FAILED` without silent shell substitution. The optional rtk
output compressor does not intercept argv-mode commands.

Failed commands carry their **real exit code**, bounded stdout/stderr, and
`commandFailureKind` when recognizable (TypeScript diagnostics, project
manifest missing, module resolution, shell/script syntax, Git outside repo,
missing executable). These are diagnostic hints, not automatic fixes.

### Exact edits and patches

`edit_block` keeps the default single-occurrence requirement. Setting
`replace_all:true` explicitly allows multiple **exact** matches in plain
UTF-8 source; maximum 10,000, never an implicit global replace. An unmatched
hunk returns `sourceSha256`, bounded `candidateLines` and a
`next:{tool:"read_code_file",args:{path,offset,length}}` suggestion.
These candidates do not authorize fuzzy writes. Office/structured-file
handlers reject the new replace_all option.

The new `apply_patch` tool accepts bounded DeepSeek/Codex-style
`*** Begin Patch` / `*** Update File: relative/path` /
`@@` context hunks / `*** End Patch`. **Only existing-file updates**
are supported. A hunk must match exactly one whole-line context; every
file/hunk is checked before any write. It reuses the existing
`edit_files` transaction engine and worker coordination policy.
`dryRun:true` validates without modifying files. Individual publishes
are atomic; multi-file rollback on later failure is best effort, **not
crash-atomic across files**. For adds/deletes/renames use file-specific
tools. No model calls and no local shell are needed for patch application.

### Ripgrep recovery

`start_search(wait:true,searchType:"content")` now retries a malformed
**implicit** regex as a literal search once, and returns an explicit
`autoLiteralFallback:true` marker. If the caller explicitly specifies
`literalSearch:false`, malformed regexes still return
`SEARCH_INVALID_PATTERN` and are never silently reinterpreted.
Search concurrency and result caps remain in place to protect host RAM.

### Activation, tests and known limitations

The source changes require a local BRC agent restart. The regenerated
MCP relay catalog requires a relay deployment (and may require a client
tool refresh) before ChatGPT sees new `run_command.program/args`,
`edit_block.replace_all`, `apply_patch` and new search guidance.
No OAuth, pairing or database migration is required by these source
changes; preserve the existing service identity and endpoint.

There is no guarantee that every unsuccessful user command becomes
successful: a broken build, missing dependency, invalid path, real compiler
error, or unavailable executable still returns a failure with improved
diagnostics. The Windows restricted-token sandbox is not part of this work.

Tests: `command-argv-reliability.test.mjs`,
`edit-repair-robustness.test.mjs`, `context-patch-reliability.test.mjs`,
`regex-auto-literal.test.mjs`, plus the complete agent and relay suites.

## Verification

```sh
pnpm --dir packages/agent build
node scripts/generate-relay-catalog.mjs --check
pnpm --dir packages/relay build
node --test packages/agent/test/search-source-context.test.mjs
node --test packages/agent/test/lazy-lsp.test.mjs
node --test packages/agent/test/dependency-workflow.test.mjs
node --test packages/agent/test/native-managed-spawn.test.mjs
node --test packages/agent/test/transport.test.mjs
node --test packages/relay/test/core-profile.test.mjs
```

These are tests of actual local agent code, disposable files, fake language
server, and disposable MCP relay. No production deployment or OAuth change is
implied by test success.
